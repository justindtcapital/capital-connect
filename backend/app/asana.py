"""Asana API integration — server-only.

Port of `src/utils/asana.server.ts`. Uses a Personal Access Token (PAT) bearer
auth against https://app.asana.com/api/1.0/. In-memory caching avoids hammering
Asana's 150 req/min rate limit.
"""

from __future__ import annotations

import logging
import re
from datetime import date

import httpx
from dateutil.relativedelta import relativedelta

from . import config
from .cache import CACHE_TTL_SECONDS, TTLCache
from .models import AsanaEvent, PortfolioEvent

logger = logging.getLogger(__name__)

ASANA_BASE = "https://app.asana.com/api/1.0"

# Each cached value is a list of raw Asana task dicts.
_cache: TTLCache[list[dict]] = TTLCache(CACHE_TTL_SECONDS)

_OPT_FIELDS = ",".join([
    "name", "due_on", "due_at", "completed", "custom_fields",
    "custom_fields.name", "custom_fields.type", "custom_fields.display_value",
    "custom_fields.enum_value", "custom_fields.multi_enum_values",
    "custom_fields.text_value", "custom_fields.number_value",
])


async def _asana_fetch(client: httpx.AsyncClient, path: str) -> dict:
    token = config.ASANA_ACCESS_TOKEN
    if not token:
        raise RuntimeError("ASANA_ACCESS_TOKEN is not configured")

    url = path if path.startswith("http") else f"{ASANA_BASE}{path}"
    res = await client.get(
        url,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    if res.status_code >= 400:
        body = res.text or ""
        raise RuntimeError(f"Asana API {res.status_code}: {body[:300]}")
    return res.json()


async def fetch_project_tasks(
    project_gid: str,
    due_after: str | None = None,
    due_before: str | None = None,
) -> list[dict]:
    """Fetch all tasks in a project with custom fields expanded (paginated)."""
    params: dict[str, str] = {"opt_fields": _OPT_FIELDS, "limit": "100"}
    if due_after:
        params["due_on.after"] = due_after
    if due_before:
        params["due_on.before"] = due_before

    query = httpx.QueryParams(params).render()
    cache_key = f"tasks:{project_gid}:{query}"
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached

    all_tasks: list[dict] = []
    url: str | None = f"/projects/{project_gid}/tasks?{query}"
    async with httpx.AsyncClient(timeout=30) as client:
        while url:
            json = await _asana_fetch(client, url)
            all_tasks.extend(json.get("data") or [])
            next_page = json.get("next_page")
            url = next_page["uri"] if next_page else None

    _cache.set(cache_key, all_tasks)
    return all_tasks


async def discover_fields(project_gid: str, label: str) -> None:
    """Log all custom field names + types on a project. Useful on first deploy to
    figure out what's actually available."""
    try:
        tasks = await fetch_project_tasks(project_gid)
        field_map: dict[str, str] = {}
        for t in tasks:
            for f in t.get("custom_fields") or []:
                field_map.setdefault(f["name"], f.get("type", ""))
        fields = ", ".join(f"{n} ({t})" for n, t in field_map.items()) or "none"
        logger.info("[asana:%s] project %s — %d tasks, fields: %s",
                    label, project_gid, len(tasks), fields)
    except Exception as err:  # noqa: BLE001 — match TS catch-all
        logger.error("[asana:%s] discovery failed: %s", label, err)


def _field_string_value(f: dict) -> str:
    """Extract a string value from a custom field regardless of type."""
    if f.get("display_value"):
        return f["display_value"]
    enum_value = f.get("enum_value")
    if enum_value and enum_value.get("name"):
        return enum_value["name"]
    multi = f.get("multi_enum_values")
    if multi:
        return ", ".join(v["name"] for v in multi)
    if f.get("text_value"):
        return f["text_value"]
    if f.get("number_value") is not None:
        return str(f["number_value"])
    return ""


async def fetch_portco_fields() -> dict[str, dict[str, str]]:
    """Build a name->fields map for portfolio companies (one task per portco)."""
    project_gid = config.ASANA_PORTCO_PROJECT_GID
    if not project_gid:
        return {}

    tasks = await fetch_project_tasks(project_gid)
    result: dict[str, dict[str, str]] = {}
    for t in tasks:
        fields: dict[str, str] = {}
        for f in t.get("custom_fields") or []:
            v = _field_string_value(f)
            if v:
                fields[f["name"]] = v
        result[t["name"].strip().lower()] = fields
    return result


def _fmt(d: date) -> str:
    return d.isoformat()


def _is_portco_field(name: str) -> bool:
    return re.search(r"portco|portfolio|compan", name, re.I) is not None


async def fetch_portfolio_events() -> dict[str, list[PortfolioEvent]]:
    """Fetch events within a rolling 12-month window (today-6mo … today+6mo) and
    explode the multi-select portco field into per-company event entries."""
    project_gid = config.ASANA_EVENTS_PROJECT_GID
    if not project_gid:
        return {}

    today = date.today()
    tasks = await fetch_project_tasks(
        project_gid,
        due_after=_fmt(today - relativedelta(months=6)),
        due_before=_fmt(today + relativedelta(months=6)),
    )

    today_str = _fmt(today)
    by_company: dict[str, list[PortfolioEvent]] = {}

    def is_role_field(name: str) -> bool:
        return re.search(r"host|sponsor|lead|role", name, re.I) is not None

    for task in tasks:
        due_at = task.get("due_at")
        event_date = task.get("due_on") or (due_at.split("T")[0] if due_at else "")
        if not event_date:
            continue

        portcos: list[str] = []
        role: str | None = None

        for f in task.get("custom_fields") or []:
            if _is_portco_field(f["name"]) and f.get("multi_enum_values"):
                portcos = [v["name"] for v in f["multi_enum_values"]]
            elif is_role_field(f["name"]):
                v = _field_string_value(f).lower()
                if "host" in v or "led by us" in v or "we lead" in v:
                    role = "hosted"
                elif "sponsor" in v:
                    role = "sponsored"

        if not portcos:
            continue

        status = "completed" if event_date < today_str else "planned"

        for portco in portcos:
            key = portco.strip().lower()
            entry = PortfolioEvent(
                id=f"asana-{task['gid']}-{key}",
                date=event_date,
                name=task["name"],
                type="conference",
                status=status,
                eventRole=role,
            )
            by_company.setdefault(key, []).append(entry)

    return by_company


def _parse_format(v: str) -> str | None:
    s = v.lower()
    if not s:
        return None
    if "hybrid" in s:
        return "hybrid"
    if any(k in s for k in ("virtual", "online", "remote", "zoom", "webinar")):
        return "virtual"
    if any(k in s for k in ("person", "onsite", "on-site", "in-person")):
        return "in-person"
    return None


async def fetch_all_asana_events() -> list[AsanaEvent]:
    """Fetch ALL events in the Asana Events project within a wide window (12mo
    back, 24mo forward) — used by the /events page and the EventPicker dropdown.
    Returns a flat list, *not* exploded by portco."""
    project_gid = config.ASANA_EVENTS_PROJECT_GID
    if not project_gid:
        return []

    today = date.today()
    tasks = await fetch_project_tasks(
        project_gid,
        due_after=_fmt(today - relativedelta(months=12)),
        due_before=_fmt(today + relativedelta(months=24)),
    )

    today_str = _fmt(today)

    def is_role_field(name: str) -> bool:
        return re.search(r"^role$|hosted|sponsor", name, re.I) is not None

    def is_lead_field(name: str) -> bool:
        return re.search(r"event\s*lead|owner|lead$", name, re.I) is not None

    def is_type_field(name: str) -> bool:
        return re.search(r"^type$|event type", name, re.I) is not None

    def is_format_field(name: str) -> bool:
        return re.search(r"in.?person|virtual|format|location\s*type|delivery", name, re.I) is not None

    def is_industry_field(name: str) -> bool:
        return re.search(r"industry|vertical|sector|domain|theme", name, re.I) is not None

    out: list[AsanaEvent] = []
    for task in tasks:
        due_at = task.get("due_at")
        event_date = task.get("due_on") or (due_at.split("T")[0] if due_at else "")
        if not event_date:
            continue

        portcos: list[str] = []
        role: str | None = None
        ev_type: str = "conference"
        lead: str | None = None
        ev_format: str | None = None
        industry: list[str] = []

        for f in task.get("custom_fields") or []:
            name = f["name"]
            if _is_portco_field(name) and f.get("multi_enum_values"):
                portcos = [v["name"] for v in f["multi_enum_values"]]
            elif is_lead_field(name):
                v = _field_string_value(f)
                if v:
                    lead = v
            elif is_format_field(name):
                parsed = _parse_format(_field_string_value(f))
                if parsed:
                    ev_format = parsed
            elif is_industry_field(name):
                # Industry is a multi-select in Asana — collect all values.
                if f.get("multi_enum_values"):
                    industry = [v["name"] for v in f["multi_enum_values"] if v.get("name")]
                else:
                    v = _field_string_value(f)
                    if v:
                        industry = [s.strip() for s in v.split(",") if s.strip()]
            elif is_role_field(name):
                v = _field_string_value(f).lower()
                if "host" in v or "led by us" in v or "we lead" in v:
                    role = "hosted"
                elif "sponsor" in v:
                    role = "sponsored"
            elif is_type_field(name):
                v = _field_string_value(f).lower()
                if "dinner" in v:
                    ev_type = "dinner"
                elif "webinar" in v:
                    ev_type = "webinar"
                elif "meeting" in v:
                    ev_type = "meeting"
                else:
                    ev_type = "conference"

        if ev_type == "conference" and ev_format == "virtual":
            ev_type = "webinar"

        out.append(AsanaEvent(
            gid=task["gid"],
            name=task["name"],
            date=event_date,
            status="completed" if event_date < today_str else "planned",
            portcos=portcos,
            role=role,
            type=ev_type,
            lead=lead,
            format=ev_format,
            sectors=industry,
        ))

    out.sort(key=lambda e: e.date)
    return out
