import type { Contact, Temperature } from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────
// Automatic network scorecard.
//
// Derives a contact's Hot / Warm / Cold rating from real activity signals that
// already live on the record — no external API needed. The score is 0–100,
// built from five weighted components, then mapped to a tier. All weights and
// thresholds live in named constants below so they're easy to tune.
// ─────────────────────────────────────────────────────────────────────────

const DAY_MS = 1000 * 60 * 60 * 24;

// Component ceilings (must sum to 100).
const WEIGHTS = {
  recency: 40,
  interactions: 30,
  events: 15,
  intros: 10,
  followUp: 5,
} as const;

// Score → tier cutoffs.
const TIER_CUTOFFS = {
  hot: 55, // >= 55 → Hot
  warm: 25, // >= 25 → Warm, else Cold
} as const;

export interface ActivityScore {
  score: number; // 0–100
  tier: Temperature;
  drivers: string[]; // short human-readable reasons, strongest first
}

function parseDate(value?: string): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

// Whole days since we last had any contact with this person (latest of
// lastContact and any logged interaction). Returns null if we've never had
// contact on record.
export function daysSinceLastContact(contact: Contact, now: number = Date.now()): number | null {
  const recentMs = mostRecentActivityMs(contact);
  if (recentMs === null) return null;
  return Math.max(0, Math.floor((now - recentMs) / DAY_MS));
}

// Most recent activity = latest of lastContact and any interaction date.
function mostRecentActivityMs(contact: Contact): number | null {
  const candidates: number[] = [];
  const last = parseDate(contact.lastContact);
  if (last !== null) candidates.push(last);
  for (const i of contact.interactions) {
    const d = parseDate(i.date);
    if (d !== null) candidates.push(d);
  }
  return candidates.length ? Math.max(...candidates) : null;
}

export function scoreContact(contact: Contact, now: number = Date.now()): ActivityScore {
  const drivers: string[] = [];

  // 1. Recency of last activity (0–40).
  let recency = 0;
  const recentMs = mostRecentActivityMs(contact);
  if (recentMs !== null) {
    const days = Math.floor((now - recentMs) / DAY_MS);
    if (days <= 30) {
      recency = WEIGHTS.recency;
      drivers.push("Active in the last 30 days");
    } else if (days <= 90) {
      recency = 30;
      drivers.push("Active in the last 90 days");
    } else if (days <= 180) {
      recency = 20;
      drivers.push("Active in the last 6 months");
    } else if (days <= 365) {
      recency = 10;
      drivers.push("Active in the last year");
    } else {
      drivers.push("No activity in over a year");
    }
  }

  // 2. Interaction volume (0–30), weighted toward recent threads.
  const total = contact.interactions.length;
  const recentCount = contact.interactions.filter((i) => {
    const d = parseDate(i.date);
    return d !== null && now - d <= 90 * DAY_MS;
  }).length;
  let interactions = 0;
  if (total >= 8) interactions = WEIGHTS.interactions;
  else if (total >= 4) interactions = 22;
  else if (total >= 2) interactions = 14;
  else if (total >= 1) interactions = 7;
  if (recentCount >= 2) interactions = Math.min(WEIGHTS.interactions, interactions + 5);
  if (total > 0) {
    drivers.push(`${total} logged interaction${total !== 1 ? "s" : ""}`);
  }

  // 3. Events attended (0–15).
  const eventCount = contact.eventsAttended.length;
  let events = 0;
  if (eventCount >= 3) events = WEIGHTS.events;
  else if (eventCount === 2) events = 10;
  else if (eventCount === 1) events = 6;
  if (eventCount > 0) {
    drivers.push(`Attended ${eventCount} event${eventCount !== 1 ? "s" : ""}`);
  }

  // 4. Portfolio intros (0–10).
  const introCount = contact.portCoIntros.length;
  let intros = 0;
  if (introCount >= 2) intros = WEIGHTS.intros;
  else if (introCount === 1) intros = 6;
  if (introCount > 0) {
    drivers.push(`${introCount} portfolio intro${introCount !== 1 ? "s" : ""}`);
  }

  // 5. Follow-up engagement (0–5).
  let followUp = 0;
  const hasCompletedFollowUp = contact.interactions.some(
    (i) => i.isFollowUp && i.followUpComplete
  );
  if (hasCompletedFollowUp) {
    followUp = WEIGHTS.followUp;
    drivers.push("Completed follow-ups");
  } else if (contact.followUpPending) {
    followUp = 3;
    drivers.push("Open follow-up");
  }

  const score = Math.min(100, recency + interactions + events + intros + followUp);

  const tier: Temperature =
    score >= TIER_CUTOFFS.hot ? "Hot" : score >= TIER_CUTOFFS.warm ? "Warm" : "Cold";

  return { score, tier, drivers };
}

/** Returns just the numeric 0–100 engagement score for a contact. */
export function effectiveScore(contact: Contact, now: number = Date.now()): number {
  return scoreContact(contact, now).score;
}
