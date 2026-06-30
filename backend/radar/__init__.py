"""VenturePulse Signal Radar v2 — batch worker.

A standalone batch worker (Stage 1 INGEST + Stage 3 TRIAGE of the v2 spec).
Structured feeds do discovery; the LLM does triage. Persists to Google Sheets
(no Postgres in this build). LLM calls go through a Vertex-ready seam (radar.llm).

Not in this slice (designed for, not built): Stage 2 LLM search sweep, Stage 4
attribution, cohort rotation, eval harness — see the v2 spec.
"""
