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
  fetchSheetTab,
  listSheetTabs,
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
const MAX_STEPS = 8;

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
  | { status: "complete"; answer: string; state: AgentState }
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
        temperature: { type: "string", enum: ["Hot", "Warm", "Cold"] },
        prime: { type: "string" },
        company: { type: "string" },
        limit: { type: "integer", description: "Max contacts to return (default 25)" },
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
      "Read rows from ANY tab of the CRM Google Sheet by its exact name. Returns the header row + data rows as objects. Works for EVERY tab in the workbook (call list_sheet_tabs if you don't know the exact tab name). Use this for tabs without a dedicated tool — e.g. Targets, Signals, Events, PortCos Introduced, Notes, App Events, PortCo Intel, Sumble Prospects, Customer Discovery, Target Accounts, Target Outreach, Target Strategy, LLM_Query_Log, and any other tab present. (For network contacts prefer query_contacts; for portfolio companies prefer query_portfolio — those return richer, joined records.) This reads Google Sheets ONLY — it has NO access to Asana.",
    input_schema: {
      type: "object",
      properties: {
        tab: { type: "string", description: "The exact tab name to read (see list_sheet_tabs)." },
        limit: { type: "integer", description: "Max data rows to return (default 50, max 200)." },
      },
      required: ["tab"],
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
        temperature: { type: "string", enum: ["Hot", "Warm", "Cold"] },
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
      "Propose an update to an EXISTING CRM contact (matched by email). WRITE — does not commit; the user must approve a diff first.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string" },
        title: { type: "string" },
        company: { type: "string" },
        phone: { type: "string" },
        location: { type: "string" },
      },
      required: ["email"],
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
        temperature: { type: "string", enum: ["Hot", "Warm", "Cold"] },
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
  "sheets_add_event",
  "sheets_add_attendees",
]);
const PAUSE_TOOLS = new Set(["request_clarification", ...WRITE_TOOLS]);

const SYSTEM_PROMPT = `You are the VenturePulse Query agent for Dell Technologies Capital (DTC), a deep-tech VC firm. You answer questions and run workflows over the user's own data by calling tools.

MODULES: Network (CRM contacts), Targeting (prospects), Events, PortCo (portfolio companies), Signals (news), Dashboard.

GROUNDING (critical): Answer data questions ONLY from tool results. Never invent contacts, companies, events, numbers, or facts from prior knowledge. Cite what you used. If you have no tool data to answer, say so.

CLARIFICATION: If a request is ambiguous, missing a required detail, or you are unsure what the user wants, call request_clarification rather than guessing. Prefer asking.

DATA ACCESS: You have FULL read access to EVERY tab of the CRM Google Sheet workbook. Use query_contacts for network contacts and query_portfolio for portfolio companies (richest, joined records). For anything else use query_sheet with the exact tab name; if you don't know which tabs exist or the exact name, call list_sheet_tabs first to discover the whole workbook, then read the relevant tab(s). Known tabs include Targets, Signals, Events, PortCos Introduced, Notes, App Events, PortCo Intel, Sumble Prospects, Customer Discovery, Target Accounts, Target Outreach, Target Strategy, and LLM_Query_Log — but read any tab the workbook actually contains.

CONFIDENTIALITY: Asana data is confidential and is NOT available to you — you have no Asana tools and read Google Sheets only. The Asana-sourced PortCo investment fields and Asana Events never reach you. Never claim to access Asana; if asked for Asana-sourced data, explain it's excluded for confidentiality. (Everything in the Google Sheet is fair game.)

TOOLS & TIERS: Read tools (query_contacts, query_portfolio, query_sheet, apollo_search, apollo_enrich, web_search) run automatically. Draft tools (draft_outreach, propose_invite_list, score_company_dna) produce reviewable output and commit nothing. Write tools each require user approval of a diff before committing: sheets_update_contact (edit an existing contact by email), sheets_add_contact (add a NEW contact — check with query_contacts first that they're not already in the CRM), sheets_add_event (create a NEW event in the app; this does NOT touch Asana), and sheets_add_attendees (tag contacts as attendees/invitees of an event — gather their emails with query_contacts or propose_invite_list first). Before adding a contact, enrich with Apollo when useful so the new record is complete. Writing must wait until any clarification is answered.

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

function leanContact(c: Contact) {
  return {
    name: c.name,
    title: c.title,
    company: c.company,
    email: c.email,
    sector: c.sector,
    temperature: c.temperature,
    prime: c.prime,
    location: c.location || "",
  };
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

async function executeTool(name: string, rawInput: JsonValue): Promise<ToolOutput> {
  const input = (
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput : {}
  ) as Record<string, JsonValue>;
  const num = (v: JsonValue | undefined, d: number) => (typeof v === "number" ? v : d);
  const str = (v: JsonValue | undefined) => (typeof v === "string" ? v : undefined);
  const arr = (v: JsonValue | undefined) =>
    Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : undefined;

  switch (name) {
    case "query_contacts": {
      const all = await buildContacts();
      const { kept, excluded } = filterContacts(all);
      const matched = matchContacts(kept, input).slice(0, Math.min(100, num(input.limit, 25)));
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
          contacts: matched.map(leanContact),
        }),
        summary: `query_contacts → ${matched.length} contacts${excluded ? ` (${excluded} confidential excluded)` : ""}`,
        sources,
        artifacts: [],
      };
    }
    case "list_sheet_tabs": {
      const tabs = await listSheetTabs();
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
      const live = await listSheetTabs();
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
      let rows: string[][] = [];
      try {
        rows = await fetchSheetTab(tab);
      } catch {
        /* tab may be empty */
      }
      const limit = Math.min(200, num(input.limit, 50));
      const { headers, records, total } = rowsToObjects(rows, limit);
      return {
        content: JSON.stringify({
          tab,
          total_rows: total,
          returned: records.length,
          headers,
          rows: records,
        }),
        summary: `query_sheet "${tab}" → ${records.length}/${total} rows`,
        sources: [{ type: "sheet_tab", ref: tab, title: tab }],
        artifacts: [],
      };
    }
    case "query_portfolio": {
      // Sheet-sourced only (buildPortfolioCompanies never includes Asana fields).
      const all = await buildPortfolioCompanies();
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
      const all = await buildContacts();
      const { kept } = filterContacts(all);
      const matched = matchContacts(kept, input).slice(0, Math.min(200, num(input.limit, 50)));
      const artifact = {
        type: "invite_list",
        count: matched.length,
        contacts: matched.map(leanContact),
      };
      return {
        content: JSON.stringify({ count: matched.length, contacts: matched.map(leanContact) }),
        summary: `propose_invite_list → ${matched.length} contacts`,
        sources: matched.map((c) => ({ type: "crm_row", ref: c.email || c.name, title: c.name })),
        artifacts: [artifact],
      };
    }
    case "score_company_dna": {
      const company = str(input.company) || "";
      const findings = str(input.findings) || "";
      const sub = await callGeminiJSON<{
        score?: number;
        dimensions?: JsonValue[];
        rationale?: string;
      }>(
        'You score companies for a deep-tech VC (security, AI, data, cloud, infrastructure, silicon, supply chain). Score ONLY from the provided findings; do not invent facts. Output ONLY JSON: {"score":<1-10>,"dimensions":[{"name":"","score":<1-10>,"note":""}],"rationale":""}',
        `Company: ${company}\n\nFindings:\n${findings}`,
        1024,
      );
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
export async function runAgent(state: AgentState): Promise<AgentOutcome> {
  for (let step = 0; step < MAX_STEPS; step++) {
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
      const answer = parts
        .filter((p) => typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n")
        .trim();
      return { status: "complete", answer, state };
    }

    const pauseCall = calls.find((c) => PAUSE_TOOLS.has(c.name));

    // Execute the non-pausing tools first (their results are needed regardless).
    const results: GeminiPart[] = [];
    for (const c of calls) {
      if (PAUSE_TOOLS.has(c.name)) continue;
      let out: ToolOutput;
      try {
        out = await executeTool(c.name, c.args);
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
  return { status: "error", error: "Agent reached its step limit without finishing.", state };
}

// Resume a paused loop: combine any stashed tool results with the user's answer /
// approval into one user turn (every function call gets exactly one response).
export async function resumeAgent(
  state: AgentState,
  toolUseId: string,
  resultText: string,
): Promise<AgentOutcome> {
  const paused = state.pausedCall;
  const combined: GeminiPart[] = [...(state.pendingResults || [])];
  if (paused) combined.push(functionResponsePart(paused.name, paused.id || toolUseId, resultText));
  state.pendingResults = [];
  state.pausedCall = undefined;
  state.messages.push({ role: "user", parts: combined });
  return runAgent(state);
}
