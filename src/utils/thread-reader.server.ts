// LLM "read" step over a single BD/GTM activity thread (a pasted email chain or
// meeting note). Turns the free text into structured insight — a real summary, a
// classified interaction type, resolved participants, an inferred follow-up, and
// any event mentioned — which the sourcing flow then writes onto CRM records.
//
// Grounding: the model extracts ONLY what the text states; it never invents
// people, dates, or commitments. On any failure it returns an empty insight so
// the caller degrades cleanly to the prior regex-only behavior.
//
// Confidentiality: this deliberately sends Asana-sourced thread text to Gemini
// (an exception to the Query agent's "Asana is walled off from the model" rule,
// made explicitly for this server-side pipeline). EVERY call is logged to the
// "Activity Insights Log" tab — timestamp, gid, track, and a SHA-256 of the
// thread text (never the raw content) plus the extracted flags.

import { createHash } from "node:crypto";
import { callGeminiJSON, GEMINI_MODEL, isGeminiConfigured } from "./gemini.server";
import { ensureTab, appendSheetRow, TAB_NAMES } from "./sheets.server";
import type { ActivityThread } from "./asana.server";

export type ThreadInteractionType = "email" | "meeting" | "call" | "intro" | "other";

export interface ThreadParticipant {
  name: string;
  email: string;
  company: string;
  role?: string;
}

export interface ThreadFollowUp {
  owed: boolean;
  who: string;
  action: string;
  dueDate?: string;
}

export interface ThreadEvent {
  mentioned: boolean;
  name?: string;
  date?: string;
  type?: string;
}

export interface ThreadInsight {
  summary: string;
  interactionType: ThreadInteractionType;
  participants: ThreadParticipant[];
  followUp: ThreadFollowUp;
  event: ThreadEvent;
  topics: string[];
  sentiment?: "positive" | "neutral" | "negative";
}

export function emptyInsight(): ThreadInsight {
  return {
    summary: "",
    interactionType: "other",
    participants: [],
    followUp: { owed: false, who: "", action: "" },
    event: { mentioned: false },
    topics: [],
  };
}

export const ACTIVITY_INSIGHTS_HEADERS = [
  "Timestamp",
  "Activity GID",
  "Track",
  "Thread SHA256",
  "Model",
  "OK",
  "Error",
  "Summary Chars",
  "Follow-up Owed",
  "Event Mentioned",
  "Participants",
];

// Cap the text we send (cost + latency); threads beyond this are rare and the
// head of the chain carries the substance.
const MAX_THREAD_CHARS = 16000;

const SYSTEM = `You read ONE business-development / go-to-market activity thread — usually a pasted email chain, sometimes a meeting or call note — and extract a structured, factual summary for a CRM.

Rules:
- Use ONLY what the text states. Never invent people, companies, dates, or commitments. If something isn't in the text, leave it empty (or false).
- "followUp.owed" is true only when the text shows a concrete next step someone still has to take. "who" is who owes it; "action" is what; "dueDate" is YYYY-MM-DD if a date is stated, else "".
- "event.mentioned" is true only when a dinner, conference, webinar, or scheduled meeting is referenced as something to attend (not just any meeting verb).
- "participants" are the real people in the thread (To/From/Cc or named). Give each a real email when present, "" otherwise.

Output ONLY JSON of exactly this shape:
{
  "summary": "1-2 sentences on what actually happened or was discussed",
  "interactionType": "email" | "meeting" | "call" | "intro" | "other",
  "participants": [{"name": "", "email": "", "company": "", "role": ""}],
  "followUp": {"owed": false, "who": "", "action": "", "dueDate": ""},
  "event": {"mentioned": false, "name": "", "date": "", "type": ""},
  "topics": [""],
  "sentiment": "positive" | "neutral" | "negative"
}`;

const TYPES = new Set<ThreadInteractionType>(["email", "meeting", "call", "intro", "other"]);
const SENTIMENTS = new Set(["positive", "neutral", "negative"]);

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const bool = (v: unknown): boolean => v === true || v === "true";
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// Coerce whatever the model returned into a safe, well-typed ThreadInsight.
function normalizeInsight(raw: Record<string, unknown>): ThreadInsight {
  const type = str(raw.interactionType).toLowerCase() as ThreadInteractionType;
  const fu = obj(raw.followUp);
  const ev = obj(raw.event);
  const participants = Array.isArray(raw.participants)
    ? raw.participants
        .slice(0, 25)
        .map((p) => {
          const o = obj(p);
          return {
            name: str(o.name),
            email: str(o.email).toLowerCase(),
            company: str(o.company),
            role: str(o.role) || undefined,
          };
        })
        .filter((p) => p.name || p.email)
    : [];
  const topics = Array.isArray(raw.topics)
    ? raw.topics.map(str).filter(Boolean).slice(0, 10)
    : [];
  const sentimentRaw = str(raw.sentiment).toLowerCase();
  return {
    summary: str(raw.summary).slice(0, 600),
    interactionType: TYPES.has(type) ? type : "other",
    participants,
    followUp: {
      owed: bool(fu.owed),
      who: str(fu.who),
      action: str(fu.action),
      dueDate: str(fu.dueDate) || undefined,
    },
    event: {
      mentioned: bool(ev.mentioned),
      name: str(ev.name) || undefined,
      date: str(ev.date) || undefined,
      type: str(ev.type) || undefined,
    },
    topics,
    sentiment: SENTIMENTS.has(sentimentRaw)
      ? (sentimentRaw as ThreadInsight["sentiment"])
      : undefined,
  };
}

// Append one audit row per LLM call. Logs a hash of the thread text, never the
// text itself. Best-effort: a logging failure must not break sourcing.
async function logInsight(
  thread: ActivityThread,
  insight: ThreadInsight,
  ok: boolean,
  error: string,
): Promise<void> {
  try {
    await ensureTab(TAB_NAMES.activityInsights, ACTIVITY_INSIGHTS_HEADERS);
    const sha = createHash("sha256").update(thread.text || "").digest("hex");
    await appendSheetRow(TAB_NAMES.activityInsights, [
      new Date().toISOString(),
      thread.gid,
      thread.track,
      sha,
      GEMINI_MODEL,
      ok ? "TRUE" : "FALSE",
      error,
      String(insight.summary.length),
      insight.followUp.owed ? "TRUE" : "FALSE",
      insight.event.mentioned ? "TRUE" : "FALSE",
      String(insight.participants.length),
    ]);
  } catch (e) {
    console.error("[thread-reader] insight log failed:", e);
  }
}

// Read one thread into structured insight. Never throws — returns an empty
// insight (and logs the failure) when Gemini is unconfigured, the text is empty,
// or the call errors, so the caller falls back to regex-only behavior.
export async function readThread(thread: ActivityThread): Promise<ThreadInsight> {
  const text = (thread.text || "").trim();
  if (!isGeminiConfigured() || !text) {
    const empty = emptyInsight();
    if (text) await logInsight(thread, empty, false, "gemini_unconfigured");
    return empty;
  }
  try {
    const user = `Track: ${thread.track}\nTitle: ${thread.name}\n\nThread:\n${text.slice(0, MAX_THREAD_CHARS)}`;
    const res = await callGeminiJSON<Record<string, unknown>>(SYSTEM, user, 1536);
    if (!res.ok || !res.data) {
      const empty = emptyInsight();
      await logInsight(thread, empty, false, res.error || "no_data");
      return empty;
    }
    const insight = normalizeInsight(res.data);
    await logInsight(thread, insight, true, "");
    return insight;
  } catch (e) {
    const empty = emptyInsight();
    await logInsight(thread, empty, false, e instanceof Error ? e.message : "error");
    return empty;
  }
}

// Read several threads concurrently. Each readThread already isolates its own
// failure, so the batch always resolves to one insight per input thread.
export async function readThreads(threads: ActivityThread[]): Promise<Map<string, ThreadInsight>> {
  const insights = await Promise.all(threads.map((t) => readThread(t)));
  const byGid = new Map<string, ThreadInsight>();
  threads.forEach((t, i) => byGid.set(t.gid, insights[i]));
  return byGid;
}
