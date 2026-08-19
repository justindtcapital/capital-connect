// Infer PortCo Engagement Source from a BD/GTM activity.
// Pure — safe to unit-test. Manual dropdown overrides still win in the UI.

import {
  ENGAGEMENT_SOURCES,
  type AsanaActivity,
  type EngagementSource,
} from "./types";

/** Sheet / UI delimiter for multi-select engagement sources. */
export const ENGAGEMENT_SOURCE_SEP = "; ";

const SOURCE_SET = new Set<string>(ENGAGEMENT_SOURCES);

/**
 * Parse an Engagement Source cell that may hold one value or several
 * (semicolon / comma / pipe separated). Unknown tokens are dropped.
 */
export function parseEngagementSources(raw: string | undefined | null): EngagementSource[] {
  const text = (raw || "").trim();
  if (!text) return ["direct introduction"];
  const parts = text
    .split(/[;|,]/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const out: EngagementSource[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    if (!SOURCE_SET.has(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p as EngagementSource);
  }
  // Preserve ENGAGEMENT_SOURCES display order when possible.
  out.sort((a, b) => ENGAGEMENT_SOURCES.indexOf(a) - ENGAGEMENT_SOURCES.indexOf(b));
  return out.length > 0 ? out : ["direct introduction"];
}

/** Serialize sources for the PortCos Introduced "Engagement Source" cell. */
export function formatEngagementSources(sources: EngagementSource[]): string {
  const uniq = mergeEngagementSources([], sources);
  return uniq.join(ENGAGEMENT_SOURCE_SEP);
}

/** Union of sources, ordered by ENGAGEMENT_SOURCES. */
export function mergeEngagementSources(
  existing: EngagementSource[],
  adding: EngagementSource[] | EngagementSource,
): EngagementSource[] {
  const add = Array.isArray(adding) ? adding : [adding];
  const seen = new Set<string>();
  const out: EngagementSource[] = [];
  for (const s of [...existing, ...add]) {
    if (!s || !SOURCE_SET.has(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  out.sort((a, b) => ENGAGEMENT_SOURCES.indexOf(a) - ENGAGEMENT_SOURCES.indexOf(b));
  return out.length > 0 ? out : ["direct introduction"];
}

/** True when `needle` is already present in a (possibly multi) source cell. */
export function engagementSourcesInclude(
  raw: string | undefined | null,
  needle: EngagementSource,
): boolean {
  return parseEngagementSources(raw).includes(needle);
}

/**
 * Pick the strongest matching engagement source for a synced activity↔PortCo tag.
 *
 * Priority:
 *   1. direct introduction — intro language / type
 *   2. evangelized during network call — pitch / network-call language
 *   3. event exposure — dinners, conferences, webinars, etc.
 *   4. activity interaction — default for email / sync / briefing / working meetings
 */
export function inferEngagementSource(
  a: Pick<AsanaActivity, "name" | "notes" | "type" | "status">,
): EngagementSource {
  const type = (a.type || "").trim().toLowerCase();
  const hay = `${a.name || ""}\n${a.notes || ""}`;

  if (type === "intro" || /\bintroduc(e|ed|ing|tion)s?\b/i.test(hay)) {
    return "direct introduction";
  }

  if (
    /\bevangeliz(e|ed|ing|ation)\b/i.test(hay) ||
    /\b(network\s+call|pitched|positioned|brought\s+up|mentioned\s+to\s+them)\b/i.test(hay)
  ) {
    return "evangelized during network call";
  }

  if (type === "event" || hasPublicEventKeyword(hay)) {
    return "event exposure";
  }

  return "activity interaction";
}

function hasPublicEventKeyword(s: string): boolean {
  return /\b(dinner|breakfast|lunch|happy\s*hour|conference|summit|forum|expo|fair|meetup|meet-up|webinar|workshop|hackathon|tech\s*week|world\s*fair|black\s*hat|rsa|cocktail|reception|awards?|booth)\b/i.test(
    s,
  );
}
