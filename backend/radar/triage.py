"""Stage 3 TRIAGE (§7).

Per-candidate, fail-fast (cheapest checks first):
  1. URL dedup        → rejected_dupe
  2. Content dedup    → rejected_dupe
  3. Date gate        → rejected_no_date / rejected_stale  (type-specific window)
  4. Source trust     → primary | independent | aggregator
  5. Quality score    → rejected_quality (<5) or promote (LLM own-words headline)

LLM (Claude seam) does classification + scoring + own-words headline/summary for
candidates that survive the cheap gates. With no LLM key, a deterministic
heuristic stands in so the pipeline still runs end-to-end.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone

from dateutil import parser as dateparser

from . import llm
from .compliance import host_of
from .config import (
    AGGREGATOR_QUALITY_CAP,
    DEFAULT_FRESHNESS_DAYS,
    FRESHNESS_DAYS,
    MAX_LLM_CALLS_PER_RUN,
    QUALITY_PROMOTE_THRESHOLD,
    RUBRIC_VERSION,
    TRUST_SEEDS,
)
from .models import SIGNAL_TYPES, Signal, SignalCandidate

# ── Heuristic classifier (for the date-gate window + no-LLM fallback) ─────────
_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("funding_ma", re.compile(r"\b(raises?|raised|funding|series [a-h]\b|seed round|acqui|merger|valuation|invests?|backs?|round)\b", re.I)),
    ("crisis_regulatory", re.compile(r"\b(breach|hack|lawsuit|sues?|sued|investigat|regulat|sec charges|layoffs?|data leak|fine[ds]?|probe)\b", re.I)),
    ("executive_movement", re.compile(r"\b(appoints?|names?|hires?|joins? as|steps? down|departs?|new (ceo|cfo|cto|coo)|promot|hiring)\b", re.I)),
    ("product_milestone", re.compile(r"\b(launch|releases?|unveils?|introduc|now available|general availability|\bga\b|certif|version|update)\b", re.I)),
    ("partnership_customer", re.compile(r"\b(partner|collaborat|integrat|selects?|chooses?|customer win|deploys?|teams up|alliance)\b", re.I)),
    ("thought_leadership", re.compile(r"\b(report|keynote|whitepaper|study|research|index|survey|predicts?|forecast)\b", re.I)),
]


def heuristic_classify(text: str) -> str:
    for signal_type, pat in _PATTERNS:
        if pat.search(text or ""):
            return signal_type
    return ""  # no confident type — rejected in no-LLM mode (no "other" bucket §6)


def trust_for(url: str) -> str:
    host = host_of(url)
    for domain, tier in TRUST_SEEDS.items():
        if host == domain or host.endswith("." + domain):
            return tier
    return "aggregator"  # unlisted → aggregator unless LLM upgrades it


def _parse_dt(s: str) -> datetime | None:
    try:
        dt = dateparser.parse(s)
        if dt is None:
            return None
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, OverflowError, TypeError):
        return None


# ── Triage decision bookkeeping ──────────────────────────────────────────────
@dataclass
class Existing:
    """Already-promoted signals, for cross-run dedup."""
    url_hashes: set[str]
    content_hashes: set[str]


@dataclass
class Decision:
    candidate: SignalCandidate
    status: str          # promoted | rejected_dupe | rejected_no_date | rejected_stale | rejected_quality
    detail: str = ""


_TAXONOMY = """Signal types (choose exactly one, or "none" if nothing fits):
- funding_ma: funding round, M&A, secondary
- product_milestone: launch, major release, GA, certification
- executive_movement: C-suite/VP hire or departure
- thought_leadership: notable publication, keynote, major report
- partnership_customer: partnership, major customer win, integration
- crisis_regulatory: breach, lawsuit, regulatory action, layoffs
- industry_trend: sector development materially affecting the company"""

_TRIAGE_SYSTEM = f"""You triage a news/filing candidate about a company for a VC's signal radar.

{_TAXONOMY}

Score QUALITY 0-10 on: materiality (would an investor care?), verifiability (source trust + specificity), and specificity (named amounts/people/facts vs vague). Be strict: minor blog posts score low; funding rounds / launches / exec moves with concrete facts score high.

Write headline and summary in YOUR OWN WORDS — never copy the source verbatim.

Return ONLY JSON:
{{"signal_type":"<one type or none>","quality_score":<0-10>,"quality_rationale":"<one sentence>","headline":"<=120 chars","summary":"<2-3 sentences>","source_trust":"primary|independent|aggregator"}}"""


async def _llm_triage(c: SignalCandidate, seed_trust: str) -> dict | None:
    user = (
        f"Company: {c.company_name}\n"
        f"Source type: {c.source_type}\n"
        f"Source host: {host_of(c.source_url)} (seed trust: {seed_trust})\n"
        f"Published: {c.published_at}\n"
        f"Title: {c.raw_title}\n"
        f"Snippet: {c.raw_snippet}"
    )
    data = await llm.complete_json(_TRIAGE_SYSTEM, user, max_tokens=600)
    if not data:
        return None
    st = str(data.get("signal_type") or "").strip()
    if st not in SIGNAL_TYPES:
        return None  # "none" / invalid → not a promotable signal
    try:
        score = float(data.get("quality_score"))
    except (TypeError, ValueError):
        return None
    trust = str(data.get("source_trust") or seed_trust)
    if trust not in ("primary", "independent", "aggregator"):
        trust = seed_trust
    return {
        "signal_type": st,
        "quality_score": max(0.0, min(10.0, score)),
        "quality_rationale": str(data.get("quality_rationale") or ""),
        "headline": (str(data.get("headline") or c.raw_title))[:120],
        "summary": str(data.get("summary") or c.raw_snippet),
        "source_trust": trust,
    }


def _heuristic_triage(c: SignalCandidate, signal_type: str, seed_trust: str) -> dict | None:
    if signal_type not in SIGNAL_TYPES:
        return None
    # Coarse materiality by type; primary/independent sources score a touch higher.
    base = {"funding_ma": 7, "crisis_regulatory": 7, "executive_movement": 6,
            "product_milestone": 6, "partnership_customer": 6,
            "thought_leadership": 5, "industry_trend": 5}.get(signal_type, 5)
    if seed_trust == "primary":
        base += 1
    elif seed_trust == "aggregator":
        base -= 1
    score = float(max(0, min(10, base)))
    return {
        "signal_type": signal_type,
        "quality_score": score,
        "quality_rationale": f"Heuristic score for {signal_type} from a {seed_trust} source.",
        "headline": (c.raw_title or "")[:120],
        "summary": c.raw_snippet or c.raw_title,
        "source_trust": seed_trust,
    }


async def triage_candidates(
    candidates: list[SignalCandidate],
    existing: Existing,
    run_id: str,
) -> tuple[list[Decision], list[Signal], int]:
    """Return (decisions, promoted signals, llm_calls_used)."""
    decisions: list[Decision] = []
    signals: list[Signal] = []
    seen_url: set[str] = set()
    seen_content: set[str] = set()
    llm_calls = 0
    now = datetime.now(timezone.utc)

    for c in candidates:
        uh, ch = c.url_hash, c.content_hash

        # 1 + 2 — dedup (cross-run + within-run)
        if uh in existing.url_hashes or uh in seen_url:
            decisions.append(Decision(c, "rejected_dupe", "url")); continue
        if ch in existing.content_hashes or ch in seen_content:
            decisions.append(Decision(c, "rejected_dupe", "content")); continue

        # 3 — date gate
        dt = _parse_dt(c.published_at)
        if dt is None:
            decisions.append(Decision(c, "rejected_no_date")); continue
        provisional_type = heuristic_classify(f"{c.raw_title} {c.raw_snippet}")
        window = FRESHNESS_DAYS.get(provisional_type, DEFAULT_FRESHNESS_DAYS)
        age_days = (now - dt).days
        if age_days > window:
            decisions.append(Decision(c, "rejected_stale", f"{age_days}d > {window}d")); continue

        # 4 — source trust (seed; LLM may upgrade unlisted domains)
        seed_trust = trust_for(c.source_url)

        # 5 — classify + quality (LLM if budget remains, else heuristic)
        verdict = None
        if llm.available() and llm_calls < MAX_LLM_CALLS_PER_RUN:
            verdict = await _llm_triage(c, seed_trust)
            llm_calls += 1
        if verdict is None:
            verdict = _heuristic_triage(c, provisional_type, seed_trust)
        if verdict is None:
            decisions.append(Decision(c, "rejected_quality", "no_type")); continue

        score = verdict["quality_score"]
        trust = verdict["source_trust"]
        if trust == "aggregator":
            score = min(score, AGGREGATOR_QUALITY_CAP)  # §7.4 cap
        if score < QUALITY_PROMOTE_THRESHOLD:
            decisions.append(Decision(c, "rejected_quality", f"score {score}")); continue

        seen_url.add(uh); seen_content.add(ch)
        c.triage_status = "promoted"
        decisions.append(Decision(c, "promoted"))
        signals.append(Signal(
            company_name=c.company_name,
            candidate_url_hash=uh,
            signal_type=verdict["signal_type"],
            headline=verdict["headline"],
            summary=verdict["summary"],
            source_url=c.source_url,
            source_trust=trust,
            published_at=c.published_at,
            quality_score=round(score, 1),
            quality_rationale=verdict["quality_rationale"],
            rubric_version=RUBRIC_VERSION,
            run_id=run_id,
        ))

    return decisions, signals, llm_calls
