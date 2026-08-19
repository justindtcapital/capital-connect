// Priority 3 — attribution resilience + feedback loop.
//
//   I. Gemini fallback for AMBIGUOUS messages only. Deterministic rules decide
//      almost everything (exact CRM email match, portfolio name in the content);
//      only the leftovers — several plausible counterparties and no company
//      resolved — are sent to Gemini, in ONE batched JSON call, and only when
//      GMAIL_ATTRIBUTION_LLM_ENABLED=true.
//
//   K. Wrong-attribution flags. Users correct Person/Company from the activity
//      card; the correction is appended to the Attribution Feedback tab and
//      replayed over every later canonicalization so the fix sticks.

import {
  applyAttributionCorrections,
  findAmbiguousActivities,
  type AttributionCorrection,
  type AmbiguousActivity,
} from "@/lib/activity-canonical";
import { portcoNamesMatch } from "@/lib/portco-names";
import { callGeminiJSON, isGeminiConfigured } from "./gemini.server";
import { appendSheetRow, ensureTab, fetchSheetTab } from "./sheets.server";
import type { AsanaActivity, Contact } from "@/lib/types";

export const ATTRIBUTION_TAB = "Attribution Feedback";
const ATTRIBUTION_HEADERS = [
  "Logged At",
  "Activity Gid",
  "Thread Id",
  "Subject",
  "Was Person",
  "Was Company",
  "Correct Person",
  "Correct Company",
  "Reason",
  "User",
];

export interface AttributionFlagInput {
  gid: string;
  threadId?: string;
  subject?: string;
  wasPerson?: string;
  wasCompany?: string;
  correctPerson?: string;
  correctCompany?: string;
  reason?: string;
  user?: string;
}

/** K — persist one human correction. */
export async function recordAttributionFlag(input: AttributionFlagInput): Promise<void> {
  await ensureTab(ATTRIBUTION_TAB, ATTRIBUTION_HEADERS);
  await appendSheetRow(ATTRIBUTION_TAB, [
    new Date().toISOString(),
    input.gid || "",
    input.threadId || "",
    input.subject || "",
    input.wasPerson || "",
    input.wasCompany || "",
    input.correctPerson || "",
    input.correctCompany || "",
    input.reason || "",
    input.user || "unknown",
  ]);
}

/** K — every correction on record (newest wins per gid/thread). */
export async function loadAttributionCorrections(): Promise<AttributionCorrection[]> {
  let rows: string[][];
  try {
    rows = await fetchSheetTab(ATTRIBUTION_TAB);
  } catch {
    return []; // tab not created yet — no corrections
  }
  if (rows.length < 2) return [];
  const header = (rows[0] || []).map((h) => h.trim().toLowerCase());
  const at = (name: string) => header.indexOf(name);
  const iGid = at("activity gid");
  const iThread = at("thread id");
  const iPerson = at("correct person");
  const iCompany = at("correct company");
  const out: AttributionCorrection[] = [];
  for (const row of rows.slice(1)) {
    const gid = (row[iGid] || "").trim();
    const threadId = (row[iThread] || "").trim();
    const person = (row[iPerson] || "").trim();
    const company = (row[iCompany] || "").trim();
    if ((!gid && !threadId) || (!person && !company)) continue;
    out.push({ gid: gid || undefined, threadId: threadId || undefined, person, company });
  }
  return out;
}

export function isAttributionLlmEnabled(): boolean {
  return process.env.GMAIL_ATTRIBUTION_LLM_ENABLED === "true" && isGeminiConfigured();
}

interface LlmPick {
  gid: string;
  person?: string;
  company?: string;
  confidence?: number;
}

const SYSTEM = `You resolve who a business email thread is really WITH, and which
portfolio company it is about.
Rules:
- Pick exactly one counterparty per item, from its candidate list only. If the
  item already states a Known person, keep that exact name.
- "company" MUST be copied verbatim from the PORTFOLIO COMPANIES list when the
  thread is plausibly about one of them (customer intro, pilot, hiring, GTM help,
  fundraise for that company). Leave "company" empty when no portfolio company
  fits — do NOT guess and do NOT return a non-portfolio company.
- Never invent people or companies. confidence is 0-1.
Return JSON: {"picks":[{"gid":"","person":"","company":"","confidence":0.0}]}`;

function prompt(items: AmbiguousActivity[], portfolioNames: string[]): string {
  const list = portfolioNames.filter(Boolean).slice(0, 400).join("; ");
  const body = items
    .map(
      (i) =>
        `--- ${i.gid}\nSubject: ${i.subject}\n${
          i.needs === "company" ? `Known person: ${i.knownPerson}\nNeeds: company only\n` : ""
        }Candidates: ${i.candidates
          .map((c) => `${c.name || "(no name)"} <${c.email}>`)
          .join("; ")}\nNotes: ${i.notes.replace(/\n/g, " ")}`,
    )
    .join("\n");
  return `PORTFOLIO COMPANIES (closed set for "company"): ${list}\n\nTHREADS:\n${body}`;
}

/**
 * I — batched Gemini fallback. Returns the activities unchanged when disabled,
 * when nothing is ambiguous, or on any failure (best-effort, never a blocker).
 */
export async function resolveAmbiguousAttribution(
  activities: AsanaActivity[],
  contacts: Contact[],
  portfolioNames: string[] = [],
): Promise<{ activities: AsanaActivity[]; resolved: number }> {
  if (!isAttributionLlmEnabled()) return { activities, resolved: 0 };
  const max = Number(process.env.GMAIL_ATTRIBUTION_LLM_MAX) || 40;
  const ambiguous = findAmbiguousActivities(activities, contacts, portfolioNames).slice(0, max);
  if (ambiguous.length === 0) return { activities, resolved: 0 };

  const res = await callGeminiJSON<{ picks?: LlmPick[] }>(
    SYSTEM,
    prompt(ambiguous, portfolioNames),
    3000,
    { maxAttempts: 1 },
  );
  if (!res.ok || !res.data?.picks) {
    if (!res.ok) console.error("[attribution] Gemini fallback failed:", res.error);
    return { activities, resolved: 0 };
  }

  const items = new Map(ambiguous.map((a) => [a.gid, a]));
  const picks = new Map<string, LlmPick>();
  for (const p of res.data.picks) {
    if (!p?.gid || (p.confidence ?? 1) < 0.6) continue;
    picks.set(p.gid, p);
  }
  if (picks.size === 0) return { activities, resolved: 0 };

  // Any company the model returns must be a real portfolio company (fuzzy-matched
  // to the canonical spelling we store), otherwise it is dropped.
  const canonicalPortco = (value: string): string => {
    const v = value.trim();
    if (!v) return "";
    const hit = portfolioNames.find((n) => portcoNamesMatch(n, v));
    return hit || "";
  };

  let resolved = 0;
  const out = activities.map((a) => {
    const p = picks.get(a.gid);
    const item = items.get(a.gid);
    if (!p || !item) return a;
    // The person must be one of the candidates we showed it — reversed or
    // reordered spellings ("Falloon, Chris" -> "Chris Falloon") are accepted.
    const allowed = new Set(
      item.candidates.map((c) => c.name.trim().toLowerCase()).filter(Boolean),
    );
    const tokens = (s: string) => s.toLowerCase().split(/[^a-z]+/i).filter(Boolean).sort().join(" ");
    const wanted = (p.person || "").trim();
    const personOk =
      item.needs !== "company" && !!wanted && [...allowed].some((n) => tokens(n) === tokens(wanted));
    const person = personOk ? wanted : a.person;
    const company = canonicalPortco(p.company || "") || a.company;
    if (person === a.person && company === a.company) return a;
    resolved++;
    return { ...a, person, company };
  });
  console.log(`[attribution] Gemini resolved ${resolved}/${ambiguous.length} activities`);
  return { activities: out, resolved };
}


/** Convenience: corrections then LLM fallback, in the order they must run. */
export async function refineAttribution(
  activities: AsanaActivity[],
  contacts: Contact[],
  portfolioNames: string[] = [],
): Promise<AsanaActivity[]> {
  const corrections = await loadAttributionCorrections().catch(() => [] as AttributionCorrection[]);
  const corrected = applyAttributionCorrections(activities, corrections);
  // Human corrections win: anything a user fixed is no longer ambiguous.
  const { activities: refined } = await resolveAmbiguousAttribution(
    corrected,
    contacts,
    portfolioNames,
  ).catch(() => ({ activities: corrected, resolved: 0 }));
  return applyAttributionCorrections(refined, corrections);
}
