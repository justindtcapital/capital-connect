// Asana API integration — server-only.
// Uses a Personal Access Token (PAT) bearer auth against https://app.asana.com/api/1.0/.
// In-memory caching avoids hammering Asana's 150 req/min rate limit.

import type { PortfolioEvent, AsanaEvent, AsanaActivity } from "@/lib/types";
import {
  ACTIVITY_NOTES_BUDGET,
  enrichActivityFromThreadText,
  formatActivityNotes,
} from "@/lib/activity-thread-intel";
import { emailBodyExcerpt } from "../lib/email-excerpt";
import { isInternalEmail, isNoiseEmail, type InternalConfig } from "@/lib/email-noise";
import { peopleEntriesFromActivity } from "@/lib/activity-canonical";
import { isNameOnlyAttendeeEmail } from "@/lib/email-address";
import { fetchAliasActivities, getActivityAliases, getInternalConfig } from "./gmail.server";
import { parseToIsoDate, compareIsoDatesDesc } from "@/lib/sheet-date";

const ASANA_BASE = "https://app.asana.com/api/1.0";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface AsanaCustomField {
  gid: string;
  name: string;
  type: string;
  display_value?: string | null;
  text_value?: string | null;
  number_value?: number | null;
  enum_value?: { gid: string; name: string } | null;
  multi_enum_values?: { gid: string; name: string }[] | null;
  date_value?: { date?: string | null; date_time?: string | null } | null;
}

interface AsanaTask {
  gid: string;
  name: string;
  due_on?: string | null;
  due_at?: string | null;
  completed?: boolean;
  custom_fields?: AsanaCustomField[];
  assignee?: { name?: string } | null;
  notes?: string | null;
  permalink_url?: string;
  memberships?: { section?: { name?: string } | null }[] | null;
}

interface CacheEntry<T> {
  value: T;
  expires: number;
}
const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | undefined {
  const e = cache.get(key);
  if (!e) return undefined;
  if (Date.now() > e.expires) {
    cache.delete(key);
    return undefined;
  }
  return e.value as T;
}
function setCached<T>(key: string, value: T) {
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

function asanaNetworkError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  const code =
    cause && typeof cause === "object" && cause !== null && "code" in cause
      ? String((cause as { code: unknown }).code)
      : "";
  if (
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    /fetch failed|Connect Timeout|ECONNRESET|ENOTFOUND|ETIMEDOUT/i.test(`${msg} ${code}`)
  ) {
    return new Error("Couldn't reach Asana — connection timed out.");
  }
  return err instanceof Error ? err : new Error(msg);
}

async function asanaFetch<T = unknown>(path: string): Promise<T> {
  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) throw new Error("ASANA_ACCESS_TOKEN is not configured");

  const url = path.startsWith("http") ? path : `${ASANA_BASE}${path}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Asana API ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    throw asanaNetworkError(err);
  }
}

// Fetch all tasks in a project with custom fields expanded.
export async function fetchProjectTasks(
  projectGid: string,
  opts: { dueAfter?: string; dueBefore?: string; extraFields?: string } = {}
): Promise<AsanaTask[]> {
  const baseFields = "name,due_on,due_at,completed,custom_fields,custom_fields.name,custom_fields.type,custom_fields.display_value,custom_fields.enum_value,custom_fields.multi_enum_values,custom_fields.text_value,custom_fields.number_value,custom_fields.date_value";
  const params = new URLSearchParams({
    opt_fields: opts.extraFields ? `${baseFields},${opts.extraFields}` : baseFields,
    limit: "100",
  });
  if (opts.dueAfter) params.set("due_on.after", opts.dueAfter);
  if (opts.dueBefore) params.set("due_on.before", opts.dueBefore);

  const cacheKey = `tasks:${projectGid}:${params.toString()}`;
  const cached = getCached<AsanaTask[]>(cacheKey);
  if (cached) return cached;

  const all: AsanaTask[] = [];
  let url: string | null = `/projects/${projectGid}/tasks?${params.toString()}`;
  while (url) {
    const json: { data: AsanaTask[]; next_page?: { uri: string } | null } = await asanaFetch(url);
    all.push(...(json.data || []));
    url = json.next_page?.uri ?? null;
  }
  setCached(cacheKey, all);
  return all;
}

// Discovery helper — logs all custom field names + types on a project.
// Useful on first deploy to figure out what's actually available.
export async function discoverFields(projectGid: string, label: string): Promise<void> {
  try {
    const tasks = await fetchProjectTasks(projectGid);
    const fieldMap = new Map<string, string>();
    for (const t of tasks) {
      for (const f of t.custom_fields || []) {
        if (!fieldMap.has(f.name)) fieldMap.set(f.name, f.type);
      }
    }
    console.log(`[asana:${label}] project ${projectGid} — ${tasks.length} tasks, fields:`,
      Array.from(fieldMap.entries()).map(([n, t]) => `${n} (${t})`).join(", ") || "none");
  } catch (err) {
    console.error(`[asana:${label}] discovery failed:`, err);
  }
}

// Helper: extract a string value from a custom field regardless of type.
function fieldStringValue(f: AsanaCustomField): string {
  if (f.display_value) return f.display_value;
  if (f.enum_value?.name) return f.enum_value.name;
  if (f.multi_enum_values?.length) return f.multi_enum_values.map((v) => v.name).join(", ");
  if (f.text_value) return f.text_value;
  if (f.number_value != null) return String(f.number_value);
  return "";
}

// Build a name->fields map for portfolio companies (one task per portco).
// Keyed by lowercased name (for case-insensitive matching), but the original
// display name is preserved so the Asana project can populate the UI on its own.
export async function fetchPortcoFields(): Promise<Map<string, { name: string; fields: Record<string, string> }>> {
  const projectGid = process.env.ASANA_PORTCO_PROJECT_GID;
  if (!projectGid) return new Map();

  const tasks = await fetchProjectTasks(projectGid);
  const result = new Map<string, { name: string; fields: Record<string, string> }>();
  for (const t of tasks) {
    const fields: Record<string, string> = {};
    for (const f of t.custom_fields || []) {
      const v = fieldStringValue(f);
      if (v) fields[f.name] = v;
    }
    result.set(t.name.trim().toLowerCase(), { name: t.name.trim(), fields });
  }
  return result;
}

// Fetch events within rolling 12-month window (today−6mo … today+6mo)
// and explode multi-select portco field into per-company event entries.
export async function fetchPortfolioEvents(): Promise<Map<string, PortfolioEvent[]>> {
  const projectGid = process.env.ASANA_EVENTS_PROJECT_GID;
  if (!projectGid) return new Map();

  const today = new Date();
  const sixMoBack = new Date(today);
  sixMoBack.setMonth(sixMoBack.getMonth() - 6);
  const sixMoFwd = new Date(today);
  sixMoFwd.setMonth(sixMoFwd.getMonth() + 6);
  const fmt = (d: Date) => d.toISOString().split("T")[0];

  const tasks = await fetchProjectTasks(projectGid, {
    dueAfter: fmt(sixMoBack),
    dueBefore: fmt(sixMoFwd),
  });

  const todayStr = fmt(today);
  const byCompany = new Map<string, PortfolioEvent[]>();

  // Heuristic field name matching — we don't know exact labels yet, so match common patterns.
  const isPortcoField = (name: string) => /portco|portfolio|compan/i.test(name);
  const isRoleField = (name: string) => /host|sponsor|lead|role/i.test(name);

  for (const task of tasks) {
    const date = task.due_on || (task.due_at ? task.due_at.split("T")[0] : "");
    if (!date) continue;

    let portcos: string[] = [];
    let role: "hosted" | "sponsored" | undefined;

    for (const f of task.custom_fields || []) {
      if (isPortcoField(f.name) && f.multi_enum_values?.length) {
        portcos = f.multi_enum_values.map((v) => v.name);
      } else if (isRoleField(f.name)) {
        const v = fieldStringValue(f).toLowerCase();
        if (v.includes("host") || v.includes("led by us") || v.includes("we lead")) role = "hosted";
        else if (v.includes("sponsor")) role = "sponsored";
      }
    }
    if (portcos.length === 0) continue;

    const status: "completed" | "planned" = date < todayStr ? "completed" : "planned";

    for (const portco of portcos) {
      const key = portco.trim().toLowerCase();
      const entry: PortfolioEvent = {
        id: `asana-${task.gid}-${key}`,
        date,
        name: task.name,
        type: "conference",
        status,
        eventRole: role,
      };
      const list = byCompany.get(key) || [];
      list.push(entry);
      byCompany.set(key, list);
    }
  }
  return byCompany;
}

// Fetch ALL events in the Asana Events project within a wide window
// (12mo back, 24mo forward) — used by the /events page and the EventPicker dropdown.
// Returns a flat list, *not* exploded by portco.
export async function fetchAllAsanaEvents(): Promise<AsanaEvent[]> {
  const projectGid = process.env.ASANA_EVENTS_PROJECT_GID;
  if (!projectGid) return [];

  const today = new Date();
  const back = new Date(today); back.setMonth(back.getMonth() - 12);
  const fwd = new Date(today); fwd.setMonth(fwd.getMonth() + 24);
  const fmt = (d: Date) => d.toISOString().split("T")[0];

  const tasks = await fetchProjectTasks(projectGid, {
    dueAfter: fmt(back),
    dueBefore: fmt(fwd),
  });

  const todayStr = fmt(today);
  const isPortcoField = (name: string) => /portco|portfolio|compan/i.test(name);
  const isRoleField = (name: string) => /^role$|hosted|sponsor/i.test(name);
  const isLeadField = (name: string) => /event\s*lead|owner|lead$/i.test(name);
  const isTypeField = (name: string) => /^type$|event type/i.test(name);
  const isFormatField = (name: string) =>
    /in.?person|virtual|format|location\s*type|delivery/i.test(name);
  const isIndustryField = (name: string) =>
    /industry|vertical|sector|domain|theme/i.test(name);
  const isAttendeeField = (name: string) =>
    /attend|headcount|head\s*count|rsvp|registr|turnout|guests?|# ?of|number of|expected/i.test(name);

  // Pull a numeric value off a custom field regardless of how it's typed in Asana.
  const fieldNumberValue = (f: AsanaCustomField): number | undefined => {
    if (typeof f.number_value === "number") return f.number_value;
    const raw = f.display_value ?? f.text_value ?? "";
    const m = raw.replace(/,/g, "").match(/\d+(\.\d+)?/);
    return m ? Number(m[0]) : undefined;
  };

  const parseFormat = (v: string): "in-person" | "virtual" | "hybrid" | undefined => {
    const s = v.toLowerCase();
    if (!s) return undefined;
    if (s.includes("hybrid")) return "hybrid";
    if (s.includes("virtual") || s.includes("online") || s.includes("remote") || s.includes("zoom") || s.includes("webinar")) return "virtual";
    if (s.includes("person") || s.includes("onsite") || s.includes("on-site") || s.includes("in-person")) return "in-person";
    return undefined;
  };

  const out: AsanaEvent[] = [];
  for (const task of tasks) {
    const date = task.due_on || (task.due_at ? task.due_at.split("T")[0] : "");
    if (!date) continue;

    let portcos: string[] = [];
    let role: "hosted" | "sponsored" | undefined;
    let type: AsanaEvent["type"] = "conference";
    let lead: string | undefined;
    let format: AsanaEvent["format"];
    let industry: string[] = [];
    let attendeeCount: number | undefined;

    for (const f of task.custom_fields || []) {
      if (isPortcoField(f.name) && f.multi_enum_values?.length) {
        portcos = f.multi_enum_values.map((v) => v.name);
      } else if (isAttendeeField(f.name)) {
        const n = fieldNumberValue(f);
        if (n != null) attendeeCount = n;
      } else if (isLeadField(f.name)) {
        const v = fieldStringValue(f);
        if (v) lead = v;
      } else if (isFormatField(f.name)) {
        const v = fieldStringValue(f);
        const parsed = parseFormat(v);
        if (parsed) format = parsed;
      } else if (isIndustryField(f.name)) {
        // Industry is a multi-select in Asana — collect all values.
        if (f.multi_enum_values?.length) {
          industry = f.multi_enum_values.map((v) => v.name).filter(Boolean);
        } else {
          const v = fieldStringValue(f);
          if (v) industry = v.split(",").map((s) => s.trim()).filter(Boolean);
        }
      } else if (isRoleField(f.name)) {
        const v = fieldStringValue(f).toLowerCase();
        if (v.includes("host") || v.includes("led by us") || v.includes("we lead")) role = "hosted";
        else if (v.includes("sponsor")) role = "sponsored";
      } else if (isTypeField(f.name)) {
        const v = fieldStringValue(f).toLowerCase();
        if (v.includes("dinner")) type = "dinner";
        else if (v.includes("webinar")) type = "webinar";
        else if (v.includes("meeting")) type = "meeting";
        else type = "conference";
      }
    }

    if (type === "conference" && format === "virtual") type = "webinar";

    out.push({
      gid: task.gid,
      name: task.name,
      date,
      status: date < todayStr ? "completed" : "planned",
      portcos,
      role,
      type,
      lead,
      format,
      sectors: industry,
      attendeeCount,
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

// ── Activity Tracking (BD / GTM) ─────────────────────────────────
// One task per BD or GTM activity. We don't know the exact custom-field labels
// (run discoverFields to log them), so company/person/owner/status/date/type are
// matched heuristically by field name, with sensible fallbacks. The matched
// company/person strings let the UI attach each activity to a Contact / PortCo.

const RICH_TASK_FIELDS = "assignee.name,notes,permalink_url,memberships.section.name";

// First custom field whose name matches `match`, as a flat string ("" if none).
function fieldByName(task: AsanaTask, match: (name: string) => boolean): string {
  for (const f of task.custom_fields || []) {
    if (match(f.name)) {
      const v = fieldStringValue(f);
      if (v) return v;
    }
  }
  return "";
}

const isCompanyField = (n: string) => /company|account|portco|portfolio|organi[sz]ation|client|customer|prospect\s*co/i.test(n);
const isPersonField = (n: string) => /contact|attendee|stakeholder|champion|\bperson\b|\blead\b(?!\s*source)/i.test(n);
const isStatusField = (n: string) => /status|stage|state|progress/i.test(n);
const isOwnerField = (n: string) => /owner|rep|\blead\b|assignee|responsible|bd\s*lead|account\s*lead/i.test(n);
const isTypeField = (n: string) => /type|activity|category|channel|motion|initiative/i.test(n);
const isDateField = (n: string) => /date|when|completed\s*on|activity\s*date|\bmet\b/i.test(n);
const isNotesField = (n: string) => /notes|comment|description|detail|summary/i.test(n);

function fieldDateValue(task: AsanaTask): string {
  for (const f of task.custom_fields || []) {
    if (!isDateField(f.name)) continue;
    const fromVal = f.date_value?.date || f.date_value?.date_time || "";
    const parsed = parseToIsoDate(fromVal) || parseToIsoDate(f.display_value || "");
    if (parsed) return parsed;
  }
  return "";
}

/**
 * Map an Asana BD/GTM task into an activity. When notes look like a pasted
 * email/calendar thread, shared thread intel fills Type/Status/People (and
 * Person/Company only when Asana custom fields left them blank).
 */
export function parseActivity(
  task: AsanaTask,
  track: "BD" | "GTM",
  opts?: { aliases?: Set<string>; internal?: InternalConfig },
): AsanaActivity {
  const dueDate = parseToIsoDate(task.due_on || "") || parseToIsoDate(task.due_at || "");
  const fieldDate = fieldDateValue(task);
  const section = task.memberships?.find((m) => m.section?.name)?.section?.name || "";
  // Built-in task description, else a custom "Notes"/"Comments" field (BD uses one).
  const rawNotes = (task.notes || "").trim() || fieldByName(task, isNotesField);
  const existingPerson = fieldByName(task, isPersonField) || undefined;
  const existingCompany = fieldByName(task, isCompanyField) || undefined;
  const existingType = fieldByName(task, isTypeField) || undefined;
  const existingStatus =
    section || fieldByName(task, isStatusField) || (task.completed ? "Completed" : undefined);

  const aliases = opts?.aliases ?? new Set(getActivityAliases());
  const internal = opts?.internal ?? getInternalConfig();
  const intel = enrichActivityFromThreadText(
    {
      subject: task.name || "",
      body: rawNotes,
      existingPerson,
      existingCompany,
      existingType,
      existingStatus,
    },
    aliases,
    internal,
  );

  let notes: string | undefined;
  if (intel.detected) {
    const audit = task.permalink_url ? `Asana: ${task.permalink_url}` : "";
    const excerpt = emailBodyExcerpt(rawNotes, ACTIVITY_NOTES_BUDGET) || rawNotes;
    notes = formatActivityNotes({
      headLine: intel.headLine,
      peopleLine: intel.peopleLine,
      channelLine: intel.channelLine,
      auditLine: audit,
      bodyExcerpt: excerpt,
      budget: ACTIVITY_NOTES_BUDGET,
    });
  } else if (rawNotes) {
    notes = rawNotes.slice(0, ACTIVITY_NOTES_BUDGET);
  }

  return {
    gid: task.gid,
    track,
    name: task.name,
    date: dueDate || fieldDate || undefined,
    completed: Boolean(task.completed),
    status: intel.detected ? intel.status || existingStatus : existingStatus,
    owner: task.assignee?.name || fieldByName(task, isOwnerField) || undefined,
    type: intel.detected ? intel.type || existingType : existingType,
    company: intel.company || existingCompany,
    person: intel.person || existingPerson,
    notes,
    url: task.permalink_url,
  };
}

export async function fetchActivities(): Promise<AsanaActivity[]> {
  const bdGid = process.env.ASANA_BD_PROJECT_GID;
  const gtmGid = process.env.ASANA_GTM_PROJECT_GID;
  if (!bdGid && !gtmGid) return [];

  const [bdTasks, gtmTasks] = await Promise.all([
    bdGid ? fetchProjectTasks(bdGid, { extraFields: RICH_TASK_FIELDS }) : Promise.resolve([]),
    gtmGid ? fetchProjectTasks(gtmGid, { extraFields: RICH_TASK_FIELDS }) : Promise.resolve([]),
  ]);

  const out: AsanaActivity[] = [
    ...bdTasks.map((t) => parseActivity(t, "BD")),
    ...gtmTasks.map((t) => parseActivity(t, "GTM")),
  ];
  // Newest first; undated activities sink to the bottom.
  out.sort((a, b) => compareIsoDatesDesc(a.date || "", b.date || ""));
  // #region agent log
  fetch("http://127.0.0.1:7724/ingest/5184a65b-0c76-4274-b203-81774fe31d23", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "3375d3" },
    body: JSON.stringify({
      sessionId: "3375d3",
      hypothesisId: "D",
      location: "asana.server.ts:fetchActivities",
      message: "Asana activity date coverage",
      data: {
        n: out.length,
        dated: out.filter((a) => a.date).length,
        undated: out.filter((a) => !a.date).length,
        isoOk: out.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a.date || "")).length,
        samples: out.slice(0, 8).map((a) => a.date || ""),
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  return out;
}

// ── Sourcing contacts from activity email threads ────────────────
// Activity notes are pasted email threads (To/From/Cc with addresses). We parse
// the people out so the CRM can dedupe + create them and log the activity.

export interface ParsedActivityPerson {
  name: string;
  email: string;
  /** Rough company name derived from the email domain. */
  company: string;
}
export interface ActivityThread {
  gid: string;
  track: "BD" | "GTM";
  name: string;
  /** Full task text (name + notes) — the raw thread the LLM reader consumes. */
  text: string;
  date?: string;
  people: ParsedActivityPerson[];
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

const titleCaseWords = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

function cleanDisplayName(raw: string): string {
  let s = raw.trim().replace(/["']/g, "").replace(/\s+/g, " ");
  // "Last, First" → "First Last"
  const parts = s.split(",");
  if (parts.length === 2 && parts[0].trim() && parts[1].trim() && !/\d/.test(s)) {
    s = `${parts[1].trim()} ${parts[0].trim()}`;
  }
  return titleCaseWords(s).slice(0, 80);
}

function nameFromLocalPart(local: string): string {
  const cleaned = local.replace(/\d+/g, "").replace(/[._-]+/g, " ").trim();
  return cleaned ? titleCaseWords(cleaned) : "";
}

function companyFromDomain(domain: string): string {
  const parts = domain.split(".");
  const sld = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  return sld ? titleCaseWords(sld) : "";
}

function parsePeople(text: string, excludeDomains: string[]): ParsedActivityPerson[] {
  // Capture "Display Name <email>" first so addresses get a real name.
  const namesByEmail = new Map<string, string>();
  const namedRe = /([A-Za-z][\w.,'\- ]{1,70}?)\s*[<(]\s*([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\s*[>)]/gi;
  let m: RegExpExecArray | null;
  while ((m = namedRe.exec(text))) {
    const email = m[2].toLowerCase();
    if (!namesByEmail.has(email)) namesByEmail.set(email, cleanDisplayName(m[1]));
  }
  const out = new Map<string, ParsedActivityPerson>();
  let e: RegExpExecArray | null;
  EMAIL_RE.lastIndex = 0;
  while ((e = EMAIL_RE.exec(text))) {
    const email = e[0].toLowerCase();
    const [local, domain] = email.split("@");
    if (!domain || out.has(email)) continue;
    if (excludeDomains.some((d) => domain === d || domain.endsWith(`.${d}`))) continue;
    if (isNoiseEmail(email)) continue;
    out.set(email, { name: namesByEmail.get(email) || nameFromLocalPart(local), email, company: companyFromDomain(domain) });
  }
  return [...out.values()];
}

function peopleForThreadText(
  text: string,
  excludeDomains: string[],
): ParsedActivityPerson[] {
  return parsePeople(text, excludeDomains).filter((p) => !isNameOnlyAttendeeEmail(p.email));
}

function peopleForGmailActivity(
  a: AsanaActivity,
  excludeDomains: string[],
): ParsedActivityPerson[] {
  const fromLine = peopleEntriesFromActivity(a).filter(
    (p) => !isNameOnlyAttendeeEmail(p.email),
  );
  const out: ParsedActivityPerson[] = [];
  const seen = new Set<string>();
  for (const p of fromLine) {
    const email = p.email.toLowerCase();
    const domain = email.split("@")[1] || "";
    if (seen.has(email)) continue;
    if (excludeDomains.some((d) => domain === d || domain.endsWith(`.${d}`))) continue;
    if (isNoiseEmail(email)) continue;
    seen.add(email);
    out.push({
      name: p.name,
      email,
      company: companyFromDomain(domain),
    });
  }
  // Fall back to full-text scan when People line was missing.
  if (out.length === 0) {
    return peopleForThreadText(`${a.name}\n${a.notes || ""}`, excludeDomains);
  }
  return out;
}

// Parse the given activities' threads into per-activity people lists.
// Asana gids re-fetch project tasks (full notes). gmail-* gids load alias
// activities and use the People line / notes (Source contacts on PortCo pages).
export async function parseActivityThreads(
  activityGids: string[],
  excludeDomains: string[] = ["dell.com"],
): Promise<ActivityThread[]> {
  const aliases = new Set(getActivityAliases().map((e) => e.toLowerCase()));
  const internal = getInternalConfig();
  const skipDomains = [
    ...excludeDomains,
    ...[...internal.domains],
  ].map((d) => d.toLowerCase());
  const skipPerson = (email: string) =>
    aliases.has(email.toLowerCase()) ||
    isInternalEmail(email, internal) ||
    isNoiseEmail(email);

  const asanaWanted = new Set(activityGids.filter((g) => !g.startsWith("gmail-")));
  const gmailWanted = new Set(activityGids.filter((g) => g.startsWith("gmail-")));
  const out: ActivityThread[] = [];

  const bdGid = process.env.ASANA_BD_PROJECT_GID;
  const gtmGid = process.env.ASANA_GTM_PROJECT_GID;
  if (asanaWanted.size > 0 && (bdGid || gtmGid)) {
    const [bd, gtm] = await Promise.all([
      bdGid ? fetchProjectTasks(bdGid, { extraFields: RICH_TASK_FIELDS }) : Promise.resolve([]),
      gtmGid ? fetchProjectTasks(gtmGid, { extraFields: RICH_TASK_FIELDS }) : Promise.resolve([]),
    ]);
    const tagged: { task: AsanaTask; track: "BD" | "GTM" }[] = [
      ...bd.map((t) => ({ task: t, track: "BD" as const })),
      ...gtm.map((t) => ({ task: t, track: "GTM" as const })),
    ];
    for (const { task, track } of tagged) {
      if (!asanaWanted.has(task.gid)) continue;
      const text = `${task.name}\n${task.notes || ""}`;
      out.push({
        gid: task.gid,
        track,
        name: task.name,
        text,
        date: parseToIsoDate(task.due_on || "") || parseToIsoDate(task.due_at || "") || fieldDateValue(task) || undefined,
        people: peopleForThreadText(text, skipDomains).filter((p) => !skipPerson(p.email)),
      });
    }
  }

  if (gmailWanted.size > 0) {
    const acts = await fetchAliasActivities().catch(() => [] as AsanaActivity[]);
    for (const a of acts) {
      if (!gmailWanted.has(a.gid)) continue;
      const text = `${a.name}\n${a.notes || ""}`;
      out.push({
        gid: a.gid,
        track: a.track,
        name: a.name,
        text,
        date: parseToIsoDate(a.date) || a.date,
        people: peopleForGmailActivity(a, skipDomains).filter((p) => !skipPerson(p.email)),
      });
    }
  }

  return out;
}
