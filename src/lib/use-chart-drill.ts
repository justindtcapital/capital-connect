import { useState, useCallback, useMemo } from "react";
import { useSearch, useNavigate } from "@tanstack/react-router";

/**
 * One active cross-filter: a chart dimension narrowed to one or more values.
 * Values OR together within a dimension; dimensions AND across each other.
 */
export interface CrossFilter {
  /** Stable key for the dimension (e.g. "sector", "format"). */
  dim: string;
  /** Human label for the dimension (e.g. "Sector") — resolved from the registry. */
  label: string;
  /** The selected values (e.g. ["Security", "Fintech"]). */
  values: string[];
}

/**
 * A reportable dimension. The accessor returns the value(s) an item has for this
 * dimension; charts and the cross-filter predicate both derive from this single
 * declaration, so adding a new filterable field is a one-line registry change.
 */
export interface Dimension<T> {
  /** Stable key matching the value clicked in a chart (the bar/slice label). */
  dim: string;
  /** Human label shown in chips and the drill header. */
  label: string;
  /** Value(s) this item has for the dimension (string or array of strings). */
  get: (item: T) => string | string[];
}

/** Compact per-dimension selection persisted in the URL (`?cf=...`). */
export interface CfParam {
  dim: string;
  values: string[];
}

/**
 * Validate/parse the `cf` search param. Used by each route's `validateSearch`
 * so a shared/refreshed URL rehydrates the cross-filter state. Labels are NOT
 * stored — they're re-derived from the page's dimension registry.
 */
export function parseCfParam(input: unknown): CfParam[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: CfParam[] = [];
  for (const x of input) {
    if (!x || typeof x !== "object") continue;
    const rec = x as Record<string, unknown>;
    if (typeof rec.dim !== "string" || !Array.isArray(rec.values)) continue;
    const values = rec.values.filter((v): v is string => typeof v === "string");
    if (values.length) out.push({ dim: rec.dim, values });
  }
  return out.length ? out : undefined;
}

/** True if `item` satisfies every active cross-filter (OR within a dim, AND across dims). */
export function matchesFilters<T>(item: T, filters: CrossFilter[], dims: Dimension<T>[]): boolean {
  return filters.every((f) => {
    const d = dims.find((x) => x.dim === f.dim);
    if (!d) return true;
    const got = d.get(item);
    const has = Array.isArray(got) ? got : [got];
    return f.values.some((v) => has.includes(v));
  });
}

// Shared interaction model for clickable charts (Dashboard + Events analytics).
// Clicking a chart segment toggles it into a URL-persisted cross-filter (so the
// view is deep-linkable / shareable / refresh-proof) AND opens a drill-down
// sheet listing the records behind the current selection. The dimension registry
// supplies labels and is the single source of truth for what's filterable.
export function useChartDrill<T>(dims: Dimension<T>[]) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { cf?: CfParam[] };
  const rawCf = search.cf;

  const labelOf = useCallback(
    (dim: string) => dims.find((d) => d.dim === dim)?.label ?? dim,
    [dims],
  );

  // The URL is the source of truth; reconstruct CrossFilters (with labels) from it.
  const crossFilters = useMemo<CrossFilter[]>(
    () =>
      (rawCf ?? [])
        .filter((c) => dims.some((d) => d.dim === c.dim))
        .map((c) => ({ dim: c.dim, label: labelOf(c.dim), values: c.values })),
    [rawCf, dims, labelOf],
  );

  const [drill, setDrill] = useState<CrossFilter | null>(null);
  const [drillOpen, setDrillOpen] = useState(false);

  const writeCf = useCallback(
    (next: CfParam[]) => {
      navigate({
        // Stay on the current route; only the `cf` search param changes. `replace`
        // keeps chart clicks out of the browser back-stack.
        search: ((prev: Record<string, unknown>) => ({
          ...prev,
          cf: next.length ? next : undefined,
        })) as never,
        replace: true,
      });
    },
    [navigate],
  );

  const focus = useCallback(
    (dim: string, value: string | number | null | undefined) => {
      const v = value == null ? "" : String(value).trim();
      if (!v || v === "unspecified") return;
      const current = rawCf ?? [];
      const existing = current.find((c) => c.dim === dim);
      // Multi-select: a repeat click toggles the value off; otherwise add it (OR within dim).
      const nextValues = existing
        ? existing.values.includes(v)
          ? existing.values.filter((x) => x !== v)
          : [...existing.values, v]
        : [v];
      const next = current.filter((c) => c.dim !== dim);
      if (nextValues.length) next.push({ dim, values: nextValues });
      writeCf(next);
      if (nextValues.length) {
        setDrill({ dim, label: labelOf(dim), values: nextValues });
        setDrillOpen(true);
      } else {
        setDrill(null);
        setDrillOpen(false);
      }
    },
    [rawCf, writeCf, labelOf],
  );

  const clear = useCallback(
    (dim: string) => writeCf((rawCf ?? []).filter((c) => c.dim !== dim)),
    [rawCf, writeCf],
  );

  const clearAll = useCallback(() => writeCf([]), [writeCf]);

  return { crossFilters, focus, clear, clearAll, drill, drillOpen, setDrillOpen };
}
