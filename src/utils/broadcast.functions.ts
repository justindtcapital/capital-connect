import { createServerFn } from "@tanstack/react-start";
import { callGeminiJSON } from "./gemini.server";
import { buildContacts } from "./sheets.server";
import { extractDomain, GENERIC_EMAIL_DOMAINS } from "@/lib/domain-utils";

// Broadcast actions for the Signals feed — all Gemini (Vertex) backed, all
// grounded in Sheets-native CRM data (Asana stays walled off).

// ── Find network targets ─────────────────────────────────────────
// Quality over quantity: score a CRM pool, keep only strong fits (score ≥ floor),
// and return a short shortlist — empty is better than weak padding.
export interface ScoredTarget {
  name: string;
  email: string;
  company: string;
  title: string;
  score: number;
  reason: string;
}

const TEMP_RANK: Record<string, number> = { Hot: 0, Warm: 1, Cold: 2 };
const MAX_POOL = 120;
const MAX_TARGETS = 5;
/** Drop anything below this after the model ranks — enforces quality over quantity. */
const MIN_SCORE = 78;

/** Normalize a company display name for equality checks (strip legal suffixes). */
function companyKey(name?: string | null): string {
  return (name || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^\w\s]/g, " ")
    .replace(/\b(inc|llc|ltd|corp|co|company|technologies|technology|holdings|group|the)\b\.?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when this contact works at the signal's company (e.g. portco employees
 * on a portco blog story). Match by company name and/or corporate email domain.
 */
function worksAtSignalCompany(
  contact: { company?: string; email?: string },
  signalCompany?: string,
  signalDomain?: string,
): boolean {
  const sig = companyKey(signalCompany);
  const contactCo = companyKey(contact.company);
  if (sig.length >= 2 && contactCo.length >= 2 && sig === contactCo) return true;

  const domain = (signalDomain || "").trim().toLowerCase().replace(/^www\./, "");
  if (!domain || !domain.includes(".") || GENERIC_EMAIL_DOMAINS.has(domain)) return false;

  for (const raw of (contact.email || "").split(/[;,]/)) {
    const d = extractDomain(raw);
    if (!d || GENERIC_EMAIL_DOMAINS.has(d)) continue;
    if (d === domain || d.endsWith(`.${domain}`) || domain.endsWith(`.${d}`)) return true;
  }
  return false;
}

export const scoreNetworkTargets = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      company?: string;
      /** Company logo/website domain when known — used to exclude employees by email. */
      companyDomain?: string;
      headline: string;
      summary?: string;
      segment?: string;
    }) => d,
  )
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string; targets: ScoredTarget[] }> => {
    try {
      // Pool: contacts with an email, not employed by the signal company,
      // warmer ties first, capped for token budget.
      const pool = (await buildContacts())
        .filter((c) => c.email)
        .filter((c) => !worksAtSignalCompany(c, data.company, data.companyDomain))
        .sort((a, b) => (TEMP_RANK[a.temperature] ?? 3) - (TEMP_RANK[b.temperature] ?? 3))
        .slice(0, MAX_POOL);

      if (pool.length === 0) return { ok: true, targets: [] };

      const excludeNote = data.company
        ? ` NEVER recommend anyone who works at ${data.company} (the signal's own company) — those contacts are already excluded from the list. `
        : "";

      const system =
        "You rank a venture-capital firm's network contacts for outreach about ONE news signal. " +
        "Quality over quantity: return ONLY people with a specific, defensible reason to care about THIS signal — not a padded top-N list. " +
        "Score 0-100. High scores require at least one hard signal of fit: " +
        "(1) an explicit interest that matches the signal's topic (not a vague adjacent word like 'Product' or 'Marketing' alone), " +
        "(2) clear sector/company overlap with the signal's domain, or " +
        "(3) a role that owns decisions on the signal's specific subject (e.g. AI ops, GTM tech, infra — not merely 'works in marketing'). " +
        "Seniority only boosts score when topical fit already exists. " +
        "EXCLUDE weak matches: title-keyword coincidence, generic interest lists, or 'might find this interesting'." +
        excludeNote +
        "If fewer than a few people qualify, return fewer — or an empty matches array. Never invent fit. " +
        `Each reason must cite the concrete overlap in one short sentence. Only include score >= ${MIN_SCORE}. ` +
        `Output ONLY JSON: {"matches":[{"i":<index>,"score":<${MIN_SCORE}-100>,"reason":"<one short sentence>"}]} ` +
        `with at most ${MAX_TARGETS} entries, highest score first.`;

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
        .filter((m) => {
          const c = pool[m.i];
          if (!c || (m.score ?? 0) < MIN_SCORE) return false;
          // Belt-and-suspenders: never surface people at the signal company.
          return !worksAtSignalCompany(c, data.company, data.companyDomain);
        })
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, MAX_TARGETS)
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
