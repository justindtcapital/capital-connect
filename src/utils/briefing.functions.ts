import { createServerFn } from "@tanstack/react-start";
import {
  buildContacts,
  buildPortfolioCompanies,
  buildTargets,
  readTodayBriefing,
  saveBriefingRow,
} from "./sheets.server";
import { fetchSignals } from "./gemini.functions";
import { callGeminiJSON } from "./gemini.server";
import { buildFeed } from "@/lib/signal-feed";
import { buildCompanyDirectory } from "@/lib/company-intel";
import { buildBriefing, type BriefingData } from "@/lib/briefing";
import type { Contact, PortfolioCompany, TargetLead } from "@/lib/types";

// Read today's already-generated briefing (cheap — drives the route loader so the
// page paints instantly when a briefing exists). Returns null if none yet today.
export const getBriefing = createServerFn({ method: "GET" }).handler(
  async (): Promise<BriefingData | null> => {
    try {
      const row = await readTodayBriefing();
      if (!row?.json) return null;
      return JSON.parse(row.json) as BriefingData;
    } catch (e) {
      console.error("[briefing] getBriefing failed:", e);
      return null;
    }
  },
);

// Build today's briefing from the entity graph, add a Gemini executive summary,
// persist it (so later visits reuse it), and return it. Triggered on demand.
export const generateBriefing = createServerFn({ method: "POST" }).handler(
  async (): Promise<BriefingData> => {
    const [contacts, portfolio, targets, signals] = await Promise.all([
      buildContacts().catch((): Contact[] => []),
      buildPortfolioCompanies().catch((): PortfolioCompany[] => []),
      buildTargets().catch((): TargetLead[] => []),
      fetchSignals().catch(() => ({ recommendations: [], otherSignals: [], compliance: [] })),
    ]);

    const feed = buildFeed({
      recommendations: signals.recommendations ?? [],
      otherSignals: signals.otherSignals ?? [],
      linkedinPosts: [],
      driveDocs: [],
      emails: [],
      portfolio,
      contacts,
    });
    const now = Date.now();
    const companies = buildCompanyDirectory({ contacts, portfolio, targets, feed, now });
    const core = buildBriefing({ contacts, feed, companies, now });

    // Executive summary via Gemini — grounded ONLY in the items we computed, so
    // it can't invent facts. Graceful fallback to the deterministic summary.
    let summary = core.summary;
    let aiUsed = false;
    if (core.priorities.length > 0 || core.opportunities.length > 0) {
      try {
        const system =
          "You are the chief of staff for a venture-capital partner. Write a crisp 2-3 sentence " +
          "morning-briefing summary based ONLY on the provided signals, opportunities, and follow-ups. " +
          "Lead with what matters most today and why it's time-sensitive. Be specific, no fluff, no " +
          'fabrication. Respond ONLY as JSON: {"summary": "..."}.';
        const user =
          `New signals (last 24h): ${core.newSignals}. Total tracked: ${core.totalSignals}. ` +
          `Open follow-ups: ${core.followUps}.\n\n` +
          `TOP PRIORITIES:\n${core.priorities
            .map(
              (p, i) =>
                `${i + 1}. ${p.company}: ${p.headline} (opportunity ${p.opportunity}${p.category ? `, ${p.category}` : ""})`,
            )
            .join("\n")}\n\n` +
          `BUYING WINDOWS (we have contacts + momentum):\n${core.opportunities
            .map(
              (o) =>
                `- ${o.company} (momentum ${o.momentum}, ${o.networkCount} contact${o.networkCount !== 1 ? "s" : ""}, opp ${o.opportunity})`,
            )
            .join("\n")}`;
        const res = await callGeminiJSON<{ summary?: string }>(system, user, 400);
        if (res.ok && res.data?.summary) {
          summary = res.data.summary.trim();
          aiUsed = true;
        }
      } catch (e) {
        console.error("[briefing] summary synthesis failed (using fallback):", e);
      }
    }

    const date = new Date().toISOString().split("T")[0];
    const generatedAt = new Date().toISOString();
    const briefing: BriefingData = {
      date,
      generatedAt,
      aiUsed,
      summary,
      newSignals: core.newSignals,
      totalSignals: core.totalSignals,
      highImpact: core.highImpact,
      followUps: core.followUps,
      priorities: core.priorities,
      opportunities: core.opportunities,
      actions: core.actions,
    };

    try {
      await saveBriefingRow(date, generatedAt, JSON.stringify(briefing));
    } catch (e) {
      console.error("[briefing] saveBriefingRow failed (returning unsaved):", e);
    }
    return briefing;
  },
);
