# Signals weekly report — 2026-08-12

Window: last **7** days · generated 2026-08-12T14:21:58.476Z

## Scorecard

| Metric | Value | 90+ target |
|---|---|---|
| Precision@10 (useful in ranked top-10 feedback) | n/a (no labels yet) | ≥ 80% |
| Duplicate rate (duplicate + already_knew) | n/a (no labels yet) | ≤ 3% |
| Partner verdicts collected | 0 | compounding |
| Time-advantage median (days) | n/a (n=0) | > 3 |
| Cap overflow rows | 0 | tune recall |
| Pipeline success (Ops Log signal/intel) | 76.9% (20 ok / 6 err / 26 total) | ≥ 99% |

## Verdicts

_No partner verdicts in window._

Interaction events (rendered/expanded/…): **392**

## By source host

_No sourceHost snapshots yet — expand cards and leave verdicts._

## Time advantage (intel → press)

- n = 0
- median = n/ad · p25 = n/ad · p75 = n/ad · mean = n/ad
_No CONFIRMED_BY_PRESS ledger rows yet._

## Scan overflow (capped candidates)

- Total discarded rows: **0**
_No overflow this window (caps not hit or ledger empty)._

## Ops notes

Pipeline skim is from the Sheets **Ops Log** (sources matching signal/intel). Inngest run history is not wired here — treat as N/A until cron dashboards land.

---

_Phase 0 measurement foundation. Re-run Mondays: `npx tsx scripts/weekly-report.ts`._
