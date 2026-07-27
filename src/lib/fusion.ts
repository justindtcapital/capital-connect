// WS3 — pipeline fusion (pure functions): the intel engine (5:30, measured
// exhaust) and the news scan (6:00, grounded press) describe the same world.
// Their agreement/disagreement is the strongest quality signal available:
//
//   news + matching intel  → corroboration (confidence & materiality boost,
//                            evidence lines on the card)
//   intel first, news later → MERGE into the intel event's timeline; the card
//                            is badged CONFIRMED BY PRESS
//   intel, no news after N  → DETECTED BEFORE PRESS — the alpha class
//
// Pure and fixture-testable; persistence lives in the pipeline/reconcile jobs.

import type { SignalConfig, SignalEventType } from "@/lib/signal-config";
import { normCompanyKey } from "@/lib/event-cluster";

/** Minimal Intel Events row shape (subset of intel.server's EventRow). */
export interface IntelEventLite {
  eventId: string;
  urid: string;
  entity: string;
  state: string;
  status: string;
  firstDetected: string;
  lastUpdated: string;
  confidence: number;
  /** Human-readable observation lines ("Form D filed 2026-07-11", "sales postings +4σ"). */
  evidenceLines: string[];
  signalId: string;
}

/** Intel lifecycle states that still describe a live development. */
const LIVE_INTEL_STATUS = new Set(["emerging", "strengthening", "confirmed"]);

export function isLiveIntelEvent(status: string): boolean {
  return LIVE_INTEL_STATUS.has((status || "").trim().toLowerCase());
}

const dayDiff = (aIso: string, bIso: string): number => {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(a - b) / 86_400_000;
};

export interface CorroborationMatch {
  intel: IntelEventLite;
  rule: { newsType: SignalEventType; intelStates: string[]; windowDays: number };
  /** True when the intel event predates the news event (intel keeps first_seen_at). */
  intelWasFirst: boolean;
}

/**
 * News→intel corroboration: find the live intel event for the same company
 * whose state the corroboration map pairs with this news type, within the
 * rule's trailing window. Most recent match wins.
 */
export function matchIntelCorroboration(
  input: {
    newsType: SignalEventType;
    company: string;
    entityUrid?: string;
    newsFirstSeen: string;
  },
  intelEvents: IntelEventLite[],
  cfg: SignalConfig,
): CorroborationMatch | null {
  const rule = cfg.fusion.corroborationMap.find((r) => r.newsType === input.newsType);
  if (!rule) return null;
  const companyKey = normCompanyKey(input.company);
  let best: CorroborationMatch | null = null;
  for (const ie of intelEvents) {
    if (!isLiveIntelEvent(ie.status)) continue;
    if (!rule.intelStates.includes(ie.state)) continue;
    const sameCompany =
      (input.entityUrid && ie.urid && input.entityUrid === ie.urid) ||
      normCompanyKey(ie.entity) === companyKey;
    if (!sameCompany) continue;
    if (dayDiff(input.newsFirstSeen, ie.lastUpdated) > rule.windowDays &&
        dayDiff(input.newsFirstSeen, ie.firstDetected) > rule.windowDays)
      continue;
    if (!best || (ie.lastUpdated || ie.firstDetected) > (best.intel.lastUpdated || best.intel.firstDetected)) {
      best = {
        intel: ie,
        rule,
        intelWasFirst: (ie.firstDetected || "") < input.newsFirstSeen,
      };
    }
  }
  return best;
}

/** Inverse map: which news types would confirm a given intel state? */
export function newsTypesForIntelState(state: string, cfg: SignalConfig): SignalEventType[] {
  return cfg.fusion.corroborationMap
    .filter((r) => r.intelStates.includes(state))
    .map((r) => r.newsType);
}

/**
 * DETECTED BEFORE PRESS eligibility — the alpha class: a live intel event with
 * material readings, old enough that press would have arrived, and no news
 * event matching its state for the same company.
 */
export function isDetectedBeforePress(
  intel: IntelEventLite,
  hasMatchingNewsEvent: boolean,
  todayIso: string,
  cfg: SignalConfig,
): boolean {
  if (!isLiveIntelEvent(intel.status)) return false;
  if (hasMatchingNewsEvent) return false;
  if (intel.confidence < cfg.fusion.detectedBeforePressMinConfidence) return false;
  return dayDiff(todayIso, intel.firstDetected) >= cfg.fusion.detectedBeforePressAgeDays;
}

/** Taxonomy type an intel state ranks under (for intel-only card materiality). */
export function taxonomyTypeForIntelState(
  state: string,
  cfg: SignalConfig,
): SignalEventType {
  return cfg.fusion.intelStateTaxonomy[state] || "other";
}

// ── Badges (shared slugs; feed renders them distinctly) ──────────

export const BADGE = {
  detectedBeforePress: "DETECTED_BEFORE_PRESS",
  confirmedByPress: "CONFIRMED_BY_PRESS",
  intelCorroborated: "INTEL_CORROBORATED",
  promoted: "PROMOTED_TO_WATCHLIST",
} as const;

/** Set-union badge merge, order-stable, semicolon-serialized on rows. */
export function mergeBadges(existing: string, ...add: string[]): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const b of [...(existing || "").split(";"), ...add]) {
    const t = b.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.join(";");
}
