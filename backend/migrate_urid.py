"""One-off: backfill stable surrogate keys (urid) across the workbook.

Activates the dormant `urid` column so record identity stops depending on
editable email/name strings or array position. This is Phase 1 of the
persistence hardening: it ADDS columns and fills BLANK cells only. It never
deletes, reorders, or overwrites existing data, so it is safe and re-runnable
(idempotent).

What it does:
  Entity tabs get a stable key column, backfilled with a UUID per row:
    - Contacts            -> "urid"
    - Targets             -> "URID"
    - Portfolio Companies -> "URID"
  Satellite tabs get a parent-key column, backfilled by resolving each row's
  current join key against the freshly-keyed entity tabs:
    - Events, Notes, PortCos Introduced -> "Contact URID"  (by contact email)
    - Field Provenance, Rating Overrides -> "URID"          (by contact email)
    - Target Outreach, Target Strategy  -> "Target URID"    (by target key)

Rows whose parent can't be resolved are reported as orphans and left blank
(the app keeps an email/target-key fallback, so nothing breaks).

Usage (run from the backend/ directory):
    python migrate_urid.py --dry-run   # report only, writes nothing
    python migrate_urid.py             # apply

Make a copy of the spreadsheet first (File > Make a copy).
"""

from __future__ import annotations

import argparse
import asyncio
import uuid

import httpx

from app import config, sheets

BASE = "https://sheets.googleapis.com/v4/spreadsheets"


# ── Small helpers ────────────────────────────────────────────────────────────
def col_letters(index: int) -> str:
    """0-based column index -> A1 letters (0 -> A, 26 -> AA)."""
    s = ""
    n = index + 1
    while n > 0:
        rem = (n - 1) % 26
        s = chr(65 + rem) + s
        n = (n - 1) // 26
    return s


def header_index(headers: list[str], name: str) -> int:
    target = name.strip().lower()
    for i, h in enumerate(headers):
        if (h or "").strip().lower() == target:
            return i
    return -1


def cell(row: list[str], idx: int) -> str:
    return (row[idx] if 0 <= idx < len(row) else "") or ""


def target_key_of(email: str, name: str, company: str) -> str:
    e = (email or "").strip().lower()
    if e:
        return e
    return f"{(name or '').strip().lower()}|{(company or '').strip().lower()}"


async def load(tab: str) -> list[list[str]] | None:
    """Fresh read of a tab, or None if the tab doesn't exist."""
    sheets._cache.delete(tab)
    try:
        return await sheets.fetch_sheet_tab(tab)
    except RuntimeError:
        return None


async def write_values(
    client: httpx.AsyncClient,
    sid: str,
    token: str,
    tab: str,
    updates: list[tuple[str, list[list[str]]]],
) -> None:
    """One values:batchUpdate call. `updates` = list of (a1_range, values_matrix)."""
    if not updates:
        return
    data = [{"range": f"{tab}!{rng}", "values": vals} for rng, vals in updates]
    res = await client.post(
        f"{BASE}/{sid}/values:batchUpdate",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"valueInputOption": "USER_ENTERED", "data": data},
    )
    res.raise_for_status()
    sheets._cache.delete(tab)


# ── Core: backfill one column in a tab ───────────────────────────────────────
async def backfill_column(
    client: httpx.AsyncClient,
    sid: str,
    token: str,
    tab: str,
    key_header: str,
    *,
    value_for_row,
    dry: bool,
) -> dict:
    """Ensure `key_header` exists on `tab` and fill blank cells via value_for_row(row).

    value_for_row returns the value to write for a data row, or "" to leave blank
    (an orphan, for satellites that can't resolve a parent). Existing non-blank
    values are always preserved.
    """
    stats = {"tab": tab, "exists": False, "total": 0, "filled": 0, "already": 0, "orphans": 0}
    rows = await load(tab)
    if rows is None:
        print(f"  [skip] {tab}: tab not found")
        return stats
    stats["exists"] = True
    if not rows:
        print(f"  [skip] {tab}: empty tab")
        return stats

    headers = rows[0]
    col_idx = header_index(headers, key_header)
    created = col_idx == -1
    if created:
        col_idx = len(headers)
    col = col_letters(col_idx)
    data_rows = rows[1:]
    stats["total"] = len(data_rows)

    column: list[list[str]] = []  # one [value] per data row, in order
    for row in data_rows:
        existing = cell(row, col_idx).strip()
        if existing:
            stats["already"] += 1
            column.append([existing])
            continue
        value = value_for_row(row) or ""
        if value:
            stats["filled"] += 1
        else:
            stats["orphans"] += 1
        column.append([value])

    note = " (new column)" if created else ""
    print(
        f"  {tab}{note}: {stats['filled']} filled, {stats['already']} already keyed, "
        f"{stats['orphans']} unresolved of {stats['total']} rows"
    )

    if dry or not data_rows:
        return stats

    updates: list[tuple[str, list[list[str]]]] = []
    if created:
        updates.append((f"{col}1", [[key_header]]))
    last_row = len(data_rows) + 1  # sheet row number of the final data row
    updates.append((f"{col}2:{col}{last_row}", column))
    await write_values(client, sid, token, tab, updates)
    return stats


# ── Build parent lookup maps (in-memory, including freshly generated urids) ───
async def _backfill_entity(
    client, sid, token, tab: str, key_header: str, *, key_for_row, dry: bool
) -> dict[str, str]:
    """Backfill an entity's urid column in a single pass and return a parent map.

    For each data row the value is the existing urid (preserved) or a freshly
    generated one; the SAME value is recorded in the returned map via key_for_row,
    so map entries and written cells can never diverge — even on re-runs.
    """
    mapping: dict[str, str] = {}
    rows = await load(tab)
    if not rows:
        print(f"  [skip] {tab}: not found or empty")
        return mapping

    headers = rows[0]
    col_idx = header_index(headers, key_header)
    created = col_idx == -1
    if created:
        col_idx = len(headers)
    col = col_letters(col_idx)
    data_rows = rows[1:]

    filled = already = 0
    column: list[list[str]] = []
    for row in data_rows:
        existing = cell(row, col_idx).strip()
        if existing:
            already += 1
            value = existing
        else:
            filled += 1
            value = str(uuid.uuid4())
        column.append([value])
        k = key_for_row(headers, row)
        if k and k not in mapping:
            mapping[k] = value

    note = " (new column)" if created else ""
    print(f"  {tab}{note}: {filled} filled, {already} already keyed of {len(data_rows)} rows")

    if not dry and data_rows:
        updates: list[tuple[str, list[list[str]]]] = []
        if created:
            updates.append((f"{col}1", [[key_header]]))
        updates.append((f"{col}2:{col}{len(data_rows) + 1}", column))
        await write_values(client, sid, token, tab, updates)
    return mapping


async def build_contact_email_map(client, sid, token, dry: bool) -> dict[str, str]:
    """email(lower) -> contact urid (every contact, existing or freshly keyed)."""

    def key_for_row(headers, row):
        return cell(row, header_index(headers, "email")).strip().lower()

    return await _backfill_entity(
        client, sid, token, "Contacts", "urid", key_for_row=key_for_row, dry=dry
    )


async def build_target_key_map(client, sid, token, dry: bool) -> dict[str, str]:
    """targetKeyOf -> target urid (every target, existing or freshly keyed)."""

    def key_for_row(headers, row):
        first = cell(row, header_index(headers, "first name"))
        last = cell(row, header_index(headers, "last name"))
        name = " ".join(p for p in [first, last] if p).strip()
        return target_key_of(
            cell(row, header_index(headers, "email")),
            name,
            cell(row, header_index(headers, "company")),
        )

    return await _backfill_entity(
        client, sid, token, "Targets", "URID", key_for_row=key_for_row, dry=dry
    )


# ── Main ─────────────────────────────────────────────────────────────────────
async def main(dry: bool) -> None:
    sid = config.GOOGLE_SPREADSHEET_ID
    if not sid:
        raise SystemExit("GOOGLE_SPREADSHEET_ID is not configured")
    token = await sheets._get_access_token()

    mode = "DRY RUN (no writes)" if dry else "APPLYING CHANGES"
    print(f"\n=== urid migration — {mode} ===\n")

    async with httpx.AsyncClient(timeout=60) as client:
        # 1) Entity tabs first so the parent maps include freshly generated urids.
        print("Entities:")
        email_to_urid = await build_contact_email_map(client, sid, token, dry)
        key_to_urid = await build_target_key_map(client, sid, token, dry)
        await backfill_column(
            client, sid, token, "Portfolio Companies", "URID",
            value_for_row=lambda row: str(uuid.uuid4()), dry=dry,
        )

        # 2) Satellite tabs joined to a contact by email.
        print("\nContact satellites (by email):")
        for tab, key_header, email_header in [
            ("Events", "Contact URID", "contact email"),
            ("Notes", "Contact URID", "contact email"),
            ("PortCos Introduced", "Contact URID", "contact email"),
            ("Field Provenance", "URID", "email"),
            ("Rating Overrides", "URID", "email"),
        ]:
            rows = await load(tab)
            if not rows:
                print(f"  [skip] {tab}: not found or empty")
                continue
            email_idx = header_index(rows[0], email_header)
            await backfill_column(
                client, sid, token, tab, key_header,
                value_for_row=lambda row, i=email_idx: email_to_urid.get(
                    cell(row, i).strip().lower(), ""
                ),
                dry=dry,
            )

        # 3) Satellite tabs joined to a target by its derived key.
        print("\nTarget satellites (by target key):")
        for tab, key_header, key_col in [
            ("Target Outreach", "Target URID", "target key"),
            ("Target Strategy", "Target URID", "target key"),
        ]:
            rows = await load(tab)
            if not rows:
                print(f"  [skip] {tab}: not found or empty")
                continue
            key_idx = header_index(rows[0], key_col)
            await backfill_column(
                client, sid, token, tab, key_header,
                value_for_row=lambda row, i=key_idx: key_to_urid.get(
                    cell(row, i).strip().lower(), ""
                ),
                dry=dry,
            )

    print("\nDone." + ("" if dry else " Re-run with --dry-run to confirm everything is keyed."))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill stable urid keys across the workbook.")
    parser.add_argument("--dry-run", action="store_true", help="report only; write nothing")
    args = parser.parse_args()
    asyncio.run(main(args.dry_run))
