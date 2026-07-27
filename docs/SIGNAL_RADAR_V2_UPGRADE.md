# Signal Radar v2.1 — High-Precision Company Intelligence Engine

**Status:** Implemented (first slice) + phased plan · **Companion:** `SIGNAL_RADAR_V2_DESIGN.md` (strategy) — this doc is the engineering upgrade spec and the record of what shipped.
**Constraint honored:** Google Sheets is the database. All schemas below are tabs; schema v2 appends columns so v1 rows stay valid.

---

## Part 1 — Repository findings (how it actually works)

- **Collectors** (`src/utils/intel-collectors.server.ts`): pure fetchers, zero app imports, 12s timeouts. ATS (Greenhouse/Lever/Ashby public JSON, slug discovery), GitHub (org resolution by blog-domain match), crt.sh CT logs (1 retry). Verified live: `greenhouse:stripe` → 523 roles; `vercel` org; crt.sh intermittently 502s (by design best-effort).
- **Core** (`src/utils/intel.server.ts`): tabs `Intel Entities` (registry, seeded from Portfolio Companies + Competitive Radar + unique Targets companies; PortCo/watch win name ties; Targets domains inferred from non-personal email hosts when present), `Intel Metric Log` (delta-only ledger), `Intel Series` (JSON-cell history + MAD z + OLS slope). Writes serialized through one promise queue (pattern from `llm-log.server.ts`). Additive re-seed runs at the start of every sweep so new Targets enter without a manual click.
- **Signal emission** (`src/utils/signal-store.server.ts` contract): positional `SIGNAL_HEADERS` rows; content-keyed IDs (`keyForStored`); feed reads via `fetchStoredSignals` → `signal-feed.ts` cards; grounded scoring overlay in `signal-strength.ts`.
- **Scheduling**: Inngest `daily-intel-sweep` 5:30 ET + `/api/cron/intel-scan` (CRON_SECRET), before the 6:00 news scan (`gemini.functions.ts / executeSignalScan`).
- **Failure points found**: single global anomaly rule (z≥2 ∧ 25%) with no per-metric policy; no distinction between observation/change/event/inference; per-metric signals with no fusion (three ATS metrics could triple-fire one fact); throttle by string-matching signal text (brittle); no collector-health telemetry (a dead board is indistinguishable from a hiring freeze — the classic false "contraction" hazard); no zero-drop protection; no feedback capture; ledger rows lacked deltas/idempotency keys.

## Part 2 — Critical weaknesses (ranked)

1. **Collector failure could masquerade as company change** (severity: investor-facing false negatives *and* false zeroes). Fixed: explicit `CollectorStatus` (`ok | no_source | error | ambiguous`); errors → health telemetry only; drop-to-zero requires a second consecutive observation.
2. **No fusion → correlated metrics double-count** (false confidence). Fixed: family-based fusion; same-family metrics can never corroborate each other.
3. **Global thresholds** (1→2 fires at +100%; 80→105 never fires). Fixed: per-metric policies with `minAbsDelta`, `minRelDelta`, `bigAbsOverride`, per-metric z and cooldowns.
4. **No event lifecycle** (same development re-fires as new cards). Fixed: `Intel Events` tab with fingerprint upserts, emerging→strengthening statuses, in-place signal refresh.
5. **No regulatory evidence** (quiet rounds invisible). Fixed: EDGAR Form D collector with strict issuer resolution.
6. **No feedback labels**. Fixed: `Signal Verdicts` tab + feed buttons.
7. Remaining (accepted for now): no website/sitemap collectors; no peer cohorts; heuristic confidence weights; entity resolution still name/domain-based without a formal review queue UI (EDGAR ambiguity lands on the entity Note field).

## Part 3 — Target architecture (boundaries)

```
Collection (pure fetchers, CollectorStatus, versions)      intel-collectors.server.ts
  → Validation & change evaluation (policies, guards)      intel-detect.server.ts  [no-LLM zone]
  → Persistence (delta ledger, series, serialized writes)  intel.server.ts
  → Fusion (families → EventCandidates)                    intel-detect.server.ts
  → Event lifecycle (fingerprint upsert, statuses)         intel.server.ts + Intel Events tab
  → Presentation (Observed vs. Interpretation, labeled)    Signals tab → signal-feed.ts cards
  → Feedback (verdict buttons → Signal Verdicts tab)       signals.tsx + intel.functions.ts
Health telemetry runs alongside every stage → Intel Collector Health tab + Ops Log alerts.
```

Layer contract (§D of the brief): **Observation** (collector value) → **Change** (validated diff; ledger row) → **Event** (fused, lifecycled) → **Inference** (labeled interpretation text inside the card body — never presented as fact).

## Part 4 — Data model (as shipped)

- `Intel Metric Log` (v2 appends): `Date, Entity URID, Entity, Metric, Prev, New, Source, Grade, Ref, Abs Delta, Pct Delta, Status(recorded|unconfirmed|confirmed), Key(idempotency)`.
- `Intel Series` (v2 appends): `…, State JSON` — `{pendingZero?, lastFired?}` detector state.
- `Intel Events` (new): `Event ID, Entity URID, Entity, State, Status, First Detected, Last Updated, Confidence, Families, Evidence JSON(≤12 items: date/metric/prev/next/z/reason/url/grade), Signal ID, Schema`.
- `Intel Collector Health` (new): per collector per sweep: `Date, Collector, Version, Attempts, OK, No Source, Ambiguous, Errors, Error Rate, Notes`.
- `Signal Verdicts` (new): `Date, Signal ID, Company, Verdict, User, Note`.
- Migration: `ensureHeaderRow` extends v1 headers in place; readers tolerate short rows; `INTEL_SCHEMA_VERSION = 2` stamped on events.

## Part 5 — Detection methodology (per metric type)

Registry: `METRIC_POLICIES` in `intel-detect.server.ts`. Kinds: `count` (roles, repos, subdomains — robust z on MAD sigma + material-move + minAbs guard + bigAbs override), `windowed` (certs-90d, active-repos-90d — stricter z=2.5–3, higher minAbs, longer cooldowns because renewal cycles wobble), `filing` (Form D — any increase fires; z-scores meaningless for point-in-time filings). Edge behavior, all fixture-tested (`scripts/intel-detect.test.ts`, 23 assertions): small denominators can't fire; <minHistory never fires; flat series → z 0; one outlier can't contaminate MAD baseline; per-metric cooldowns; drop-to-zero → `hold_unconfirmed` → next sweep either `confirmed` or `discard_blip`.

## Part 6 — Multi-signal fusion (no double-counting)

Every metric maps to one evidence **family** (hiring / engineering / infrastructure / funding). Fusion (`fuseChanges`) takes an entity's in-window anomalies and applies priority-ordered state rules; composites (e.g. **Expansion preparation** = hiring↑ + infrastructure↑) consume their constituent anomalies so a composite suppresses its single-family sub-events. Confidence = 0.45 + 0.35·strength(max |z|) + 0.15·(families−1), capped 0.95 — *only additional independent families* raise it; three ATS metrics = one family = no boost. Contradiction/weakening: events carry statuses; stale events (45d) get superseded rather than updated.

## Part 7 — Source roadmap (next collectors, ranked)

**Shipped in v2.2 (same iteration):**
- **Sitemap/website intelligence** (`collectSiteSignals`): robots.txt-declared sitemaps (fallback to conventional paths), sitemap-index aggregation (≤3 children, ≤5000 URLs), URL-path classification into page-class flags — `site_has_pricing / enterprise / security / customers / partners / docs / changelog` + `site_sitemap_urls` count. New `flag` metric kind (appearance 0→1 fires; disappearance only records — sitemaps flap), new `commercial` evidence family, and two new fused states: **Enterprise go-to-market expansion** (hiring↑ + commercial↑, priority above Expansion preparation) and **Commercial maturation**. Verified live on vercel.com (all 8 flags with example paths).
- **ATS coverage expansion**: SmartRecruiters, Recruitee, Workable probes added (6 providers total). **Trap found in live testing and fixed:** SmartRecruiters answers 200 + empty list for ANY slug — an empty board during *discovery* is now never a match (keeps probing), while a *known* board reporting 0 remains a real hiring-freeze observation.
- **Discovery negative-cache**: failed ATS/GitHub discovery is remembered on the entity (`ats_checked`/`gh_checked`, 30-day TTL) so undiscoverable entities stop re-spending probe requests daily.

**Shipped in v2.3 (same iteration):**
- **Peer benchmarking** (`peerPercentile` in intel-detect, applied in the sweep): every fired anomaly gains cohort context — "more extreme than N% of M monitored companies with <metric> data." Cohort = all monitored entities with sufficient history on the SAME metric, compared on relative deviation from each company's own baseline (stage-size fair). Null below n=8 — no fabricated precision.
- **Changelog release-velocity collector** (`collectChangelogFeed`): changelog-scoped RSS/Atom feeds ONLY (generic blog feeds rejected — posts ≠ releases), entry-date parsing → `changelog_releases_90d` (windowed, engineering family). Feed URL cached in xref; 30-day negative cache. Live: vercel.com → 155 releases/90d.
- **CT redundancy**: crt.sh retry now fails over to certspotter issuances API — live-verified fixing a domain that 502'd on crt.sh the same day.

**Next, ranked:**
1. ~~**USPTO trademarks**~~: **shipped** — `collectUsptoTrademarks` (strict owner match, `uspto_trademark_filings` filing metric, `ip` evidence family → "Product launch preparation"). Requires free `USPTO_API_KEY` in `.env` ([TSDR key manager](https://account.uspto.gov/api-manager/) and/or [ODP getting started](https://data.uspto.gov/apis/getting-started)); without the key the collector returns `no_source` and never invents filings.
2. **Careers-page HTML fallback** for companies on Workday/custom boards: biggest remaining hiring-coverage gap; parser-maintenance heavy.
3. **Website page-feature extraction** (pricing tiers, customer logos): highest event value, needs canonicalized content hashing.
4. **Package registries (npm/PyPI)**: dev-tool entities only.
5. Licensed people-movement data: policy decision, not engineering.

## Part 8 — Implementation plan (phases; 0–1 SHIPPED)

- **Phase 0–1 (this iteration, done)**: collector status + versions; detect/fusion module; policies; events lifecycle; health; Form D; verdicts; fixtures. Rollback: `INTEL_CRON_ENABLED=false`; v1 rows remain readable.
- **Phase 2**: careers fallback + sitemap + changelog collectors; entity resolution review queue surface (Resolution tab + /platform panel); collector fixtures from captured payloads.
- **Phase 3**: peer cohorts (stage × sector from CRM data; percentile context with cohort-size honesty); confidence decomposition into the 8 ranking components; relationship joins (warm paths on cards).
- **Phase 4**: verdict-driven threshold tuning dashboards; replay harness over the Metric Log archives; briefing sections (verified vs. emerging vs. inferred).

## Part 9 — Tests & evaluation

- Unit fixtures (shipped): `scripts/intel-detect.test.ts` — run `npx tsx scripts/intel-detect.test.ts`.
- Live smokes (run during build): ATS/GitHub real endpoints; EDGAR strict-match (Databricks → CIK 1587468, 15 filings, 8 SPVs excluded; Anduril → ambiguous, correctly no signal).
- Evaluation metrics to start tracking (from Verdicts + Ops Log): useful-rate of top-5 daily, already-knew rate, invalidated-event rate, per-collector success rate, median lead time vs. first news mention (join Momentum events to later news signals for the same company).

## Part 11 — Remaining risks / unvalidated

- **Confidence weights are heuristic** (0.45/0.35/0.15) — honest placeholders until verdict data exists; displayed as percentages but always alongside the evidence list.
- **Event→signal in-place rewrite** depends on Signals-tab row stability; concurrent manual row deletion during a sweep could mis-target a rewrite (mitigated: ID lookup at write time inside the serialized queue; falls back to append).
- **EDGAR strict matching will miss issuers whose legal name differs from their brand** (false negatives by design); the ambiguous-note flow needs a nicer review surface than the entity Note cell.
- **crt.sh flakiness** caps infrastructure-family coverage; a second CT source (e.g. certspotter API) is a cheap redundancy add.
- **No live multi-sweep validation yet** of the zero-drop confirm path or event strengthening (needs days of real history; fixtures cover the logic).
- Role-bucket regexes (eng/GTM) are crude; misclassification shifts composition metrics but not totals.
