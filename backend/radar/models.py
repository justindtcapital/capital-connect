"""Radar data models (dataclasses) + hashing helpers.

These mirror the v2 spec's Postgres tables (§5) but are persisted to Google
Sheets in this build, so there are no FKs — rows are keyed by company name +
url_hash. Field names track the spec for continuity if/when Postgres lands.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

# Signal taxonomy (§6) — "Personal Milestone" intentionally dropped.
SIGNAL_TYPES = (
    "funding_ma",
    "product_milestone",
    "executive_movement",
    "thought_leadership",
    "partnership_customer",
    "crisis_regulatory",
    "industry_trend",
)


def url_hash(url: str) -> str:
    """md5 of the lowercased URL (matches the spec's generated column)."""
    return hashlib.md5((url or "").strip().lower().encode("utf-8")).hexdigest()


def content_hash(title: str, snippet: str) -> str:
    """md5 of normalized title+snippet for cross-URL dedup of the same event."""
    norm = re.sub(r"\s+", " ", f"{title or ''} {snippet or ''}".strip().lower())
    return hashlib.md5(norm.encode("utf-8")).hexdigest()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class Company:
    """A tracked entity. Loaded from Sheets (portfolio + network companies)."""
    name: str
    website: str = ""
    domain: str = ""          # focus area / sector label
    location: str = ""
    tier: str = "T3"          # T1 | T2 | T3 (rotation is future work)
    # Enrichment columns (§3.1) — populated once, cached. Empty until enriched.
    sec_cik: str = ""
    rss_press_url: str = ""
    github_org: str = ""
    ats_board_url: str = ""

    @property
    def host(self) -> str:
        raw = (self.website or "").strip()
        if not raw:
            return ""
        raw = re.sub(r"^https?://", "", raw, flags=re.I).split("/")[0]
        return raw.lower().removeprefix("www.")


@dataclass
class SignalCandidate:
    """Raw candidate from any source, pre-triage (§5 signal_candidates)."""
    company_name: str
    source_type: str          # 'edgar' | 'gnews_rss' | 'press_rss' | 'github' | 'ats' | 'llm_search'
    source_url: str
    raw_title: str = ""
    raw_snippet: str = ""
    published_at: str = ""    # ISO; may be empty pre-triage
    fetched_at: str = field(default_factory=now_iso)
    run_id: str = ""
    triage_status: str = "pending"

    @property
    def url_hash(self) -> str:
        return url_hash(self.source_url)

    @property
    def content_hash(self) -> str:
        return content_hash(self.raw_title, self.raw_snippet)


@dataclass
class Signal:
    """Promoted, deduplicated, classified signal (§5 signals)."""
    company_name: str
    candidate_url_hash: str
    signal_type: str
    headline: str
    summary: str
    source_url: str
    source_trust: str         # 'primary' | 'independent' | 'aggregator'
    published_at: str
    quality_score: float
    quality_rationale: str
    rubric_version: str
    run_id: str
    lifecycle: str = "new"
    created_at: str = field(default_factory=now_iso)


@dataclass
class ScanRun:
    """One worker execution (§5 scan_runs)."""
    id: str
    started_at: str = field(default_factory=now_iso)
    finished_at: str = ""
    candidates_found: int = 0
    signals_promoted: int = 0
    searches_used: int = 0
    llm_calls: int = 0
    status: str = "running"   # running | success | partial | failed
    error_detail: str = ""
