// Signals v2 — persistence for the event layer (WS1/WS2/WS5).
//
// New tabs (CRM workbook; names avoid the existing "Events" conference tab):
//   Signal Events   — one row per real-world event (clustered stories)
//   Signal Feedback — per-card interaction log with frozen feature vectors
//   Signal Config   — analyst-editable overrides of DEFAULT_SIGNAL_CONFIG
//   Signal Metrics  — nightly quality metrics (precision_at_10, …)
//
// Same storage discipline as intel.server.ts: writes serialized through one
// promise queue, JSON-in-cell for lists, additive schema with positional reads
// tolerant of short rows.

import {
  ensureTab,
  fetchSheetTab,
  appendSheetRows,
  writeSheetRow,
} from "./sheets.server";
import {
  DEFAULT_SIGNAL_CONFIG,
  type SignalConfig,
  type SignalEventType,
  type SourceTier,
  type CorroborationRule,
} from "@/lib/signal-config";

export const SIGNAL_V2_TABS = {
  events: "Signal Events",
  feedback: "Signal Feedback",
  config: "Signal Config",
  metrics: "Signal Metrics",
} as const;

export const SIGNAL_EVENT_SCHEMA_VERSION = 1;

export const SIGNAL_EVENT_HEADERS = [
  "Event ID",
  "Company",
  "Entity URID",
  "Event Type",
  "First Seen",
  "Last Updated",
  "Status",
  "Source Count",
  "Top Source URL",
  "Top Tier",
  "Sources JSON",
  "Confidence",
  "Materiality",
  "Materiality Adj",
  "Relevance",
  "Actionability",
  "Surprise",
  "Rank Score",
  "Magnitude JSON",
  "Intel Event ID",
  "Badges",
  "Score Breakdown JSON",
  "Tokens JSON",
  "Constituent IDs",
  "Schema",
];

export const SIGNAL_FEEDBACK_HEADERS = [
  "Date",
  "Event ID",
  "Signal ID",
  "Action",
  "User",
  "Rank Position",
  "Feature Vector JSON",
];

export const SIGNAL_CONFIG_HEADERS = ["Section", "Key", "Value", "Notes"];
export const SIGNAL_METRIC_HEADERS = ["Date", "Metric", "Value", "Details JSON"];

// ── Types ────────────────────────────────────────────────────────

export interface EventSource {
  /** URL. */
  u: string;
  /** Tier A/B/C at ingest. */
  t: SourceTier;
  /** ISO date this source joined the event. */
  d: string;
  /** Truncated title (audit only). */
  ti?: string;
}

export interface EventMagnitude {
  value: number;
  unit: string;
  /** The exact substring from the grounded source text it was validated against. */
  verbatim: string;
}

export interface SignalEventRow {
  eventId: string;
  company: string;
  entityUrid: string;
  eventType: SignalEventType;
  firstSeen: string;
  lastUpdated: string;
  status: "open" | "updated" | "closed";
  sourceCount: number;
  topSourceUrl: string;
  topTier: SourceTier;
  sources: EventSource[];
  confidence: number;
  materiality: number;
  materialityAdj: number;
  relevance: number;
  actionability: number;
  surprise: number;
  rankScore: number;
  magnitude: EventMagnitude | null;
  intelEventId: string;
  /** Semicolon-separated badge slugs (CONFIRMED_BY_PRESS, DETECTED_BEFORE_PRESS, …). */
  badges: string;
  /** Component breakdown — every stored score reconstructible from this. */
  scoreBreakdown: Record<string, unknown>;
  /** Clustering centroid token set. */
  tokens: string[];
  /** Constituent signal IDs (and, for burst meta-events, member event IDs). */
  constituentIds: string[];
  /** 1-based sheet row (0 = not yet persisted). */
  rowNumber: number;
}

// ── Serialized writes (same pattern as intel.server / llm-log.server) ──
let writeChain: Promise<void> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function parseJson<T>(raw: string, fallback: T): T {
  if (!raw || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const num = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ── Row mapping ──────────────────────────────────────────────────

function eventFromRow(row: string[], rowNumber: number): SignalEventRow | null {
  const eventId = (row[0] || "").trim();
  const company = (row[1] || "").trim();
  if (!eventId || !company) return null;
  return {
    eventId,
    company,
    entityUrid: (row[2] || "").trim(),
    eventType: ((row[3] || "other").trim() as SignalEventType) || "other",
    firstSeen: (row[4] || "").trim(),
    lastUpdated: (row[5] || "").trim(),
    status: ((row[6] || "open").trim().toLowerCase() as SignalEventRow["status"]) || "open",
    sourceCount: num(row[7] || "1") || 1,
    topSourceUrl: (row[8] || "").trim(),
    topTier: ((row[9] || "C").trim().toUpperCase() as SourceTier) || "C",
    sources: parseJson<EventSource[]>(row[10] || "", []),
    confidence: num(row[11] || ""),
    materiality: num(row[12] || ""),
    materialityAdj: num(row[13] || ""),
    relevance: num(row[14] || ""),
    actionability: num(row[15] || ""),
    surprise: num(row[16] || ""),
    rankScore: num(row[17] || ""),
    magnitude: parseJson<EventMagnitude | null>(row[18] || "", null),
    intelEventId: (row[19] || "").trim(),
    badges: (row[20] || "").trim(),
    scoreBreakdown: parseJson<Record<string, unknown>>(row[21] || "", {}),
    tokens: parseJson<string[]>(row[22] || "", []),
    constituentIds: parseJson<string[]>(row[23] || "", []),
    rowNumber,
  };
}

function rowFromEvent(e: SignalEventRow): string[] {
  return [
    e.eventId,
    e.company,
    e.entityUrid,
    e.eventType,
    e.firstSeen,
    e.lastUpdated,
    e.status,
    String(e.sourceCount),
    e.topSourceUrl,
    e.topTier,
    JSON.stringify(e.sources.slice(0, 25)),
    String(e.confidence),
    String(e.materiality),
    String(e.materialityAdj),
    String(e.relevance),
    String(e.actionability),
    String(e.surprise),
    String(e.rankScore),
    e.magnitude ? JSON.stringify(e.magnitude) : "",
    e.intelEventId,
    e.badges,
    JSON.stringify(e.scoreBreakdown).slice(0, 8000),
    JSON.stringify(e.tokens.slice(0, 60)),
    JSON.stringify(e.constituentIds.slice(0, 40)),
    String(SIGNAL_EVENT_SCHEMA_VERSION),
  ];
}

// ── Events API ───────────────────────────────────────────────────

export async function ensureSignalV2Tabs(): Promise<void> {
  await ensureTab(SIGNAL_V2_TABS.events, SIGNAL_EVENT_HEADERS);
  await ensureTab(SIGNAL_V2_TABS.feedback, SIGNAL_FEEDBACK_HEADERS);
  await ensureTab(SIGNAL_V2_TABS.metrics, SIGNAL_METRIC_HEADERS);
  await ensureConfigSeeded();
}

export async function loadSignalEvents(opts: { sinceDays?: number } = {}): Promise<
  SignalEventRow[]
> {
  let rows: string[][] = [];
  try {
    rows = await fetchSheetTab(SIGNAL_V2_TABS.events);
  } catch {
    return [];
  }
  const out: SignalEventRow[] = [];
  const cutoff =
    opts.sinceDays && opts.sinceDays > 0
      ? new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString().split("T")[0]
      : "";
  for (let i = 1; i < rows.length; i++) {
    const e = eventFromRow(rows[i], i + 1);
    if (!e) continue;
    if (cutoff && (e.lastUpdated || e.firstSeen) < cutoff) continue;
    out.push(e);
  }
  return out;
}

/** Append brand-new events and rewrite changed ones, serialized. */
export async function persistSignalEvents(input: {
  created: SignalEventRow[];
  updated: SignalEventRow[];
}): Promise<void> {
  const { created, updated } = input;
  if (created.length === 0 && updated.length === 0) return;
  await serialized(async () => {
    if (created.length > 0) {
      await appendSheetRows(SIGNAL_V2_TABS.events, created.map(rowFromEvent));
    }
    for (const e of updated) {
      if (e.rowNumber > 0) {
        await writeSheetRow(SIGNAL_V2_TABS.events, e.rowNumber, rowFromEvent(e));
      } else {
        await appendSheetRows(SIGNAL_V2_TABS.events, [rowFromEvent(e)]);
      }
    }
  });
}

export function newEventId(): string {
  return `sev-${crypto.randomUUID().slice(0, 8)}`;
}

// ── Feedback + metrics (WS5) ─────────────────────────────────────

export type FeedbackAction =
  | "rendered"
  | "expanded"
  | "clicked_source"
  | "actioned"
  | "dismissed"
  | "ignored";

export interface FeedbackRow {
  dateIso: string;
  eventId: string;
  signalId: string;
  action: FeedbackAction;
  user: string;
  rankPosition: number | null;
  featureVector: Record<string, unknown>;
}

export async function appendSignalFeedback(rows: FeedbackRow[]): Promise<void> {
  if (rows.length === 0) return;
  await ensureTab(SIGNAL_V2_TABS.feedback, SIGNAL_FEEDBACK_HEADERS);
  await serialized(() =>
    appendSheetRows(
      SIGNAL_V2_TABS.feedback,
      rows.map((r) => [
        r.dateIso,
        r.eventId,
        r.signalId,
        r.action,
        r.user || "unknown",
        r.rankPosition == null ? "" : String(r.rankPosition),
        JSON.stringify(r.featureVector).slice(0, 4000),
      ]),
    ),
  );
}

export async function loadSignalFeedback(opts: { sinceDays?: number } = {}): Promise<
  FeedbackRow[]
> {
  let rows: string[][] = [];
  try {
    rows = await fetchSheetTab(SIGNAL_V2_TABS.feedback);
  } catch {
    return [];
  }
  const cutoff =
    opts.sinceDays && opts.sinceDays > 0
      ? new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString()
      : "";
  const out: FeedbackRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const dateIso = (r[0] || "").trim();
    if (!dateIso || (cutoff && dateIso < cutoff)) continue;
    out.push({
      dateIso,
      eventId: (r[1] || "").trim(),
      signalId: (r[2] || "").trim(),
      action: ((r[3] || "").trim() as FeedbackAction) || "rendered",
      user: (r[4] || "").trim(),
      rankPosition: r[5] ? num(r[5]) : null,
      featureVector: parseJson<Record<string, unknown>>(r[6] || "", {}),
    });
  }
  return out;
}

export async function appendSignalMetric(
  metric: string,
  value: number,
  details: Record<string, unknown> = {},
): Promise<void> {
  await ensureTab(SIGNAL_V2_TABS.metrics, SIGNAL_METRIC_HEADERS);
  await serialized(() =>
    appendSheetRows(SIGNAL_V2_TABS.metrics, [
      [
        new Date().toISOString().split("T")[0],
        metric,
        String(value),
        JSON.stringify(details).slice(0, 2000),
      ],
    ]),
  );
}

export async function loadSignalMetrics(
  metric: string,
  opts: { sinceDays?: number } = {},
): Promise<Array<{ date: string; value: number; details: Record<string, unknown> }>> {
  let rows: string[][] = [];
  try {
    rows = await fetchSheetTab(SIGNAL_V2_TABS.metrics);
  } catch {
    return [];
  }
  const cutoff =
    opts.sinceDays && opts.sinceDays > 0
      ? new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString().split("T")[0]
      : "";
  const out: Array<{ date: string; value: number; details: Record<string, unknown> }> = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if ((r[1] || "").trim() !== metric) continue;
    const date = (r[0] || "").trim();
    if (cutoff && date < cutoff) continue;
    out.push({ date, value: num(r[2] || ""), details: parseJson(r[3] || "", {}) });
  }
  return out;
}

// ── Config: sheet overrides on top of checked-in defaults ────────
//
// The Signal Config tab is a flat (Section, Key, Value) table seeded from
// DEFAULT_SIGNAL_CONFIG on first run. Analysts edit Values in place; unknown
// sections/keys are ignored; malformed values fall back to the default. The
// merged config is what every pipeline stage receives — weights never live in
// code paths.

type ScalarSection =
  | "clustering"
  | "confidence"
  | "ranking"
  | "surprise"
  | "feed"
  | "watchTiers"
  | "fusionScalars";

function configRows(cfg: SignalConfig): string[][] {
  const rows: string[][] = [];
  for (const [type, tc] of Object.entries(cfg.eventTaxonomy)) {
    rows.push(["taxonomy", type, String(tc.prior), tc.label]);
  }
  rows.push(["sourceTiers", "tierA", JSON.stringify(cfg.sourceTiers.tierA), "primary sources"]);
  rows.push(["sourceTiers", "tierB", JSON.stringify(cfg.sourceTiers.tierB), "original reporting"]);
  for (const rule of cfg.fusion.corroborationMap) {
    rows.push([
      "corroboration",
      rule.newsType,
      JSON.stringify({ intelStates: rule.intelStates, windowDays: rule.windowDays }),
      "news type ↔ intel states",
    ]);
  }
  const scalarSections: Array<[ScalarSection, Record<string, unknown>]> = [
    ["clustering", cfg.clustering as unknown as Record<string, unknown>],
    ["confidence", cfg.confidence as unknown as Record<string, unknown>],
    ["ranking", cfg.ranking as unknown as Record<string, unknown>],
    ["surprise", cfg.surprise as unknown as Record<string, unknown>],
    ["feed", cfg.feed as unknown as Record<string, unknown>],
    ["watchTiers", cfg.watchTiers as unknown as Record<string, unknown>],
    [
      "fusionScalars",
      {
        materialityMultiplier: cfg.fusion.materialityMultiplier,
        detectedBeforePressAgeDays: cfg.fusion.detectedBeforePressAgeDays,
        detectedBeforePressMinConfidence: cfg.fusion.detectedBeforePressMinConfidence,
        detectedBeforePressBoost: cfg.fusion.detectedBeforePressBoost,
      },
    ],
  ];
  for (const [section, obj] of scalarSections) {
    for (const [key, value] of Object.entries(obj)) {
      rows.push([section, key, typeof value === "object" ? JSON.stringify(value) : String(value), ""]);
    }
  }
  return rows;
}

async function ensureConfigSeeded(): Promise<void> {
  await ensureTab(SIGNAL_V2_TABS.config, SIGNAL_CONFIG_HEADERS);
  let rows: string[][] = [];
  try {
    rows = await fetchSheetTab(SIGNAL_V2_TABS.config);
  } catch {
    return;
  }
  const hasData = rows.some(
    (r, i) => i > 0 && (r[0] || "").trim() && (r[1] || "").trim(),
  );
  if (!hasData) {
    await serialized(() =>
      appendSheetRows(SIGNAL_V2_TABS.config, configRows(DEFAULT_SIGNAL_CONFIG)),
    );
  }
}

function parseValue(raw: string): unknown {
  const v = (raw || "").trim();
  if (!v) return undefined;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === "true") return true;
  if (v === "false") return false;
  if (v.startsWith("[") || v.startsWith("{")) {
    try {
      return JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  return v;
}

/** Load the merged (defaults ⊕ sheet overrides) config. Never throws. */
export async function loadSignalConfig(): Promise<SignalConfig> {
  const cfg: SignalConfig = structuredClone(DEFAULT_SIGNAL_CONFIG);
  let rows: string[][] = [];
  try {
    rows = await fetchSheetTab(SIGNAL_V2_TABS.config);
  } catch {
    return cfg;
  }
  const corroboration = new Map<string, CorroborationRule>(
    cfg.fusion.corroborationMap.map((r) => [r.newsType, r]),
  );
  for (let i = 1; i < rows.length; i++) {
    const [secRaw, keyRaw, valRaw] = rows[i] || [];
    const section = (secRaw || "").trim();
    const key = (keyRaw || "").trim();
    const value = parseValue(valRaw || "");
    if (!section || !key || value === undefined) continue;
    try {
      if (section === "taxonomy") {
        const t = key as SignalEventType;
        if (cfg.eventTaxonomy[t] && typeof value === "number") {
          cfg.eventTaxonomy[t].prior = value;
        }
      } else if (section === "sourceTiers") {
        if ((key === "tierA" || key === "tierB") && Array.isArray(value)) {
          cfg.sourceTiers[key] = value.map(String);
        }
      } else if (section === "corroboration") {
        const v = value as { intelStates?: string[]; windowDays?: number };
        if (Array.isArray(v?.intelStates)) {
          corroboration.set(key, {
            newsType: key as SignalEventType,
            intelStates: v.intelStates.map(String),
            windowDays: typeof v.windowDays === "number" ? v.windowDays : 60,
          });
        }
      } else if (section === "fusionScalars") {
        const f = cfg.fusion as unknown as Record<string, unknown>;
        if (key in f && typeof value === typeof f[key]) f[key] = value;
      } else if (
        section === "clustering" ||
        section === "confidence" ||
        section === "ranking" ||
        section === "surprise" ||
        section === "feed" ||
        section === "watchTiers"
      ) {
        const target = cfg[section] as unknown as Record<string, unknown>;
        if (key in target && typeof value === typeof target[key]) target[key] = value;
        else if (key in target && typeof target[key] === "object" && typeof value === "object")
          target[key] = value;
      }
    } catch {
      /* one bad row never poisons the config */
    }
  }
  cfg.fusion.corroborationMap = [...corroboration.values()];
  return cfg;
}
