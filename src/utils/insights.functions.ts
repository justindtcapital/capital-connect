import { createServerFn } from "@tanstack/react-start";
import { callGeminiJSON } from "./gemini.server";
import { buildContacts, buildPortfolioCompanies } from "./sheets.server";
import { connectionStrategistGem } from "./gems/registry";
import { runGemJSON } from "./gems/run";
import type { GemKnowledge } from "./gems/types";
import type { Contact, PortfolioCompany } from "@/lib/types";

// AI-narrative layer for the requirements' "AI insights" items. The raw stats are
// computed client-side (deterministic, always shown); these endpoints only add the
// Gemini commentary on demand.
//
// IMPORTANT: callers must pass only SHEETS-NATIVE network data (contact titles,
// sectors, types, engagement-source categories, rating transitions). Asana-sourced
// records are deliberately NOT sent to the model — see the Asana data wall.

export interface InsightNarrative {
  ok: boolean;
  error?: string;
  errorCode?: string;
  summary?: string;
  commonalities?: string[];
  suggestions?: string[];
}

// #5 — company-level intro insights. Input: the network contacts engaged with one
// portfolio company (title / sector / contact-type / engagement source).
export const companyIntroInsights = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      company: string;
      engagements: { title: string; sector: string; type: string; source: string }[];
    }) => data,
  )
  .handler(async ({ data }): Promise<InsightNarrative> => {
    const rows = (data.engagements || []).filter((e) => e.title || e.sector);
    if (rows.length === 0) {
      return { ok: false, error: "No network engagement on this company yet to analyze." };
    }
    const system =
      "You analyze a venture firm's network engagement with ONE portfolio company. " +
      "Find commonalities in WHO gets engaged (titles, sectors, contact types) and the engagement pattern. " +
      "Be concrete and brief. Respond ONLY as JSON: " +
      '{"summary": "1-2 sentences", "commonalities": ["..."], "suggestions": ["who/what to pursue next, 2-4 items"]}.';
    const lines = rows.map(
      (e, i) =>
        `${i + 1}. ${e.title || "—"}${e.sector ? ` · ${e.sector}` : ""}${e.type ? ` · ${e.type}` : ""}${e.source ? ` · via ${e.source}` : ""}`,
    );
    const user = `Portfolio company: ${data.company}\nNetwork contacts engaged (${rows.length}):\n${lines.join("\n")}`;
    const res = await callGeminiJSON<{
      summary?: string;
      commonalities?: string[];
      suggestions?: string[];
    }>(system, user, 800);
    if (!res.ok || !res.data)
      return {
        ok: false,
        error: res.error || "Insight generation failed.",
        errorCode: res.errorCode,
      };
    return {
      ok: true,
      summary: res.data.summary || "",
      commonalities: Array.isArray(res.data.commonalities) ? res.data.commonalities : [],
      suggestions: Array.isArray(res.data.suggestions) ? res.data.suggestions : [],
    };
  });

// #9 — suggest a portfolio company's competitors (named products/companies) as
// selectable chips that can drive a customer-discovery search.
export interface CompetitorSuggestion {
  ok: boolean;
  error?: string;
  errorCode?: string;
  competitors?: string[];
}

export const suggestCompetitors = createServerFn({ method: "POST" })
  .inputValidator((data: { company: string; sector?: string; description?: string }) => data)
  .handler(async ({ data }): Promise<CompetitorSuggestion> => {
    if (!data.company?.trim()) return { ok: false, error: "A company is required." };
    const system =
      "You name the main direct competitors of a B2B company — real, specific competing PRODUCTS or vendors " +
      "(not generic categories). These will be used to find companies already using a competitor (displacement targets). " +
      'Respond ONLY as JSON: {"competitors": ["Name1", "Name2", ...]} with 4-8 entries, most direct first.';
    const user = `Company: ${data.company}\nSector: ${data.sector || ""}\nWhat they do: ${data.description || ""}`;
    const res = await callGeminiJSON<{ competitors?: string[] }>(system, user, 400);
    if (!res.ok || !res.data)
      return {
        ok: false,
        error: res.error || "Couldn't suggest competitors.",
        errorCode: res.errorCode,
      };
    const competitors = (Array.isArray(res.data.competitors) ? res.data.competitors : [])
      .map((c) => String(c).trim())
      .filter(Boolean)
      .slice(0, 8);
    return { ok: true, competitors };
  });

// #3 — draft a short synopsis of an event from its attendee roster (Sheets-native
// contact data: names/titles/companies). Returns plain text in `summary`.
export const eventSynopsisDraft = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      eventName: string;
      date?: string;
      attendees: { name: string; title: string; company: string }[];
    }) => data,
  )
  .handler(async ({ data }): Promise<InsightNarrative> => {
    const roster = (data.attendees || []).filter((a) => a.name || a.company);
    if (roster.length === 0) {
      return { ok: false, error: "No tagged attendees to summarize yet." };
    }
    const system =
      "You write a concise 2-3 sentence synopsis of a business event for a venture firm's CRM, " +
      "based on who from their network attended. Note the mix of seniority, companies, and sectors represented, " +
      'and any notable concentration. Respond ONLY as JSON: {"summary": "..."}.';
    const lines = roster
      .slice(0, 60)
      .map(
        (a, i) =>
          `${i + 1}. ${a.name || "—"}${a.title ? ` · ${a.title}` : ""}${a.company ? ` · ${a.company}` : ""}`,
      );
    const user = `Event: ${data.eventName}${data.date ? ` (${data.date})` : ""}\nNetwork attendees (${roster.length}):\n${lines.join("\n")}`;
    const res = await callGeminiJSON<{ summary?: string }>(system, user, 500);
    if (!res.ok || !res.data)
      return {
        ok: false,
        error: res.error || "Synopsis generation failed.",
        errorCode: res.errorCode,
      };
    return { ok: true, summary: res.data.summary || "" };
  });

// Connection strategy — given a prospecting target's profile (Sheets-native:
// title / company / location / sector / why-surfaced) plus any prior outreach,
// recommend a concrete, personalized way to make the connection. Used by the
// "How to Connect" section of the target detail sheet.
export interface ConnectionStrategy {
  ok: boolean;
  error?: string;
  errorCode?: string;
  /** 1-2 sentence overall recommended approach. */
  approach?: string;
  /** Recommended primary channel (e.g. "Warm intro via a mutual portfolio contact", "LinkedIn"). */
  channel?: string;
  /** Concrete, sequenced next steps. */
  steps?: string[];
  /** Hooks / angles tied to their role, company, or why they were surfaced. */
  talkingPoints?: string[];
  /** A suggested opening message. */
  opener?: string;
}

// ── Connection-strategy grounding (knowledge for the Connection Strategist Gem) ──
const norm = (s?: string) => (s || "").trim().toLowerCase();

// Loose sector match: equal, or one contains the other (guarding tiny strings).
function sectorMatch(a?: string, b?: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length > 2 && y.includes(x)) return true;
  if (y.length > 2 && x.includes(y)) return true;
  return false;
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// Build the real, per-call KNOWLEDGE the Gem grounds on. Only SHEETS-NATIVE
// network attributes (name/title/company/sector/temperature/last-contact) are
// included — consistent with the Asana data wall (no Asana activity content).
function buildConnectionKnowledge(
  target: { name?: string; company?: string; sector?: string },
  contacts: Contact[],
  portfolio: PortfolioCompany[],
): GemKnowledge[] {
  const tName = norm(target.name);
  const tCompany = norm(target.company);

  // Portfolio companies in the target's space — the richest warm-intro hooks.
  const sectorPortcos = portfolio
    .filter((p) => sectorMatch(p.sector, target.sector))
    .slice(0, 8)
    .map(
      (p) =>
        `- ${p.name}${p.sector ? ` (${p.sector})` : ""}${p.description ? `: ${truncate(p.description, 160)}` : ""}`,
    );

  // Network people who could broker a warm intro, scored by closeness to the
  // target (same company > same sector) and relationship temperature.
  const tempScore: Record<string, number> = { Hot: 2, Warm: 1, Cold: 0 };
  const brokers = contacts
    .filter((c) => norm(c.name) && norm(c.name) !== tName)
    .map((c) => {
      let score = 0;
      if (tCompany && norm(c.company) === tCompany) score += 3;
      if (sectorMatch(c.sector, target.sector)) score += 2;
      score += tempScore[c.temperature] ?? 0;
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(
      ({ c }) =>
        `- ${c.name}${c.title ? `, ${c.title}` : ""}${c.company ? ` @ ${c.company}` : ""} · ${c.temperature}${c.sector ? ` · ${c.sector}` : ""}${c.lastContact ? ` · last contact ${c.lastContact}` : ""}`,
    );

  // Compact roster of the whole portfolio (names + sector) for any other angle.
  const roster = portfolio
    .slice(0, 50)
    .map((p) => `${p.name}${p.sector ? ` (${p.sector})` : ""}`)
    .join(", ");

  const knowledge: GemKnowledge[] = [];
  if (sectorPortcos.length)
    knowledge.push({
      label: `DTC PORTFOLIO — companies in or near ${target.sector || "the target's"} space (warm-intro hooks)`,
      content: sectorPortcos.join("\n"),
    });
  if (brokers.length)
    knowledge.push({
      label: "NETWORK PEOPLE who could broker a warm intro (closest first)",
      content: brokers.join("\n"),
    });
  if (roster)
    knowledge.push({
      label: "FULL DTC PORTFOLIO (names only, for any other warm angle)",
      content: roster,
    });
  return knowledge;
}

export const connectionStrategy = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      name: string;
      title?: string;
      company?: string;
      location?: string;
      sector?: string;
      originSource?: string;
      reasonSurfaced?: string;
      stage?: string;
      outreach?: { method: string; summary: string }[];
    }) => data,
  )
  .handler(async ({ data }): Promise<ConnectionStrategy> => {
    if (!data.name?.trim()) return { ok: false, error: "A target is required." };

    // Pull real CRM context server-side so the suggestion can name actual brokers
    // and portfolio hooks. Best-effort: if either load fails the Gem still runs,
    // just without grounding (degrades to its general advice).
    const [contacts, portfolio] = await Promise.all([
      buildContacts().catch((): Contact[] => []),
      buildPortfolioCompanies().catch((): PortfolioCompany[] => []),
    ]);
    const knowledge = buildConnectionKnowledge(data, contacts, portfolio);

    const trail = (data.outreach || [])
      .slice(0, 10)
      .map((o, i) => `${i + 1}. ${o.method}: ${o.summary}`)
      .join("\n");
    const user =
      `Target: ${data.name}\n` +
      `Title: ${data.title || "—"}\n` +
      `Company: ${data.company || "—"}\n` +
      `Location: ${data.location || "—"}\n` +
      `Sector: ${data.sector || "—"}\n` +
      `How surfaced: ${data.originSource || "—"}${data.reasonSurfaced ? ` — ${data.reasonSurfaced}` : ""}\n` +
      `Pipeline stage: ${data.stage || "—"}\n` +
      `Prior outreach:\n${trail || "none yet"}`;

    const res = await runGemJSON<{
      approach?: string;
      channel?: string;
      steps?: string[];
      talkingPoints?: string[];
      opener?: string;
    }>(connectionStrategistGem, user, knowledge);
    if (!res.ok || !res.data)
      return {
        ok: false,
        error: res.error || "Couldn't generate a strategy.",
        errorCode: res.errorCode,
      };
    return {
      ok: true,
      approach: res.data.approach || "",
      channel: res.data.channel || "",
      steps: Array.isArray(res.data.steps) ? res.data.steps : [],
      talkingPoints: Array.isArray(res.data.talkingPoints) ? res.data.talkingPoints : [],
      opener: res.data.opener || "",
    };
  });

// #9 — network progression insights. Input: aggregate rating transitions + a
// breakdown of who's recently been added (by title / sector / location). All
// Sheets-native contact data.
export const networkProgressionInsights = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      transitions: { from: string; to: string; count: number }[];
      recentAdds: { bucket: string; label: string; count: number }[];
      windowLabel: string;
    }) => data,
  )
  .handler(async ({ data }): Promise<InsightNarrative> => {
    if ((data.transitions || []).length === 0 && (data.recentAdds || []).length === 0) {
      return { ok: false, error: "Not enough network history to analyze yet." };
    }
    const system =
      "You analyze how a venture firm's network is evolving. Given rating transitions (cold/warm/hot) and a breakdown " +
      "of recently-added contacts by title/sector/location, surface the momentum and the GAPS (where to hunt next). " +
      "Be concrete and brief. Respond ONLY as JSON: " +
      '{"summary": "1-2 sentences", "commonalities": ["patterns observed"], "suggestions": ["gaps / where to add next, 2-4 items"]}.';
    const t =
      (data.transitions || []).map((x) => `${x.from}→${x.to}: ${x.count}`).join(", ") ||
      "none recorded";
    const adds =
      (data.recentAdds || []).map((x) => `${x.bucket} ${x.label}: ${x.count}`).join("; ") || "none";
    const user = `Window: ${data.windowLabel}\nRating transitions: ${t}\nRecently added breakdown: ${adds}`;
    const res = await callGeminiJSON<{
      summary?: string;
      commonalities?: string[];
      suggestions?: string[];
    }>(system, user, 800);
    if (!res.ok || !res.data)
      return {
        ok: false,
        error: res.error || "Insight generation failed.",
        errorCode: res.errorCode,
      };
    return {
      ok: true,
      summary: res.data.summary || "",
      commonalities: Array.isArray(res.data.commonalities) ? res.data.commonalities : [],
      suggestions: Array.isArray(res.data.suggestions) ? res.data.suggestions : [],
    };
  });
