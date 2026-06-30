import { createServerFn } from "@tanstack/react-start";
import { callGeminiJSON } from "./gemini.server";
import { buildContacts } from "./sheets.server";

// Broadcast actions for the Signals feed — all Gemini (Vertex) backed, all
// grounded in Sheets-native CRM data (Asana stays walled off).

// ── Find network targets ─────────────────────────────────────────
// Scores up to ~120 CRM contacts for relevance to a signal and returns the top 8.
export interface ScoredTarget {
  name: string;
  email: string;
  company: string;
  title: string;
  score: number;
  reason: string;
}

const TEMP_RANK: Record<string, number> = { Hot: 0, Warm: 1, Cold: 2 };

export const scoreNetworkTargets = createServerFn({ method: "POST" })
  .inputValidator((d: { company?: string; headline: string; summary?: string; segment?: string }) => d)
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string; targets: ScoredTarget[] }> => {
    try {
      // Pool: contacts with an email, warmer ties first, capped for token budget.
      const pool = (await buildContacts())
        .filter((c) => c.email)
        .sort((a, b) => (TEMP_RANK[a.temperature] ?? 3) - (TEMP_RANK[b.temperature] ?? 3))
        .slice(0, 120);

      if (pool.length === 0) return { ok: true, targets: [] };

      const system =
        "You rank a venture-capital firm's network contacts by how relevant a news signal is to each person. " +
        "Score relevance 0-100 weighing: explicit areas of interest, sector overlap, title/role fit, and seniority " +
        "(senior decision-makers score higher when relevant). Only include genuinely relevant people. " +
        'Output ONLY JSON: {"matches":[{"i":<index>,"score":<0-100>,"reason":"<one short sentence>"}]} with at most 8 entries, highest score first.';

      const list = pool
        .map(
          (c, i) =>
            `${i}. ${c.name} | ${c.title || ""} | ${c.company || ""} | sector:${c.sector || ""} | interests:${(c.areasOfInterest || []).join(", ")}`,
        )
        .join("\n");
      const user =
        `SIGNAL\nCompany: ${data.company || "—"}\nSegment: ${data.segment || "—"}\nHeadline: ${data.headline}\n` +
        `${data.summary ? `Summary: ${data.summary}\n` : ""}\nCONTACTS (index. name | title | company | sector | interests):\n${list}`;

      const res = await callGeminiJSON<{ matches?: Array<{ i: number; score: number; reason: string }> }>(system, user, 1500);
      if (!res.ok || !res.data) return { ok: false, error: res.error || "Scoring failed", targets: [] };

      const targets: ScoredTarget[] = (res.data.matches || [])
        .filter((m) => pool[m.i])
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, 8)
        .map((m) => {
          const c = pool[m.i];
          return {
            name: c.name,
            email: c.email?.split(";")[0]?.trim() || "",
            company: c.company || "",
            title: c.title || "",
            score: Math.max(0, Math.min(100, Math.round(m.score ?? 0))),
            reason: m.reason || "",
          };
        });

      return { ok: true, targets };
    } catch (e) {
      console.error("[broadcast] scoreNetworkTargets failed:", e);
      return { ok: false, error: e instanceof Error ? e.message : "Scoring failed", targets: [] };
    }
  });

// ── Draft a LinkedIn post ────────────────────────────────────────
export const draftLinkedInPost = createServerFn({ method: "POST" })
  .inputValidator((d: { company?: string; headline: string; summary?: string; sourceUrl?: string }) => d)
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string; post?: string }> => {
    try {
      const system =
        "You write short, polished LinkedIn posts in the voice of Dell Technologies Capital (DTC), a deep-tech VC. " +
        "Tone: warm, credible, not hypey. 80-150 words. Reference the signal, add a brief DTC perspective, and end with " +
        "3-5 relevant hashtags that MUST include #DellTechCapital. Do not fabricate facts beyond what's given. " +
        'Output ONLY JSON: {"post":"<the post text with real \\n line breaks>"}';
      const user =
        `Signal:\nCompany: ${data.company || "—"}\nHeadline: ${data.headline}\n` +
        `${data.summary ? `Summary: ${data.summary}\n` : ""}${data.sourceUrl ? `Source: ${data.sourceUrl}\n` : ""}`;

      const res = await callGeminiJSON<{ post?: string }>(system, user, 800);
      if (!res.ok || !res.data?.post) return { ok: false, error: res.error || "Draft failed" };
      return { ok: true, post: res.data.post };
    } catch (e) {
      console.error("[broadcast] draftLinkedInPost failed:", e);
      return { ok: false, error: e instanceof Error ? e.message : "Draft failed" };
    }
  });
