// Collapse duplicate portfolio-company cards (Sheet rows + Asana-only orphans).
// Pure — safe to unit test.

import { normalizePortcoName } from "./portco-names";
import { extractDomain } from "./domain-utils";

export interface DedupableCompany {
  id: string;
  name: string;
  website?: string;
  urid?: string;
}

/** Normalized website host, or "" when there's no usable website. */
export function portcoDomainKey(website?: string): string {
  const d = extractDomain(website || "");
  return (d || "").replace(/^www\./, "").toLowerCase();
}

function score(c: DedupableCompany): number {
  // Prefer real sheet rows (URID) over Asana-only cards, and richer records.
  let s = 0;
  if (c.urid) s += 100;
  if (!c.id.startsWith("asana-pc-")) s += 50;
  if (portcoDomainKey(c.website)) s += 10;
  return s;
}

/**
 * Keep one card per company, matching on normalized name OR website domain.
 * The best-scoring record wins; later duplicates are dropped (their Asana
 * fields/events are merged into the winner when a merge fn is supplied).
 */
export function dedupePortfolioCompanies<T extends DedupableCompany>(
  companies: T[],
  merge?: (winner: T, dropped: T) => T,
): T[] {
  const out: T[] = [];
  const nameKeyToIndex = new Map<string, number>();
  const domainKeyToIndex = new Map<string, number>();

  for (const c of companies) {
    const nameKey = normalizePortcoName(c.name) || (c.name || "").trim().toLowerCase();
    const domainKey = portcoDomainKey(c.website);
    const existingIndex =
      (nameKey ? nameKeyToIndex.get(nameKey) : undefined) ??
      (domainKey ? domainKeyToIndex.get(domainKey) : undefined);

    if (existingIndex === undefined) {
      const index = out.length;
      out.push(c);
      if (nameKey) nameKeyToIndex.set(nameKey, index);
      if (domainKey) domainKeyToIndex.set(domainKey, index);
      continue;
    }

    const existing = out[existingIndex];
    const winner = score(c) > score(existing) ? c : existing;
    const dropped = winner === c ? existing : c;
    out[existingIndex] = merge ? merge(winner, dropped) : winner;
    // Register the extra keys so a third spelling also collapses here.
    if (nameKey && !nameKeyToIndex.has(nameKey)) nameKeyToIndex.set(nameKey, existingIndex);
    if (domainKey && !domainKeyToIndex.has(domainKey))
      domainKeyToIndex.set(domainKey, existingIndex);
  }

  return out;
}
