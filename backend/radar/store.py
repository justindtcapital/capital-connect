"""Sheets-backed persistence for the radar (this build keeps everything in Sheets).

Tabs (auto-created on first run):
  Radar Candidates · Radar Signals · Radar Runs · Radar Audit

Cross-run dedup reads back the promoted url/content hashes from Radar Candidates.
When Postgres lands, only this module changes.
"""

from __future__ import annotations

from app.sheets import append_sheet_rows, ensure_tab, fetch_sheet_tab

from .config import TAB_AUDIT, TAB_CANDIDATES, TAB_RUNS, TAB_SIGNALS
from .models import ScanRun, Signal, SignalCandidate, now_iso
from .triage import Decision, Existing

CANDIDATE_HEADERS = [
    "Run ID", "Company", "Source Type", "Source URL", "URL Hash", "Content Hash",
    "Title", "Snippet", "Published At", "Fetched At", "Triage Status", "Detail",
]
SIGNAL_HEADERS = [
    "Run ID", "Company", "Signal Type", "Headline", "Summary", "Source URL",
    "Source Trust", "Published At", "Quality Score", "Quality Rationale",
    "Rubric Version", "Lifecycle", "Created At", "URL Hash",
]
RUN_HEADERS = [
    "Run ID", "Started At", "Finished At", "Candidates Found", "Signals Promoted",
    "Searches Used", "LLM Calls", "Status", "Error Detail",
]
AUDIT_HEADERS = ["Run ID", "Stage", "Event", "Payload", "Created At"]


async def ensure_tabs() -> None:
    await ensure_tab(TAB_CANDIDATES, CANDIDATE_HEADERS)
    await ensure_tab(TAB_SIGNALS, SIGNAL_HEADERS)
    await ensure_tab(TAB_RUNS, RUN_HEADERS)
    await ensure_tab(TAB_AUDIT, AUDIT_HEADERS)


async def load_existing() -> Existing:
    """Promoted hashes from prior runs, for cross-run dedup (§7.1/7.2)."""
    url_hashes: set[str] = set()
    content_hashes: set[str] = set()
    try:
        rows = await fetch_sheet_tab(TAB_CANDIDATES)
    except RuntimeError:
        return Existing(url_hashes, content_hashes)
    if len(rows) < 2:
        return Existing(url_hashes, content_hashes)
    header = [h.strip().lower() for h in rows[0]]
    try:
        i_uh = header.index("url hash")
        i_ch = header.index("content hash")
        i_st = header.index("triage status")
    except ValueError:
        return Existing(url_hashes, content_hashes)
    for r in rows[1:]:
        if len(r) > i_st and r[i_st] == "promoted":
            if len(r) > i_uh:
                url_hashes.add(r[i_uh])
            if len(r) > i_ch:
                content_hashes.add(r[i_ch])
    return Existing(url_hashes, content_hashes)


def _candidate_row(run_id: str, d: Decision) -> list[str]:
    c = d.candidate
    return [
        run_id, c.company_name, c.source_type, c.source_url, c.url_hash, c.content_hash,
        c.raw_title, c.raw_snippet, c.published_at, c.fetched_at, d.status, d.detail,
    ]


def _signal_row(s: Signal) -> list[str]:
    return [
        s.run_id, s.company_name, s.signal_type, s.headline, s.summary, s.source_url,
        s.source_trust, s.published_at, str(s.quality_score), s.quality_rationale,
        s.rubric_version, s.lifecycle, s.created_at, s.candidate_url_hash,
    ]


async def write_decisions(run_id: str, decisions: list[Decision]) -> None:
    if decisions:
        await append_sheet_rows(TAB_CANDIDATES, [_candidate_row(run_id, d) for d in decisions])


async def write_signals(signals: list[Signal]) -> None:
    if signals:
        await append_sheet_rows(TAB_SIGNALS, [_signal_row(s) for s in signals])


async def write_run(run: ScanRun) -> None:
    await append_sheet_rows(TAB_RUNS, [[
        run.id, run.started_at, run.finished_at, str(run.candidates_found),
        str(run.signals_promoted), str(run.searches_used), str(run.llm_calls),
        run.status, run.error_detail,
    ]])


async def write_audit(run_id: str, stage: str, event: str, payload: str = "") -> None:
    try:
        await append_sheet_rows(TAB_AUDIT, [[run_id, stage, event, payload, now_iso()]])
    except Exception:  # noqa: BLE001 — audit must never break a run
        pass
