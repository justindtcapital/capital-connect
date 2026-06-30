"""Load the tracked-company universe from Google Sheets.

Portfolio companies (Portfolio Companies tab) are T1/T2; network companies
(derived from CRM Contacts) are T3. Optional enrichment columns on the Portfolio
tab — "SEC CIK", "RSS Press URL", "GitHub Org", "ATS Board URL" — feed the
EDGAR/GitHub/ATS sources when present (§3.1). Cohort rotation is future work; for
the structured-only slice, structured feeds cover everyone cheaply.
"""

from __future__ import annotations

from app.sheets import TAB_NAMES, build_contacts, fetch_sheet_tab

from .models import Company

_ENRICH = {
    "sec cik": "sec_cik",
    "rss press url": "rss_press_url",
    "github org": "github_org",
    "ats board url": "ats_board_url",
}
_CORE = {"company name": "name", "website": "website", "focus area(s)": "domain", "hq": "location"}


def _index(headers: list[str], wanted: dict[str, str]) -> dict[int, str]:
    lower = [h.strip().lower() for h in headers]
    out: dict[int, str] = {}
    for col, field in wanted.items():
        if col in lower:
            out[lower.index(col)] = field
    return out


async def _portfolio() -> list[Company]:
    try:
        rows = await fetch_sheet_tab(TAB_NAMES["portfolio"])
    except RuntimeError:
        return []
    if len(rows) < 2:
        return []
    idx = _index(rows[0], {**_CORE, **_ENRICH})
    companies: list[Company] = []
    for r in rows[1:]:
        vals = {field: (r[i].strip() if i < len(r) else "") for i, field in idx.items()}
        name = vals.get("name", "")
        if not name:
            continue
        companies.append(Company(
            name=name,
            website=vals.get("website", ""),
            domain=vals.get("domain", ""),
            location=vals.get("location", ""),
            tier="T1",
            sec_cik=vals.get("sec_cik", ""),
            rss_press_url=vals.get("rss_press_url", ""),
            github_org=vals.get("github_org", ""),
            ats_board_url=vals.get("ats_board_url", ""),
        ))
    return companies


async def _network(exclude: set[str]) -> list[Company]:
    try:
        contacts = await build_contacts()
    except Exception:  # noqa: BLE001
        return []
    seen: set[str] = set()
    out: list[Company] = []
    for c in contacts:
        name = (c.company or "").strip()
        key = name.lower()
        if not name or key in exclude or key in seen:
            continue
        seen.add(key)
        out.append(Company(name=name, tier="T3"))
    return out


async def load_companies(*, include_network: bool = False, limit: int | None = None) -> list[Company]:
    portfolio = await _portfolio()
    companies = list(portfolio)
    if include_network:
        exclude = {c.name.lower() for c in portfolio}
        companies.extend(await _network(exclude))
    if limit is not None:
        companies = companies[:limit]
    return companies
