// Fuzzy portfolio-company name matching (Sheet ↔ Asana).
// Handles "VAST" ↔ "VAST Data", "Bland" ↔ "Bland AI", "SiMa" ↔ "SiMa.ai", etc.
// Pure — safe client-side / fixture-testable.

import { extractDomain } from "@/lib/domain-utils";
import type { PortfolioCompany, PortfolioEvent, PortfolioIntro } from "@/lib/types";

/** Strip legal/product suffixes and punctuation for loose comparison. */
export function normalizePortcoName(name: string): string {
  return (name || "")
    .toLowerCase()
    // Turn domain-style suffixes into tokens before punctuation wipe ("sima.ai" → "sima ai").
    .replace(/\.ai\b/g, " ai ")
    .replace(/[.,'’]/g, "")
    .replace(
      /\b(incorporated|inc|corporation|corp|company|co|llc|llp|lp|ltd|limited|labs|technologies|ai)\b/g,
      "",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Score how well two company names refer to the same portco.
 * 0 = no match; higher is better. Exact / normalized equality beat substrings.
 */
export function scorePortcoNameMatch(a: string, b: string): number {
  const la = (a || "").trim().toLowerCase();
  const lb = (b || "").trim().toLowerCase();
  if (!la || !lb) return 0;
  if (la === lb) return 1000;

  const na = normalizePortcoName(a);
  const nb = normalizePortcoName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 900;
  if (na.includes(nb) || nb.includes(na)) {
    const shorter = Math.min(na.length, nb.length);
    const longer = Math.max(na.length, nb.length);
    // Prefer tighter containment ("vast"/"vast data" ≫ "a"/"alation").
    if (shorter < 2) return 0;
    return 100 + Math.round((100 * shorter) / longer);
  }
  return 0;
}

export function portcoNamesMatch(a: string, b: string): boolean {
  return scorePortcoNameMatch(a, b) > 0;
}

/**
 * Greedy 1:1 map from sheet company names → Asana lookup keys.
 * Each Asana key and each sheet name is claimed at most once (best score first).
 */
export function matchSheetToAsanaKeys(
  sheetNames: string[],
  asanaKeys: string[],
  asanaDisplayName?: (key: string) => string,
): Map<string, string> {
  const display = asanaDisplayName || ((k: string) => k);
  type Pair = { sheet: string; asanaKey: string; score: number };
  const pairs: Pair[] = [];

  for (const sheet of sheetNames) {
    for (const key of asanaKeys) {
      const score = Math.max(
        scorePortcoNameMatch(sheet, key),
        scorePortcoNameMatch(sheet, display(key)),
      );
      if (score > 0) pairs.push({ sheet, asanaKey: key, score });
    }
  }

  pairs.sort((a, b) => b.score - a.score || b.asanaKey.length - a.asanaKey.length);

  const bySheet = new Map<string, string>();
  const usedSheet = new Set<string>();
  const usedAsana = new Set<string>();
  for (const p of pairs) {
    if (usedSheet.has(p.sheet) || usedAsana.has(p.asanaKey)) continue;
    usedSheet.add(p.sheet);
    usedAsana.add(p.asanaKey);
    bySheet.set(p.sheet, p.asanaKey);
  }
  return bySheet;
}

function isAsanaOnlyPortco(c: PortfolioCompany): boolean {
  return (c.id || "").startsWith("asana-pc-");
}

/** Prefer sheet-backed + richer rows when collapsing duplicates. */
function portcoDedupeRank(c: PortfolioCompany): number {
  let rank = 0;
  if (!isAsanaOnlyPortco(c)) rank += 1000;
  if (c.urid) rank += 100;
  if ((c.website || "").trim()) rank += 10;
  if ((c.description || "").trim()) rank += 5;
  if (c.asanaFields && Object.keys(c.asanaFields).length > 0) rank += 5;
  if ((c.events || []).length) rank += Math.min(c.events.length, 5);
  if ((c.location || "").trim()) rank += 2;
  if ((c.sector || "").trim()) rank += 2;
  return rank;
}

function mergePortcoLists<T extends { id: string }>(a: T[] | undefined, b: T[] | undefined): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of [...(a || []), ...(b || [])]) {
    const key = item.id || JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function mergePortfolioCompanyPair(winner: PortfolioCompany, loser: PortfolioCompany): PortfolioCompany {
  const pick = (w: string, l: string) => (w || "").trim() || (l || "").trim() || w || l || "";
  const asanaFields = {
    ...(loser.asanaFields || {}),
    ...(winner.asanaFields || {}),
  };
  return {
    ...winner,
    name: pick(winner.name, loser.name) || winner.name,
    website: pick(winner.website, loser.website),
    linkedinUrl: pick(winner.linkedinUrl, loser.linkedinUrl),
    location: pick(winner.location, loser.location),
    description: pick(winner.description, loser.description),
    sector: pick(winner.sector, loser.sector) || winner.sector,
    contactName: pick(winner.contactName, loser.contactName),
    contactEmail: pick(winner.contactEmail, loser.contactEmail),
    contactPhone: pick(winner.contactPhone, loser.contactPhone),
    urid: winner.urid || loser.urid,
    asanaFields: Object.keys(asanaFields).length > 0 ? asanaFields : undefined,
    events: mergePortcoLists<PortfolioEvent>(winner.events, loser.events),
    introductions: mergePortcoLists<PortfolioIntro>(winner.introductions, loser.introductions),
    employees: mergePortcoLists(winner.employees, loser.employees),
    exposures: (() => {
      const merged = [...(winner.exposures || []), ...(loser.exposures || [])];
      return merged.length > 0 ? merged : undefined;
    })(),
  };
}

/**
 * Collapse duplicate PortCo cards after Sheet + Asana merge.
 * Same normalized name OR same website domain → one card.
 * Prefer sheet-backed (URID) rows over Asana-only orphans; fill blanks from the loser.
 * Does NOT use fuzzy containment — "Twine" and "Twine Security" stay distinct.
 */
export function dedupePortfolioCompanies(companies: PortfolioCompany[]): PortfolioCompany[] {
  const out: PortfolioCompany[] = [];
  const byName = new Map<string, number>();
  const byDomain = new Map<string, number>();

  const findIndex = (c: PortfolioCompany): number => {
    const nameKey = normalizePortcoName(c.name);
    if (nameKey && byName.has(nameKey)) return byName.get(nameKey)!;
    const domain = extractDomain(c.website);
    if (domain && byDomain.has(domain)) return byDomain.get(domain)!;
    return -1;
  };

  const indexKeys = (c: PortfolioCompany, idx: number) => {
    const nameKey = normalizePortcoName(c.name);
    if (nameKey) byName.set(nameKey, idx);
    const domain = extractDomain(c.website);
    if (domain) byDomain.set(domain, idx);
  };

  for (const company of companies) {
    if (!(company.name || "").trim()) continue;
    const existingIdx = findIndex(company);
    if (existingIdx === -1) {
      indexKeys(company, out.length);
      out.push(company);
      continue;
    }

    const existing = out[existingIdx];
    const winnerFirst = portcoDedupeRank(existing) >= portcoDedupeRank(company);
    const merged = winnerFirst
      ? mergePortfolioCompanyPair(existing, company)
      : mergePortfolioCompanyPair(company, existing);
    out[existingIdx] = merged;
    // Re-index in case merge filled a blank name/website.
    indexKeys(merged, existingIdx);
  }

  return out;
}
