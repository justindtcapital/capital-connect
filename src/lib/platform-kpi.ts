// Portfolio-company KPI model for the /platform tab.
//
// Datapoints live in the append-only "PortCo KPIs" sheet tab — one row per
// (company, metric, period) observation. Nothing is ever mutated in place:
// corrections append a fresh row and reads collapse to the newest entry via
// latestWins(). Periods are canonical months ("YYYY-MM") so lexicographic
// order IS chronological order, which keeps chart x-axes and dedup keys
// trivial. This module is pure (client- and server-safe): the metric
// registry below is the single source of truth shared by the entry dialogs,
// the smart-paste extraction prompt, and the trend charts.

export type KpiCategory = "capital" | "commercial" | "digital" | "pmf";

export interface KpiMetricDef {
  key: string;
  label: string;
  unit: "$M" | "#" | "%" | "months" | "score";
}

export const KPI_CATEGORY_LABELS: Record<KpiCategory, string> = {
  capital: "Ownership & valuation",
  commercial: "Commercial",
  digital: "Digital traction",
  pmf: "PMF & product health",
};

// Digital + public valuation metrics are populated by web-grounded lookups
// (source "gemini_web") and deliberately use their own keys so a best-effort
// public number can never overwrite or mask a manually entered figure.
// Asana ownership/investment are shown live from Asana fields (not this sheet).
export const KPI_METRICS: Record<KpiCategory, KpiMetricDef[]> = {
  capital: [
    { key: "post_money_usd_m", label: "Post-money valuation", unit: "$M" },
    { key: "last_round_usd_m", label: "Last round size", unit: "$M" },
    { key: "dtc_ownership_pct", label: "DTC ownership", unit: "%" },
    { key: "dtc_investment_usd_m", label: "DTC investment", unit: "$M" },
  ],
  commercial: [
    { key: "revenue_arr_usd_m", label: "Revenue / ARR", unit: "$M" },
    { key: "gmv_usd_m", label: "GMV", unit: "$M" },
    { key: "customers", label: "Customers", unit: "#" },
    { key: "burn_usd_m", label: "Monthly burn", unit: "$M" },
    { key: "runway_months", label: "Runway", unit: "months" },
  ],
  digital: [
    { key: "linkedin_followers", label: "LinkedIn followers", unit: "#" },
    { key: "x_followers", label: "X followers", unit: "#" },
    { key: "press_mentions_90d", label: "Press mentions (90d)", unit: "#" },
    { key: "traffic_rank_global", label: "Web traffic rank", unit: "#" },
  ],
  pmf: [
    { key: "pmf_very_disappointed_pct", label: "PMF survey (very disappointed)", unit: "%" },
    { key: "nps", label: "NPS", unit: "score" },
    { key: "gross_retention_pct", label: "Gross retention", unit: "%" },
    { key: "logo_churn_pct", label: "Logo churn", unit: "%" },
  ],
};

export const KPI_CATEGORIES = Object.keys(KPI_METRICS) as KpiCategory[];

const METRIC_INDEX = new Map<string, { def: KpiMetricDef; category: KpiCategory }>(
  KPI_CATEGORIES.flatMap((cat) => KPI_METRICS[cat].map((def) => [def.key, { def, category: cat }])),
);

export function metricDef(key: string): KpiMetricDef | undefined {
  return METRIC_INDEX.get(key)?.def;
}

export function metricCategory(key: string): KpiCategory | undefined {
  return METRIC_INDEX.get(key)?.category;
}

// Lower-is-better metrics render inverted delta colors (a falling burn or
// churn is good news).
const LOWER_IS_BETTER = new Set(["burn_usd_m", "logo_churn_pct", "traffic_rank_global"]);

export function lowerIsBetter(metric: string): boolean {
  return LOWER_IS_BETTER.has(metric);
}

export type KpiSource = "manual" | "smart_paste" | "gemini_web";

/** One persisted row of the "PortCo KPIs" tab. */
export interface KpiPoint {
  id: string;
  portcoUrid: string;
  companyName: string;
  category: string;
  metric: string;
  period: string; // canonical "YYYY-MM"
  value: number;
  unit: string;
  source: KpiSource | string;
  note: string;
  enteredBy: string;
  enteredAt: string; // ISO timestamp
}

/** A datapoint about to be written; category/unit derive from the registry. */
export interface NewKpiPoint {
  portcoUrid: string;
  companyName: string;
  metric: string;
  period: string;
  value: number;
  source: KpiSource;
  note?: string;
}

/** One row extracted from pasted text / uploaded docs, pending user review. */
export interface ExtractedKpi {
  metric: string;
  value: number;
  period: string | null;
  quote: string;
}

/** Attachment sent from the browser for smart-paste extraction (inline to Gemini). */
export interface KpiPasteAttachment {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** base64 with no data: prefix */
  dataBase64: string;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

const QUARTER_END: Record<string, string> = { "1": "03", "2": "06", "3": "09", "4": "12" };

/**
 * Normalize a human/LLM-supplied period to canonical "YYYY-MM".
 * Accepts "2025-09", "2025-09-15", "Q3 2025" / "2025 Q3" / "Q3'25",
 * "Sep 2025" / "September 2025", "9/2025", "09/15/2025".
 * Returns null when the input is ambiguous or unparseable (e.g. a bare year).
 */
export function normalizePeriod(input: string | null | undefined): string | null {
  const s = (input ?? "").trim();
  if (!s) return null;

  let m = /^(\d{4})-(\d{1,2})(?:-\d{1,2}.*)?$/.exec(s);
  if (m) return monthOrNull(m[1], m[2]);

  m = /^q([1-4])\s*[' ]?\s*(\d{2}|\d{4})$/i.exec(s);
  if (m) return `${fullYear(m[2])}-${QUARTER_END[m[1]]}`;

  m = /^(\d{4})\s*q([1-4])$/i.exec(s);
  if (m) return `${m[1]}-${QUARTER_END[m[2]]}`;

  m = /^([a-z]{3,9})\.?\s+(\d{2}|\d{4})$/i.exec(s);
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return month ? `${fullYear(m[2])}-${month}` : null;
  }

  m = /^(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return monthOrNull(m[2], m[1]);

  m = /^(\d{1,2})\/\d{1,2}\/(\d{4})$/.exec(s);
  if (m) return monthOrNull(m[2], m[1]);

  return null;
}

function fullYear(y: string): string {
  return y.length === 2 ? `20${y}` : y;
}

function monthOrNull(year: string, month: string): string | null {
  const n = Number(month);
  if (!Number.isInteger(n) || n < 1 || n > 12) return null;
  return `${year}-${String(n).padStart(2, "0")}`;
}

/** Canonical period for "now" — used for web-sourced datapoints. */
export function currentPeriod(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function normalizeCompanyName(name: string): string {
  return name.trim().toLowerCase();
}

function pointKey(p: KpiPoint): string {
  const who = p.portcoUrid.trim() || normalizeCompanyName(p.companyName);
  return `${who}|${p.metric}|${p.period}`;
}

/**
 * Collapse the append-only log to the newest entry per
 * (company, metric, period). Corrections therefore just append.
 */
export function latestWins(points: KpiPoint[]): KpiPoint[] {
  const best = new Map<string, KpiPoint>();
  for (const p of points) {
    const key = pointKey(p);
    const prev = best.get(key);
    if (!prev || p.enteredAt >= prev.enteredAt) best.set(key, p);
  }
  return [...best.values()];
}

/** Points belonging to one portco — URID match first, name fallback. */
export function pointsForCompany(
  points: KpiPoint[],
  company: { urid?: string; name: string },
): KpiPoint[] {
  const urid = (company.urid ?? "").trim();
  const name = normalizeCompanyName(company.name);
  return points.filter((p) =>
    urid && p.portcoUrid.trim() ? p.portcoUrid.trim() === urid : normalizeCompanyName(p.companyName) === name,
  );
}

/** Chronological series for one metric, ready for a recharts LineChart. */
export function seriesFor(
  points: KpiPoint[],
  metric: string,
): { period: string; value: number }[] {
  return latestWins(points.filter((p) => p.metric === metric))
    .sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0))
    .map((p) => ({ period: p.period, value: p.value }));
}

export function formatKpiValue(value: number, unit: string): string {
  switch (unit) {
    case "$M":
      return `$${value % 1 === 0 ? value : value.toFixed(1)}M`;
    case "%":
      return `${value % 1 === 0 ? value : value.toFixed(1)}%`;
    case "months":
      return `${value % 1 === 0 ? value : value.toFixed(1)} mo`;
    case "#":
      return value.toLocaleString();
    default:
      return String(value);
  }
}

/** "2025-09" → "Sep 2025" for axis ticks and stat cards. */
export function formatPeriod(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return period;
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const idx = Number(m[2]) - 1;
  return idx >= 0 && idx < 12 ? `${names[idx]} ${m[1]}` : period;
}
