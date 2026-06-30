# Signal Radar v2 — batch worker (Stage 1 + Stage 3)

A standalone batch worker implementing the **structured ingestion + triage** slice
of the [Signal Radar v2 spec]. *Structured feeds do discovery; the LLM does triage.*

This build keeps persistence in **Google Sheets** (no Postgres yet) and routes LLM
calls through a **Vertex-ready seam** that uses the Anthropic Claude key today.

## What's built (this slice)

- **Stage 1 — INGEST (deterministic):** `sources/` connectors behind a common
  `SignalSource` interface:
  - `gnews_rss` — Google News RSS per company (works for everyone, no key) ← workhorse
  - `edgar` — SEC EDGAR full-text (Form D + 8-K) by name/CIK → funding & material events
  - `github` — latest releases for orgs with a `github_org` enrichment value
  - `ats` — senior/exec postings on Greenhouse/Lever boards (`ats_board_url`)
- **Stage 3 — TRIAGE (LLM seam, with deterministic fallback):**
  URL dedup → content dedup → date gate (type-specific freshness windows) →
  source-trust tiering (aggregator capped at quality 5) → classification + 0–10
  quality score + own-words headline/summary → promote ≥ 5.
- **Compliance guard:** LinkedIn/Crunchbase/PitchBook blocked at the HTTP layer;
  blocked attempts raise and are recorded. CI test in `tests/test_compliance.py`.
- **Persistence:** auto-created Sheet tabs — `Radar Candidates`, `Radar Signals`,
  `Radar Runs`, `Radar Audit`. Cross-run dedup reads promoted hashes back.

## Not built yet (designed for, per spec)

Stage 2 LLM search sweep · Stage 4 attribution + outreach drafts · cohort rotation
(T1/T2/T3) · eval harness/golden set · Postgres. The `SignalSource` interface and
config knobs are in place so these are additive.

## Run

```bash
cd backend
# dry run — ingest + triage, print only, no Sheets writes:
python -m radar.run --dry-run --limit 5 --source gnews_rss
# full run (writes to Sheets), portfolio companies only:
python -m radar.run
# include CRM network companies (T3):
python -m radar.run --network
# compliance test:
python -m radar.tests.test_compliance
```

Flags: `--dry-run`, `--limit N`, `--network`, `--source <type>`.
Env knobs: `RADAR_MAX_LLM_CALLS`, `RADAR_LLM_MODEL`, `RADAR_USER_AGENT`.
Requires the same `.env` as the app (Google Sheets creds + `ANTHROPIC_API_KEY`).
With no Anthropic key the pipeline still runs using deterministic heuristics.

## Match precision (important)

Sources match by **company name**. Short/ambiguous names (acronyms, common words)
will pull unrelated entities — e.g. "AAI" can match an unrelated public ticker.
Two fixes, both supported:
1. Use full company names in the Portfolio "Company Name" column.
2. Populate the optional enrichment columns on the Portfolio tab:
   **`SEC CIK`**, **`RSS Press URL`**, **`GitHub Org`**, **`ATS Board URL`**.
   When present they make EDGAR/GitHub/ATS precise and add company-owned sources.

## Deploying as a Cloud Run Job (later)

The worker is import-clean and restart-safe (dedup keys prevent dupes). To run on
Cloud Run, containerize `backend/`, set the entrypoint to `python -m radar.run`,
schedule via Cloud Scheduler, and move secrets to Secret Manager. Swapping Sheets
→ Postgres is isolated to `store.py`; swapping Claude → Vertex is isolated to
`llm.py`.
