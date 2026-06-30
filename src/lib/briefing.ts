// Morning briefing — the grounded synthesis layer over the entity graph.
//
// Reads the SAME deterministic structures everything else does (the scored signal
// feed + the company directory + open follow-ups) and assembles a prioritized
// "start your day" view: what's new, what to focus on, where the buying windows
// are, and the concrete actions to take. Every number here traces to real data —
// the LLM (in briefing.functions) only writes the executive-summary prose on top.
//
// Pure functions — safe to run server-side.

import type { Contact } from "@/lib/types";
import type { FeedCard } from "@/lib/signal-feed";
import type { CompanyIntel } from "@/lib/company-intel";

export interface BriefingPriority {
  company: string;
  headline: string;
  category?: string;
  opportunity: number;
  why: string;
  person?: string;
  email?: string;
  sourceUrl?: string;
}

export interface BriefingOpportunity {
  company: string;
  momentum: number;
  opportunity: number;
  networkCount: number;
  segment: string;
  reason: string;
}

export type BriefingActionKind = "follow-up" | "email" | "broadcast" | "intro";

export interface BriefingAction {
  kind: BriefingActionKind;
  label: string;
  detail?: string;
  company?: string;
  /** Person identity — enables a contact deep-link / a seeded email draft. */
  name?: string;
  email?: string;
  /** Reference URL (email actions: the signal source). */
  sourceUrl?: string;
}

export interface BriefingData {
  date: string;
  generatedAt: string;
  /** True when the summary prose came from Gemini (vs. the deterministic fallback). */
  aiUsed: boolean;
  newSignals: number;
  totalSignals: number;
  highImpact: number;
  followUps: number;
  summary: string;
  priorities: BriefingPriority[];
  opportunities: BriefingOpportunity[];
  actions: BriefingAction[];
}

const DAY = 86_400_000;

function hasOpenFollowUp(c: Contact): boolean {
  return c.interactions.some((i) => i.isFollowUp && !i.followUpComplete) || !!c.followUpPending;
}

export interface BuildBriefingInput {
  contacts: Contact[];
  feed: FeedCard[];
  companies: CompanyIntel[];
  now: number;
}

// Everything except the AI prose + persistence stamps (added by the server fn).
export type BriefingCore = Omit<BriefingData, "date" | "generatedAt" | "aiUsed">;

export function buildBriefing(input: BuildBriefingInput): BriefingCore {
  const { contacts, feed, companies, now } = input;

  const newSignals = feed.filter((c) => c.sortTs && c.sortTs >= now - DAY).length;

  // Priorities — the highest-opportunity signals, today's focus list.
  const priorities: BriefingPriority[] = [...feed]
    .filter((c) => (c.insight?.scores.opportunity ?? 0) > 0)
    .sort((a, b) => (b.insight?.scores.opportunity ?? 0) - (a.insight?.scores.opportunity ?? 0))
    .slice(0, 5)
    .map((c) => ({
      company: c.company,
      headline: c.headline,
      category: c.category,
      opportunity: c.insight?.scores.opportunity ?? 0,
      why: c.insight?.whyItMatters ?? c.summary ?? "",
      person: c.person,
      email: c.email,
      sourceUrl: c.sourceUrl,
    }));
  const highImpact = priorities.filter((p) => p.opportunity >= 70).length;

  // Buying windows — companies where we BOTH have a way in (network) and
  // something is moving (opportunity). This is the revenue-generation lens.
  const opportunities: BriefingOpportunity[] = companies
    .filter((e) => e.networkCount > 0 && e.opportunity >= 50)
    .sort((a, b) => b.opportunity - a.opportunity || b.momentum.score - a.momentum.score)
    .slice(0, 5)
    .map((e) => ({
      company: e.name,
      momentum: e.momentum.score,
      opportunity: e.opportunity,
      networkCount: e.networkCount,
      segment: e.segment,
      reason: e.signals[0]?.insight?.whyNow || e.momentum.drivers.join(" · "),
    }));

  // Recommended actions — overdue follow-ups first (real obligations), then warm
  // outreach on the top signals, then a broadcast for the day's biggest story.
  const overdue = contacts.filter(hasOpenFollowUp);
  const followUps = overdue.length;
  const actions: BriefingAction[] = [];
  for (const c of overdue.slice(0, 4)) {
    actions.push({
      kind: "follow-up",
      label: `Follow up with ${c.name}`,
      detail: c.company || undefined,
      company: c.company,
      name: c.name,
      email: c.email,
    });
  }
  for (const p of priorities) {
    if (p.person && p.email) {
      actions.push({
        kind: "email",
        label: `Email ${p.person}`,
        detail: `${p.company} — ${p.headline}`,
        company: p.company,
        name: p.person,
        email: p.email,
        sourceUrl: p.sourceUrl,
      });
    }
  }
  if (priorities[0]) {
    actions.push({
      kind: "broadcast",
      label: `Broadcast ${priorities[0].company}`,
      detail: priorities[0].headline,
      company: priorities[0].company,
    });
  }
  const seen = new Set<string>();
  const dedupActions = actions
    .filter((a) => {
      if (seen.has(a.label)) return false;
      seen.add(a.label);
      return true;
    })
    .slice(0, 6);

  // Deterministic fallback summary (used verbatim if Gemini is unavailable).
  const summary =
    `You're tracking ${feed.length} signal${feed.length !== 1 ? "s" : ""}` +
    (newSignals ? `, ${newSignals} new in the last 24h` : "") +
    `. ` +
    (priorities[0]
      ? `Top focus: ${priorities[0].company} — ${priorities[0].headline} (opportunity ${priorities[0].opportunity}). `
      : "") +
    (followUps ? `${followUps} follow-up${followUps !== 1 ? "s" : ""} need attention.` : "");

  return {
    newSignals,
    totalSignals: feed.length,
    highImpact,
    followUps,
    summary: summary.trim(),
    priorities,
    opportunities,
    actions: dedupActions,
  };
}
