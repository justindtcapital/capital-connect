import type { Dimension } from "./use-chart-drill";

// Config-driven charting: a chart is described by a ChartSpec rather than
// hand-coded recharts JSX. Combined with the dimension registry this gives an
// Asana-style "add chart" builder for free, plus the chart types we lacked:
//   • numeric roll-up  → metric is a "sum" measure (not just record count)
//   • stacked bar      → splitBy a second dimension
//   • multi-metric     → compare a second measure on the same axis

export type ChartStyle = "bar" | "hbar" | "line" | "pie";

/** A numeric measure to aggregate (e.g. record count, total headcount). */
export interface Metric<T> {
  key: string;
  label: string;
  /** Per-item numeric contribution (record count uses () => 1). */
  get: (item: T) => number;
}

export interface ChartSpec {
  id: string;
  /** Dimension key to group on (the x-axis / slices). */
  groupBy: string;
  /** Primary measure key. */
  metric: string;
  /** Optional second dimension → stacked/series breakdown (ignored for pie). */
  splitBy?: string;
  /** Optional second measure overlaid on the same axis (ignored if splitBy set or pie). */
  compare?: string;
  style: ChartStyle;
  /** Optional custom title; otherwise derived from the registry. */
  title?: string;
}

export interface Series {
  key: string;
  label: string;
}

export interface AggResult {
  data: Array<Record<string, string | number>>;
  series: Series[];
}

const TOP_GROUPS = 20;
const TOP_SPLITS = 8;
const EMPTY = "Unspecified";

function valuesFor<T>(item: T, dim: Dimension<T>): string[] {
  const g = dim.get(item);
  const arr = Array.isArray(g) ? g : [g];
  const out = arr.map((v) => (v == null ? "" : String(v).trim()) || EMPTY);
  return out.length ? out : [EMPTY];
}

/**
 * Aggregate items into chart-ready rows for a spec. Multi-valued dimensions
 * (e.g. a contact's events) contribute to every group they belong to. Groups
 * and split series are capped (top-N by total) to keep charts legible. Split
 * series get index-based keys (s0, s1…) so raw values containing dots don't
 * confuse recharts' dataKey path parsing.
 */
export function aggregate<T>(
  items: T[],
  spec: ChartSpec,
  dims: Dimension<T>[],
  metrics: Metric<T>[],
): AggResult {
  const groupDim = dims.find((d) => d.dim === spec.groupBy);
  const metric = metrics.find((m) => m.key === spec.metric);
  if (!groupDim || !metric) return { data: [], series: [] };

  // Pie shows a single measure across one dimension — no split/compare.
  const splitDim =
    spec.style !== "pie" && spec.splitBy ? dims.find((d) => d.dim === spec.splitBy) : undefined;
  const compareMetric =
    spec.style !== "pie" && !splitDim && spec.compare
      ? metrics.find((m) => m.key === spec.compare)
      : undefined;

  if (splitDim) {
    const groups = new Map<string, Map<string, number>>();
    const splitTotals = new Map<string, number>();
    const groupTotals = new Map<string, number>();
    for (const item of items) {
      const mv = metric.get(item);
      for (const gv of valuesFor(item, groupDim)) {
        const row = groups.get(gv) ?? new Map<string, number>();
        for (const sv of valuesFor(item, splitDim)) {
          row.set(sv, (row.get(sv) || 0) + mv);
          splitTotals.set(sv, (splitTotals.get(sv) || 0) + mv);
        }
        groups.set(gv, row);
        groupTotals.set(gv, (groupTotals.get(gv) || 0) + mv);
      }
    }
    const topSplits = [...splitTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_SPLITS)
      .map(([k]) => k);
    const series = topSplits.map((label, i) => ({ key: `s${i}`, label }));
    const data = [...groupTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_GROUPS)
      .map(([gv]) => {
        const row: Record<string, string | number> = { name: gv };
        const sm = groups.get(gv);
        topSplits.forEach((sv, i) => {
          row[`s${i}`] = sm?.get(sv) || 0;
        });
        return row;
      });
    return { data, series };
  }

  // Single measure (optionally a second compare measure on the same axis).
  const primary = new Map<string, number>();
  const compare = new Map<string, number>();
  for (const item of items) {
    const mv = metric.get(item);
    const cv = compareMetric ? compareMetric.get(item) : 0;
    for (const gv of valuesFor(item, groupDim)) {
      primary.set(gv, (primary.get(gv) || 0) + mv);
      if (compareMetric) compare.set(gv, (compare.get(gv) || 0) + cv);
    }
  }
  const series: Series[] = [{ key: "value", label: metric.label }];
  if (compareMetric) series.push({ key: "compare", label: compareMetric.label });
  const data = [...primary.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_GROUPS)
    .map(([gv, v]) => {
      const row: Record<string, string | number> = { name: gv, value: v };
      if (compareMetric) row.compare = compare.get(gv) || 0;
      return row;
    });
  return { data, series };
}

/** Human title for a chart, derived from the registry unless one was set. */
export function chartTitle<T>(spec: ChartSpec, dims: Dimension<T>[], metrics: Metric<T>[]): string {
  if (spec.title?.trim()) return spec.title.trim();
  const g = dims.find((d) => d.dim === spec.groupBy)?.label ?? spec.groupBy;
  const m = metrics.find((x) => x.key === spec.metric)?.label ?? spec.metric;
  let t = `${m} by ${g}`;
  if (spec.style !== "pie" && spec.splitBy) {
    const s = dims.find((d) => d.dim === spec.splitBy)?.label ?? spec.splitBy;
    t += ` · split by ${s}`;
  } else if (spec.style !== "pie" && spec.compare) {
    const c = metrics.find((x) => x.key === spec.compare)?.label ?? spec.compare;
    t += ` vs ${c}`;
  }
  return t;
}

function isValidSpec(x: unknown): x is ChartSpec {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.groupBy === "string" &&
    typeof r.metric === "string" &&
    (r.style === "bar" || r.style === "hbar" || r.style === "line" || r.style === "pie")
  );
}

/** Custom charts persist per page in localStorage (survives reload / is per-user). */
export function loadCharts(key: string): ChartSpec[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed.filter(isValidSpec) : [];
  } catch {
    return [];
  }
}

export function saveCharts(key: string, specs: ChartSpec[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(specs));
  } catch {
    /* ignore quota / private-mode errors */
  }
}

export function newChartId(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  return c?.randomUUID ? c.randomUUID() : `c-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}
