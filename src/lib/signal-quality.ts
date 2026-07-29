// Shared soft-gate + digest headline helpers for the Signals write path.
// Pure functions — safe to import from scan, digest archive, and unit tests.

import type { SignalConfig } from "./signal-config";
import { eventRelevance } from "./materiality";

export interface AwarenessProxyFacts {
  isPortco: boolean;
  isWatch: boolean;
  networkContactCount: number;
}

/** CRM-fact relevance proxy (0–10) when no recommendation attribution exists. */
export function awarenessRelevanceProxy(
  facts: AwarenessProxyFacts,
  cfg: SignalConfig,
): number {
  return eventRelevance(
    {
      recRelevances: [],
      isPortco: facts.isPortco,
      isWatch: facts.isWatch,
      networkContactCount: facts.networkContactCount,
    },
    cfg,
  ).relevance;
}

/**
 * Soft gate for sheet persistence. Recommendations always pass.
 * Awareness passes when relevance or materiality clears the configured floor.
 */
export function passesAwarenessQualityGate(
  s: {
    type: string;
    relevance?: number | null;
    materiality?: number | null;
  },
  cfg: SignalConfig,
): boolean {
  if ((s.type || "").toLowerCase() === "recommendation") return true;
  const rel = Number(s.relevance) || 0;
  const matRaw = s.materiality == null ? 0 : Number(s.materiality);
  const matN = Number.isFinite(matRaw) ? matRaw : 0;
  const g = cfg.qualityGate ?? { minRelevance: 5, minMateriality: 6 };
  return rel >= g.minRelevance || matN >= g.minMateriality;
}

/** Minimum usable OG/meta description length before falling back to the title. */
export const DIGEST_SNIPPET_MIN_CHARS = 40;

/** True when a digest description is long enough and sentence-like to use as the signal. */
export function isUsableDigestSnippet(snippet: string): boolean {
  const s = (snippet || "").trim().replace(/\s+/g, " ");
  if (s.length < DIGEST_SNIPPET_MIN_CHARS) return false;
  // Single token / truncated fragments ("AI", "We", "approx. $1.") are not usable.
  if (!/\s/.test(s)) return false;
  return true;
}

/**
 * Prefer a usable page description; otherwise use the article title.
 * Avoids storing garbage headlines like "AI" or "We" from bad OG tags.
 */
export function digestHeadline(snippet: string, title: string): string {
  const snip = (snippet || "").trim().replace(/\s+/g, " ");
  const tit = (title || "").trim().replace(/\s+/g, " ");
  if (isUsableDigestSnippet(snip)) return snip;
  return tit || snip;
}
