// Asana API integration — server-only.
// Uses a Personal Access Token (PAT) bearer auth against https://app.asana.com/api/1.0/.
// In-memory caching avoids hammering Asana's 150 req/min rate limit.

import type { PortfolioEvent, AsanaEvent, AsanaActivity } from "@/lib/types";

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

async function asanaFetch<T = unknown>(path: string): Promise<T> {
  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) throw new Error("ASANA_ACCESS_TOKEN is not configured");

  const url = path.startsWith("http") ? path : `${ASANA_BASE}${path}`;
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
}

// Fetch all tasks in a project with custom fields expanded.
export async function fetchProjectTasks(
  projectGid: string,
  opts: { dueAfter?: string; dueBefore?: string; extraFields?: string } = {}
): Promise<AsanaTask[]> {
  const baseFields = "name,due_on,due_at,completed,custom_fields,custom_fields.name,custom_fields.type,custom_fields.display_value,custom_fields.enum_value,custom_fields.multi_enum_values,custom_fields.text_value,custom_fields.number_value";
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
const isDateField = (n: string) => /date|when|met|completed\s*on|activity\s*date/i.test(n);
const isNotesField = (n: string) => /notes|comment|description|detail|summary/i.test(n);

function parseActivity(task: AsanaTask, track: "BD" | "GTM"): AsanaActivity {
  const dueDate = task.due_on || (task.due_at ? task.due_at.split("T")[0] : "");
  const fieldDate = fieldByName(task, isDateField);
  const section = task.memberships?.find((m) => m.section?.name)?.section?.name || "";
  // Built-in task description, else a custom "Notes"/"Comments" field (BD uses one).
  const notes = (task.notes || "").trim() || fieldByName(task, isNotesField);

  return {
    gid: task.gid,
    track,
    name: task.name,
    date: (dueDate || fieldDate || "").slice(0, 10) || undefined,
    completed: Boolean(task.completed),
    status: section || fieldByName(task, isStatusField) || (task.completed ? "Completed" : undefined),
    owner: task.assignee?.name || fieldByName(task, isOwnerField) || undefined,
    type: fieldByName(task, isTypeField) || undefined,
    company: fieldByName(task, isCompanyField) || undefined,
    person: fieldByName(task, isPersonField) || undefined,
    notes: notes ? notes.slice(0, 600) : undefined,
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
  out.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
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
// Skip shared/system mailboxes — they aren't people.
const SYSTEM_LOCALPART = /^(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|calendar|info|support|admin|sales|marketing|events?|team|hello|contact|help|billing)$/i;
// Conferencing / calendar / automation domains whose addresses aren't people
// (e.g. Zoom room connectors "<meeting-id>@zoomcrc.com", Google Calendar resources,
// and Asana's own add-by-email addresses "x+<project-gid>@mail.asana.com").
const NON_PERSON_DOMAIN = /(?:zoomcrc\.com|calendar\.google\.com|calendar-server\.|resource\.calendar\.|@?webex\.com$|teams\.microsoft\.com|asana\.com)$/i;

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
    if (NON_PERSON_DOMAIN.test(domain)) continue;
    if (SYSTEM_LOCALPART.test(local)) continue;
    // Reject addresses whose local part has no letters (meeting IDs, etc.) — not a person.
    if (!/[a-z]/i.test(local)) continue;
    out.set(email, { name: namesByEmail.get(email) || nameFromLocalPart(local), email, company: companyFromDomain(domain) });
  }
  return [...out.values()];
}

// Parse the given activities' threads into per-activity people lists. Re-fetches
// the projects (cached) so it sees FULL notes, not the display-truncated copy.
export async function parseActivityThreads(
  activityGids: string[],
  excludeDomains: string[] = ["dell.com"],
): Promise<ActivityThread[]> {
  const bdGid = process.env.ASANA_BD_PROJECT_GID;
  const gtmGid = process.env.ASANA_GTM_PROJECT_GID;
  if (!bdGid && !gtmGid) return [];
  const wanted = new Set(activityGids);

  const [bd, gtm] = await Promise.all([
    bdGid ? fetchProjectTasks(bdGid, { extraFields: RICH_TASK_FIELDS }) : Promise.resolve([]),
    gtmGid ? fetchProjectTasks(gtmGid, { extraFields: RICH_TASK_FIELDS }) : Promise.resolve([]),
  ]);
  const tagged: { task: AsanaTask; track: "BD" | "GTM" }[] = [
    ...bd.map((t) => ({ task: t, track: "BD" as const })),
    ...gtm.map((t) => ({ task: t, track: "GTM" as const })),
  ];

  const out: ActivityThread[] = [];
  for (const { task, track } of tagged) {
    if (!wanted.has(task.gid)) continue;
    const text = `${task.name}\n${task.notes || ""}`;
    out.push({
      gid: task.gid,
      track,
      name: task.name,
      text,
      date: (task.due_on || (task.due_at ? task.due_at.split("T")[0] : "")) || undefined,
      people: parsePeople(text, excludeDomains),
    });
  }
  return out;
}
