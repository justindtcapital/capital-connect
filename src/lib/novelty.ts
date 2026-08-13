/**
 * Phase 2 — cross-run novelty classification (pure).
 * Before treating a candidate as a brand-new event, compare against prior
 * events for the same entity over a long horizon.
 */

import { tokensOf, tokenSim, normCompanyKey } from "@/lib/event-cluster";
import type { SignalEventType } from "@/lib/signal-config";

export type NoveltyClass = "new" | "update" | "confirmation" | "recycled";

export interface NoveltyPriorEvent {
  eventId: string;
  company: string;
  entityUrid?: string;
  eventType: SignalEventType | string;
  firstSeen: string;
  lastUpdated: string;
  tokens: string[];
  magnitudeKey?: string;
  status?: string;
}

export interface NoveltyCandidate {
  company: string;
  entityUrid?: string;
  eventType: SignalEventType | string;
  title: string;
  text: string;
  dateIso: string;
  magnitudeKey?: string;
  /** True when magnitude/material field is newly validated vs the matched prior. */
  hasNewMaterialField?: boolean;
}

export interface NoveltyConfig {
  horizonDays: number;
  /** Token similarity bar to treat as same story family. */
  mergeSim: number;
}

export const DEFAULT_NOVELTY_CONFIG: NoveltyConfig = {
  horizonDays: 90,
  mergeSim: 0.55,
};

export interface NoveltyResult {
  class: NoveltyClass;
  matchedEventId?: string;
  why: string;
  /** Multiplier applied into rankScore (1.0 new, ~0.5 update, ~0.1 confirmation, 0 recycled). */
  noveltyMult: number;
}

function sameEntity(a: NoveltyCandidate, b: NoveltyPriorEvent): boolean {
  if (a.entityUrid && b.entityUrid) return a.entityUrid === b.entityUrid;
  return normCompanyKey(a.company) === normCompanyKey(b.company);
}

function daysBetween(aIso: string, bIso: string): number {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(a - b) / 86_400_000;
}

export function classifyNovelty(
  candidate: NoveltyCandidate,
  priorEvents: NoveltyPriorEvent[],
  cfg: NoveltyConfig = DEFAULT_NOVELTY_CONFIG,
): NoveltyResult {
  const candTokens = tokensOf(candidate.title, candidate.text);
  const candMag = candidate.magnitudeKey || "";

  let best: { ev: NoveltyPriorEvent; sim: number } | null = null;

  for (const ev of priorEvents) {
    if (ev.status === "closed") continue;
    if (!sameEntity(candidate, ev)) continue;
    if (ev.eventType !== candidate.eventType) continue;
    if (daysBetween(candidate.dateIso, ev.firstSeen) > cfg.horizonDays) continue;

    const sim = tokenSim(candTokens, ev.tokens || []);
    if (sim < cfg.mergeSim) continue;

    if (!best || sim > best.sim) best = { ev, sim };
  }

  if (!best) {
    return {
      class: "new",
      why: "no prior same-type event above merge similarity in horizon",
      noveltyMult: 1,
    };
  }

  const { ev, sim } = best;
  const sameMag =
    Boolean(candMag && ev.magnitudeKey && candMag === ev.magnitudeKey) ||
    (!candMag && !ev.magnitudeKey);

  if (sameMag && !candidate.hasNewMaterialField) {
    // Same magnitude key + high sim → recycled retrospective or pure confirmation.
    const age = daysBetween(candidate.dateIso, ev.firstSeen);
    if (age >= 14) {
      return {
        class: "recycled",
        matchedEventId: ev.eventId,
        why: `same type+magnitude as ${ev.eventId} (${age.toFixed(0)}d earlier, sim ${sim.toFixed(2)})`,
        noveltyMult: 0,
      };
    }
    return {
      class: "confirmation",
      matchedEventId: ev.eventId,
      why: `confirms ${ev.eventId} (sim ${sim.toFixed(2)}, no new magnitude)`,
      noveltyMult: 0.1,
    };
  }

  // New validated magnitude or material field → update.
  if (candidate.hasNewMaterialField || (candMag && ev.magnitudeKey && candMag !== ev.magnitudeKey)) {
    return {
      class: "update",
      matchedEventId: ev.eventId,
      why: `update to ${ev.eventId} (sim ${sim.toFixed(2)}, new material field/magnitude)`,
      noveltyMult: 0.5,
    };
  }

  return {
    class: "confirmation",
    matchedEventId: ev.eventId,
    why: `near-duplicate of ${ev.eventId} (sim ${sim.toFixed(2)})`,
    noveltyMult: 0.1,
  };
}
