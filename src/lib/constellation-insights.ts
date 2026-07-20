import type { Contact } from "@/lib/types";
import { daysSinceLastContact } from "@/lib/activity-score";
import {
  computeInfluence,
  isBridgeContact,
  portCoFrequency,
  type InfluenceBreakdown,
} from "@/lib/constellation-influence";

export type InsightKind = "decay" | "opportunity" | "blindspot" | "bridge";

export interface ConstellationInsight {
  id: string;
  kind: InsightKind;
  title: string;
  detail: string;
  contactId?: string;
  portco?: string;
  score: number;
}

/** AI-style overlays derived from graph + influence — no external model required. */
export function buildConstellationInsights(
  contacts: Contact[],
  topPortcos: string[],
  influenceById: Map<string, InfluenceBreakdown>,
  now = Date.now(),
): ConstellationInsight[] {
  const insights: ConstellationInsight[] = [];
  const freq = portCoFrequency(contacts);

  for (const c of contacts) {
    const inf = influenceById.get(c.id);
    if (!inf) continue;
    const days = daysSinceLastContact(c, now);

    // Decay: was valuable, now cooling
    if (
      (c.temperature === "Hot" || c.temperature === "Warm" || c.temperature === "Council") &&
      (inf.momentum === "cooling" || (days !== null && days > 90))
    ) {
      insights.push({
        id: `decay:${c.id}`,
        kind: "decay",
        title: `${c.name} is cooling`,
        detail:
          days != null
            ? `${c.temperature} · ${days}d since last touch · Influence ${inf.score}`
            : `${c.temperature} · stale · Influence ${inf.score}`,
        contactId: c.id,
        score: inf.score + (c.temperature === "Council" || c.temperature === "Hot" ? 20 : 0),
      });
    }

    // Opportunity: follow-up pending on strong node, or warm bridge underused
    if (c.followUpPending && inf.score >= 40) {
      insights.push({
        id: `opp:fu:${c.id}`,
        kind: "opportunity",
        title: `Follow up with ${c.name}`,
        detail: `Pending follow-up · Influence ${inf.score} · ${inf.drivers[0] || "active bond"}`,
        contactId: c.id,
        score: inf.score + 15,
      });
    } else if (isBridgeContact(c, topPortcos) && inf.score >= 45 && c.temperature !== "Cold") {
      insights.push({
        id: `opp:bridge:${c.id}`,
        kind: "opportunity",
        title: `${c.name} bridges ecosystems`,
        detail: `Multi-PortCo reach · ${c.portCoIntros.slice(0, 3).join(", ")}`,
        contactId: c.id,
        score: inf.score + 10,
      });
    } else if (
      (c.temperature === "Warm" || c.temperature === "Hot") &&
      (c.portCoIntros?.length ?? 0) === 0 &&
      inf.score >= 35
    ) {
      insights.push({
        id: `opp:intro:${c.id}`,
        kind: "opportunity",
        title: `Intro path open — ${c.name}`,
        detail: `${c.temperature} with no PortCo intro yet · strong candidate`,
        contactId: c.id,
        score: inf.score + 8,
      });
    }
  }

  // Blind spots — thin PortCo orbits among top names
  for (const portco of topPortcos) {
    const orbit = contacts.filter((c) =>
      (c.portCoIntros || []).some((p) => p.trim() === portco),
    );
    const hotWarm = orbit.filter(
      (c) => c.temperature === "Hot" || c.temperature === "Warm" || c.temperature === "Council",
    );
    const count = freq.get(portco) || orbit.length;
    if (count <= 2 || hotWarm.length <= 1) {
      insights.push({
        id: `blind:${portco}`,
        kind: "blindspot",
        title: `${portco} under-connected`,
        detail:
          hotWarm.length === 0
            ? `${count} intro${count === 1 ? "" : "s"} · no Hot/Warm coverage`
            : `${count} intros · only ${hotWarm.length} Hot/Warm`,
        portco,
        score: 100 - hotWarm.length * 20 - Math.min(count, 5) * 5,
      });
    }
  }

  // Dedupe by contact (keep highest score per contact for person-bound kinds)
  const byKey = new Map<string, ConstellationInsight>();
  for (const ins of insights) {
    const key = ins.contactId ? `${ins.kind}:${ins.contactId}` : ins.id;
    const prev = byKey.get(key);
    if (!prev || ins.score > prev.score) byKey.set(key, ins);
  }

  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, 12);
}

export function insightContactIds(insights: ConstellationInsight[], kind?: InsightKind): Set<string> {
  const s = new Set<string>();
  for (const i of insights) {
    if (kind && i.kind !== kind) continue;
    if (i.contactId) s.add(i.contactId);
  }
  return s;
}

export function insightPortcos(insights: ConstellationInsight[]): Set<string> {
  const s = new Set<string>();
  for (const i of insights) {
    if (i.kind === "blindspot" && i.portco) s.add(i.portco);
  }
  return s;
}
