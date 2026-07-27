# Signal Radar v2 — From News Monitoring to Institutional Intelligence Collection

**Status:** Design proposal · **Audience:** senior/staff engineering · **Scope:** the entire signal discovery engine (not UI)
**Author's frame:** intelligence-cycle architecture applied to venture relationship intelligence, grounded in the current VenturePulse codebase.
**Hard constraint:** **Google Sheets is the database.** No Postgres, no ClickHouse, no vector store. All storage designs below are expressed as Sheets tabs/workbooks, and every scale claim is sized to what Sheets can actually hold. Where a capability genuinely cannot exist under this constraint, the doc says so explicitly rather than pretending.

---

## 1. Executive Summary

Signal Radar today is a well-disciplined **news summarizer**: it fetches recent articles about companies the firm already knows, asks Gemini to attribute them to people in the network, and stores the output with evidence-grounded scores. Its philosophy is right — *AI creates hypotheses, evidence creates truth* — but its architecture caps it at "yesterday's headlines, nicely attributed."

The redesign reframes the system as an **intelligence cycle**, the loop used by every serious collection organization:

> **Tasking → Collection → Processing → Exploitation → Analysis → Dissemination → Feedback → (back to Tasking)**

Six architectural shifts follow from that frame:

1. **The atomic unit becomes the Observation, not the article.** An append-only, entity-resolved observation ledger records every *state change* the system sees (a job posting appeared, a TLS cert was issued, commit velocity changed, a Form D was filed). Articles become just one observation type among ~30. In Sheets form this is a **sparse delta log** — one row per detected change, not per probe — which is what makes a ledger fit inside a spreadsheet.
2. **Collection becomes sensor-driven, not search-driven.** Most pre-news exhaust is structured and cheap: ATS career pages, GitHub, certificate-transparency logs, EDGAR Form Ds, USPTO filings, changelogs, app stores, DNS. News APIs become the *lagging confirmation* channel, not the primary channel.
3. **Time becomes a first-class dimension.** Per-entity metric time series with baselines, changepoint detection, and momentum turn "an article was published today" into "this company has been quietly accelerating for six months."
4. **Fusion replaces single-source signals.** Independent evidence combines through source-graded, correlation-aware log-odds pooling into confidence-tiered signals. One article alone is a C-grade signal; article + hiring surge + CT-log cert + conference talk is an A-grade signal.
5. **Opportunities replace events.** A dedicated engine intersects signals with the relationship graph, firm theses, and timing windows to emit *actions with owners and expiry* — not headlines.
6. **The loop closes.** Outcomes (acted / ignored / replied / meeting / deal) already partially captured by the CRM feed a learning loop that re-weights ranking and re-allocates collection budget.

The current philosophy survives intact and gets *stronger*: LLMs move to the edges (extraction, summarization, clustering) and are structurally excluded from asserting facts or probabilities. Every number traces to observations you can click.

---

## 2. Critical Flaws in the Current Design

Ordered by how much they constrain the ceiling of the system.

**F1 — Article-centric ontology.** The pipeline's atomic unit is a published article. Anything that never becomes an article (99% of company exhaust) is invisible. Publication is the *last* step of most corporate events; the system is blind during the entire window where knowing early has value.

**F2 — No durable observation record.** Only Gemini's *outputs* are stored (Signals tab rows). The raw inputs — articles fetched, links seen, documents read — are discarded except as dedup URLs. Consequences: no baselines, no derivatives, no reprocessing when extraction improves, no backtesting for prediction models. The system has opinions but no memory of what it observed.

**F3 — Stateless snapshots, no temporal model.** Each scan is an independent batch. `dateFound` is the only timestamp, and it records when *we* found it, not when the event happened. There is no concept of history, momentum, trajectory, or decay beyond a client-side freshness label.

**F4 — Entity identity is a string.** Companies are matched by name (`portcoNames.has(name.toLowerCase())`); people by email. "Snowflake" the company vs. the noun, "Meta" vs. Meta Platforms, renamed companies, subsidiaries — all silently mis-resolve. A knowledge graph cannot be built on string equality.

**F5 — One LLM call conflates four intelligence functions.** Collection (what to read), processing (what does it say), analysis (what does it mean), and production (write the outreach draft) happen in a single Gemini pass. This makes every stage unauditable, unimprovable in isolation, and expensive — the model re-derives world state on every scan.

**F6 — Deduplication by URL/content-key, not by real-world event.** Fifty syndicated copies of one funding story are fifty dedup checks, but two *different* articles about the same round are two signals. The unit that should be deduplicated is the underlying event (story cluster), not the document.

**F7 — Uniform collection budget.** A Hot portfolio company and a cold prospect get the same treatment on the same cron. There is no tasking function converting "what we most need to know" into "what we collect next," and no burst mode when something happens.

**F8 — Signals are terminal.** A stored signal never changes state. It can't be confirmed by later evidence, contradicted, escalated, decayed, or linked to what the firm did about it. `status` exists in the schema but nothing drives a lifecycle.

**F9 — No feedback loop.** Partner behavior (dismissed instantly, drafted outreach, got a reply, booked a meeting) is either unrecorded or recorded (Target Outreach, Email Activity, Events) but never fed back into ranking or collection.

**F10 — Undisciplined use of the storage ceiling.** Sheets is the database (a fixed constraint), but the current schema spends its budget badly: signals are stored as verbose write-once rows with full outreach bodies inline, nothing is ever compacted or aggregated, and every consumer re-reads whole tabs. A spreadsheet holds 10M cells and stays fast under ~50k rows per tab — that is *plenty* for an intelligence system **if and only if** the schema stores state changes and aggregates rather than raw exhaust, rotates detail into archive workbooks, and treats cells as a budget. Today nothing enforces that discipline.

**F11 — Attribution pool is capped and pre-filtered.** `maxPeople=150` sorted by temperature means the system literally cannot notice signals about the cold majority of the network — precisely the people whose status changes are most informative.

---

## 3. New System Architecture

### 3.1 The intelligence cycle

```
                    ┌─────────────────────────────────────────────┐
                    │                  TASKING                    │
                    │  collection priorities · budgets · bursts   │
                    └──────┬──────────────────────────────▲───────┘
                           ▼                              │
┌──────────────────────────────────────┐         ┌────────┴─────────┐
│             COLLECTION               │         │     FEEDBACK     │
│ 30+ collectors (sensors), scheduled  │         │ outcomes, partner│
│ by tasking, emitting raw payloads    │         │ actions, model   │
└──────┬───────────────────────────────┘         │ calibration      │
       ▼                                         └────────▲─────────┘
┌──────────────────────────────────────┐                  │
│             PROCESSING               │                  │
│ normalize → entity-resolve → dedup   │                  │
│ → OBSERVATION LEDGER (append-only)   │                  │
└──────┬───────────────────────────────┘                  │
       ▼                                                  │
┌──────────────────────────────────────┐         ┌────────┴─────────┐
│            EXPLOITATION              │         │  DISSEMINATION   │
│ metric extraction → time series →    │         │ feed · briefing  │
│ detectors → evidence clusters →      │────────▶│ alerts · query   │
│ FUSION → Signals (graded)            │         │ agent · pages    │
└──────┬───────────────────────────────┘         └────────▲─────────┘
       ▼                                                  │
┌──────────────────────────────────────┐                  │
│              ANALYSIS                │                  │
│ hypotheses · predictions · themes ·  │──────────────────┘
│ graph propagation → OPPORTUNITIES    │
└──────────────────────────────────────┘
```

Every arrow is an event stream; every box is independently replayable from the ledger.

### 3.2 The intelligence object hierarchy

This is the data model that replaces "a signal is a row."

| Object | What it is | Mutability | Example |
|---|---|---|---|
| **Observation** | One timestamped, source-attributed fact about one entity | Immutable, append-only | "2026-07-20: acme.com careers page lists 14 open roles (was 9 on 07-01). Source: ats:greenhouse, capture sha256:…" |
| **Evidence Cluster** | Observations resolved to the same real-world event/state change | Grows | 6 syndicated articles + 1 Form D + 1 founder tweet = one "Acme raised a Series B" cluster |
| **Signal** | An interpreted state change with direction, magnitude, confidence grade, and half-life | Lifecycle: `candidate → active → confirmed / contradicted / decayed` | "Acme engineering hiring accelerating (B2 confidence, half-life 45d)" |
| **Hypothesis** | A forward-looking claim with a prior and an evidence ledger that updates it | Continuously re-scored | "Acme will raise within 2 quarters — currently 0.62, up from 0.31 six weeks ago" |
| **Opportunity** | Hypothesis × relationship graph × firm context → a concrete action with owner, warm path, and expiry | Lifecycle: `open → claimed → actioned → expired` | "Intro Acme's CTO (via J. Chen, Hot, ex-colleague) before the round becomes public. Window ~3 weeks." |
| **Campaign** | The actions the firm chose to run | Tracked | Outreach sequence, event invite, diligence run |
| **Outcome** | What actually happened | Ground truth | Reply received; meeting held; round confirmed at $40M; we passed |

Objects reference *down* the hierarchy: an Opportunity cites its Hypothesis, which cites Signals, which cite Evidence Clusters, which cite Observations, which cite raw captures. **Click-through provenance is the product's trust model** — this generalizes the existing `signal-strength.ts` design rule ("every number traces to evidence we actually hold") to the whole system.

---

## 4. Collection Layer Redesign

### 4.1 Principle

Rank sources by **(lead time before news) × (structure) ÷ (cost + legal risk)**. The best sources are structured, free, legal, and early. News is late, unstructured, and already commoditized — it stays, but as *confirmation*, not discovery.

### 4.2 Source taxonomy

**Tier 1 — structured, legal, early, cheap (build first):**

| Source | Exhaust | Typical lead time vs. news | Access |
|---|---|---|---|
| ATS career pages (Greenhouse/Lever/Ashby public JSON) | Hiring by function, seniority, location | 3–6 months ahead of "Acme is scaling" stories | Public JSON endpoints, stable schemas |
| GitHub org/repos | Commit velocity, contributors, releases, new repos, org-member growth | 1–6 months ahead of launches | REST/GraphQL API, generous free tier |
| Certificate Transparency logs | New subdomains (`app.`, `enterprise.`, `eu.`, `soc2.`) | 2–8 weeks ahead of product/region launches | crt.sh / CT stream, free |
| SEC EDGAR (Form D, S-1, 13F, 8-K) | Raised rounds pre-press-release; fund formations | Days–weeks ahead of announcement; sometimes the *only* disclosure | Free API + full-text search |
| USPTO / EUIPO | Patents (18-mo lag but thesis-grade), trademarks (product names pre-launch) | Trademarks: 1–6 months pre-launch | Free APIs |
| Package registries (npm, PyPI, Docker Hub) | SDK releases, download momentum | Weeks–months | Free APIs |
| Changelogs / release notes / status pages / docs sitemaps | Feature velocity, enterprise-readiness pages (SSO, SOC2, HIPAA) | Weeks | RSS or diff-crawl |
| App stores (iOS/Android) | Release cadence, ranking moves, review velocity | Weeks | Public/cheap APIs |
| DNS / MX / CDN | Infra migrations, email-provider changes, new regions | Weeks | Passive DNS providers, cheap |
| Procurement (SAM.gov, USAspending, EU TED) | Gov customer wins — for defense/govtech theses | Months | Free APIs |
| Company registries (Companies House, state filings) | Incorporations, officer changes, charges | Weeks–months | Free/cheap APIs |
| Conference agendas & CFPs | Speaker lineups, sponsor lists = GTM posture | 1–3 months | Crawl |
| arXiv / Papers-with-Code | Research direction of technical founders/labs | 6–18 months ahead of productization | Free APIs |

**Tier 2 — high value, needs licensing or careful handling:**

- **People-movement data** (headcount by department, exec joins/leaves): use a **licensed provider** (Live Data Technologies, Coresignal, PDL, Aviato). Direct LinkedIn scraping is a legal and account-risk nonstarter — this repo already made that call for Signal Radar v1, and the redesign keeps it. Note: **Sumble is already integrated** and provides jobs + tech-stack exhaust; it becomes a Tier-2 collector rather than a one-off panel.
- **Web traffic / app usage estimates** (Similarweb, Data.ai), **Glassdoor/review velocity** (licensed feeds), **podcast/YouTube transcripts** (Podscan, YouTube API + Whisper), **community chatter** (HN/Reddit APIs are fine; Discord/Slack only where the firm is a legitimate member).
- **Commercial graphs** (Crunchbase/PitchBook/Dealroom) as *entity-resolution backbones and priors*, not as signal sources — they are consensus by definition.

**Tier 3 — the proprietary moat (internal exhaust):**

The firm's own operations are a sensor network no competitor can buy:
- **Gmail metadata** (already read-only integrated): reply latency, thread frequency, OOO/bounce messages. *An email bounce from a contact is one of the fastest departure detectors that exists.*
- **Calendar/event attendance** (already tracked): who actually shows up, who declines.
- **Notes/outreach trails** (already stored): what messaging worked, historical response rates per person.
- **Every partner's manual actions** in the app: dismissals, saves, promotes — labeled training data.

### 4.3 Weak-signal catalog (what to detect before it is news)

Each collector feeds named **precursor detectors**. Illustrative catalog:

| Precursor | Observable | Typically predicts | Lead |
|---|---|---|---|
| Hiring inflection | Changepoint in open-role count; first Head-of-Sales/CRO posting | Round closed quietly; GTM expansion | 1–6 mo |
| Recruiter burst | 3+ recruiter roles posted in a week | Headcount ramp → raised or about to | 2–4 mo |
| CT cert for `enterprise.*` / `eu.*` | New TLS cert | Upmarket move / EU launch | 2–8 wk |
| Docs add SOC2/SSO/HIPAA pages | Sitemap diff | Enterprise sales motion | 1–3 mo |
| Pricing page adds "Contact us" tier | HTML diff | Sales-led pivot | 1–2 mo |
| Trademark filing for unknown name | USPTO | Product launch | 1–6 mo |
| Form D filed | EDGAR | Round already raised, pre-announcement | days–wks |
| GitHub velocity collapse + exec profile updates | Composite | Trouble, pivot, or acquisition talks | 1–3 mo |
| Founder podcast circuit (3+ appearances/quarter) | Transcripts | Fundraise narrative-building | 1–4 mo |
| Job postings deleted en masse | ATS diff | Freeze / down round / M&A quiet period | 2–8 wk |
| New DNS MX to enterprise provider | Passive DNS | Ops maturation | wk |
| Repeated commits to `billing/`, `sso/`, `audit-log/` paths | GitHub | Monetization/enterprise features | 1–3 mo |
| Exec calendar/conference pattern (same corp-dev conference twice) | Agendas | Partnership/M&A exploration | 1–3 mo |
| Review-site sentiment slope down + hiring freeze | Composite | Churn risk / distress | 1–4 mo |

The catalog is data, not code: each precursor is a row (metric, detector type, threshold, predicts, half-life) so analysts can add precursors without deploys.

---

## 5. Retrieval Strategy — Adaptive, Expanding Search

Today search is a fixed fan-out over known names. Replace it with **case-file expansion**:

1. **Steady-state:** each tracked entity has a standing collector set determined by tasking (§8).
2. **Trigger:** any B-grade-or-better signal opens a **case** on the entity.
3. **Expansion:** a case triggers one round of *bounded* graph expansion — collect on: named competitors (from Radar Watchlist + embedding-nearest companies), founders and executives (as person entities), lead investors, named customers/partners in the evidence, and the entity's technology neighbors (via Sumble tech-stack overlap).
4. **Each expansion node gets a temporary budget boost** with exponential decay (e.g., 2 weeks), not a permanent subscription — this is how the graph grows *where heat is* without unbounded crawl growth.
5. **Query synthesis:** for unstructured sources, queries are generated from the case's evidence (entity aliases + event vocabulary), not from a static template; a small LLM writes and refines source-specific queries, and query performance (novel-observation yield per call) is tracked per query so dead queries are retired automatically.

This converts isolated searches into an **expanding intelligence graph**: every confirmed signal makes the map around it temporarily higher-resolution.

---

## 6. Intelligence Fusion Engine

### 6.1 Source grading (Admiralty system, adapted)

Every observation carries a two-axis grade assigned at ingest:

- **Source reliability (A–E):** A = registry/filing (EDGAR, USPTO, CT logs — the world can't fake these cheaply), B = first-party artifact (company's own careers page, changelog, repo), C = reputable press, D = social/community chatter, E = search-engine inference with no durable URL.
- **Information credibility (1–5):** direct primary statement (1) → corroborated (2) → plausible single-source (3) → questionable (4) → contradicted (5).

The existing `confidence.reason` in `signal-strength.ts` ("real article vs. search guess") is a 2-level version of this; v2 makes it the universal ingest stamp.

### 6.2 Story clustering (fixes F6)

Before fusion, observations are clustered into evidence clusters by **(entity, event-type, time window, text similarity)**. Fifty syndicated articles collapse to one cluster with 50 members and *one* vote. Clustering runs incrementally: each new observation either joins the nearest open cluster or seeds a new one. At Sheets scale (a few thousand tracked entities, dozens of open clusters per entity at most) this needs no vector database: the (entity, event-type, ±7d) key does 90% of the work, and title similarity (normalized token overlap, or cached embeddings computed in-process and stored as a JSON cell on the cluster row) settles the rest.

### 6.3 Confidence combination

Per candidate signal, combine evidence clusters in **log-odds space** with correlation discounting:

```
logodds(signal) = prior(event-type, cohort)
                + Σ_clusters  w(grade) · LR(cluster → signal) · independence(cluster | earlier clusters)
```

- `w(grade)`: weight from the Admiralty grade (A1 ≫ D4).
- `LR`: likelihood ratio for "this cluster type given the signal is real vs. not" — initialized from analyst priors in the precursor catalog, later fit from outcomes (§13).
- `independence`: clusters sharing an origin (same wire story, same underlying filing) discount each other toward one effective vote; genuinely independent channels (hiring + certs + filings) do not.
- Output is banded into the confidence tiers partners see: **A (act on it), B (watch closely), C (context), D (noise floor)**.

### 6.4 Contradiction and uncertainty

- Contradictory evidence *lowers the posterior*; it never deletes. The signal record shows both columns of the ledger ("supports: 4 clusters / contradicts: 1").
- Signals whose posterior falls below the floor transition to `contradicted` or `decayed` (per-class half-life; a funding signal decays in weeks, a patent thesis signal in years) — fixing F8.
- Uncertainty is always displayed as the grade + the evidence ledger, never as false precision ("87.3%").

---

## 7. Knowledge Graph

### 7.1 Schema

Typed property graph over the entities the firm reasons about:

- **Nodes:** Company, Person, Fund/Investor, ProductTech, Theme, Event(conference), GeoMarket.
- **Edges (all time-stamped, all weighted):** `WORKS_AT(person, company, from, to)`, `FOUNDED`, `INVESTED_IN(fund, company, round, date)`, `KNOWS(partner, person, warmth, lastContact)` (from the CRM's engagement score), `INTRODUCED_TO`, `ATTENDED(person, event)`, `USES_TECH(company, tech)` (from Sumble), `COMPETES_WITH`, `PARTNERS_WITH`, `ALUMNI_OF(person, company)` — the historical `WORKS_AT` edges that never expire.

### 7.2 Entity resolution (fixes F4)

- **Companies:** primary key = registrable domain; crosswalk table maps external IDs (EDGAR CIK, GitHub org, CB/PB IDs, ATS slugs, app-store IDs) and aliases to the canonical node. New observations that can't resolve confidently go to a **resolution queue** (human-in-the-loop, batched) rather than auto-creating duplicate nodes — a poisoned graph is worse than a delayed observation.
- **People:** email(s) + LinkedIn URL + (name, company, timeframe) tuples; merge is conservative, split is cheap.

### 7.3 Propagation algorithms

- **Warm-path search:** max-warmth path of length ≤ 2 from any partner to a target node; warmth of a path = min(edge warmths) × decay(path length). This powers "who can intro" and is the direct upgrade of the network factor in `signal-strength.ts`.
- **Event diffusion:** when a node fires a signal, run bounded **personalized-PageRank / heat diffusion** from that node; any *known-person* node receiving heat above threshold generates a secondary notification ("your contact J. Chen's former company just…"). Exec-move events fire at *both* company nodes and re-time-stamp all `ALUMNI_OF` edges they touch.
- **Alumni cascades:** a departure creates a standing watch on the person node (where do they land?); a landing at a young company is itself a strong signal (senior operator joined seed-stage startup → their network believes in it).

### 7.4 Graph storage under the Sheets constraint

Most edges **already exist as CRM tabs**: `WORKS_AT` ≈ Contacts/Targets company fields, `KNOWS` ≈ engagement scores + primes, `ATTENDED` ≈ Events, `INTRODUCED_TO` ≈ PortCos Introduced, `USES_TECH` ≈ Sumble data, `INVESTED_IN` ≈ Portfolio Companies. The graph is therefore **materialized in memory** at read time from cached tabs (a few thousand nodes — milliseconds to build), not stored as a separate graph database. Only two additions are needed: an `Edges` tab in the Intelligence workbook for edge types with no CRM home (`ALUMNI_OF` from detected departures, `COMPETES_WITH` from the Radar Watchlist, `PARTNERS_WITH` from evidence), and time-stamps on edges wherever the source tab has a date. Warm-path search and bounded diffusion over an in-memory graph of this size need no infrastructure at all.

---

## 8. Temporal Reasoning Engine

### 8.1 Metric time series

Every quantitative observation lands in a per-entity metric store: `(entity, metric, ts, value, source)`. Core metrics: open roles (total and by function), commit velocity, contributor count, release cadence, news-mention count, traffic rank, app rank, review velocity/sentiment, headcount estimate, funding-precursor index.

### 8.2 Detector bank (runs on every append)

- **Baseline & anomaly:** rolling median/IQR per entity; z-score vs. *own history* and vs. *cohort* (stage × sector) — a 5-person seed company adding 3 roles is a bigger event than a 500-person company adding 30.
- **Changepoint detection:** CUSUM or Bayesian online changepoint on each series — the formal version of "started accelerating in February."
- **Momentum & acceleration:** EWMA slope and second derivative; sign changes = trend reversals.
- **Sequence motifs:** event-stream patterns from the precursor catalog, e.g. `recruiter-burst → sales-hires → pricing-change` within 120d ⇒ GTM-expansion motif; `roles-deleted → exec-departures → repo-archived` ⇒ distress motif.
- **Seasonality guards:** deseasonalize (intern cycles, December freezes, conference season) before flagging.

### 8.3 The "quiet acceleration" construct

The flagship temporal signal is explicitly computable:

```
StealthScore(entity) = momentum(activity metrics) − momentum(news mentions)
```

Sustained positive slope across ≥3 *independent* activity metrics while the news-mention series stays flat = "quietly accelerating for six months," with the sparkline as evidence. High StealthScore is the single best proxy for "before it becomes obvious" — and it is impossible to compute without the observation ledger (F2/F3).

---

## 9. Opportunity Engine

**An event is something that happened in the world. An opportunity is an event × the firm's position × a clock.** The engine evaluates opportunity *templates* — declarative rules over (signals, graph, CRM state):

| Template | Trigger pattern | Qualification (graph/CRM) | Action + window |
|---|---|---|---|
| Warm intro | Fundraise hypothesis ≥ B at non-portfolio co | Warm path ≤ 2 hops, warmth ≥ Warm | Intro request, expires when round announces |
| Pre-round engagement | StealthScore high + no press | Thesis match ≥ threshold (Theses tab) | Partner outreach, 2–6 wk window |
| Competitive threat | Expansion motif at competitor of portco | `COMPETES_WITH` edge to portfolio | Brief portco CEO; board-note draft |
| Executive move | Departure detected (bounce/OOO/provider) | Person is Hot/Warm contact or alumni edge | Congrats/re-engage within 7d of landing |
| Re-engagement | Contact's company fires any A/B signal + lastContact > 90d | Owned by a specific prime | Personal note, 2 wk |
| Customer expansion | Portco tech detected at new company (Sumble) | Portco BD relevance | Intro portco ↔ prospect |
| Follow-up rescue | Open follow-up flag + new signal on same entity | Notes tab | Nudge with fresh hook |
| Thesis instantiation | Theme detector fires (§ Themes) | Coverage gap in Targets | Sourcing sprint into theme |

Every opportunity carries: the citing hypothesis, the warm path (named), the suggested owner (from prime/ownership index), the expiry, and the drafted first move (LLM production step — the *last* step, as today). Opportunities expire loudly; expired-unactioned is itself a tracked outcome.

---

## 10. Prediction Engine

### 10.1 Position

Predictions are **hypotheses with calibrated probabilities**, never LLM vibes. LLMs extract features from text; statistical models own the numbers.

### 10.2 Models (in order of build difficulty)

1. **Fundraise-within-180d** (first, because labels are free): every announced round in the last N years is a label; features are the observable exhaust in the preceding 6 months (hiring slope, Form D presence, founder-podcast count, StealthScore, months-since-last-round vs. stage median, investor-graph heat). Gradient-boosted trees or a discrete-time hazard model. Backtestable *today* from public history — no waiting for data collection.
2. **Executive departure** (bounce/OOO/profile-change precursors + tenure vs. cohort baseline; survival analysis).
3. **Product launch** (trademark + CT certs + changelog cadence + docs growth; classification over sequence motifs).
4. **Acquisition/shutdown/pivot** (later — rarer labels, noisier).

### 10.3 Discipline

- **Calibration is a feature:** reliability curves and Brier scores per model on a dashboard; probabilities shown to partners only after a model clears a calibration bar; before that, models emit unscored watchlist flags.
- **Base rates always displayed** next to predictions ("62% vs. 11% base rate for Series-A-age companies").
- Every prediction lists its top contributing features as evidence — same click-through provenance as everything else.

---

## 11. Ranking — the Opportunity Score

Replace scalar relevance with an **expected-value decomposition** (all factors 0–1, each with visible evidence):

```
OpportunityScore = P(success) × Value × Timeliness

P(success)  = f( network_strength,        // warm-path warmth (graph)
                 relationship_warmth,     // engagement score, reply history
                 response_prior )         // this person/segment's historical reply rate

Value       = f( strategic_importance,    // thesis match, portfolio adjacency
                 competitive_impact,      // threat/benefit to portcos
                 stage_fit,               // fund's check-size window
                 evidence_confidence )    // fusion grade discounts value

Timeliness  = f( window_remaining,        // expiry from the template
                 signal_freshness,        // per-class decay
                 crowding )               // StealthScore: pre-news scores higher than post-news
```

Weights start heuristic (as `signal-strength.ts` does today), then are fit by logistic regression on outcomes (§13). The score is *never* shown without its factor breakdown — the existing "click a score and see why" rule is non-negotiable and is the product's differentiation against black-box competitors.

---

## 12. Theme Detection

Themes are **first-class graph nodes** aggregating entity-level series:

1. **Membership:** companies embed (description + tech stack + hiring vocabulary); themes are clusters in that space plus curated seeds from the existing Theses tab. Membership is scored, not boolean, and re-computed monthly.
2. **Theme-level series:** sum/median of member metrics — funding velocity, hiring velocity, new-entrant rate, exit rate, StealthScore distribution.
3. **Theme signals:** the same detector bank runs on theme series: "Defense-adjacent autonomy: hiring +38% QoQ across 24 tracked companies, 6 new entrants, 2 quiet accelerators" — that sentence is a computed object with drill-down, not prose.
4. **Lifecycle:** themes are born (cluster coherence crosses threshold), heat up, cool, merge, and die; the timeline of a theme is itself briefing content and connects directly to the thesis-sourcing flow already in /platform.

---

## 13. Learning Loop

**Labels the system already half-collects:** outreach drafted (Target Outreach), replies (Email Activity), meetings (Events/Calendar), promotes to Targets, dismissals in the feed, deals (Portfolio adds). Add explicit lightweight verdicts on cards (useful / not useful / already knew) — one tap.

**What learns from what:**

| Learner | Signal | Updates |
|---|---|---|
| Ranking weights | acted/ignored/replied per opportunity | Logistic weights in OpportunityScore |
| Fusion LRs | signals later confirmed/contradicted | Likelihood ratios per (precursor, event) |
| Prediction models | announced rounds, departures, launches | Retraining sets, calibration |
| Tasking | novel-observation yield per (entity, collector) | Crawl budgets |
| Query synthesis | yield per query | Query retirement |
| Noise filters | "already knew" rate per source | Source-level suppression |

"Already knew" is the most important label: it directly measures whether the system is beating the partner's own information diet — the product's core promise.

---

## 14. Tasking & Collection Strategy (the scheduler)

Collection is a budgeted optimization, not a cron:

```
priority(entity, collector) =
    relationship_value(entity)          // portco > hot target > warm network > cold index
  × hypothesis_uncertainty(entity)      // open hypotheses near decision boundaries crave evidence
  × expected_yield(entity, collector)   // Thompson-sampled from historical novel-observation rate
  ÷ cost(collector)                     // API $ + LLM $ + legal risk weight
```

- **Cadence bands:** portcos & active cases: hours. Hot targets/themes: daily. Warm network: weekly. The remaining tracked universe: monthly structural sweep (cheap collectors only). Beyond the tracked universe: push-style only — registry/CT/EDGAR alerts that create an entity when they fire; no active crawl, no stored rows until there is something to store.
- **Burst mode:** any A/B signal or opened case multiplies the entity's budget (and its expansion neighbors', §5) for a decaying window.
- **Bandit adaptation:** entities/collectors that keep yielding state changes get sampled more; dead pairs decay to floor cadence. This is Thompson sampling over "will this probe observe a change?"
- **Budget caps** are explicit and per-tier, so cost is a dial, not a surprise.

---

## 15. Storage Model & Event Pipeline — Sheets-Native

**Ground rule: Google Sheets is the database.** The design therefore treats spreadsheet capacity as a budget to engineer against, exactly the way embedded-systems engineers treat RAM. The three governing numbers:

- **10,000,000 cells per spreadsheet** (hard Google limit) — a 10-column tab tops out at ~1M rows in theory;
- **~50,000 rows per tab** is the practical ceiling before reads/writes degrade (keep working tabs well under it);
- **~50,000 characters per cell** — which makes JSON-in-cell a legitimate storage primitive (this codebase already uses it: Target Strategy `Plan JSON`, Daily Briefing `JSON`, Platform Content `JSON`).

Three techniques make an intelligence system fit inside those numbers:

1. **Delta-only ledger.** Never store probe results; store *changes*. "Checked Acme's careers page, still 9 roles" writes nothing. "9 → 14" writes one row. Most metrics for most entities change rarely, so the ledger grows with *events in the world*, not with crawl frequency — the single most important sizing decision in this document.
2. **JSON-cell series.** Time series live as one row per (entity, metric) with the history compressed into a JSON cell (`[[isoWeek, value], …]`, capped at 104 weekly points ≈ 1.6k chars — 3% of a cell). 2,000 entities × 8 metrics = 16,000 rows *forever*, regardless of years elapsed.
3. **Compaction + archive workbooks.** Working tabs hold the hot window; a scheduled compactor rolls old delta rows into the JSON series and moves them to yearly archive spreadsheets (the `Signals Archive` tab already establishes this pattern). Additional *spreadsheets* are cheap and still "Sheets is the DB" — the intelligence layer gets its **own workbook** (`VenturePulse Intelligence`, second spreadsheet ID) so its growth can never degrade the CRM workbook's performance.

### 15.1 Tab schema (Intelligence workbook)

| Tab | Row = | Key columns | Sizing |
|---|---|---|---|
| **Entities** | one tracked entity | URID, name, domain, aliases JSON, xref JSON (GitHub org, ATS slug, EDGAR CIK, app-store ids), tier, cadence band, collector state JSON (last-run/cursor per collector) | 2–5k rows, stable |
| **Metric Log** | one detected change (the ledger) | date, entity URID, metric, prev → new value, source, Admiralty grade, capture hash/URL | append-only; ~100–200k changes/yr at 2k entities → hot tab holds the current quarter (≤30k rows), compactor archives the rest |
| **Entity Series** | one (entity, metric) | current value, baseline, slope, z-score, changepoint date, history JSON (104 wk) | 16–40k rows, fixed |
| **Evidence** | one evidence cluster | ID, entity, event type, first/last seen, members JSON (url+grade list), combined grade, status | few thousand live; archived with age |
| **Signals** (existing tab, upgraded) | one graded signal | + confidence grade, lifecycle status, evidence IDs, expires | stays the published feed view, top-N current only |
| **Hypotheses** | one forward-looking claim | entity, claim type, log-odds score, evidence ledger JSON, updated | hundreds live |
| **Opportunities** | one actionable item | template, entity, hypothesis ID, warm path JSON, owner, expires, status | hundreds live |
| **Verdicts** | one partner feedback tap | signal/opportunity ID, user, verdict, ts | slow append; the learning labels |
| **Resolution Queue** | one ambiguous entity match | raw string, candidates JSON, status | small, human-drained |

Outcomes need **no new tabs** — Target Outreach, Email Activity, Events, and Targets promotions already live in the CRM workbook and join by URID/email.

**What is genuinely given up under this constraint — stated, not hidden:**

- **Raw capture storage** (full HTML snapshots enabling re-extraction) does not fit in cells. Two options: store only content hashes + source URLs (accepting that dead links lose re-extraction), or push snapshot files to the already-integrated Google Drive and store the Drive file ID in the ledger row. Drive is Workspace, not a new database — recommended, but it is the user's call.
- **Replay depth.** Event-sourcing replay still works over the Metric Log + archives (values and grades survive), but re-*extraction* from raw text only works where a capture exists. Detectors remain retroactively improvable; extractors mostly do not.
- **Scale caps.** The tracked universe is **~2,000–5,000 entities**, not 100k prospects or a 1M-company index. The cold index shrinks to push-style watchlists (CT-log alerts, EDGAR full-text alerts, registry RSS) that only *create* an entity row when they fire. The scalability answer here is honesty, not Kafka.
- **Vector search.** No vector store; clustering and theme membership use keys + in-process similarity over small candidate sets (§6.2), with any embeddings cached in JSON cells.

### 15.2 Access discipline (what makes Sheets survivable as a DB)

- **Single-writer queue.** All intelligence-workbook writes go through one serialized promise queue with idempotency keys `(collector, entity, content-hash)` — the exact pattern `llm-log.server.ts` already uses to kill duplicate-append races, promoted to a global rule.
- **Process-level read cache.** Tab reads cache in server memory with short TTLs (the per-turn `ToolCache` in `llm.server.ts`, widened to process scope); `values.batchGet` fetches all needed ranges in one API call. Sheets quota (~60 read calls/min/user) is never consumed by fan-out.
- **Compute in memory, store results.** Changepoints, momentum, fusion, ranking all run in Node over cached tabs (trivially fast at 16k series rows) and write back *conclusions*, never intermediate state.
- **The compactor** is a scheduled Inngest job: rolls Metric Log rows older than the hot window into Entity Series JSON, moves them to the yearly archive workbook, prunes decayed signals/evidence, and reports cell-budget utilization per tab to the Ops Log — the storage budget becomes an observable metric, not a surprise.

### 15.3 Pipeline

```
collectors ──▶ normalize ──▶ entity-resolve ──▶ Metric Log append (delta only)
                                 (Resolution Queue on ambiguity)      │
        ┌─────────────────────────────────────────────────────────────┘
        ▼
 series update ─▶ detector bank ─▶ candidate signals ─▶ story clustering (Evidence)
        ─▶ fusion ─▶ Signals lifecycle ─▶ Hypotheses update ─▶ Opportunities eval
        ─▶ dissemination (feed, briefing, alerts, query agent)   ─▶ compactor (nightly)
```

- **Orchestration:** Inngest (already integrated) end to end — one durable function per stage, fan-out per entity, retries and cursors in Inngest's own state (Inngest is infrastructure, not a database). No Kafka at this scale, ever; the delta-only ledger keeps event volume small enough that durable functions are sufficient.
- **LLM budget optimization:** LLMs only at (a) extraction from unstructured text — smallest model that passes eval, structured output, cached by content hash; (b) query synthesis; (c) final production (drafts, briefing prose). Router: cheap model first, escalate on low confidence. Frequent extraction patterns get distilled into parsers/regex over time. *Nothing in fusion, ranking, or prediction calls an LLM.*

---

## 16. Incremental Rollout Plan

Each phase ships standalone value; nothing requires a big-bang rewrite. Touchpoints reference the current codebase.

**Phase 0 — The ledger (2–4 wks).**
Create the **Intelligence workbook** (second spreadsheet ID; same auth, same `sheets.server.ts` helpers) with the Entities, Metric Log, and Evidence tabs. Tee the *existing* collectors (NewsAPI, Perplexity, Gmail links, Drive docs — `executeSignalScan`'s inputs) into the ledger *before* Gemini sees them, as delta rows with Admiralty grades. Add story-clustering dedup. Promote the `llm-log` serialized-writer pattern into a shared intelligence-write queue. Nothing user-visible changes; F2/F6 are fixed and history starts accumulating from day one. (Every week of delay is a week of lost baseline data — this is why Phase 0 is first.)

**Phase 1 — Tier-1 sensors + time (4–8 wks).**
Add the five highest-yield collectors: ATS careers JSON, GitHub, CT logs, EDGAR Form D, USPTO trademarks — all free/structured, all delta-only writers. Entity Series tab + changepoint/momentum detectors (in-memory over cached tabs). Nightly compactor with cell-budget reporting to the Ops Log. Ship **Momentum cards** and **StealthScore** into the existing /signals feed and briefing (new card types in `signal-feed.ts`). This is the moment the product stops being a news summarizer.

**Phase 2 — Fusion, tasking, opportunities (6–10 wks).**
Confidence-graded signals with lifecycles replace write-once rows (Signals tab becomes a published view). Tasking scheduler with cadence bands + burst mode replaces the flat cron (`scan-signals` route stays as the trigger surface). First six opportunity templates over the existing graph data (contacts, engagement scores, primes, Theses, Sumble). Opportunities appear in the attention queue on `/` and in `/briefing`.

**Phase 3 — Learning + first prediction (8–12 wks).**
Wire outcomes (Target Outreach, Email Activity, Events, feed verdict taps) into the label store. Fit ranking weights. Backtest and ship the fundraise-within-180d model as a *watchlist flag* first, probabilities after calibration clears. Query agent (`query_signals`, `query_targets`) gets hypothesis/opportunity tools.

**Phase 4 — Coverage + graph depth (quarter+).**
Push-style watchlists widen coverage beyond actively-tracked entities (CT-log, EDGAR full-text, and registry alerts that create an entity row only when they fire — coverage without crawl). Graph propagation alerts (alumni cascades, diffusion) over the in-memory graph. Theme engine on top of the Theses tab. A second archive workbook generation and compactor tuning as the ledger's history deepens — capacity work stays inside Sheets by design.

---

## 17. Risks and Trade-offs

- **Legal/ToS (highest severity).** No LinkedIn scraping (keep v1's stance; use licensed people-data providers). Respect robots.txt and rate limits on first-party crawls; prefer official APIs; keep a per-source legal review row in the collector registry. GDPR: people-observations need purpose limitation, retention windows, and deletion workflows — build them into the ledger schema now (per-record `subject_type`, `retention_class`), not later.
- **Entity-resolution poisoning.** A wrong merge propagates everywhere. Mitigate: conservative auto-merge, human resolution queue, cheap splits, provenance on every edge.
- **False-positive fatigue.** The fastest way to kill the product is a noisy feed. Launch every new detector in shadow mode (logged, not shown); promote on measured precision; "already knew / not useful" taps gate promotion.
- **Prediction overconfidence.** Uncalibrated probabilities in front of partners are reputational poison. Calibration bar + base rates + evidence lists are launch gates, not nice-to-haves.
- **Cost creep.** LLM-at-the-edges, content-hash caching, bandit-driven crawl budgets, and per-tier caps make cost a dial. The Tier-1 sensors are nearly free; the expensive things (people-data licenses, traffic estimates) are explicit line items to adopt deliberately.
- **Team-size realism.** This design is a multi-quarter program for a small team. The phase plan is sequenced so that stopping after any phase still leaves a strictly better system; the ledger (Phase 0) is the only irreversible commitment and the cheapest.
- **Sheets capacity discipline (the constraint's price).** The system lives or dies on the delta-only rule and the compactor. One chatty collector writing probe results instead of changes can burn the cell budget in weeks. Mitigations: writes only through the shared queue (which enforces delta semantics centrally), per-tab cell-utilization reported to the Ops Log with alerts at 60%, and collector-level novel-row-rate monitoring so a misbehaving sensor is caught by its write pattern, not by an outage.
- **Sheets quota exhaustion.** ~60 read calls/min/user is easy to blow with naive fan-out. The process-level cache + `batchGet` discipline (§15.2) is mandatory, not optional; every new consumer reads through the cache layer or not at all.
- **Two-workbook boundary.** CRM workbook (human-curated memory) and Intelligence workbook (machine-written observations) must stay one-directional per field class: curated fields flow CRM→Intelligence at read time, computed views flow Intelligence→CRM (the published Signals tab). Nothing machine-written ever overwrites a curated cell.

---

## 18. Roadmap

**Year 1 — "See earlier."** Phases 0–3 complete. Ledger with 12 months of baselines; Tier-1 sensors on every portco and hot target; momentum/stealth detection live; opportunity queue with owners and expiry; fundraise model calibrated; ranking learning from outcomes. Success metric: median lead time of firm awareness vs. first mainstream article > 3 weeks; "already knew" rate < 30%.

**Year 3 — "Institutional memory that compounds."** ~5,000 tracked entities with multi-year series; push-style watchlists surfacing new entrants the moment they leave exhaust; theme engine driving sourcing sprints; graph propagation as the default alerting model; prediction suite (fundraise, departure, launch) calibrated; multi-year entity dossiers ("everything we've ever observed about Acme, on one timeline") as the diligence starting point. The ledger's replayability means every detector improvement has been applied retroactively — the moat is now *accumulated observation history*, which no competitor can backfill.

**Year 5 — "The terminal, at boutique scale."** The constraint stays the strategy: not the biggest index, but the deepest history on the entities that matter to *this firm* — years of delta-ledger observations, a fully time-stamped relationship graph, and a decade of interaction outcomes that make its ranking and predictions un-replicable. Analysts task collection in natural language through the query agent ("open a case on EU industrial-AI seed companies hiring their first sales lead"); VenturePulse is the screen a partner opens *instead of* the news — because by the time it's news, the system flagged it a month ago and the intro already happened. If the firm ever outgrows the workbook, the delta ledger's schema ports row-for-row to any database — the discipline built here is the migration plan.

---

*Appendix pointers (current code):* scan pipeline `src/utils/gemini.functions.ts` (`executeSignalScan`), grounded scoring `src/lib/signal-strength.ts`, feed mapping `src/lib/signal-feed.ts`, cron `src/routes/api/cron/scan-signals.ts`, storage `src/utils/sheets.server.ts` (`SIGNAL_HEADERS`), tech-stack exhaust `src/utils/sumble.server.ts`, theses `src/utils/platform.server.ts`.
