"""Radar configuration — freshness windows, source-trust seeds, sheet tabs,
and the compliance blocklist. Tunable knobs live here (or env), never hardcoded
deep in logic (§4, §11 of the spec)."""

from __future__ import annotations

import os

# ── Compliance blocklist (§3.3, §13) ─────────────────────────────────────────
# Hard requirement: the worker must contain NO code path that fetches these.
# Enforced at the HTTP-client layer (radar.http_client) — any attempt fails loud.
BLOCKED_DOMAINS = ("linkedin.com", "crunchbase.com", "pitchbook.com")

# ── HTTP ─────────────────────────────────────────────────────────────────────
# SEC EDGAR requires a descriptive User-Agent with contact info or it 403s.
USER_AGENT = os.environ.get(
    "RADAR_USER_AGENT", "VenturePulse Signal Radar (contact: jadorant@villanova.edu)"
)
HTTP_TIMEOUT = 30.0

# ── Freshness windows by signal type, in days (§7.3) ─────────────────────────
FRESHNESS_DAYS = {
    "funding_ma": 14,
    "crisis_regulatory": 7,
    "executive_movement": 21,
    "product_milestone": 30,
    "thought_leadership": 30,
    "partnership_customer": 30,
    "industry_trend": 30,
}
DEFAULT_FRESHNESS_DAYS = 30

# ── Quality gate (§7.5) ──────────────────────────────────────────────────────
QUALITY_PROMOTE_THRESHOLD = 5.0   # score < 5 → reject_quality
AGGREGATOR_QUALITY_CAP = 5.0      # aggregator-only signals can't exceed this (§7.4)

# ── Source-trust seed table (§7.4) ───────────────────────────────────────────
# domain → 'primary' | 'independent' | 'aggregator'. Unlisted domains are judged
# by the triage LLM (rationale logged) and default to 'aggregator' without LLM.
TRUST_SEEDS = {
    # primary (the company's own claim / verified filing)
    "sec.gov": "primary",
    "businesswire.com": "primary",
    "prnewswire.com": "primary",
    "globenewswire.com": "primary",
    "github.com": "primary",
    # independent (reputable outlets)
    "reuters.com": "independent",
    "bloomberg.com": "independent",
    "wsj.com": "independent",
    "techcrunch.com": "independent",
    "theinformation.com": "independent",
    "forbes.com": "independent",
    "cnbc.com": "independent",
    "venturebeat.com": "independent",
    "axios.com": "independent",
    "fortune.com": "independent",
    "theverge.com": "independent",
    "ft.com": "independent",
}

# ── Persistence: Google Sheet tabs (this build keeps everything in Sheets) ────
TAB_CANDIDATES = "Radar Candidates"
TAB_SIGNALS = "Radar Signals"
TAB_RUNS = "Radar Runs"
TAB_AUDIT = "Radar Audit"

# ── Budget caps (§11) — Stage-2 search not built yet, kept for parity ────────
MAX_LLM_CALLS_PER_RUN = int(os.environ.get("RADAR_MAX_LLM_CALLS", "200"))

# ── LLM ──────────────────────────────────────────────────────────────────────
LLM_MODEL = os.environ.get("RADAR_LLM_MODEL", "claude-sonnet-4-6")
RUBRIC_VERSION = "quality-v1"
