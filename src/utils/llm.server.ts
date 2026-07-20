// LLM Query Tab — Gemini function-calling agent over VenturePulse data.
// Grounding: the agent answers ONLY from tool results. Asana is confidential and
// has no tool (it can never reach the model). See VenturePulse_LLM_Query_Tab_Spec.
//
// Web search is exposed as a CUSTOM tool (web_search) backed by an isolated Gemini
// "Google Search grounding" sub-call — because Gemini cannot combine the built-in
// google_search tool with custom functionDeclarations in the same request.

import {
  buildContacts,
  buildPortfolioCompanies,
  buildTargets,
  fetchSheetTab,
  listSheetTabs,
  TAB_NAMES,
} from "./sheets.server";
import { searchPeople, enrichPerson } from "./apollo.server";
import {
  draftEmail,
  callGeminiJSON,
  geminiGenerate,
  GEMINI_MODEL,
  type GeminiContent,
  type GeminiPart,
  type GeminiResponse,
} from "./gemini.server";
import type { Contact } from "@/lib/types";

export const LLM_MODEL = GEMINI_MODEL;
export const MAX_STEPS = 8;
/** Default wall-clock budget for one agent run (ms). Override with QUERY_AGENT_TIMEOUT_MS. */
export const DEFAULT_AGENT_TIMEOUT_MS = Number(process.env["QUERY_AGENT_TIMEOUT_MS"]) || 120_000;

export type AgentProgress = {
  step: number;
  maxSteps: number;
  phase: "thinking" | "tool" | "paused" | "done";
  tool?: string;
  message: string;
};

export type RunAgentOptions = {
  onProgress?: (p: AgentProgress) => void;
  /** Absolute deadline (Date.now() ms). */
  deadlineAt?: number;
};

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export interface Provenance {
  tools: JsonValue[];
  sources: JsonValue[];
  clarifications: JsonValue[];
  artifacts: JsonValue[];
  attachments: JsonValue[];
  tokensIn: number;
  tokensOut: number;
  reviewRequired: boolean;
}
export const emptyProvenance = (): Provenance => ({
  tools: [],
  sources: [],
  clarifications: [],
  artifacts: [],
  attachments: [],
  tokensIn: 0,
  tokensOut: 0,
  reviewRequired: false,
});

export interface AgentState {
  /** Conversation in Gemini `contents` format. */
  messages: GeminiContent[];
  prov: Provenance;
  /** functionResponse parts already computed for non-pausing tools this turn. */
  pendingResults?: GeminiPart[];
  /** The tool whose result we're waiting on (clarification / write approval). */
  pausedCall?: { id?: string; name: string };
}

export type AgentOutcome =
  | { status: "complete"; answer: string; state: AgentState; partial?: boolean }
  | {
      status: "needs_input";
      pause: {
        kind: "clarification" | "write_approval";
        toolUseId: string;
        name: string;
        input: JsonValue;
      };
      state: AgentState;
    }
  | { status: "error"; error: string; state: AgentState };

function textFromParts(parts: GeminiPart[]): string {
  return parts
    .filter((p) => typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim();
}

/** Best-effort answer from the last model turn + tool summaries. */
function partialAnswerFromState(state: AgentState, reason: string): string {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.role !== "model") continue;
    const t = textFromParts(m.parts || []);
    if (t) {
      return `${t}\n\n_(${reason})_`;
    }
  }
  const tools = (state.prov.tools || [])
    .map((t) => {
      if (t && typeof t === "object" && !Array.isArray(t) && "result_summary" in t) {
        return String((t as { result_summary?: string }).result_summary || "");
      }
      return "";
    })
    .filter(Boolean)
    .slice(-6);
  if (tools.length > 0) {
    return (
      `I gathered some results but couldn't finish a full answer:\n\n` +
      tools.map((s) => `• ${s}`).join("\n") +
      `\n\n_(${reason} — ask a follow-up to continue.)_`
    );
  }
  return `I hit a limit before finishing. _( ${reason} — try a more specific follow-up.)_`;
}

// Build a Gemini functionResponse part for a tool result.
function functionResponsePart(name: string, id: string | undefined, content: string): GeminiPart {
  const fr: GeminiPart["functionResponse"] = { name, response: { content } };
  if (id) fr.id = id;
  return { functionResponse: fr };
}

// ── Tool schemas (custom tools; web_search runs an isolated grounding sub-call) ──
const TOOLS = [
  {
    name: "query_contacts",
    description:
      "Search the CRM network contacts (Google Sheets). Returns matching contacts. Use for any question about who is in the network.",
    input_schema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description: "Free text matched against name, company, title, email",
        },
        sector: { type: "string" },
        temperature: { type: "string", enum: ["Council", "Hot", "Warm", "Cold"] },
        prime: { type: "string" },
        company: { type: "string" },
        limit: { type: "integer", description: "Max contacts to return (default 25)" },
        detail: {
          type: "boolean",
          description:
            "If true, return richer fields (notes summary, events, PortCo intros, LinkedIn) for up to a few contacts. Default false.",
        },
      },
    },
  },
  {
    name: "query_portfolio",
    description:
      "Search DTC's portfolio companies (from the Google Sheet only — Asana data is excluded). Returns name, sector/domain, website, location, and description.",
    input_schema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description: "Free text matched against name, sector, description",
        },
        domain: { type: "string", description: "Focus area, e.g. Security, AI, Data, Cloud" },
        limit: { type: "integer" },
      },
    },
  },
  {
    name: "list_sheet_tabs",
    description:
      "List EVERY tab (worksheet) that currently exists in the CRM Google Sheet workbook. Call this first when you need a tab whose exact name you don't know, or to discover what data is available. Reads Google Sheets metadata ONLY — no Asana access.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "query_sheet",
    description:
      "Read rows from ANY tab of the CRM Google Sheet by its exact name, with server-side filtering, column projection, sorting, and paging — USE THESE instead of pulling every row and scanning yourself. Works for EVERY tab in the workbook (call list_sheet_tabs if you don't know the exact tab name). Use this for tabs without a dedicated tool — e.g. Events, PortCos Introduced, Notes, App Events, PortCo Intel, Sumble Prospects, Customer Discovery, Target Accounts, Target Outreach, Target Strategy, LLM_Query_Log, and any other tab present. (Prefer query_contacts for network contacts, query_portfolio for portfolio companies, query_targets for the Targeting pipeline, and query_signals for Signal Radar — those return richer records.) This reads Google Sheets ONLY — it has NO access to Asana.",
    input_schema: {
      type: "object",
      properties: {
        tab: { type: "string", description: "The exact tab name to read (see list_sheet_tabs)." },
        search: {
          type: "string",
          description: "Free text matched (case-insensitive) against every column of every row.",
        },
        filters: {
          type: "array",
          description:
            "Column filters, ANDed together. Column names match the tab's headers case-insensitively.",
          items: {
            type: "object",
            properties: {
              column: { type: "string", description: "Header name of the column to test." },
              op: {
                type: "string",
                enum: [
                  "contains",
                  "equals",
                  "not_equals",
                  "gt",
                  "gte",
                  "lt",
                  "lte",
                  "empty",
                  "not_empty",
                ],
                description:
                  "Comparison operator (default contains). gt/gte/lt/lte compare numbers or dates when both sides parse, else text.",
              },
              value: { type: "string", description: "Comparison value (not needed for empty/not_empty)." },
            },
            required: ["column"],
          },
        },
        columns: {
          type: "array",
          items: { type: "string" },
          description: "Return ONLY these columns (header names). Omit for all columns.",
        },
        sort_by: { type: "string", description: "Column to sort by (numeric/date aware)." },
        sort_dir: { type: "string", enum: ["asc", "desc"], description: "Sort direction (default asc)." },
        limit: {
          type: "integer",
          description: "Max rows to return AFTER filtering/sorting (default 50, max 200).",
        },
        offset: { type: "integer", description: "Rows to skip after filtering/sorting (paging)." },
      },
      required: ["tab"],
    },
  },
  {
    name: "query_targets",
    description:
      "Search the Targeting pipeline (Targets tab) with joined outreach history and connection plans — richer than query_sheet on Targets. Use for any question about prospects/leads: who is in the pipeline, their stage, why they were surfaced, and outreach activity.",
    input_schema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description: "Free text matched against name, company, title, email, reason surfaced",
        },
        stage: {
          type: "string",
          enum: ["Prospecting", "Researching", "Outreach Sent", "Ready to Promote"],
        },
        sector: { type: "string" },
        company: { type: "string" },
        origin: { type: "string", description: "Where the lead came from (source contains)" },
        has_outreach: {
          type: "boolean",
          description: "true → only targets with at least one logged outreach attempt; false → only untouched ones",
        },
        limit: { type: "integer", description: "Max targets to return (default 25, max 100)" },
      },
    },
  },
  {
    name: "query_signals",
    description:
      "Search Signal Radar news signals (Signals tab): funding rounds, launches, moves and other tracked events about people/companies in the network. Sorted newest first. Use for any question about recent signals or news the app has captured.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Free text matched against person, company, signal, category" },
        company: { type: "string" },
        person: { type: "string" },
        category: { type: "string" },
        status: { type: "string", description: "Signal status, e.g. new, reviewed, dismissed" },
        since: { type: "string", description: "Only signals found on/after this date (YYYY-MM-DD)" },
        limit: { type: "integer", description: "Max signals to return (default 25, max 100)" },
      },
    },
  },
  {
    name: "apollo_search",
    description:
      "Search Apollo's database for NEW people not in the CRM, by title/location/company-domain/keywords. Results are obfuscated; use apollo_enrich to reveal a person.",
    input_schema: {
      type: "object",
      properties: {
        titles: { type: "array", items: { type: "string" } },
        locations: { type: "array", items: { type: "string" } },
        organizationDomains: { type: "array", items: { type: "string" } },
        keywords: { type: "string" },
        perPage: { type: "integer" },
      },
    },
  },
  {
    name: "apollo_enrich",
    description:
      "Enrich/reveal a person's contact info from Apollo by email, name+company, or LinkedIn URL.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string" },
        firstName: { type: "string" },
        lastName: { type: "string" },
        company: { type: "string" },
        linkedinUrl: { type: "string" },
      },
    },
  },
  {
    name: "draft_outreach",
    description:
      "Draft a personalized outreach email (the DTC Gem). Returns a reviewable draft; sends nothing.",
    input_schema: {
      type: "object",
      properties: {
        contactName: { type: "string" },
        contactEmail: { type: "string" },
        contactTitle: { type: "string" },
        contactCompany: { type: "string" },
        purpose: { type: "string" },
        tone: { type: "string" },
        notes: { type: "string" },
      },
      required: ["contactName", "purpose"],
    },
  },
  {
    name: "propose_invite_list",
    description:
      "Propose a list of CRM contacts for an event invite, filtered by sector/temperature/prime/company. Returns a reviewable list.",
    input_schema: {
      type: "object",
      properties: {
        sector: { type: "string" },
        temperature: { type: "string", enum: ["Council", "Hot", "Warm", "Cold"] },
        prime: { type: "string" },
        company: { type: "string" },
        search: { type: "string" },
        limit: { type: "integer" },
      },
    },
  },
  {
    name: "score_company_dna",
    description:
      "Score a prospective company against DTC's deep-tech investment thesis. Pass FINDINGS you gathered (e.g. from web_search) — never invented facts. Returns a reviewable score.",
    input_schema: {
      type: "object",
      properties: {
        company: { type: "string" },
        findings: {
          type: "string",
          description: "Grounded facts about the company gathered from tools",
        },
      },
      required: ["company", "findings"],
    },
  },
  {
    name: "sheets_update_contact",
    description:
      "Propose an update to an EXISTING CRM contact (matched by email). Can change profile fields (title, company, phone, location), classification (sector, prime), and temperature (setting temperature manually LOCKS it against the auto-scorecard). WRITE — does not commit; the user must approve a diff first.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string" },
        title: { type: "string" },
        company: { type: "string" },
        phone: { type: "string" },
        location: { type: "string" },
        sector: { type: "string", description: "Industry category" },
        prime: { type: "string", description: "The DTC relationship prime/owner" },
        temperature: {
          type: "string",
          enum: ["Council", "Hot", "Warm", "Cold"],
          description: "Manual relationship tier — locks the contact's rating",
        },
      },
      required: ["email"],
    },
  },
  {
    name: "sheets_add_note",
    description:
      "Add a note / interaction to an EXISTING CRM contact's trail (Notes tab), matched by email. Use to record call summaries, meeting notes, or anything worth remembering about the contact; optionally flag it for follow-up. WRITE — does not commit; the user must approve first.",
    input_schema: {
      type: "object",
      properties: {
        contactEmail: { type: "string" },
        note: { type: "string", description: "The note content" },
        type: {
          type: "string",
          enum: ["note", "call", "meeting", "email", "intro", "follow-up"],
          description: "Interaction type (default note)",
        },
        requiresFollowUp: { type: "boolean", description: "Flag the note for follow-up (default false)" },
      },
      required: ["contactEmail", "note"],
    },
  },
  {
    name: "sheets_add_target",
    description:
      "Propose adding a NEW prospect to the Targeting pipeline (Targets tab) — for leads to pursue, NOT confirmed network contacts (those use sheets_add_contact). Check query_targets first that they're not already in the pipeline. ALWAYS include reasonSurfaced saying why this person is worth pursuing. WRITE — does not commit; the user must approve first.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Full name" },
        title: { type: "string" },
        company: { type: "string" },
        email: { type: "string" },
        linkedin: { type: "string", description: "LinkedIn profile URL" },
        location: { type: "string" },
        sector: { type: "string" },
        stage: {
          type: "string",
          enum: ["Prospecting", "Researching", "Outreach Sent", "Ready to Promote"],
          description: "Pipeline stage (default Prospecting)",
        },
        reasonSurfaced: {
          type: "string",
          description: "Why this lead was surfaced (grounded in tool results)",
        },
        researchPurpose: { type: "string", description: "What we want to learn / why we're targeting them" },
      },
      required: ["name", "reasonSurfaced"],
    },
  },
  {
    name: "sheets_update_target",
    description:
      "Propose an update to an EXISTING target in the Targeting pipeline. Identify the target by email, or by name + company (as returned by query_targets). Only the fields inside `fields` are changed. WRITE — does not commit; the user must approve first.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Target's email (best identifier)" },
        name: { type: "string", description: "Target's full name (needed when no email)" },
        company: { type: "string", description: "Target's company (needed when no email)" },
        fields: {
          type: "object",
          description: "The fields to change",
          properties: {
            stage: {
              type: "string",
              enum: ["Prospecting", "Researching", "Outreach Sent", "Ready to Promote"],
            },
            sector: { type: "string" },
            title: { type: "string" },
            location: { type: "string" },
            notes: { type: "string", description: "Research purpose / notes field" },
          },
        },
      },
      required: ["fields"],
    },
  },
  {
    name: "sheets_add_contact",
    description:
      "Propose adding a NEW contact to the CRM. Use when the person isn't already in the network. WRITE — does not commit; the user must approve first. Default temperature is Warm unless specified.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        title: { type: "string" },
        company: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        location: { type: "string" },
        sector: { type: "string" },
        prime: { type: "string", description: "The DTC relationship prime/owner" },
        temperature: { type: "string", enum: ["Council", "Hot", "Warm", "Cold"] },
      },
      required: ["name"],
    },
  },
  {
    name: "sheets_add_event",
    description:
      "Propose creating a NEW event. Saved to the app's events (Google Sheet) — NOT written to Asana. WRITE — does not commit; the user must approve first.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        type: { type: "string", enum: ["conference", "dinner", "webinar", "meeting"] },
        format: { type: "string", enum: ["in-person", "virtual", "hybrid"] },
        lead: { type: "string" },
        role: { type: "string", enum: ["hosted", "sponsored"] },
        sectors: { type: "array", items: { type: "string" } },
        portcos: { type: "array", items: { type: "string" } },
      },
      required: ["name", "date"],
    },
  },
  {
    name: "sheets_add_attendees",
    description:
      "Tag CRM contacts as attendees or invitees of an event. First get the contacts' emails (via query_contacts or propose_invite_list), then pass them here. WRITE — does not commit; the user must approve first.",
    input_schema: {
      type: "object",
      properties: {
        eventName: { type: "string" },
        emails: { type: "array", items: { type: "string" }, description: "Contact emails to tag" },
        type: { type: "string", enum: ["attended", "invited"], description: "Default: invited" },
      },
      required: ["eventName", "emails"],
    },
  },
  {
    name: "request_clarification",
    description:
      "When intent is ambiguous, a required parameter is missing, or confidence is low, STOP and ask the user instead of guessing.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string" },
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              prompt: { type: "string" },
              type: { type: "string", enum: ["single_select", "multi_select"] },
              options: { type: "array", items: { type: "string" } },
              allow_other: { type: "boolean" },
            },
            required: ["id", "prompt", "type", "options"],
          },
        },
      },
      required: ["reason", "questions"],
    },
  },
];

const WRITE_TOOLS = new Set([
  "sheets_update_contact",
  "sheets_add_contact",
  "sheets_add_note",
  "sheets_add_event",
  "sheets_add_attendees",
  "sheets_add_target",
  "sheets_update_target",
]);
const PAUSE_TOOLS = new Set(["request_clarification", ...WRITE_TOOLS]);

const SYSTEM_PROMPT = `You are the VenturePulse Query agent for Dell Technologies Capital (DTC), a deep-tech VC firm. You answer questions and run workflows over the user's own data by calling tools.

MODULES: Network (CRM contacts), Targeting (prospects), Events, PortCo (portfolio companies), Signals (news), Dashboard.

GROUNDING (critical): Answer data questions ONLY from tool results. Never invent contacts, companies, events, numbers, or facts from prior knowledge. Cite what you used. If you have no tool data to answer, say so.

CLARIFICATION: If a request is ambiguous, missing a required detail, or you are unsure what the user wants, call request_clarification rather than guessing. Prefer asking.

DATA ACCESS: You have FULL read access to EVERY tab of the CRM Google Sheet workbook. Use the dedicated tools first — query_contacts (network contacts), query_portfolio (portfolio companies), query_targets (Targeting pipeline, with outreach history), query_signals (Signal Radar news) — they return the richest, joined records. For anything else use query_sheet with the exact tab name, and USE its filters/columns/sort_by/limit parameters to fetch only what you need rather than dumping whole tabs. If you don't know which tabs exist or the exact name, call list_sheet_tabs first. Known tabs include Events, PortCos Introduced, Notes, App Events, PortCo Intel, Sumble Prospects, Customer Discovery, Target Accounts, Target Outreach, Target Strategy, and LLM_Query_Log — but read any tab the workbook actually contains.

CONFIDENTIALITY: Asana data is confidential and is NOT available to you — you have no Asana tools and read Google Sheets only. The Asana-sourced PortCo investment fields and Asana Events never reach you. Never claim to access Asana; if asked for Asana-sourced data, explain it's excluded for confidentiality. (Everything in the Google Sheet is fair game.)

TOOLS & TIERS: Read tools (query_contacts, query_portfolio, query_targets, query_signals, query_sheet, apollo_search, apollo_enrich, web_search) run automatically. Draft tools (draft_outreach, propose_invite_list, score_company_dna) produce reviewable output and commit nothing. Write tools each require user approval of a diff before committing: sheets_update_contact (edit an existing contact by email — profile fields, sector, prime, or temperature), sheets_add_contact (add a NEW contact — check with query_contacts first that they're not already in the CRM), sheets_add_note (record a note/interaction on a contact's trail), sheets_add_event (create a NEW event in the app; this does NOT touch Asana), sheets_add_attendees (tag contacts as attendees/invitees of an event — gather their emails with query_contacts or propose_invite_list first), sheets_add_target (add a NEW prospect to the Targeting pipeline — check query_targets for duplicates and always give reasonSurfaced), and sheets_update_target (edit an existing target's stage/sector/title/location/notes). Before adding a contact, enrich with Apollo when useful so the new record is complete. If the user declines a proposed write, accept the decision — do not re-propose the same write. Writing must wait until any clarification is answered.

Be concise. When you produce a draft, list, or score via a tool, briefly summarize it for the user.`;

// ── Confidentiality: filter CRM rows (future-proof; Asana never reaches here) ──
function contactLevel(c: Contact): string {
  const lvl = (c as unknown as { confidentiality?: string }).confidentiality;
  return (lvl || "internal").toLowerCase();
}
function filterContacts(contacts: Contact[]): { kept: Contact[]; excluded: number } {
  let excluded = 0;
  const kept = contacts.filter((c) => {
    const lvl = contactLevel(c);
    if (lvl === "confidential" || lvl === "restricted") {
      excluded++;
      return false;
    }
    return true;
  });
  return { kept, excluded };
}

function matchContacts(contacts: Contact[], input: Record<string, JsonValue>): Contact[] {
  const s = (v: JsonValue | undefined) => (typeof v === "string" ? v.trim().toLowerCase() : "");
  const search = s(input.search),
    sector = s(input.sector),
    temp = s(input.temperature),
    prime = s(input.prime),
    company = s(input.company);
  return contacts.filter((c) => {
    if (search) {
      const hay = `${c.name} ${c.company} ${c.title} ${c.email}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (sector && !(c.sector || "").toLowerCase().includes(sector)) return false;
    if (temp && (c.temperature || "").toLowerCase() !== temp) return false;
    if (prime && !(c.prime || "").toLowerCase().includes(prime)) return false;
    if (company && !(c.company || "").toLowerCase().includes(company)) return false;
    return true;
  });
}

function leanContact(c: Contact, detail = false) {
  const openFollowUps = (c.interactions || []).filter(
    (i) => i.isFollowUp && !i.followUpComplete,
  ).length;
  const base = {
    name: c.name,
    title: c.title,
    company: c.company,
    email: c.email,
    sector: c.sector,
    temperature: c.temperature,
    prime: c.prime,
    location: c.location || "",
    activityScore: c.activityScore ?? 0,
    lastContact: c.lastContact || "",
    noteCount: (c.interactions || []).length,
    openFollowUps,
    followUpPending: Boolean(c.followUpPending || openFollowUps > 0),
    portCoIntroCount: (c.portCoIntros || []).length,
    eventsAttendedCount: (c.eventsAttended || []).length,
    eventsInvitedCount: (c.eventsInvited || []).length,
  };
  if (!detail) return base;
  return {
    ...base,
    linkedinUrl: c.linkedinUrl || "",
    contactType: c.contactType || "",
    portCoIntros: (c.portCoIntros || []).slice(0, 12),
    eventsAttended: (c.eventsAttended || []).slice(0, 8),
    eventsInvited: (c.eventsInvited || []).slice(0, 8),
    recentNotes: (c.interactions || [])
      .slice()
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
      .slice(0, 5)
      .map((i) => ({
        date: i.date,
        type: i.type,
        summary: (i.summary || "").slice(0, 180),
        followUp: Boolean(i.isFollowUp && !i.followUpComplete),
      })),
  };
}

/** Per-agent-turn cache so multi-step tools don't re-fetch the workbook. */
export interface ToolCache {
  contacts?: Contact[];
  portfolio?: Awaited<ReturnType<typeof buildPortfolioCompanies>>;
  targets?: Awaited<ReturnType<typeof buildTargets>>;
  tabs?: string[];
  sheetRows?: Map<string, string[][]>;
}

// ── query_sheet filtering/sorting helpers ────────────────────────
// Compare two cell values numerically when both parse as numbers, then as dates,
// falling back to case-insensitive text. Used by filters (gt/lt/…) and sort_by.
function compareCells(a: string, b: string): number {
  const clean = (v: string) => v.replace(/[$,%\s]/g, "");
  const na = clean(a) === "" ? NaN : Number(clean(a));
  const nb = clean(b) === "" ? NaN : Number(clean(b));
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (!Number.isNaN(da) && !Number.isNaN(db)) return da - db;
  return a.toLowerCase().localeCompare(b.toLowerCase());
}

interface SheetFilter {
  column: string;
  op?: string;
  value?: string;
}

function cellPasses(cell: string, op: string, value: string): boolean {
  const c = cell.trim();
  switch (op) {
    case "equals":
      return c.toLowerCase() === value.trim().toLowerCase();
    case "not_equals":
      return c.toLowerCase() !== value.trim().toLowerCase();
    case "gt":
      return c !== "" && compareCells(c, value) > 0;
    case "gte":
      return c !== "" && compareCells(c, value) >= 0;
    case "lt":
      return c !== "" && compareCells(c, value) < 0;
    case "lte":
      return c !== "" && compareCells(c, value) <= 0;
    case "empty":
      return c === "";
    case "not_empty":
      return c !== "";
    default: // contains
      return c.toLowerCase().includes(value.trim().toLowerCase());
  }
}

// Convert raw sheet rows (first row = headers) into header-keyed objects.
function rowsToObjects(
  rows: string[][],
  limit: number,
): { headers: string[]; records: Record<string, string>[]; total: number } {
  if (rows.length === 0) return { headers: [], records: [], total: 0 };
  const headers = rows[0].map((h, i) => h || `col${i + 1}`);
  const dataRows = rows.slice(1);
  const records = dataRows.slice(0, limit).map((r) => {
    const o: Record<string, string> = {};
    headers.forEach((h, i) => {
      o[h] = r[i] ?? "";
    });
    return o;
  });
  return { headers, records, total: dataRows.length };
}

// ── Tool executor (non-pausing tools) ────────────────────────────
interface ToolOutput {
  content: string;
  summary: string;
  sources: JsonValue[];
  artifacts: JsonValue[];
}

async function getCachedContacts(cache: ToolCache): Promise<Contact[]> {
  if (!cache.contacts) cache.contacts = await buildContacts();
  return cache.contacts;
}
async function getCachedPortfolio(cache: ToolCache) {
  if (!cache.portfolio) cache.portfolio = await buildPortfolioCompanies();
  return cache.portfolio;
}
async function getCachedTabs(cache: ToolCache): Promise<string[]> {
  if (!cache.tabs) cache.tabs = await listSheetTabs();
  return cache.tabs;
}
async function getCachedSheetRows(cache: ToolCache, tab: string): Promise<string[][]> {
  if (!cache.sheetRows) cache.sheetRows = new Map();
  const key = tab.toLowerCase();
  if (!cache.sheetRows.has(key)) {
    try {
      cache.sheetRows.set(key, await fetchSheetTab(tab));
    } catch {
      cache.sheetRows.set(key, []);
    }
  }
  return cache.sheetRows.get(key) || [];
}

async function executeTool(
  name: string,
  rawInput: JsonValue,
  cache: ToolCache,
): Promise<ToolOutput> {
  const input = (
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput : {}
  ) as Record<string, JsonValue>;
  const num = (v: JsonValue | undefined, d: number) => (typeof v === "number" ? v : d);
  const str = (v: JsonValue | undefined) => (typeof v === "string" ? v : undefined);
  const arr = (v: JsonValue | undefined) =>
    Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : undefined;
  const bool = (v: JsonValue | undefined) => v === true;

  switch (name) {
    case "query_contacts": {
      const all = await getCachedContacts(cache);
      const { kept, excluded } = filterContacts(all);
      const detail = bool(input.detail);
      const limit = detail
        ? Math.min(5, num(input.limit, 5))
        : Math.min(100, num(input.limit, 25));
      const matched = matchContacts(kept, input).slice(0, limit);
      const sources: JsonValue[] = matched.map((c) => ({
        type: "crm_row",
        ref: c.email || c.name,
        title: c.name,
      }));
      if (excluded > 0)
        sources.push({ type: "redaction", excluded_count: excluded, level: "confidential" });
      return {
        content: JSON.stringify({
          count: matched.length,
          excluded_confidential: excluded,
          detail,
          contacts: matched.map((c) => leanContact(c, detail)),
        }),
        summary: `query_contacts → ${matched.length} contacts${excluded ? ` (${excluded} confidential excluded)` : ""}${detail ? " (detail)" : ""}`,
        sources,
        artifacts: [],
      };
    }
    case "list_sheet_tabs": {
      const tabs = await getCachedTabs(cache);
      return {
        content: JSON.stringify({ count: tabs.length, tabs }),
        summary: `list_sheet_tabs → ${tabs.length} tabs`,
        sources: [],
        artifacts: [],
      };
    }
    case "query_sheet": {
      const requested = str(input.tab) || "";
      // Full workbook access: resolve against the tabs that ACTUALLY exist (not a
      // hardcoded allow-list), case-insensitively, so any tab in the sheet is
      // readable. Asana is never a tab here, so the confidentiality wall holds.
      const live = await getCachedTabs(cache);
      const tab = live.find((t) => t.toLowerCase() === requested.trim().toLowerCase());
      if (!tab) {
        return {
          content: JSON.stringify({
            error: `No tab named "${requested}". Available tabs: ${live.join(", ")}`,
          }),
          summary: `query_sheet → unknown tab "${requested}"`,
          sources: [],
          artifacts: [],
        };
      }
      const rows = await getCachedSheetRows(cache, tab);
      const { headers, records: all, total } = rowsToObjects(rows, Number.MAX_SAFE_INTEGER);
      // Case-insensitive header resolution for filters/columns/sort_by.
      const resolveHeader = (name: string | undefined) =>
        name ? headers.find((h) => h.toLowerCase() === name.trim().toLowerCase()) : undefined;

      let matched = all;
      const search = (str(input.search) || "").trim().toLowerCase();
      if (search) {
        matched = matched.filter((r) =>
          headers.some((h) => (r[h] || "").toLowerCase().includes(search)),
        );
      }

      const rawFilters = Array.isArray(input.filters) ? (input.filters as JsonValue[]) : [];
      const badColumns: string[] = [];
      for (const f of rawFilters) {
        if (!f || typeof f !== "object" || Array.isArray(f)) continue;
        const flt = f as unknown as SheetFilter;
        const col = resolveHeader(flt.column);
        if (!col) {
          if (flt.column) badColumns.push(flt.column);
          continue;
        }
        const op = flt.op || "contains";
        const value = flt.value ?? "";
        matched = matched.filter((r) => cellPasses(r[col] || "", op, String(value)));
      }

      const sortCol = resolveHeader(str(input.sort_by));
      if (sortCol) {
        const dir = str(input.sort_dir) === "desc" ? -1 : 1;
        matched = matched
          .slice()
          .sort((a, b) => dir * compareCells(a[sortCol] || "", b[sortCol] || ""));
      }

      const wantedCols = (arr(input.columns) || [])
        .map((c) => resolveHeader(c))
        .filter((c): c is string => !!c);
      const outHeaders = wantedCols.length > 0 ? wantedCols : headers;

      const offset = Math.max(0, num(input.offset, 0));
      const limit = Math.min(200, num(input.limit, 50));
      const page = matched.slice(offset, offset + limit).map((r) => {
        if (wantedCols.length === 0) return r;
        const o: Record<string, string> = {};
        for (const h of outHeaders) o[h] = r[h] || "";
        return o;
      });

      return {
        content: JSON.stringify({
          tab,
          total_rows: total,
          matched: matched.length,
          returned: page.length,
          offset,
          headers: outHeaders,
          ...(badColumns.length > 0
            ? { warning: `Unknown filter column(s): ${badColumns.join(", ")}. Available: ${headers.join(", ")}` }
            : {}),
          rows: page,
        }),
        summary: `query_sheet "${tab}" → ${page.length}/${matched.length} rows (of ${total})`,
        sources: [{ type: "sheet_tab", ref: tab, title: tab }],
        artifacts: [],
      };
    }
    case "query_targets": {
      if (!cache.targets) cache.targets = await buildTargets();
      const s = (v: JsonValue | undefined) =>
        typeof v === "string" ? v.trim().toLowerCase() : "";
      const search = s(input.search),
        stage = s(input.stage),
        sector = s(input.sector),
        company = s(input.company),
        origin = s(input.origin);
      const hasOutreach = typeof input.has_outreach === "boolean" ? input.has_outreach : undefined;
      const matched = cache.targets
        .filter((t) => {
          if (search) {
            const hay =
              `${t.name} ${t.company} ${t.title} ${t.email} ${t.reasonSurfaced || ""}`.toLowerCase();
            if (!hay.includes(search)) return false;
          }
          if (stage && (t.stage || "").toLowerCase() !== stage) return false;
          if (sector && !(t.sector || "").toLowerCase().includes(sector)) return false;
          if (company && !(t.company || "").toLowerCase().includes(company)) return false;
          if (origin && !(t.originSource || "").toLowerCase().includes(origin)) return false;
          if (hasOutreach === true && t.outreach.length === 0) return false;
          if (hasOutreach === false && t.outreach.length > 0) return false;
          return true;
        })
        .slice(0, Math.min(100, num(input.limit, 25)));
      const lean = matched.map((t) => ({
        name: t.name,
        title: t.title,
        company: t.company,
        email: t.email,
        linkedin: t.linkedinUrl,
        location: t.location,
        sector: t.sector,
        stage: t.stage,
        origin: t.originSource,
        reasonSurfaced: t.reasonSurfaced || "",
        dateAdded: t.dateAdded || "",
        notes: (t.notes || "").slice(0, 200),
        outreachCount: t.outreach.length,
        lastOutreach: t.outreach[0]
          ? `${t.outreach[0].date} · ${t.outreach[0].method} · ${(t.outreach[0].summary || "").slice(0, 120)}`
          : "",
        hasConnectionPlan: Boolean(t.connectionPlan),
      }));
      return {
        content: JSON.stringify({ count: lean.length, targets: lean }),
        summary: `query_targets → ${lean.length} targets`,
        sources: matched.map((t) => ({
          type: "target",
          ref: t.email || t.name,
          title: t.name,
        })),
        artifacts: [],
      };
    }
    case "query_signals": {
      const rows = await getCachedSheetRows(cache, TAB_NAMES.signals);
      const { records: all } = rowsToObjects(rows, Number.MAX_SAFE_INTEGER);
      const get = (r: Record<string, string>, name: string) => {
        const k = Object.keys(r).find((h) => h.toLowerCase() === name);
        return k ? r[k] || "" : "";
      };
      const s = (v: JsonValue | undefined) =>
        typeof v === "string" ? v.trim().toLowerCase() : "";
      const search = s(input.search),
        company = s(input.company),
        person = s(input.person),
        category = s(input.category),
        status = s(input.status),
        since = (str(input.since) || "").trim();
      const matched = all
        .filter((r) => {
          if (search) {
            const hay =
              `${get(r, "person")} ${get(r, "company")} ${get(r, "signal")} ${get(r, "category")} ${get(r, "type")}`.toLowerCase();
            if (!hay.includes(search)) return false;
          }
          if (company && !get(r, "company").toLowerCase().includes(company)) return false;
          if (person && !get(r, "person").toLowerCase().includes(person)) return false;
          if (category && !get(r, "category").toLowerCase().includes(category)) return false;
          if (status && get(r, "status").toLowerCase() !== status) return false;
          if (since && compareCells(get(r, "date found"), since) < 0) return false;
          return true;
        })
        .sort((a, b) => compareCells(get(b, "date found"), get(a, "date found")))
        .slice(0, Math.min(100, num(input.limit, 25)));
      const lean = matched.map((r) => ({
        id: get(r, "id"),
        dateFound: get(r, "date found"),
        type: get(r, "type"),
        status: get(r, "status"),
        person: get(r, "person"),
        company: get(r, "company"),
        category: get(r, "category"),
        signal: get(r, "signal"),
        relevance: get(r, "relevance"),
        urgency: get(r, "urgency"),
        sourceUrl: get(r, "source url"),
      }));
      return {
        content: JSON.stringify({ count: lean.length, signals: lean }),
        summary: `query_signals → ${lean.length} signals`,
        sources: matched.map((r) => ({
          type: "signal",
          ref: get(r, "source url") || get(r, "id"),
          title: get(r, "signal").slice(0, 80),
        })),
        artifacts: [],
      };
    }
    case "query_portfolio": {
      // Sheet-sourced only (buildPortfolioCompanies never includes Asana fields).
      const all = await getCachedPortfolio(cache);
      const search = (str(input.search) || "").toLowerCase();
      const domain = (str(input.domain) || "").toLowerCase();
      const matched = all
        .filter((c) => {
          if (search && !`${c.name} ${c.sector} ${c.description}`.toLowerCase().includes(search))
            return false;
          if (domain && !`${c.domain} ${c.sector}`.toLowerCase().includes(domain)) return false;
          return true;
        })
        .slice(0, Math.min(100, num(input.limit, 50)));
      const lean = matched.map((c) => ({
        name: c.name,
        sector: c.sector,
        domain: c.domain,
        website: c.website,
        location: c.location,
        description: c.description,
      }));
      return {
        content: JSON.stringify({ count: lean.length, companies: lean }),
        summary: `query_portfolio → ${lean.length} companies`,
        sources: matched.map((c) => ({ type: "portfolio", ref: c.name, title: c.name })),
        artifacts: [],
      };
    }
    case "apollo_search": {
      const res = await searchPeople({
        titles: arr(input.titles),
        locations: arr(input.locations),
        organizationDomains: arr(input.organizationDomains),
        keywords: str(input.keywords),
        perPage: num(input.perPage, 10),
      });
      return {
        content: JSON.stringify({ total: res.total, people: res.people }),
        summary: `apollo_search → ${res.people?.length ?? 0} candidates`,
        sources: [{ type: "apollo", ref: "search", title: str(input.keywords) || "people search" }],
        artifacts: [],
      };
    }
    case "apollo_enrich": {
      const r = await enrichPerson({
        email: str(input.email),
        firstName: str(input.firstName),
        lastName: str(input.lastName),
        organizationName: str(input.company),
        linkedinUrl: str(input.linkedinUrl),
      });
      return {
        content: JSON.stringify(r),
        summary: r.found
          ? `apollo_enrich → ${r.name || r.email || "person"}`
          : "apollo_enrich → no match",
        sources: [
          {
            type: "apollo",
            ref: r.email || str(input.email) || str(input.linkedinUrl) || "enrich",
            title: r.name || "",
          },
        ],
        artifacts: [],
      };
    }
    case "draft_outreach": {
      const d = await draftEmail({
        contactName: str(input.contactName) || "",
        contactTitle: str(input.contactTitle),
        contactCompany: str(input.contactCompany),
        purpose: str(input.purpose) || "",
        tone: str(input.tone),
        notes: str(input.notes),
      });
      if (!d.found)
        return {
          content: JSON.stringify({ error: d.error }),
          summary: "draft_outreach failed",
          sources: [],
          artifacts: [],
        };
      const artifact = {
        type: "draft_email",
        to: str(input.contactEmail) || "",
        contactName: str(input.contactName) || "",
        subject: d.subject || "",
        body: d.body || "",
      };
      return {
        content: JSON.stringify({ subject: d.subject, body: d.body }),
        summary: `draft_outreach → "${d.subject}"`,
        sources: [],
        artifacts: [artifact],
      };
    }
    case "propose_invite_list": {
      const all = await getCachedContacts(cache);
      const { kept } = filterContacts(all);
      const matched = matchContacts(kept, input).slice(0, Math.min(200, num(input.limit, 50)));
      const contacts = matched.map((c) => leanContact(c, false));
      const artifact = {
        type: "invite_list",
        count: matched.length,
        contacts,
      };
      return {
        content: JSON.stringify({ count: matched.length, contacts }),
        summary: `propose_invite_list → ${matched.length} contacts`,
        sources: matched.map((c) => ({ type: "crm_row", ref: c.email || c.name, title: c.name })),
        artifacts: [artifact],
      };
    }
    case "score_company_dna": {
      const company = str(input.company) || "";
      const findings = str(input.findings) || "";
      const sub = await scoreCompanyDna(company, findings);
      const parsed: JsonValue =
        sub.ok && sub.data ? (sub.data as JsonValue) : { raw: sub.error || "scoring failed" };
      const artifact = { type: "company_score", company, score: parsed };
      return {
        content: JSON.stringify(parsed),
        summary: `score_company_dna → ${company}`,
        sources: [],
        artifacts: [artifact],
      };
    }
    case "web_search": {
      return geminiWebSearch(str(input.query) || "");
    }
    default:
      return {
        content: JSON.stringify({ error: `Unknown tool ${name}` }),
        summary: `unknown tool ${name}`,
        sources: [],
        artifacts: [],
      };
  }
}

// ── Gemini wiring ────────────────────────────────────────────────
// Convert a JSON-schema-style tool input_schema to a Gemini Schema (uppercase
// types; only the fields Gemini supports).
function toGeminiSchema(s: unknown): Record<string, unknown> | undefined {
  if (!s || typeof s !== "object") return undefined;
  const src = s as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (src.type) out.type = String(src.type).toUpperCase();
  if (src.description) out.description = src.description;
  if (src.enum) out.enum = src.enum;
  if (src.properties && typeof src.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src.properties as Record<string, unknown>))
      props[k] = toGeminiSchema(v);
    out.properties = props;
  }
  if (src.items) out.items = toGeminiSchema(src.items);
  if (Array.isArray(src.required)) out.required = src.required;
  return out;
}

// Tool declarations Gemini sees: the custom tools + a web_search function whose
// executor performs an isolated Google Search grounding call (see geminiWebSearch).
const FUNCTION_DECLARATIONS = [
  ...TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: toGeminiSchema(t.input_schema),
  })),
  {
    name: "web_search",
    description:
      "Search the public web for recent, factual information and return a concise summary with sources. Use whenever the question needs current external facts (news, company info, people).",
    parameters: {
      type: "OBJECT",
      properties: { query: { type: "STRING", description: "The search query" } },
      required: ["query"],
    },
  },
];

// Thesis-fit scorer, shared by the agent's score_company_dna tool and the
// /platform diligence flow. Scores ONLY from supplied findings.
export async function scoreCompanyDna(
  company: string,
  findings: string,
): Promise<{ ok: boolean; data?: { score?: number; dimensions?: JsonValue[]; rationale?: string }; error?: string }> {
  return callGeminiJSON<{
    score?: number;
    dimensions?: JsonValue[];
    rationale?: string;
  }>(
    'You score companies for a deep-tech VC (security, AI, data, cloud, infrastructure, silicon, supply chain). Score ONLY from the provided findings; do not invent facts. Output ONLY JSON: {"score":<1-10>,"dimensions":[{"name":"","score":<1-10>,"note":""}],"rationale":""}',
    `Company: ${company}\n\nFindings:\n${findings}`,
    1024,
  );
}

// Isolated web-search grounding sub-call. Kept separate from the agent's
// function-calling request because Gemini disallows mixing google_search with
// custom functionDeclarations in one call.
async function geminiWebSearch(query: string): Promise<ToolOutput> {
  if (!query)
    return {
      content: JSON.stringify({ error: "empty query" }),
      summary: "web_search → empty query",
      sources: [],
      artifacts: [],
    };
  let resp: GeminiResponse;
  try {
    resp = await geminiGenerate({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Search the web and give a concise, factual summary with the key facts for: ${query}`,
            },
          ],
        },
      ],
      tools: [{ googleSearch: {} }],
      generationConfig: { maxOutputTokens: 1500 + 2048, thinkingConfig: { thinkingBudget: 2048 } },
    });
  } catch (e) {
    return {
      content: JSON.stringify({ error: e instanceof Error ? e.message : "web_search failed" }),
      summary: "web_search error",
      sources: [],
      artifacts: [],
    };
  }
  const cand = resp.candidates?.[0];
  const text = (cand?.content?.parts || [])
    .filter((p) => typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
    .trim();
  const sources: JsonValue[] = [];
  const gm = cand?.groundingMetadata as
    | { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> }
    | undefined;
  for (const ch of gm?.groundingChunks || []) {
    const w = ch?.web;
    if (w?.uri) sources.push({ type: "web", ref: w.uri, title: w.title || "" });
  }
  return {
    content: JSON.stringify({ summary: text, sources }),
    summary: `web_search → ${sources.length} source${sources.length !== 1 ? "s" : ""}`,
    sources,
    artifacts: [],
  };
}

// ── Agent loop ───────────────────────────────────────────────────
export async function runAgent(
  state: AgentState,
  cache: ToolCache = {},
  opts: RunAgentOptions = {},
): Promise<AgentOutcome> {
  const report = (p: Omit<AgentProgress, "maxSteps"> & { maxSteps?: number }) => {
    opts.onProgress?.({ maxSteps: MAX_STEPS, ...p });
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    if (opts.deadlineAt && Date.now() > opts.deadlineAt) {
      return {
        status: "complete",
        answer: partialAnswerFromState(state, "timed out"),
        state,
        partial: true,
      };
    }

    report({
      step: step + 1,
      phase: "thinking",
      message: step === 0 ? "Thinking…" : `Thinking (step ${step + 1}/${MAX_STEPS})…`,
    });

    let resp: GeminiResponse;
    try {
      resp = await geminiGenerate({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: state.messages,
        tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
        generationConfig: {
          maxOutputTokens: 4096 + 4096,
          thinkingConfig: { thinkingBudget: 4096 },
        },
      });
    } catch (err) {
      return {
        status: "error",
        error: err instanceof Error ? err.message : "Model call failed",
        state,
      };
    }

    if (opts.deadlineAt && Date.now() > opts.deadlineAt) {
      return {
        status: "complete",
        answer: partialAnswerFromState(state, "timed out"),
        state,
        partial: true,
      };
    }

    const cand = resp.candidates?.[0];
    if (resp.usageMetadata) {
      state.prov.tokensIn += resp.usageMetadata.promptTokenCount || 0;
      state.prov.tokensOut += resp.usageMetadata.candidatesTokenCount || 0;
    }
    const parts = cand?.content?.parts || [];
    // Persist the model turn verbatim so the next request keeps full history.
    state.messages.push({ role: "model", parts });

    const calls = parts
      .map((p) => p.functionCall)
      .filter((c): c is NonNullable<GeminiPart["functionCall"]> => !!c)
      // Give every call a stable id (Gemini may omit it).
      .map((c, i) => ({
        id: c.id || `${c.name}-${step}-${i}`,
        name: c.name,
        args: (c.args || {}) as JsonValue,
      }));

    if (calls.length === 0) {
      const answer = textFromParts(parts);
      report({ step: step + 1, phase: "done", message: "Done" });
      return { status: "complete", answer, state };
    }

    const pauseCall = calls.find((c) => PAUSE_TOOLS.has(c.name));

    // Execute the non-pausing tools first (their results are needed regardless).
    const results: GeminiPart[] = [];
    for (const c of calls) {
      if (PAUSE_TOOLS.has(c.name)) continue;
      if (opts.deadlineAt && Date.now() > opts.deadlineAt) {
        return {
          status: "complete",
          answer: partialAnswerFromState(state, "timed out"),
          state,
          partial: true,
        };
      }
      report({
        step: step + 1,
        phase: "tool",
        tool: c.name,
        message: `Running ${c.name}…`,
      });
      let out: ToolOutput;
      try {
        out = await executeTool(c.name, c.args, cache);
      } catch (e) {
        out = {
          content: JSON.stringify({ error: e instanceof Error ? e.message : "tool error" }),
          summary: `${c.name} error`,
          sources: [],
          artifacts: [],
        };
      }
      state.prov.tools.push({ tool: c.name, input: c.args, result_summary: out.summary });
      state.prov.sources.push(...out.sources);
      state.prov.artifacts.push(...out.artifacts);
      results.push(functionResponsePart(c.name, c.id, out.content));
    }

    // Pause for clarification / write approval (handled by the client). Stash any
    // already-computed results so resume can satisfy every function call at once.
    if (pauseCall) {
      state.pendingResults = results;
      state.pausedCall = { id: pauseCall.id, name: pauseCall.name };
      state.prov.reviewRequired = state.prov.reviewRequired || WRITE_TOOLS.has(pauseCall.name);
      if (pauseCall.name === "request_clarification")
        state.prov.clarifications.push(pauseCall.args);
      report({
        step: step + 1,
        phase: "paused",
        tool: pauseCall.name,
        message:
          pauseCall.name === "request_clarification"
            ? "Waiting for your answer…"
            : "Waiting for approval…",
      });
      return {
        status: "needs_input",
        pause: {
          kind: pauseCall.name === "request_clarification" ? "clarification" : "write_approval",
          toolUseId: pauseCall.id,
          name: pauseCall.name,
          input: pauseCall.args,
        },
        state,
      };
    }

    state.messages.push({ role: "user", parts: results });
  }

  // Soft exit: return whatever we have instead of a hard error.
  return {
    status: "complete",
    answer: partialAnswerFromState(state, `stopped after ${MAX_STEPS} steps`),
    state,
    partial: true,
  };
}

// Resume a paused loop: combine any stashed tool results with the user's answer /
// approval into one user turn (every function call gets exactly one response).
export async function resumeAgent(
  state: AgentState,
  toolUseId: string,
  resultText: string,
  cache: ToolCache = {},
  opts: RunAgentOptions = {},
): Promise<AgentOutcome> {
  const paused = state.pausedCall;
  const combined: GeminiPart[] = [...(state.pendingResults || [])];
  if (paused) combined.push(functionResponsePart(paused.name, paused.id || toolUseId, resultText));
  state.pendingResults = [];
  state.pausedCall = undefined;
  state.messages.push({ role: "user", parts: combined });
  return runAgent(state, cache, opts);
}
