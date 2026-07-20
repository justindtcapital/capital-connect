import type { Contact, Temperature } from "@/lib/types";
import { daysSinceLastContact } from "@/lib/activity-score";

/**
 * Influence Score for the Network Constellation Intelligence Surface.
 * Auditable 0–100 composite — not temperature alone.
 */
export interface InfluenceBreakdown {
  score: number;
  quality: number;
  recency: number;
  engagement: number;
  portfolioReach: number;
  centrality: number;
  access: number;
  responseProxy: number;
  confidence: number;
  momentum: "rising" | "stable" | "cooling";
  drivers: string[];
}

const TEMP_QUALITY: Record<Temperature, number> = {
  Council: 100,
  Hot: 85,
  Warm: 55,
  Cold: 20,
};

function clamp(n: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

/** Distinct PortCo count among a filtered universe — used for centrality. */
export function portCoFrequency(contacts: Contact[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of contacts) {
    for (const p of c.portCoIntros || []) {
      const name = p.trim();
      if (!name) continue;
      m.set(name, (m.get(name) || 0) + 1);
    }
  }
  return m;
}

export function computeInfluence(
  contact: Contact,
  cohort: Contact[],
  portcoFreq?: Map<string, number>,
  now = Date.now(),
): InfluenceBreakdown {
  const freq = portcoFreq ?? portCoFrequency(cohort);
  const drivers: string[] = [];

  // 20% — relationship quality (temperature)
  const quality = TEMP_QUALITY[contact.temperature] ?? 20;
  if (contact.temperature === "Council" || contact.temperature === "Hot") {
    drivers.push(`${contact.temperature} relationship`);
  }

  // 15% — recency / decay
  const days = daysSinceLastContact(contact, now);
  let recency = 25;
  if (days === null) {
    recency = 15;
  } else if (days <= 14) {
    recency = 100;
    drivers.push("Touched in last 2 weeks");
  } else if (days <= 45) {
    recency = 75;
  } else if (days <= 90) {
    recency = 50;
  } else if (days <= 180) {
    recency = 30;
  } else {
    recency = 10;
    drivers.push("Cooling — stale touch");
  }

  // 15% — engagement quality
  const interactions = contact.interactions?.length ?? 0;
  const events = contact.eventsAttended?.length ?? 0;
  const engagement = clamp(interactions * 8 + events * 10 + (contact.followUpPending ? 12 : 0));
  if (interactions >= 3) drivers.push(`${interactions} logged interactions`);

  // 15% — portfolio reach
  const intros = (contact.portCoIntros || []).filter((p) => p.trim());
  const portfolioReach = clamp(intros.length * 18);
  if (intros.length >= 2) drivers.push(`${intros.length} PortCo intros`);

  // 10% — network centrality (bridges across busy PortCos)
  let centrality = 0;
  if (intros.length >= 2) {
    const reachScore = intros.reduce((sum, p) => sum + Math.min(freq.get(p) || 0, 8), 0);
    centrality = clamp(reachScore * 4 + (intros.length >= 3 ? 25 : 0));
    if (intros.length >= 3) drivers.push("Bridge across ecosystems");
  }

  // 10% — access proxy (prime assigned + type)
  let access = contact.prime?.trim() ? 55 : 20;
  const type = (contact.contactType || "").toLowerCase();
  if (type === "vc") access += 20;
  if (type === "customer" || type === "dell") access += 10;
  if (contact.temperature === "Council") access += 15;
  access = clamp(access);

  // 5% — response / follow-through proxy
  const responseProxy = contact.followUpPending ? 35 : interactions > 0 ? 70 : 40;

  // 10% — confidence (data completeness)
  let confidence = 40;
  if (contact.lastContact) confidence += 15;
  if (interactions > 0) confidence += 15;
  if (intros.length > 0) confidence += 15;
  if (contact.email) confidence += 10;
  if (contact.activityScore != null) confidence += 5;
  confidence = clamp(confidence);

  const score = Math.round(
    quality * 0.2 +
      recency * 0.15 +
      engagement * 0.15 +
      portfolioReach * 0.15 +
      centrality * 0.1 +
      access * 0.1 +
      responseProxy * 0.05 +
      confidence * 0.1,
  );

  let momentum: InfluenceBreakdown["momentum"] = "stable";
  if (recency >= 75 && (contact.temperature === "Hot" || contact.temperature === "Council")) {
    momentum = "rising";
  } else if (recency <= 30 || (days !== null && days > 120 && contact.temperature === "Cold")) {
    momentum = "cooling";
  }

  if (!drivers.length) drivers.push("Baseline network presence");

  return {
    score: clamp(score),
    quality,
    recency,
    engagement,
    portfolioReach,
    centrality,
    access,
    responseProxy,
    confidence,
    momentum,
    drivers: drivers.slice(0, 3),
  };
}

export function isBridgeContact(contact: Contact, topPortcos: string[]): boolean {
  const hits = (contact.portCoIntros || [])
    .map((p) => p.trim())
    .filter((p) => topPortcos.includes(p));
  return new Set(hits).size >= 2;
}

export function nodeRole(contact: Contact): "founder" | "investor" | "partner" | "contact" {
  const type = (contact.contactType || "").toLowerCase();
  const title = (contact.title || "").toLowerCase();
  if (type === "vc" || /investor|partner|gp|managing director/.test(title)) return "investor";
  if (type === "dell") return "partner";
  if (/founder|co-founder|ceo/.test(title)) return "founder";
  return "contact";
}
