import type { Contact, Interaction } from "@/lib/types";
import { daysSinceLastContact } from "@/lib/activity-score";
import {
  computeInfluence,
  portCoFrequency,
  type InfluenceBreakdown,
} from "@/lib/constellation-influence";

const DAY_MS = 1000 * 60 * 60 * 24;

export type TimeHorizon = "today" | "30d" | "quarter" | "year" | "all";

export const TIME_HORIZONS: { id: TimeHorizon; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "30d", label: "30d" },
  { id: "quarter", label: "Quarter" },
  { id: "year", label: "Year" },
  { id: "all", label: "All" },
];

export function horizonOffsetMs(horizon: TimeHorizon): number {
  switch (horizon) {
    case "today":
      return 0;
    case "30d":
      return 30 * DAY_MS;
    case "quarter":
      return 90 * DAY_MS;
    case "year":
      return 365 * DAY_MS;
    case "all":
      return 0;
  }
}

/** Point-in-time "now" for the scrubber. */
export function asOfTimestamp(horizon: TimeHorizon, now = Date.now()): number {
  return now - horizonOffsetMs(horizon);
}

function parseDate(value?: string): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** Project a contact as it would have appeared at asOf (interactions/intros after asOf removed). */
export function contactAsOf(contact: Contact, asOf: number, horizon: TimeHorizon): Contact {
  if (horizon === "today" || horizon === "all") return contact;

  const interactions = (contact.interactions || []).filter((i: Interaction) => {
    const d = parseDate(i.date);
    return d === null || d <= asOf;
  });

  const engagements = (contact.portCoEngagements || []).filter((e) => {
    const d = parseDate(e.date);
    return d === null || d <= asOf;
  });

  // Prefer engagement-derived intros when we have dated engagements; else keep intros
  // but only if the contact existed by asOf.
  const dateAdded = parseDate(contact.dateAdded);
  const existed = dateAdded === null || dateAdded <= asOf;

  let portCoIntros = contact.portCoIntros || [];
  if (engagements.length > 0) {
    portCoIntros = [...new Set(engagements.map((e) => e.portco).filter(Boolean))];
  } else if (!existed) {
    portCoIntros = [];
  }

  let lastContact = contact.lastContact;
  const lastMs = parseDate(lastContact);
  if (lastMs !== null && lastMs > asOf) {
    const latestIx = interactions
      .map((i) => parseDate(i.date))
      .filter((d): d is number => d !== null);
    lastContact = latestIx.length
      ? new Date(Math.max(...latestIx)).toISOString().slice(0, 10)
      : undefined;
  }

  return {
    ...contact,
    interactions,
    portCoEngagements: engagements,
    portCoIntros,
    lastContact,
    eventsAttended: existed ? contact.eventsAttended : [],
  };
}

export function isGhostAtHorizon(contact: Contact, asOf: number, horizon: TimeHorizon): boolean {
  if (horizon === "today" || horizon === "all") return false;
  const added = parseDate(contact.dateAdded);
  if (added !== null && added > asOf) return true;
  const days = daysSinceLastContact(contact, asOf);
  // Never touched by asOf and no dated presence → soft ghost if only modern activity
  if (days === null && added === null) {
    const anyPast = (contact.interactions || []).some((i) => {
      const d = parseDate(i.date);
      return d !== null && d <= asOf;
    });
    return !anyPast && (contact.interactions?.length ?? 0) > 0;
  }
  return false;
}

export function influenceAtHorizon(
  contact: Contact,
  cohort: Contact[],
  horizon: TimeHorizon,
  now = Date.now(),
): { influence: InfluenceBreakdown; projected: Contact; ghost: boolean } {
  const asOf = asOfTimestamp(horizon, now);
  const projected = contactAsOf(contact, asOf, horizon);
  const projectedCohort = cohort.map((c) => contactAsOf(c, asOf, horizon));
  const freq = portCoFrequency(projectedCohort);
  const influence = computeInfluence(projected, projectedCohort, freq, asOf);
  const ghost = isGhostAtHorizon(contact, asOf, horizon);
  return { influence, projected, ghost };
}
