"""Google Sheets integration — server-only.

Port of `src/utils/sheets.server.ts`. OAuth2 refresh-token → access-token flow,
5-minute read caching, plus the column mappings and data builders that turn raw
sheet rows into Contacts / Targets / Portfolio Companies.
"""

from __future__ import annotations

import time
from urllib.parse import quote

import httpx

from . import config
from .cache import CACHE_TTL_SECONDS, TTLCache
from .models import Contact, Interaction, PortfolioCompany, TargetLead

# ── Cache ────────────────────────────────────────────────────────────────────
# Each cached value is the raw row matrix (list of rows of cells) for one tab.
_cache: TTLCache[list[list[str]]] = TTLCache(CACHE_TTL_SECONDS)

# ── Google Auth (OAuth2 Refresh Token → access token) ────────────────────────
_cached_token: dict | None = None  # {"token": str, "expires_at": float}


async def _get_access_token() -> str:
    global _cached_token
    if _cached_token and time.time() < _cached_token["expires_at"] - 30:
        return _cached_token["token"]

    client_id = config.GOOGLE_CLIENT_ID
    client_secret = config.GOOGLE_CLIENT_SECRET
    refresh_token = config.GOOGLE_REFRESH_TOKEN

    if not client_id or not client_secret or not refresh_token:
        raise RuntimeError(
            "Google OAuth2 credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, "
            "GOOGLE_REFRESH_TOKEN) are not configured"
        )

    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.post(
            "https://oauth2.googleapis.com/token",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "grant_type": "refresh_token",
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
            },
        )

    if res.status_code >= 400:
        raise RuntimeError(f"Google token refresh failed [{res.status_code}]: {res.text}")

    data = res.json()
    access_token = data["access_token"]
    expires_in = data["expires_in"]
    _cached_token = {"token": access_token, "expires_at": time.time() + expires_in}
    return access_token


# ── Fetch a single sheet tab ─────────────────────────────────────────────────
async def fetch_sheet_tab(tab_name: str) -> list[list[str]]:
    cached = _cache.get(tab_name)
    if cached is not None:
        return cached

    spreadsheet_id = config.GOOGLE_SPREADSHEET_ID
    if not spreadsheet_id:
        raise RuntimeError("GOOGLE_SPREADSHEET_ID secret is not configured")

    token = await _get_access_token()
    url = (
        f"https://sheets.googleapis.com/v4/spreadsheets/{quote(spreadsheet_id, safe='')}"
        f"/values/{quote(tab_name, safe='')}"
    )

    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.get(url, headers={"Authorization": f"Bearer {token}"})

    if res.status_code >= 400:
        raise RuntimeError(f'Sheets API error for tab "{tab_name}" [{res.status_code}]: {res.text}')

    rows = res.json().get("values") or []
    _cache.set(tab_name, rows)
    return rows


# ── Append a row to a sheet tab ──────────────────────────────────────────────
async def append_sheet_row(tab_name: str, values: list[str]) -> None:
    spreadsheet_id = config.GOOGLE_SPREADSHEET_ID
    if not spreadsheet_id:
        raise RuntimeError("GOOGLE_SPREADSHEET_ID secret is not configured")

    token = await _get_access_token()
    url = (
        f"https://sheets.googleapis.com/v4/spreadsheets/{quote(spreadsheet_id, safe='')}"
        f"/values/{quote(tab_name, safe='')}:append"
        "?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"
    )

    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.post(
            url,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"values": [values]},
        )

    if res.status_code >= 400:
        raise RuntimeError(f'Sheets append error for tab "{tab_name}" [{res.status_code}]: {res.text}')

    # Invalidate cache for this tab.
    _cache.delete(tab_name)


# ── Append multiple rows to a sheet tab (one API call) ───────────────────────
async def append_sheet_rows(tab_name: str, rows: list[list[str]]) -> None:
    if not rows:
        return
    spreadsheet_id = config.GOOGLE_SPREADSHEET_ID
    if not spreadsheet_id:
        raise RuntimeError("GOOGLE_SPREADSHEET_ID secret is not configured")

    token = await _get_access_token()
    url = (
        f"https://sheets.googleapis.com/v4/spreadsheets/{quote(spreadsheet_id, safe='')}"
        f"/values/{quote(tab_name, safe='')}:append"
        "?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"
    )
    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.post(
            url,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"values": rows},
        )
    if res.status_code >= 400:
        raise RuntimeError(f'Sheets append error for tab "{tab_name}" [{res.status_code}]: {res.text}')
    _cache.delete(tab_name)


# ── Ensure a tab exists with a header row (create it if missing) ─────────────
async def _batch_update(requests: list[dict]) -> dict:
    spreadsheet_id = config.GOOGLE_SPREADSHEET_ID
    if not spreadsheet_id:
        raise RuntimeError("GOOGLE_SPREADSHEET_ID secret is not configured")
    token = await _get_access_token()
    url = (
        f"https://sheets.googleapis.com/v4/spreadsheets/{quote(spreadsheet_id, safe='')}"
        ":batchUpdate"
    )
    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.post(
            url,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"requests": requests},
        )
    if res.status_code >= 400:
        raise RuntimeError(f"Sheets batchUpdate error [{res.status_code}]: {res.text}")
    return res.json()


async def ensure_tab(tab_name: str, headers: list[str]) -> None:
    """Create the tab with a header row if it doesn't exist; if it exists but is
    empty, write the header row. Existing populated tabs are left untouched."""
    try:
        rows = await fetch_sheet_tab(tab_name)
    except RuntimeError:
        # Tab almost certainly doesn't exist (Sheets returns 400 on unknown range).
        await _batch_update([{"addSheet": {"properties": {"title": tab_name}}}])
        rows = []
    if not rows:
        await append_sheet_row(tab_name, headers)


# ── Update a specific cell in a sheet tab ────────────────────────────────────
async def update_sheet_cell(tab_name: str, cell_range: str, value: str) -> None:
    spreadsheet_id = config.GOOGLE_SPREADSHEET_ID
    if not spreadsheet_id:
        raise RuntimeError("GOOGLE_SPREADSHEET_ID secret is not configured")

    token = await _get_access_token()
    range_ = f"{tab_name}!{cell_range}"
    url = (
        f"https://sheets.googleapis.com/v4/spreadsheets/{quote(spreadsheet_id, safe='')}"
        f"/values/{quote(range_, safe='')}?valueInputOption=USER_ENTERED"
    )

    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.put(
            url,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"values": [[value]]},
        )

    if res.status_code >= 400:
        raise RuntimeError(f'Sheets update error for "{range_}" [{res.status_code}]: {res.text}')

    _cache.delete(tab_name)


# ── Column mapping helper ────────────────────────────────────────────────────
def _map_rows(rows: list[list[str]], mapping: dict[str, str]) -> list[dict[str, str]]:
    if len(rows) < 2:
        return []
    headers = [h.strip().lower() for h in rows[0]]
    field_map: dict[int, str] = {}

    for sheet_col, field_name in mapping.items():
        try:
            idx = headers.index(sheet_col.lower())
        except ValueError:
            continue
        field_map[idx] = field_name

    result: list[dict[str, str]] = []
    for row in rows[1:]:
        obj: dict[str, str] = {}
        for idx, field in field_map.items():
            cell = row[idx] if idx < len(row) else ""
            obj[field] = (cell or "").strip()
        result.append(obj)
    return result


# ══════════════════════════════════════════════════════════════════════════════
# COLUMN MAPPINGS — matched to actual Google Sheet
# Keys = sheet column header (case-insensitive), values = model field
# ══════════════════════════════════════════════════════════════════════════════

# Tab names — matched to actual sheet
TAB_NAMES = {
    "contacts": "Contacts",
    "events": "Events",
    "portcoIntros": "PortCos Introduced",
    "interactions": "Notes",
    "targets": "Targets",
    "portfolio": "Portfolio Companies",
}

CONTACT_COLS = {
    "name": "name",
    "role": "title",
    "company": "company",
    "email": "email",
    "phone number": "phone",
    "location": "location",
    "relationship prime": "prime",
    "industry category": "sector",
    "relationship status": "temperature",
    "follow up flag": "followUpFlag",
    "date added": "dateAdded",
    "urid": "urid",
}

EVENT_COLS = {
    "contact email": "email",
    "event name": "eventName",
    "date": "date",
    "type": "type",
}

PORTCO_INTRO_COLS = {
    "contact email": "email",
    "portco name": "portcoName",
    "date": "date",
}

INTERACTION_COLS = {
    "contact email": "email",
    "timestamp": "date",
    "note content": "summary",
    "requires follow up": "isFollowUp",
    "follow up resolved": "followUpComplete",
}

TARGET_COLS = {
    "first name": "firstName",
    "last name": "lastName",
    "company": "company",
    "role": "role",
    "linkedin": "linkedinUrl",
    "email": "email",
    "location": "location",
    "sector": "sector",
    "stage": "stage",
    "source": "originSource",
    "research purpose": "researchPurpose",
    "date added": "dateAdded",
    "last contacted": "lastContacted",
}

PORTFOLIO_COLS = {
    "company name": "name",
    "website": "website",
    "focus area(s)": "domain",
    "hq": "location",
    "summary": "description",
}


# ══════════════════════════════════════════════════════════════════════════════
# DATA BUILDERS
# ══════════════════════════════════════════════════════════════════════════════


def _group_by(items: list[dict[str, str]], key: str) -> dict[str, list[dict[str, str]]]:
    out: dict[str, list[dict[str, str]]] = {}
    for item in items:
        k = (item.get(key) or "").lower()
        if not k:
            continue
        out.setdefault(k, []).append(item)
    return out


async def _safe_fetch_tab(tab_name: str) -> list[list[str]]:
    """fetchSheetTab(...).catch(() => []) — used for the optional tabs."""
    try:
        return await fetch_sheet_tab(tab_name)
    except Exception:  # noqa: BLE001
        return []


async def build_contacts() -> list[Contact]:
    # The TS uses Promise.all; the first tab is required, the rest tolerate errors.
    contact_rows = await fetch_sheet_tab(TAB_NAMES["contacts"])
    event_rows = await _safe_fetch_tab(TAB_NAMES["events"])
    intro_rows = await _safe_fetch_tab(TAB_NAMES["portcoIntros"])
    interaction_rows = await _safe_fetch_tab(TAB_NAMES["interactions"])

    raw_contacts = _map_rows(contact_rows, CONTACT_COLS)
    raw_events = _map_rows(event_rows, EVENT_COLS)
    raw_intros = _map_rows(intro_rows, PORTCO_INTRO_COLS)
    raw_interactions = _map_rows(interaction_rows, INTERACTION_COLS)

    # Group by email
    events_by_email = _group_by(raw_events, "email")
    intros_by_email = _group_by(raw_intros, "email")
    interactions_by_email = _group_by(raw_interactions, "email")

    contacts: list[Contact] = []
    for idx, c in enumerate(raw_contacts):
        email = c.get("email") or ""
        contact_events = events_by_email.get(email, [])
        contact_intros = intros_by_email.get(email, [])
        contact_interactions = interactions_by_email.get(email, [])

        events_attended = [
            e["eventName"] for e in contact_events
            if (e.get("type") or "attended").lower() == "attended"
        ]
        events_invited = [
            e["eventName"] for e in contact_events
            if (e.get("type") or "").lower() == "invited"
        ]

        # dict.fromkeys preserves order while de-duplicating (≈ [...new Set()]).
        port_co_intros = list(dict.fromkeys(
            i["portcoName"] for i in contact_intros if i.get("portcoName")
        ))

        interactions: list[Interaction] = []
        for i_idx, i in enumerate(contact_interactions):
            interactions.append(Interaction(
                id=f"i-{idx}-{i_idx}",
                date=i.get("date") or "",
                type="note",
                summary=i.get("summary") or "",
                isFollowUp=(i.get("isFollowUp") or "").lower() == "true",
                followUpComplete=(i.get("followUpComplete") or "").lower() == "true",
            ))

        # Follow-up pending: either from Notes tab or from Contact's Follow Up Flag
        follow_up_from_notes = any(i.is_follow_up and not i.follow_up_complete for i in interactions)
        follow_up_from_flag = (c.get("followUpFlag") or "").lower() == "true"
        follow_up_pending = follow_up_from_notes or follow_up_from_flag

        # Map "Relationship Status" to Temperature
        raw_temp = (c.get("temperature") or "").strip()
        temperature = raw_temp if raw_temp in ("Hot", "Warm", "Cold") else "Cold"

        events_invited_union = list(dict.fromkeys([*events_invited, *events_attended]))

        contacts.append(Contact(
            id=f"c-{idx}",
            name=c.get("name") or "",
            title=c.get("title") or "",
            company=c.get("company") or "",
            email=email,
            phone=c.get("phone") or "",
            address="",
            prime=c.get("prime") or "",
            sector=c.get("sector") or "",
            areasOfInterest=[],
            temperature=temperature,
            portCoIntros=port_co_intros,
            eventsAttended=events_attended,
            eventsInvited=events_invited_union,
            interactions=interactions,
            lastContact=c.get("dateAdded") or (interactions[0].date if interactions else ""),
            followUpPending=follow_up_pending,
            location=c.get("location") or "",
        ))
    return contacts


async def build_targets() -> list[TargetLead]:
    target_rows = await fetch_sheet_tab(TAB_NAMES["targets"])
    raw_targets = _map_rows(target_rows, TARGET_COLS)

    targets: list[TargetLead] = []
    for idx, t in enumerate(raw_targets):
        first_name = t.get("firstName") or ""
        last_name = t.get("lastName") or ""
        name = " ".join(p for p in (first_name, last_name) if p)

        targets.append(TargetLead(
            id=f"t-{idx}",
            name=name,
            title=t.get("title") or "",
            company=t.get("company") or "",
            linkedinUrl=t.get("linkedinUrl") or "",
            email=t.get("email") or "",
            phone=t.get("phone") or "",
            location=t.get("location") or "",
            sector=t.get("sector") or "",
            stage=t.get("stage") or "Prospecting",
            originSource=t.get("originSource") or "",
            outreach=[],
            notes=t.get("researchPurpose") or "",
        ))
    return targets


_DOMAIN_MAP = {
    "security": "Security",
    "ai": "AI",
    "artificial intelligence": "AI",
    "data": "Data",
    "cloud": "Cloud",
    "infrastructure": "Cloud",
    "logistics": "Logistics",
    "supply chain": "Supply Chain",
    "silicon": "Silicon",
    "developer tools": "Cloud",
}


async def build_portfolio_companies() -> list[PortfolioCompany]:
    company_rows = await fetch_sheet_tab(TAB_NAMES["portfolio"])
    raw_companies = _map_rows(company_rows, PORTFOLIO_COLS)

    companies: list[PortfolioCompany] = []
    for idx, c in enumerate(raw_companies):
        name = c.get("name") or ""

        # Parse Focus Area(s) as domain — map to closest PortfolioDomain
        raw_domain = (c.get("domain") or "").strip()
        domain_lower = raw_domain.lower()
        domain = "Cloud"
        for keyword, mapped in _DOMAIN_MAP.items():
            if keyword in domain_lower:
                domain = mapped
                break

        companies.append(PortfolioCompany(
            id=f"pc-{idx}",
            name=name,
            sector=raw_domain,
            domain=domain,
            website=c.get("website") or "",
            linkedinUrl="",
            location=c.get("location") or "",
            description=c.get("description") or "",
            contactName="",
            contactEmail="",
            contactPhone="",
            employees=[],
            events=[],
            introductions=[],
        ))
    return companies
