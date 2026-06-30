"""FastAPI app exposing the DTC CRM backend.

Each route is a port of a TanStack `createServerFn` handler from
`src/utils/*.functions.ts`. GET routes that read external data degrade
gracefully (returning empty data) exactly like the originals, so a missing
integration never crashes the app.
"""

from __future__ import annotations

import logging
from datetime import date

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import asana, config, sheets
from .apollo import enrich_person
from .models import (
    AddContactInput,
    AddEventInput,
    AddNoteInput,
    AddPortcoIntroInput,
    AddTargetInput,
    ApolloEnrichmentResult,
    AsanaEvent,
    AsanaPortcoData,
    Contact,
    EnrichContactInput,
    PortfolioCompany,
    ResolveFollowUpInput,
    TargetLead,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="DTC CRM API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _today() -> str:
    return date.today().isoformat()


# ── Google Sheets: reads (sheets.functions.ts) ───────────────────────────────
# Note: the TS versions fall back to bundled `sample-data` on error. Here we
# follow the `.env.example` contract — "returns no data instead of crashing" —
# and return an empty list. Swap in fixtures if you want sample data instead.


@app.get("/api/contacts", response_model=list[Contact])
async def get_contacts() -> list[Contact]:
    try:
        return await sheets.build_contacts()
    except Exception as error:  # noqa: BLE001
        logger.error("Failed to fetch contacts from Google Sheets: %s", error)
        return []


@app.get("/api/targets", response_model=list[TargetLead])
async def get_targets() -> list[TargetLead]:
    try:
        return await sheets.build_targets()
    except Exception as error:  # noqa: BLE001
        logger.error("Failed to fetch targets from Google Sheets: %s", error)
        return []


@app.get("/api/portfolio-companies", response_model=list[PortfolioCompany])
async def get_portfolio_companies() -> list[PortfolioCompany]:
    try:
        return await sheets.build_portfolio_companies()
    except Exception as error:  # noqa: BLE001
        logger.error("Failed to fetch portfolio companies from Google Sheets: %s", error)
        return []


# ── Google Sheets: write-backs (sheets.functions.ts) ─────────────────────────


@app.post("/api/notes")
async def add_note(data: AddNoteInput) -> dict:
    await sheets.append_sheet_row(sheets.TAB_NAMES["interactions"], [
        data.contact_email,
        _today(),
        data.note_content,
        "TRUE" if data.requires_follow_up else "FALSE",
        "FALSE",
    ])
    return {"success": True}


@app.post("/api/events")
async def add_event(data: AddEventInput) -> dict:
    await sheets.append_sheet_row(sheets.TAB_NAMES["events"], [
        data.contact_email,
        data.event_name,
        _today(),
        data.type,
    ])
    return {"success": True}


@app.post("/api/portco-intros")
async def add_portco_intro(data: AddPortcoIntroInput) -> dict:
    await sheets.append_sheet_row(sheets.TAB_NAMES["portcoIntros"], [
        data.contact_email,
        data.portco_name,
        _today(),
    ])
    return {"success": True}


@app.post("/api/contacts")
async def add_contact(data: AddContactInput) -> dict:
    await sheets.append_sheet_row(sheets.TAB_NAMES["contacts"], [
        data.name,
        data.role,
        data.company,
        data.email,
        data.phone,
        data.location,
        data.prime,
        data.sector,
        data.temperature,
        "FALSE",
        _today(),
    ])
    return {"success": True}


@app.post("/api/targets")
async def add_target(data: AddTargetInput) -> dict:
    await sheets.append_sheet_row(sheets.TAB_NAMES["targets"], [
        data.first_name,
        data.last_name,
        data.company,
        data.role,
        data.linkedin,
        data.email,
        data.location,
        data.sector,
        data.stage,
        data.source,
        data.research_purpose,
        _today(),
        "",
    ])
    return {"success": True}


@app.post("/api/resolve-follow-up")
async def resolve_follow_up(data: ResolveFollowUpInput) -> dict:
    rows = await sheets.fetch_sheet_tab(sheets.TAB_NAMES["interactions"])
    if len(rows) < 2:
        return {"success": False}

    headers = [h.strip().lower() for h in rows[0]]
    try:
        email_idx = headers.index("contact email")
        note_idx = headers.index("note content")
        resolved_idx = headers.index("follow up resolved")
    except ValueError as exc:
        raise RuntimeError("Could not find required columns in Notes tab") from exc

    # Find matching row (skip header, so data row 1 = sheet row 2)
    email_lower = data.contact_email.lower()
    for i in range(1, len(rows)):
        row = rows[i]
        row_email = (row[email_idx] if email_idx < len(row) else "").strip().lower()
        row_note = (row[note_idx] if note_idx < len(row) else "").strip()
        if row_email == email_lower and row_note == data.note_content.strip():
            col_letter = chr(65 + resolved_idx)  # A=0, B=1, ...
            cell_range = f"{col_letter}{i + 1}"
            await sheets.update_sheet_cell(
                sheets.TAB_NAMES["interactions"],
                cell_range,
                "TRUE" if data.resolved else "FALSE",
            )
            return {"success": True}
    return {"success": False}


# ── Asana (asana.functions.ts) ───────────────────────────────────────────────

_did_discover = False


@app.get("/api/asana/portco-data", response_model=AsanaPortcoData)
async def fetch_asana_portco_data() -> AsanaPortcoData:
    global _did_discover
    try:
        # One-time field discovery logged to server output.
        if not _did_discover:
            _did_discover = True
            if config.ASANA_PORTCO_PROJECT_GID:
                await asana.discover_fields(config.ASANA_PORTCO_PROJECT_GID, "portco")
            if config.ASANA_EVENTS_PROJECT_GID:
                await asana.discover_fields(config.ASANA_EVENTS_PROJECT_GID, "events")

        fields_map = await asana.fetch_portco_fields()
        events_map = await asana.fetch_portfolio_events()

        return AsanaPortcoData(
            fieldsByCompanyName=fields_map,
            eventsByCompanyName=events_map,
        )
    except Exception as err:  # noqa: BLE001
        logger.error("[asana] fetchAsanaPortcoData failed: %s", err)
        return AsanaPortcoData(fieldsByCompanyName={}, eventsByCompanyName={})


@app.get("/api/asana/events", response_model=list[AsanaEvent])
async def fetch_asana_events() -> list[AsanaEvent]:
    try:
        return await asana.fetch_all_asana_events()
    except Exception as err:  # noqa: BLE001
        logger.error("[asana] fetchAsanaEvents failed: %s", err)
        return []


# ── Apollo (apollo.functions.ts) ─────────────────────────────────────────────


@app.post("/api/apollo/enrich", response_model=ApolloEnrichmentResult)
async def enrich_contact(data: EnrichContactInput) -> ApolloEnrichmentResult:
    return await enrich_person(
        email=data.email,
        first_name=data.first_name,
        last_name=data.last_name,
        organization_name=data.company,
        linkedin_url=data.linkedin_url,
    )


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}
