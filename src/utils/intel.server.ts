// Signal Radar v2 — Sheets-native intelligence core (docs/SIGNAL_RADAR_V2_DESIGN.md
// + docs/SIGNAL_RADAR_V2_UPGRADE.md).
//
// Layers (strictly separated):
//   Observation — what a collector saw (intel-collectors.server.ts, pure fetchers)
//   Change      — validated difference, delta-only ledger (Intel Metric Log)
//   Event       — fused related changes with a lifecycle (Intel Events)
//   Inference   — labeled interpretation inside the signal card, never a fact
// Detection/fusion math lives in intel-detect.server.ts (pure, fixture-tested);
// this module owns persistence, lifecycle, health, and signal emission.
//
// Storage discipline (Sheets is the DB):
//   · writes go through one serialized queue (no interleaved appends)
//   · probe results are never stored — only changes reach the Metric Log
//   · history lives as a JSON cell capped at 104 points (~2% of a cell)
//   · collector failure is health telemetry, NEVER a downward company signal

import {
  ensureTab,
  ensureHeaderRow,
  ensureHeaderWidth,
  fetchSheetTab,
  appendSheetRows,
  writeSheetRow,
  buildPortfolioCompanies,
  buildTargets,
  logOpsEvent,
  TAB_NAMES,
} from "./sheets.server";
import { loadSignalConfig } from "./event-store.server";
import { BADGE, promotionCheck } from "@/lib/fusion";
import { buildRadarWatchlist } from "./platform.server";
import {
  fetchStoredSignals,
  keyForStored,
  rowFromStored,
  type StoredSignal,
} from "./signal-store.server";
import { newsSourceType } from "@/lib/signal-feed";
import {
  collectAtsJobs,
  collectGithub,
  collectCtSubdomains,
  collectEdgarFormD,
  collectSiteSignals,
  collectChangelogFeed,
  collectUsptoTrademarks,
  domainOf,
  COLLECTOR_VERSIONS,
  type CollectorResult,
} from "./intel-collectors.server";
import {
  evaluateChange,
  fuseChanges,
  computeStats,
  policyFor,
  peerPercentile,
  type Anomaly,
  type EventCandidate,
} from "./intel-detect.server";

// ── Tabs & schemas ───────────────────────────────────────────────

export const INTEL_TABS = {
  entities: "Intel Entities",
  metricLog: "Intel Metric Log",
  series: "Intel Series",
  events: "Intel Events",
  health: "Intel Collector Health",
  verdicts: "Signal Verdicts",
} as const;

/** Bump when row semantics change; stamped on events for replayability. */
export const INTEL_SCHEMA_VERSION = 2;

export const INTEL_ENTITY_HEADERS = [
  "URID",
  "Name",
  "Domain",
  "Tier",
  "Xref JSON",
  "Added",
  "Last Scanned",
  "Note",
  // WS6 — depth-tiered watch universe (appended; blank rows default by Tier):
  //   1 = portcos + active targets: all collectors, daily; news daily.
  //   2 = watchlist + most-connected: all collectors daily; news weekly.
  //   3 = broad sourcing universe: cheap high-precision collectors only
  //       (config watchTiers.tier3Collectors — ATS + EDGAR Form D); no news.
  "Watch Tier",
];
// v2 appends columns AFTER the v1 set — existing rows stay valid (shorter).
export const INTEL_METRIC_LOG_HEADERS = [
  "Date",
  "Entity URID",
  "Entity",
  "Metric",
  "Prev",
  "New",
  "Source",
  "Grade",
  "Ref",
  "Abs Delta",
  "Pct Delta",
  "Status",
  "Key",
];
export const INTEL_SERIES_HEADERS = [
  "Entity URID",
  "Entity",
  "Metric",
  "Current",
  "Baseline",
  "Slope Wk",
  "Z",
  "History JSON",
  "Updated",
  "State JSON",
];
export const INTEL_EVENT_HEADERS = [
  "Event ID",
  "Entity URID",
  "Entity",
  "State",
  "Status",
  "First Detected",
  "Last Updated",
  "Confidence",
  "Families",
  "Evidence JSON",
  "Signal ID",
  "Schema",
];
export const INTEL_HEALTH_HEADERS = [
  "Date",
  "Collector",
  "Version",
  "Attempts",
  "OK",
  "No Source",
  "Ambiguous",
  "Errors",
  "Error Rate",
  "Notes",
];
export const SIGNAL_VERDICT_HEADERS = ["Date", "Signal ID", "Company", "Verdict", "User", "Note"];

const HISTORY_MAX_POINTS = 104;
const EVENT_EVIDENCE_MAX = 12;
/** An event that saw no new evidence for this long is eligible to be superseded by a fresh one. */
const EVENT_STALE_DAYS = 45;
const SWEEP_LIMIT_DEFAULT = Number(process.env["INTEL_SWEEP_LIMIT"]) || 15;

// ── Serialized intel writes (same pattern as llm-log.server) ─────
let writeChain: Promise<void> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ── Types ────────────────────────────────────────────────────────

export interface IntelEntity {
  urid: string;
  name: string;
  domain: string;
  tier: "portco" | "watch" | "target" | string;
  xref: Record<string, string>;
  added: string;
  lastScanned: string;
  note: string;
  /** WS6 collection depth (1/2/3) — editable in the UI, auto-promotable 3→2. */
  watchTier: number;
  /** 1-based sheet row (header = 1). */
  rowNumber: number;
}

/** Default watch tier when the column is blank, from the legacy source tier. */
export function defaultWatchTier(tier: string): number {
  return tier === "portco" ? 1 : tier === "watch" ? 2 : 3;
}

interface SeriesState {
  /** Date an unconfirmed drop-to-zero was first seen. */
  pendingZero?: string;
  /** Date this series last contributed an anomaly (per-metric cooldown). */
  lastFired?: string;
}

interface SeriesRow {
  urid: string;
  entity: string;
  metric: string;
  current: number;
  baseline: number;
  slopeWk: number;
  z: number;
  history: Array<[string, number]>;
  updated: string;
  state: SeriesState;
  rowNumber?: number;
}

interface EvidenceItem {
  date: string;
  metric: string;
  prev: number;
  next: number;
  z: number;
  reason: string;
  url: string;
  grade: string;
}

type EventStatus = "emerging" | "strengthening" | "confirmed" | "weakening" | "resolved" | "invalidated";

interface EventRow {
  eventId: string;
  urid: string;
  entity: string;
  state: string;
  status: EventStatus;
  firstDetected: string;
  lastUpdated: string;
  confidence: number;
  families: number;
  evidence: EvidenceItem[];
  signalId: string;
  rowNumber?: number;
}

export interface IntelSweepResult {
  ok: boolean;
  error?: string;
  entitiesScanned: number;
  entitiesTotal: number;
  observations: number;
  eventsCreated: number;
  eventsUpdated: number;
  signalsEmitted: number;
  collectorErrors: string[];
}

const today = () => new Date().toISOString().split("T")[0];
const nowIso = () => new Date().toISOString();
const daysBetween = (a: string, b: string) =>
  Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;

function parseJson<T>(raw: string, fallback: T): T {
  if (!raw || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function readTab(tab: string): Promise<string[][]> {
  try {
    return await fetchSheetTab(tab);
  } catch {
    return [];
  }
}

// ── Entities ─────────────────────────────────────────────────────

function entityFromRow(row: string[], rowNumber: number): IntelEntity | null {
  const urid = (row[0] || "").trim();
  const name = (row[1] || "").trim();
  if (!urid || !name) return null;
  const tier = (row[3] || "watch").trim();
  const wt = Number((row[8] || "").trim());
  return {
    urid,
    name,
    domain: (row[2] || "").trim().toLowerCase(),
    tier,
    xref: parseJson<Record<string, string>>(row[4] || "", {}),
    added: (row[5] || "").trim(),
    lastScanned: (row[6] || "").trim(),
    note: (row[7] || "").trim(),
    watchTier: wt >= 1 && wt <= 3 ? wt : defaultWatchTier(tier),
    rowNumber,
  };
}

function rowFromEntity(e: IntelEntity): string[] {
  return [
    e.urid,
    e.name,
    e.domain,
    e.tier,
    JSON.stringify(e.xref),
    e.added,
    e.lastScanned,
    e.note,
    String(e.watchTier || defaultWatchTier(e.tier)),
  ];
}

export async function loadIntelEntities(): Promise<IntelEntity[]> {
  const rows = await readTab(INTEL_TABS.entities);
  const out: IntelEntity[] = [];
  for (let i = 1; i < rows.length; i++) {
    const e = entityFromRow(rows[i], i + 1);
    if (e) out.push(e);
  }
  return out;
}

/** Consumer / free-mail hosts — never treat these as a company domain. */
const PERSONAL_EMAIL_HOSTS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "pm.me",
  "hey.com",
  "mail.com",
  "yandex.com",
  "gmx.com",
]);

/** Most common non-personal email host among people at a company ("" if none). */
function companyDomainFromEmails(emails: string[]): string {
  const counts = new Map<string, number>();
  for (const raw of emails) {
    const host = String(raw || "")
      .trim()
      .toLowerCase()
      .split("@")[1];
    if (!host || PERSONAL_EMAIL_HOSTS.has(host)) continue;
    // Skip obvious ISP / education noise for corp inference.
    if (host.endsWith(".edu") || host.endsWith(".gov")) continue;
    counts.set(host, (counts.get(host) || 0) + 1);
  }
  let best = "";
  let bestN = 0;
  for (const [host, n] of counts) {
    if (n > bestN) {
      best = host;
      bestN = n;
    }
  }
  return best;
}

/**
 * Seed/refresh the registry from Portfolio Companies + Competitive Radar
 * watchlist + unique Targets companies (additive; never demotes an existing tier).
 */
export async function seedIntelEntities(): Promise<{ added: number; total: number }> {
  await ensureTab(INTEL_TABS.entities, INTEL_ENTITY_HEADERS);
  const existing = await loadIntelEntities();
  const seen = new Set(existing.map((e) => e.name.trim().toLowerCase()));

  const candidates: Array<{ name: string; domain: string; tier: string; urid?: string }> = [];
  try {
    for (const p of await buildPortfolioCompanies()) {
      if (p.name)
        candidates.push({ name: p.name, domain: domainOf(p.website), tier: "portco", urid: p.urid });
    }
  } catch (e) {
    console.error("[intel] seed: portfolio read failed", e);
  }
  try {
    for (const w of await buildRadarWatchlist()) {
      if (w.company) candidates.push({ name: w.company, domain: domainOf(w.website), tier: "watch" });
    }
  } catch (e) {
    console.error("[intel] seed: radar watchlist read failed", e);
  }
  // Targets are people rows — collapse to unique companies. Prefer PortCo/watch
  // when the same name already appears (candidates are ordered; seen skips dupes).
  try {
    const byCompany = new Map<string, { name: string; emails: string[] }>();
    for (const t of await buildTargets()) {
      const name = (t.company || "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const row = byCompany.get(key) || { name, emails: [] };
      if (t.email) row.emails.push(t.email);
      byCompany.set(key, row);
    }
    for (const row of byCompany.values()) {
      candidates.push({
        name: row.name,
        domain: companyDomainFromEmails(row.emails),
        tier: "target",
      });
    }
  } catch (e) {
    console.error("[intel] seed: targets read failed", e);
  }

  const toAdd: IntelEntity[] = [];
  for (const c of candidates) {
    const key = c.name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    toAdd.push({
      urid: c.urid || crypto.randomUUID(),
      name: c.name.trim(),
      domain: c.domain,
      tier: c.tier,
      xref: {},
      added: today(),
      lastScanned: "",
      note: "",
      watchTier: defaultWatchTier(c.tier),
      rowNumber: 0,
    });
  }
  if (toAdd.length > 0) {
    await serialized(() => appendSheetRows(INTEL_TABS.entities, toAdd.map(rowFromEntity)));
  }
  return { added: toAdd.length, total: existing.length + toAdd.length };
}

// ── Series persistence ───────────────────────────────────────────

function seriesFromRow(row: string[], rowNumber: number): SeriesRow | null {
  const urid = (row[0] || "").trim();
  const metric = (row[2] || "").trim();
  if (!urid || !metric) return null;
  return {
    urid,
    entity: (row[1] || "").trim(),
    metric,
    current: Number(row[3]) || 0,
    baseline: Number(row[4]) || 0,
    slopeWk: Number(row[5]) || 0,
    z: Number(row[6]) || 0,
    history: parseJson<Array<[string, number]>>(row[7] || "", []),
    updated: (row[8] || "").trim(),
    state: parseJson<SeriesState>(row[9] || "", {}),
    rowNumber,
  };
}

function rowFromSeries(s: SeriesRow): string[] {
  return [
    s.urid,
    s.entity,
    s.metric,
    String(s.current),
    String(Math.round(s.baseline * 100) / 100),
    String(Math.round(s.slopeWk * 100) / 100),
    String(Math.round(s.z * 100) / 100),
    JSON.stringify(s.history.slice(-HISTORY_MAX_POINTS)),
    s.updated,
    JSON.stringify(s.state),
  ];
}

// ── Events persistence & lifecycle ───────────────────────────────

function eventFromRow(row: string[], rowNumber: number): EventRow | null {
  const eventId = (row[0] || "").trim();
  if (!eventId) return null;
  return {
    eventId,
    urid: (row[1] || "").trim(),
    entity: (row[2] || "").trim(),
    state: (row[3] || "").trim(),
    status: ((row[4] || "emerging").trim().toLowerCase() as EventStatus) || "emerging",
    firstDetected: (row[5] || "").trim(),
    lastUpdated: (row[6] || "").trim(),
    confidence: Number(row[7]) || 0,
    families: Number(row[8]) || 1,
    evidence: parseJson<EvidenceItem[]>(row[9] || "", []),
    signalId: (row[10] || "").trim(),
    rowNumber,
  };
}

function rowFromEvent(e: EventRow): string[] {
  return [
    e.eventId,
    e.urid,
    e.entity,
    e.state,
    e.status,
    e.firstDetected,
    e.lastUpdated,
    String(e.confidence),
    String(e.families),
    JSON.stringify(e.evidence.slice(-EVENT_EVIDENCE_MAX)),
    e.signalId,
    String(INTEL_SCHEMA_VERSION),
  ];
}

// ── Signal composition (Observed vs. Interpretation, always labeled) ──

function eventSignal(
  entity: IntelEntity,
  candidate: EventCandidate,
  event: EventRow,
  isPortco: boolean,
): StoredSignal {
  const observed = candidate.anomalies
    .map(
      (a) =>
        `${a.label} ${a.prev} → ${a.next}${a.z !== 0 ? ` (z=${a.z.toFixed(1)})` : ""}`,
    )
    .join("; ");
  const evidenceLines = event.evidence
    .slice(-6)
    .map((ev) => `• ${ev.date} ${ev.metric}: ${ev.prev} → ${ev.next} [${ev.grade}] ${ev.url}`)
    .join("\n");
  const sig: StoredSignal = {
    id: "",
    dateFound: today(),
    type: "awareness",
    status: "New",
    person: "",
    company: entity.name,
    email: "",
    category: "Momentum",
    signal: `OBSERVED: ${observed}. First-party/registry evidence from ${event.families} independent source famil${event.families === 1 ? "y" : "ies"}, status ${event.status}.`,
    sourceUrl: candidate.anomalies[0] ? eventEvidenceUrl(event) : "",
    subject: `${entity.name} — ${candidate.state} (${Math.round(event.confidence * 100)}% conf)`,
    body: `VERIFIED OBSERVATIONS\n${evidenceLines}\n\nINTERPRETATION (inference, not a confirmed fact)\n${candidate.interpretation}\n\nEvent ${event.eventId} · first detected ${event.firstDetected} · status ${event.status} · ${event.families} independent source families · confidence ${Math.round(event.confidence * 100)}%.`,
    relevance: Math.round(event.confidence * 100),
    justification: `${candidate.anomalies.map((a) => a.reason).join(" ")} Same-source metrics counted once; ${event.families} independent famil${event.families === 1 ? "y" : "ies"}.`,
    urgency: event.confidence >= 0.75 || candidate.state === "Fundraising evidence" ? "High" : "Medium",
    timing: `Event status: ${event.status} · first detected ${event.firstDetected}`,
    sourceType: newsSourceType(
      undefined,
      isPortco,
      candidate.anomalies[0] ? eventEvidenceUrl(event) : "",
    ),
    docUrl: "",
    hasBody: true,
  };
  sig.id = keyForStored(sig);
  return sig;
}

function eventEvidenceUrl(event: EventRow): string {
  const last = event.evidence[event.evidence.length - 1];
  return last?.url || "";
}

// ── The sweep ────────────────────────────────────────────────────

export interface IntelSweepOptions {
  limit?: number;
  tier?: string;
  entityName?: string;
}

interface HealthCounter {
  attempts: number;
  ok: number;
  noSource: number;
  ambiguous: number;
  errors: number;
  notes: string[];
}

export async function runIntelSweep(opts: IntelSweepOptions = {}): Promise<IntelSweepResult> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? SWEEP_LIMIT_DEFAULT));
  try {
    await ensureTab(INTEL_TABS.entities, INTEL_ENTITY_HEADERS);
    await ensureTab(INTEL_TABS.metricLog, INTEL_METRIC_LOG_HEADERS);
    await ensureTab(INTEL_TABS.series, INTEL_SERIES_HEADERS);
    await ensureTab(INTEL_TABS.events, INTEL_EVENT_HEADERS);
    await ensureTab(INTEL_TABS.health, INTEL_HEALTH_HEADERS);
    // Schema v2 adds columns to v1 tabs — extend headers in place, rows stay valid.
    await ensureHeaderRow(INTEL_TABS.metricLog, INTEL_METRIC_LOG_HEADERS);
    await ensureHeaderRow(INTEL_TABS.series, INTEL_SERIES_HEADERS);
    // WS6: widen pre-tier registries so Watch Tier gets a header cell.
    await ensureHeaderWidth(INTEL_TABS.entities, INTEL_ENTITY_HEADERS);
    const cfg = await loadSignalConfig();

    let entities = await loadIntelEntities();
    // Additive refresh every sweep so new Targets / watchlist rows enter the
    // universe without a manual seed click (PortCo/watch still win on name ties).
    const seeded = await seedIntelEntities();
    if (seeded.added > 0) {
      console.log(`[intel] seed: added ${seeded.added} entit(ies) → ${seeded.total} total`);
      entities = await loadIntelEntities();
    } else if (entities.length === 0) {
      entities = await loadIntelEntities();
    }
    const entitiesTotal = entities.length;

    const wanted = (opts.entityName || "").trim().toLowerCase();
    let batch = entities
      .filter((e) => (opts.tier ? e.tier === opts.tier : true))
      .filter((e) => (wanted ? e.name.toLowerCase() === wanted : true));
    // Tier 1 outranks 2 outranks 3 for scan slots; stalest first within a tier.
    batch.sort(
      (a, b) =>
        a.watchTier - b.watchTier ||
        (a.lastScanned || "").localeCompare(b.lastScanned || ""),
    );
    batch = batch.slice(0, limit);

    // Series index: "urid|metric" → row.
    const seriesRows = await readTab(INTEL_TABS.series);
    const series = new Map<string, SeriesRow>();
    for (let i = 1; i < seriesRows.length; i++) {
      const s = seriesFromRow(seriesRows[i], i + 1);
      if (s) series.set(`${s.urid}|${s.metric}`, s);
    }

    // Events index: "urid|state" → most recent live event.
    const eventRows = await readTab(INTEL_TABS.events);
    const events = new Map<string, EventRow>();
    for (let i = 1; i < eventRows.length; i++) {
      const ev = eventFromRow(eventRows[i], i + 1);
      if (!ev) continue;
      const key = `${ev.urid}|${ev.state}`;
      const prev = events.get(key);
      if (!prev || (ev.lastUpdated || "") > (prev.lastUpdated || "")) events.set(key, ev);
    }

    const existingSignals = await fetchStoredSignals();
    const seenSignalKeys = new Set(existingSignals.map(keyForStored));
    let portcoNames = new Set<string>();
    try {
      portcoNames = new Set(
        (await buildPortfolioCompanies()).map((p) => p.name.trim().toLowerCase()),
      );
    } catch {
      /* portco flag is cosmetic for the feed bucket */
    }

    const logRows: string[][] = [];
    const newSeries: SeriesRow[] = [];
    const changedSeries = new Set<SeriesRow>();
    const dirtyEntities: IntelEntity[] = [];
    const newSignals: StoredSignal[] = [];
    const updatedSignals: StoredSignal[] = [];
    const newEvents: EventRow[] = [];
    const changedEvents = new Set<EventRow>();
    const collectorErrors: string[] = [];
    const promotions: string[] = [];
    const health: Record<string, HealthCounter> = {};
    const bump = (collector: string, status: CollectorResult["status"], note?: string) => {
      const h = (health[collector] ||= { attempts: 0, ok: 0, noSource: 0, ambiguous: 0, errors: 0, notes: [] });
      h.attempts++;
      if (status === "ok") h.ok++;
      else if (status === "no_source") h.noSource++;
      else if (status === "ambiguous") h.ambiguous++;
      else h.errors++;
      if (note && h.notes.length < 8) h.notes.push(note);
    };

    const pushLedger = (
      entity: IntelEntity,
      metric: string,
      prev: number | "",
      next: number,
      res: CollectorResult,
      grade: string,
      status: "recorded" | "unconfirmed" | "confirmed",
    ) => {
      const prevN = prev === "" ? 0 : prev;
      const abs = prev === "" ? "" : String(Math.abs(next - prevN));
      const pct =
        prev === "" || prevN === 0 ? "" : `${Math.round(((next - prevN) / Math.abs(prevN)) * 100)}%`;
      logRows.push([
        today(),
        entity.urid,
        entity.name,
        metric,
        prev === "" ? "" : String(prev),
        String(next),
        res.collector,
        grade,
        res.resolvedRef || "",
        abs,
        pct,
        status,
        `${today()}|${entity.urid}|${metric}|${prev}|${next}`,
      ]);
    };

    for (const entity of batch) {
      const noSource = (collector: CollectorResult["collector"], why = "no domain"): CollectorResult => ({
        collector,
        ok: false,
        status: "no_source",
        metrics: [],
        error: why,
      });
      // Negative-cache discovery: a failed slug/org hunt is remembered for 30
      // days so undiscoverable entities don't re-spend probe requests daily.
      const stale = (stamp?: string) => !stamp || daysBetween(today(), stamp) > 30;
      const atsKnown = entity.xref["ats"];
      const ghKnown = entity.xref["github"];
      const feedKnown = entity.xref["feed"];
      // WS6 — Tier 3 runs ONLY the cheap high-precision collectors (config:
      // ATS + EDGAR Form D). Near-zero cost, near-zero false positives, so
      // the broad sourcing universe scales to hundreds of companies.
      const gatedOut = (collector: CollectorResult["collector"]): boolean =>
        entity.watchTier >= 3 && !cfg.watchTiers.tier3Collectors.includes(collector);
      const [ats, gh, ct, edgar, site, changelog, uspto] = await Promise.all([
        gatedOut("ats")
          ? Promise.resolve(noSource("ats", "tier 3 — collector gated"))
          : atsKnown || stale(entity.xref["ats_checked"])
            ? collectAtsJobs(entity.name, atsKnown)
            : Promise.resolve(noSource("ats", "discovery cached (none found)")),
        gatedOut("github")
          ? Promise.resolve(noSource("github", "tier 3 — collector gated"))
          : ghKnown || stale(entity.xref["gh_checked"])
            ? collectGithub(entity.name, entity.domain, ghKnown)
            : Promise.resolve(noSource("github", "discovery cached (none found)")),
        gatedOut("ct") || !entity.domain
          ? Promise.resolve(noSource("ct", gatedOut("ct") ? "tier 3 — collector gated" : "no domain"))
          : collectCtSubdomains(entity.domain),
        gatedOut("edgar")
          ? Promise.resolve(noSource("edgar", "tier 3 — collector gated"))
          : collectEdgarFormD(entity.name, entity.xref["edgar"]),
        gatedOut("site") || !entity.domain
          ? Promise.resolve(noSource("site", gatedOut("site") ? "tier 3 — collector gated" : "no domain"))
          : collectSiteSignals(entity.domain),
        gatedOut("changelog") || !entity.domain
          ? Promise.resolve(
              noSource("changelog", gatedOut("changelog") ? "tier 3 — collector gated" : "no domain"),
            )
          : feedKnown || stale(entity.xref["feed_checked"])
            ? collectChangelogFeed(entity.domain, feedKnown)
            : Promise.resolve(noSource("changelog", "discovery cached (none found)")),
        gatedOut("uspto")
          ? Promise.resolve(noSource("uspto", "tier 3 — collector gated"))
          : collectUsptoTrademarks(entity.name, entity.xref["uspto"]),
      ]);
      if (!atsKnown) {
        if (ats.resolvedRef) delete entity.xref["ats_checked"];
        else if (ats.status === "no_source" && !ats.error?.includes("cached"))
          entity.xref["ats_checked"] = today();
      }
      if (!ghKnown) {
        if (gh.resolvedRef) delete entity.xref["gh_checked"];
        else if (gh.status === "no_source" && !gh.error?.includes("cached"))
          entity.xref["gh_checked"] = today();
      }
      if (!feedKnown) {
        if (changelog.resolvedRef) delete entity.xref["feed_checked"];
        else if (changelog.status === "no_source" && !changelog.error?.includes("cached"))
          entity.xref["feed_checked"] = today();
      }

      const entityAnomalies: Array<{ anomaly: Anomaly; res: CollectorResult; grade: string }> = [];

      // Peer cohort for one metric: every OTHER monitored entity's relative
      // deviation from its own baseline — same scale for a seed co and a portco.
      const peerRelDevs = (metric: string): number[] => {
        const minHist = policyFor(metric).minHistory;
        const out: number[] = [];
        for (const s of series.values()) {
          if (s.metric !== metric || s.urid === entity.urid) continue;
          if (s.history.length < minHist) continue;
          out.push((s.current - s.baseline) / Math.max(Math.abs(s.baseline), 1));
        }
        return out;
      };

      for (const res of [ats, gh, ct, edgar, site, changelog, uspto]) {
        bump(res.collector, res.status, res.error ? `${entity.name}: ${res.error}` : undefined);
        if (!res.ok) {
          if (res.status === "error")
            collectorErrors.push(`${entity.name}/${res.collector}: ${res.error}`);
          // Ambiguous EDGAR matches surface on the entity for human review.
          if (res.status === "ambiguous" && res.note && !entity.note.includes("near-match")) {
            entity.note = [entity.note, res.note].filter(Boolean).join(" · ").slice(0, 300);
          }
          continue;
        }
        if (res.resolvedRef && entity.xref[res.collector] !== res.resolvedRef) {
          entity.xref[res.collector] = res.resolvedRef;
        }

        for (const m of res.metrics) {
          const key = `${entity.urid}|${m.metric}`;
          const existing = series.get(key);
          if (!existing) {
            // First observation — an event by definition; never an anomaly.
            const s: SeriesRow = {
              urid: entity.urid,
              entity: entity.name,
              metric: m.metric,
              current: m.value,
              baseline: m.value,
              slopeWk: 0,
              z: 0,
              history: [[today(), m.value]],
              updated: nowIso(),
              state: {},
            };
            series.set(key, s);
            newSeries.push(s);
            pushLedger(entity, m.metric, "", m.value, res, m.grade, "recorded");
            continue;
          }
          if (existing.current === m.value && !existing.state.pendingZero) continue;

          const candidateHistory = (() => {
            const h = existing.history.slice();
            const last = h[h.length - 1];
            if (last && last[0] === today()) h[h.length - 1] = [today(), m.value];
            else h.push([today(), m.value]);
            return h.slice(-HISTORY_MAX_POINTS);
          })();
          const daysSinceLastFire = existing.state.lastFired
            ? daysBetween(today(), existing.state.lastFired)
            : Number.POSITIVE_INFINITY;

          const verdict = evaluateChange({
            metric: m.metric,
            prev: existing.current,
            next: m.value,
            history: candidateHistory,
            daysSinceLastFire,
            pendingZeroSince: existing.state.pendingZero,
          });

          if (verdict.action === "hold_unconfirmed") {
            // Ledger records the sighting; the series does NOT believe it yet.
            pushLedger(entity, m.metric, existing.current, m.value, res, m.grade, "unconfirmed");
            existing.state.pendingZero = today();
            changedSeries.add(existing);
            continue;
          }
          if (verdict.action === "discard_blip") {
            delete existing.state.pendingZero;
            changedSeries.add(existing);
            continue;
          }

          const wasPending = Boolean(existing.state.pendingZero);
          delete existing.state.pendingZero;
          pushLedger(
            entity,
            m.metric,
            existing.current,
            m.value,
            res,
            m.grade,
            wasPending ? "confirmed" : "recorded",
          );
          existing.history = candidateHistory;
          existing.current = m.value;
          const stats = computeStats(existing.history, existing.current);
          existing.baseline = stats.baseline;
          existing.z = stats.z;
          existing.slopeWk = stats.slopeWk;
          existing.updated = nowIso();
          changedSeries.add(existing);

          if (verdict.action === "record_anomaly") {
            existing.state.lastFired = today();
            // Peer context: how extreme is this move among monitored companies
            // with the same metric? Only attached when the cohort is honest (n≥8).
            const a = verdict.anomaly;
            const myRelDev = (a.next - a.baseline) / Math.max(Math.abs(a.baseline), 1);
            const peers = peerPercentile(peerRelDevs(m.metric), myRelDev, a.direction);
            if (peers) {
              a.reason += ` Peer context: more extreme than ${peers.percentile}% of ${peers.n} monitored companies with ${a.label} data.`;
            }
            entityAnomalies.push({ anomaly: a, res, grade: m.grade });
          }
        }
      }

      // ── Fusion: this entity's anomalies → event candidates → lifecycle upsert ──
      if (entityAnomalies.length > 0) {
        const candidates = fuseChanges(entityAnomalies.map((a) => a.anomaly));
        for (const cand of candidates) {
          const evidence: EvidenceItem[] = cand.anomalies.map((a) => {
            const src = entityAnomalies.find((ea) => ea.anomaly.metric === a.metric);
            return {
              date: today(),
              metric: a.metric,
              prev: a.prev,
              next: a.next,
              z: Math.round(a.z * 10) / 10,
              reason: a.reason,
              url: src?.res.metrics.find((mm) => mm.metric === a.metric)?.sourceUrl || "",
              grade: src?.grade || "B2",
            };
          });
          const key = `${entity.urid}|${cand.state}`;
          const existingEvent = events.get(key);
          const isPortco = portcoNames.has(entity.name.trim().toLowerCase());

          if (
            existingEvent &&
            existingEvent.status !== "resolved" &&
            existingEvent.status !== "invalidated" &&
            existingEvent.lastUpdated &&
            daysBetween(today(), existingEvent.lastUpdated) <= EVENT_STALE_DAYS
          ) {
            // Same continuing development → UPDATE the event, don't create a twin.
            existingEvent.evidence = [...existingEvent.evidence, ...evidence].slice(-EVENT_EVIDENCE_MAX);
            const grew = cand.independentFamilies > existingEvent.families;
            existingEvent.families = Math.max(existingEvent.families, cand.independentFamilies);
            existingEvent.confidence = Math.max(existingEvent.confidence, cand.confidence);
            existingEvent.status = grew ? "strengthening" : existingEvent.status === "emerging" ? "strengthening" : existingEvent.status;
            existingEvent.lastUpdated = today();
            changedEvents.add(existingEvent);
            // Refresh the linked signal card in place (same signal ID → same row).
            const sig = eventSignal(entity, cand, existingEvent, isPortco);
            sig.id = existingEvent.signalId || sig.id;
            updatedSignals.push(sig);
          } else {
            const ev: EventRow = {
              eventId: `ev-${crypto.randomUUID().slice(0, 8)}`,
              urid: entity.urid,
              entity: entity.name,
              state: cand.state,
              status: "emerging",
              firstDetected: today(),
              lastUpdated: today(),
              confidence: cand.confidence,
              families: cand.independentFamilies,
              evidence,
              signalId: "",
            };
            const sig = eventSignal(entity, cand, ev, isPortco);
            if (!seenSignalKeys.has(sig.id)) {
              seenSignalKeys.add(sig.id);
              ev.signalId = sig.id;
              newSignals.push(sig);
            }
            events.set(key, ev);
            newEvents.push(ev);
          }
        }
      }

      // ── WS6 — signal-driven promotion (Tier 3 → 2) ──
      // Every fired anomaly stamps its evidence family on the entity; a Tier-3
      // company with ≥ promotionMinFamilies DISTINCT families inside the
      // window auto-promotes. Logged, reversible (Watch Universe editor —
      // manual demotion clears the family stamps so it doesn't re-fire).
      if (entityAnomalies.length > 0) {
        const fired = parseJson<Record<string, string>>(entity.xref["fired_families"] || "", {});
        for (const ea of entityAnomalies) fired[ea.anomaly.family] = today();
        entity.xref["fired_families"] = JSON.stringify(fired);
        if (entity.watchTier === 3) {
          const check = promotionCheck(fired, today(), cfg);
          if (check.promote) {
            const recent = check.evidence;
            entity.watchTier = 2;
            const evidence = recent.map(([f, d]) => `${f} (${d})`).join(", ");
            const isPortco = portcoNames.has(entity.name.trim().toLowerCase());
            const promo: StoredSignal = {
              id: "",
              dateFound: today(),
              type: "awareness",
              status: "New",
              person: "",
              company: entity.name,
              email: "",
              category: "Watchlist Promotion",
              signal: `Promoted to watchlist (Tier 3 → 2): ${recent.length} independent detector families fired within ${cfg.watchTiers.promotionWindowDays}d — ${evidence}.`,
              sourceUrl: "",
              subject: `Promoted to watchlist: ${entity.name}`,
              body: `Signal-driven promotion. Evidence families: ${evidence}.\n\nRule: ≥${cfg.watchTiers.promotionMinFamilies} distinct evidence families within ${cfg.watchTiers.promotionWindowDays} days. Reversible from the Watch Universe editor on /signals (manual demotion resets the evidence stamps).`,
              relevance: 0,
              justification: `Auto-promotion: ${evidence}.`,
              urgency: "Medium",
              timing: "",
              sourceType: newsSourceType(undefined, isPortco),
              docUrl: "",
              hasBody: true,
              badges: BADGE.promoted,
            };
            promo.id = keyForStored(promo);
            if (!seenSignalKeys.has(promo.id)) {
              seenSignalKeys.add(promo.id);
              newSignals.push(promo);
            }
            promotions.push(`${entity.name}: ${evidence}`);
          }
        }
      }

      entity.lastScanned = nowIso();
      dirtyEntities.push(entity);
    }

    // ── Writes, serialized ──
    await serialized(async () => {
      if (logRows.length > 0) await appendSheetRows(INTEL_TABS.metricLog, logRows);
      if (newSeries.length > 0) await appendSheetRows(INTEL_TABS.series, newSeries.map(rowFromSeries));
      for (const s of changedSeries) {
        if (s.rowNumber) await writeSheetRow(INTEL_TABS.series, s.rowNumber, rowFromSeries(s));
      }
      if (newEvents.length > 0) await appendSheetRows(INTEL_TABS.events, newEvents.map(rowFromEvent));
      for (const ev of changedEvents) {
        if (ev.rowNumber) await writeSheetRow(INTEL_TABS.events, ev.rowNumber, rowFromEvent(ev));
      }
      for (const e of dirtyEntities) {
        if (e.rowNumber) await writeSheetRow(INTEL_TABS.entities, e.rowNumber, rowFromEntity(e));
      }
      if (newSignals.length > 0)
        await appendSheetRows(TAB_NAMES.signals, newSignals.map(rowFromStored));
      if (updatedSignals.length > 0) {
        // In-place refresh: find each signal's row by ID (positional col 0).
        const sigRows = await readTab(TAB_NAMES.signals);
        const rowById = new Map<string, number>();
        for (let i = 0; i < sigRows.length; i++) {
          const id = (sigRows[i][0] || "").trim();
          if (id) rowById.set(id, i + 1);
        }
        for (const sig of updatedSignals) {
          const rowNum = rowById.get(sig.id);
          if (rowNum) await writeSheetRow(TAB_NAMES.signals, rowNum, rowFromStored(sig));
          else await appendSheetRows(TAB_NAMES.signals, [rowFromStored(sig)]);
        }
      }
      // Collector health: one row per collector per sweep + ops alert on collapse.
      const healthRows = Object.entries(health).map(([collector, h]) => [
        today(),
        collector,
        COLLECTOR_VERSIONS[collector as CollectorResult["collector"]] || "?",
        String(h.attempts),
        String(h.ok),
        String(h.noSource),
        String(h.ambiguous),
        String(h.errors),
        h.attempts > 0 ? `${Math.round((h.errors / h.attempts) * 100)}%` : "0%",
        h.notes.join(" | ").slice(0, 400),
      ]);
      if (healthRows.length > 0) await appendSheetRows(INTEL_TABS.health, healthRows);
    });

    for (const [collector, h] of Object.entries(health)) {
      if (h.attempts >= 5 && h.errors / h.attempts > 0.5) {
        await logOpsEvent({
          action: "sync",
          source: "intel_health",
          status: "error",
          summary: `Collector "${collector}" failing: ${h.errors}/${h.attempts} errors this sweep — investigate before trusting ${collector} metrics`,
          records: h.errors,
          details: { collector, ...h, notes: h.notes.join(" | ") },
        });
      }
    }

    await logOpsEvent({
      action: "sync",
      source: "intel_sweep",
      status: "ok",
      summary: `Intel sweep · ${batch.length}/${entitiesTotal} entities · ${logRows.length} observations · ${newEvents.length} new / ${changedEvents.size} updated events · ${newSignals.length + updatedSignals.length} signals`,
      records: logRows.length,
      details: {
        scanned: batch.length,
        total: entitiesTotal,
        observations: logRows.length,
        newSeries: newSeries.length,
        eventsCreated: newEvents.length,
        eventsUpdated: changedEvents.size,
        signals: newSignals.length,
        signalUpdates: updatedSignals.length,
        errors: collectorErrors.length,
      },
      items: [
        ...logRows.slice(0, 30).map((r) => `${r[2]} · ${r[3]}: ${r[4] || "∅"} → ${r[5]} (${r[11]})`),
        ...newEvents.map((ev) => `EVENT: ${ev.entity} — ${ev.state} (${Math.round(ev.confidence * 100)}%)`),
        ...[...changedEvents].map((ev) => `EVENT UPDATE: ${ev.entity} — ${ev.state} → ${ev.status}`),
        ...promotions.map((p) => `PROMOTED T3→T2: ${p}`),
      ],
    });

    return {
      ok: true,
      entitiesScanned: batch.length,
      entitiesTotal,
      observations: logRows.length,
      eventsCreated: newEvents.length,
      eventsUpdated: changedEvents.size,
      signalsEmitted: newSignals.length + updatedSignals.length,
      collectorErrors,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Intel sweep failed";
    console.error("[intel] sweep failed:", err);
    await logOpsEvent({
      action: "sync",
      source: "intel_sweep",
      status: "error",
      summary: message,
      records: 0,
    });
    return {
      ok: false,
      error: message,
      entitiesScanned: 0,
      entitiesTotal: 0,
      observations: 0,
      eventsCreated: 0,
      eventsUpdated: 0,
      signalsEmitted: 0,
      collectorErrors: [],
    };
  }
}

// ── Partner feedback (labels for the learning loop) ──────────────

export type SignalVerdict =
  | "useful"
  | "not_useful"
  | "already_knew"
  | "incorrect_company"
  | "incorrect_interpretation"
  | "too_early"
  | "duplicate"
  | "followed_up";

export async function recordSignalVerdict(input: {
  signalId: string;
  company: string;
  verdict: SignalVerdict;
  user: string;
  note?: string;
}): Promise<{ ok: boolean }> {
  try {
    await ensureTab(INTEL_TABS.verdicts, SIGNAL_VERDICT_HEADERS);
    await serialized(() =>
      appendSheetRows(INTEL_TABS.verdicts, [
        [
          nowIso(),
          input.signalId,
          input.company,
          input.verdict,
          input.user || "unknown",
          (input.note || "").slice(0, 300),
        ],
      ]),
    );
    return { ok: true };
  } catch (e) {
    console.error("[intel] recordSignalVerdict failed:", e);
    return { ok: false };
  }
}

// ── WS6 — manual watch-tier edits (logged, reversible) ───────────

export async function setEntityWatchTier(input: {
  urid: string;
  watchTier: number;
  user?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const wt = Math.round(input.watchTier);
  if (wt < 1 || wt > 3) return { ok: false, error: "watchTier must be 1, 2, or 3" };
  try {
    const entities = await loadIntelEntities();
    const entity = entities.find((e) => e.urid === input.urid);
    if (!entity || !entity.rowNumber) return { ok: false, error: "entity not found" };
    const prev = entity.watchTier;
    entity.watchTier = wt;
    // Manual demotion to Tier 3 resets promotion evidence so the auto-rule
    // doesn't instantly re-promote — the human's call stands until NEW
    // evidence accumulates.
    if (wt === 3) delete entity.xref["fired_families"];
    await serialized(() =>
      writeSheetRow(INTEL_TABS.entities, entity.rowNumber, rowFromEntity(entity)),
    );
    await logOpsEvent({
      action: "sync",
      source: "intel_watch_tier",
      status: "ok",
      summary: `Watch tier: ${entity.name} ${prev} → ${wt}${input.user ? ` (by ${input.user})` : ""}`,
      records: 1,
      details: { urid: entity.urid, name: entity.name, from: prev, to: wt, user: input.user || "" },
    });
    return { ok: true };
  } catch (e) {
    console.error("[intel] setEntityWatchTier failed:", e);
    return { ok: false, error: e instanceof Error ? e.message : "update failed" };
  }
}

// ── Status (for UI / query agent) ────────────────────────────────

export interface IntelStatus {
  entities: number;
  byTier: Record<string, number>;
  seriesTracked: number;
  ledgerRows: number;
  events: number;
  lastScanned: string;
}

export async function intelStatus(): Promise<IntelStatus> {
  const [entityRows, seriesRows, logRows, eventRows] = await Promise.all([
    readTab(INTEL_TABS.entities),
    readTab(INTEL_TABS.series),
    readTab(INTEL_TABS.metricLog),
    readTab(INTEL_TABS.events),
  ]);
  const byTier: Record<string, number> = {};
  let lastScanned = "";
  for (let i = 1; i < entityRows.length; i++) {
    const e = entityFromRow(entityRows[i], i + 1);
    if (!e) continue;
    byTier[e.tier] = (byTier[e.tier] || 0) + 1;
    if (e.lastScanned > lastScanned) lastScanned = e.lastScanned;
  }
  return {
    entities: Math.max(0, entityRows.length - 1),
    byTier,
    seriesTracked: Math.max(0, seriesRows.length - 1),
    ledgerRows: Math.max(0, logRows.length - 1),
    events: Math.max(0, eventRows.length - 1),
    lastScanned,
  };
}

// Re-export for callers that need policy metadata (labels in UI, tests).
export { policyFor };
