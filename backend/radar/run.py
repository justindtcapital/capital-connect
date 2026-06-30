"""Signal Radar batch worker — entrypoint (Stage 1 INGEST + Stage 3 TRIAGE).

Usage (from backend/):
    python -m radar.run --dry-run            # ingest + triage, print, no Sheets writes
    python -m radar.run --limit 5            # only the first 5 companies
    python -m radar.run --network            # also scan CRM network companies
    python -m radar.run --source gnews_rss   # restrict to one source

Run is restart-safe: dedup keys mean re-running never duplicates signals (§13).
"""

from __future__ import annotations

import argparse
import asyncio
import uuid
from collections import Counter

from . import http_client, llm, store
from .companies import load_companies
from .models import ScanRun, now_iso
from .sources import ALL_SOURCES
from .triage import Existing, triage_candidates


async def run(*, dry_run: bool, limit: int | None, include_network: bool, source_filter: str | None) -> ScanRun:
    run_id = str(uuid.uuid4())
    scan = ScanRun(id=run_id)
    http_client.COMPLIANCE_BLOCKS.clear()

    print(f">> radar run {run_id[:8]}  (dry_run={dry_run}, llm={'on' if llm.available() else 'off - heuristic'})")

    if not dry_run:
        await store.ensure_tabs()

    companies = await load_companies(include_network=include_network, limit=limit)
    print(f"  companies: {len(companies)}")
    if not companies:
        scan.status = "failed"
        scan.error_detail = "no companies loaded (check Portfolio Companies tab / Sheets creds)"
        scan.finished_at = now_iso()
        if not dry_run:
            await store.write_run(scan)
        print("  XX no companies - aborting")
        return scan

    # ── Stage 1: INGEST ──────────────────────────────────────────────
    sources = [s for s in ALL_SOURCES if not source_filter or s.source_type == source_filter]
    candidates = []
    for src in sources:
        try:
            found = await src.fetch_candidates(companies)
        except Exception as exc:  # noqa: BLE001 — a source failing must not kill the run
            found = []
            print(f"  !! source {src.source_type} errored: {exc}")
            if not dry_run:
                await store.write_audit(run_id, "ingest", "source_error", f"{src.source_type}: {exc}")
        print(f"  ingest[{src.source_type}]: {len(found)} candidates")
        if not dry_run:
            await store.write_audit(run_id, "ingest", "source_done", f"{src.source_type}={len(found)}")
        candidates.extend(found)
    scan.candidates_found = len(candidates)

    # ── Stage 3: TRIAGE ──────────────────────────────────────────────
    existing = await store.load_existing() if not dry_run else Existing(set(), set())
    decisions, signals, llm_calls = await triage_candidates(candidates, existing, run_id)
    scan.signals_promoted = len(signals)
    scan.llm_calls = llm_calls

    breakdown = Counter(d.status for d in decisions)
    print(f"  triage: {dict(breakdown)}  (llm_calls={llm_calls})")
    print(f"  OK promoted {len(signals)} signals")
    for s in signals[:10]:
        print(f"      [{s.signal_type} {s.quality_score} {s.source_trust}] {s.company_name}: {s.headline}")

    # ── Compliance guard (§13): blocked attempts fail loudly ─────────
    if http_client.COMPLIANCE_BLOCKS:
        scan.status = "failed"
        scan.error_detail = f"compliance_block: {http_client.COMPLIANCE_BLOCKS}"
        print(f"  XX COMPLIANCE BLOCK attempted: {http_client.COMPLIANCE_BLOCKS}")
        if not dry_run:
            await store.write_audit(run_id, "ingest", "compliance_block", str(http_client.COMPLIANCE_BLOCKS))

    # ── Persist ──────────────────────────────────────────────────────
    if not dry_run:
        await store.write_decisions(run_id, decisions)
        await store.write_signals(signals)
        if scan.status == "running":
            scan.status = "success"
        scan.finished_at = now_iso()
        await store.write_run(scan)
    else:
        if scan.status == "running":
            scan.status = "success"
        scan.finished_at = now_iso()
        print("  (dry-run — nothing written to Sheets)")

    return scan


def main() -> None:
    ap = argparse.ArgumentParser(description="VenturePulse Signal Radar worker (Stage 1+3)")
    ap.add_argument("--dry-run", action="store_true", help="ingest + triage, print, no Sheets writes")
    ap.add_argument("--limit", type=int, default=None, help="cap number of companies")
    ap.add_argument("--network", action="store_true", help="also scan CRM network companies (T3)")
    ap.add_argument("--source", default=None, help="restrict to one source_type (e.g. gnews_rss)")
    args = ap.parse_args()

    asyncio.run(run(
        dry_run=args.dry_run,
        limit=args.limit,
        include_network=args.network,
        source_filter=args.source,
    ))


if __name__ == "__main__":
    main()
