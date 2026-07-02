export type Temperature = "Hot" | "Warm" | "Cold";

// How a contact came to engage with a portfolio company.
export type EngagementSource =
  | "direct introduction"
  | "event exposure"
  | "evangelized during network call";

export const ENGAGEMENT_SOURCES: EngagementSource[] = [
  "direct introduction",
  "event exposure",
  "evangelized during network call",
];

export interface PortCoEngagement {
  portco: string;
  date: string;
  source: EngagementSource;
}

/** A company-level event exposure row from the PortCo Event Exposure tab. */
export interface PortCoExposure {
  company: string;
  event: string;
  date: string;
  format: string;
  source: string;
  loggedDate: string;
}

// Canonical origin of a Contact or Target record. Attribution is by the ENGINE
// or entry-point that produced the record: discovery surfaced via Sumble's
// technographic search → "Sumble"; via Apollo people/attribute search → "Apollo";
// the Customer Discovery feature → "Customer Discovery"; CSV/paste-into-targets
// imports → "CSV Import"; everything else (manual add, smart paste) → "Manual
// Entry". Legacy rows with no recorded source backfill to "Manual Entry".
export type RecordSource =
  | "Sumble"
  | "Apollo"
  | "Customer Discovery"
  | "CSV Import"
  | "Manual Entry";

export const RECORD_SOURCES: RecordSource[] = [
  "Sumble",
  "Apollo",
  "Customer Discovery",
  "CSV Import",
  "Manual Entry",
];

// Normalize any free-text / legacy source string to a canonical RecordSource.
// Used when reading sheets (older rows hold free text like "Customer Discovery —
// Acme" or "Network Finder — Splunk") and to backfill blanks to "Manual Entry".
export function normalizeSource(raw?: string): RecordSource {
  const s = (raw || "").trim().toLowerCase();
  if (!s) return "Manual Entry";
  if (s.includes("customer discovery")) return "Customer Discovery";
  if (s.includes("sumble") || s.includes("network finder") || s.includes("network search"))
    return "Sumble";
  if (s.includes("apollo")) return "Apollo";
  if (s.includes("csv") || s.includes("import") || s.includes("paste") || s.includes("bulk"))
    return "CSV Import";
  if (s.includes("manual")) return "Manual Entry";
  return "Manual Entry";
}

// Profile fields that can be edited across many contacts at once.
export type BulkEditField =
  | "status"
  | "location"
  | "sector"
  | "prime"
  | "title"
  | "company"
  | "contactType"
  | "areasOfInterest"
  | "source";

// How a contact is used by DTC — the three prioritized categories.
export type ContactType = "Dell" | "Customer" | "VC";
export const CONTACT_TYPES: ContactType[] = ["Dell", "Customer", "VC"];

// A logged outreach email (from the "Email Activity" tab), surfaced on the
// Event and PortCo detail views.
export interface EmailActivityRecord {
  contactEmail: string;
  timestamp: string;
  subject: string;
  type: string; // PortCo | Event | General
  linkedPortco: string;
  linkedEvent: string;
}

export type InteractionType =
  | "call"
  | "email"
  | "meeting"
  | "intro"
  | "event"
  | "note"
  | "follow-up";

export interface Interaction {
  id: string;
  date: string;
  type: InteractionType;
  summary: string;
  isFollowUp?: boolean;
  followUpComplete?: boolean;
}

const INTERACTION_TYPES: readonly InteractionType[] = [
  "call",
  "email",
  "meeting",
  "intro",
  "event",
  "note",
  "follow-up",
];

/** Coerce a free-text / sheet / LLM value into a valid InteractionType.
 *  Unknown or empty values fall back to "note". */
export function normalizeInteractionType(raw: string | undefined | null): InteractionType {
  const v = (raw || "").trim().toLowerCase();
  if (!v) return "note";
  if ((INTERACTION_TYPES as readonly string[]).includes(v)) return v as InteractionType;
  if (v === "phone") return "call";
  if (v === "mail" || v === "e-mail") return "email";
  if (v === "introduction" || v === "portfolio intro") return "intro";
  if (v === "followup" || v === "follow up") return "follow-up";
  return "note";
}

export interface Contact {
  id: string;
  /** Stable surrogate primary key (UUID) from the Contacts "urid" column. Identity
   *  is decoupled from email/name so edits and row reorders can't orphan/renumber. */
  urid?: string;
  name: string;
  title: string;
  company: string;
  email: string;
  phone: string;
  address: string;
  prime: string;
  sector: string;
  areasOfInterest: string[];
  temperature: Temperature;
  portCoIntros: string[];
  /** Portfolio engagements with their source category (richer than portCoIntros). */
  portCoEngagements?: PortCoEngagement[];
  eventsAttended: string[];
  eventsInvited: string[];
  interactions: Interaction[];
  lastContact?: string;
  /** Date the contact was added (from the Contacts "Date Added" column). */
  dateAdded?: string;
  /** How DTC uses this contact: Dell / Customer / VC (manual). */
  contactType?: string;
  followUpPending?: boolean;
  location?: string;
  linkedinUrl?: string;
  apolloEnriched?: boolean;
  apolloEnrichedDate?: string;
  /** Per-field data source ("user" = human-edited, "apollo" = enrichment). */
  fieldProvenance?: Record<string, "user" | "apollo">;
  /** Automatic activity score (0–100) derived from interactions/events/intros. */
  activityScore?: number;
  /** True when the rating was set by hand and should not be auto-updated. */
  ratingLocked?: boolean;
  /** Canonical origin of this contact (from the Contacts "Source" column). */
  source?: RecordSource;
  /** V2: supporting "why surfaced" reasoning (Sumble technographic context). */
  sourceContext?: string;
}

export interface ContactFilters {
  search: string;
  /** Multi-select categorical filters: empty array = no filter; values OR together. */
  sector: string[];
  temperature: string[];
  prime: string[];
  areaOfInterest: string[];
  /** Canonical source filter (empty = no filter). */
  source: string[];
  /** Seniority level derived from title (empty = no filter). */
  seniority: string[];
  /** Department derived from title (empty = no filter). */
  department: string[];
  /** Title contains (free text). */
  title: string;
  /** Geography / city (empty = no filter). */
  location: string[];
  followUpOnly: boolean;
  /** Which date the range filters on: when the contact was added, or last activity. */
  dateField: "added" | "activity";
  /** Inclusive lower bound (YYYY-MM-DD); "" = no bound. */
  dateFrom: string;
  /** Inclusive upper bound (YYYY-MM-DD); "" = no bound. */
  dateTo: string;
}

export type PipelineStage = "Prospecting" | "Researching" | "Outreach Sent" | "Ready to Promote";

export interface OutreachAttempt {
  id: string;
  date: string;
  method: string;
  summary: string;
}

// A saved AI "how to connect" recommendation for a target (persisted + reloaded).
export interface ConnectionPlan {
  approach?: string;
  channel?: string;
  steps?: string[];
  talkingPoints?: string[];
  opener?: string;
  /** ISO timestamp when last saved. */
  savedAt?: string;
}

// Stable key for joining a target to its persisted outreach / strategy rows.
// Prefers email; falls back to "name|company". Case-insensitive. Both the read
// path (buildTargets) and the write path (log/save) must use this same key.
export function targetKeyOf(t: { email?: string; name?: string; company?: string }): string {
  const email = (t.email || "").trim().toLowerCase();
  if (email) return email;
  return `${(t.name || "").trim().toLowerCase()}|${(t.company || "").trim().toLowerCase()}`;
}

export interface TargetLead {
  id: string;
  /** Stable surrogate primary key (UUID) from the Targets "URID" column. Joins to
   *  outreach/strategy use this so editing email/name/company can't detach them. */
  urid?: string;
  name: string;
  title: string;
  company: string;
  linkedinUrl: string;
  email: string;
  phone: string;
  location: string;
  sector: string;
  stage: PipelineStage;
  /** Where the lead came from (e.g. "Customer Discovery — Acme", "Network Finder — Kubernetes"). */
  originSource: string;
  /** Why this lead was surfaced (e.g. "Uses Salesforce", "Hiring security engineers"). */
  reasonSurfaced?: string;
  /** Date the lead was added to the pipeline (from the Targets "Date Added" column). */
  dateAdded?: string;
  outreach: OutreachAttempt[];
  notes: string;
  /** Latest saved AI connection plan (persisted to the Target Strategy tab). */
  connectionPlan?: ConnectionPlan;
}

export interface TargetingFilters {
  search: string;
  stage: string;
  sector: string;
  city: string;
  origin: string;
}

export interface PortfolioEmployee {
  id: string;
  name: string;
  title: string;
  email: string;
  linkedinUrl: string;
}

export interface PortfolioEvent {
  id: string;
  date: string;
  name: string;
  type: "conference" | "dinner" | "webinar" | "meeting";
  status?: "completed" | "planned";
  eventRole?: "hosted" | "sponsored";
}

export interface PortfolioIntro {
  id: string;
  date: string;
  targetName: string;
  targetCompany: string;
  introducedBy: string;
  outcome: string;
}

export type PortfolioDomain =
  | "Security"
  | "AI"
  | "Data"
  | "Cloud"
  | "Logistics"
  | "Supply Chain"
  | "Silicon";

export const portfolioDomains: PortfolioDomain[] = [
  "Security",
  "AI",
  "Data",
  "Cloud",
  "Logistics",
  "Supply Chain",
  "Silicon",
];

export interface PortfolioCompany {
  id: string;
  /** Stable surrogate primary key (UUID) from the Portfolio Companies "URID" column. */
  urid?: string;
  name: string;
  sector: string;
  domain: PortfolioDomain;
  website: string;
  linkedinUrl: string;
  location: string;
  description: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  employees: PortfolioEmployee[];
  events: PortfolioEvent[];
  introductions: PortfolioIntro[];
  asanaFields?: Record<string, string>;
}

export interface PortfolioFilters {
  search: string;
  sector: string;
  domain: string;
  city: string;
  dtcPriority: string;
}

// Asana-sourced event surfaced across Network/PortCo/Events views.
export type EventFormat = "in-person" | "virtual" | "hybrid";
export type EventLead = "DTC" | "PortCo" | "Partner" | "External" | "Other";

export interface AsanaEvent {
  gid: string;
  name: string;
  date: string; // YYYY-MM-DD
  status: "completed" | "planned";
  portcos: string[];
  role?: "hosted" | "sponsored";
  type: "conference" | "dinner" | "webinar" | "meeting";
  /** Who is leading the event (from Asana "Event Lead" field). */
  lead?: string;
  /** In-person / virtual / hybrid (from Asana). */
  format?: EventFormat;
  /** Sectors (Asana "Industry" multi-select). E.g. ["AI", "Security"]. */
  sectors: string[];
  /** Total headcount from an Asana number field (Attendees / Headcount / RSVPs), if present. */
  attendeeCount?: number;
}

/** A BD or GTM activity pulled from an Asana "Activity Tracking" project, matched
 *  to a Contact and/or PortCo for display on those detail records. */
export interface AsanaActivity {
  gid: string;
  /** Which Activity Tracking project this came from. */
  track: "BD" | "GTM";
  name: string;
  /** Activity date (due_on/due_at, or a date custom field). YYYY-MM-DD. */
  date?: string;
  completed: boolean;
  /** Section/stage or a status custom field. */
  status?: string;
  /** Internal owner — task assignee or an owner custom field. */
  owner?: string;
  /** Activity type/category custom field, when present. */
  type?: string;
  /** Company/account/portco the activity references (custom field or task name). */
  company?: string;
  /** Person/contact the activity references (custom field), when present. */
  person?: string;
  /** Task notes/description (trimmed). */
  notes?: string;
  /** Permalink to the task in Asana. */
  url?: string;
}
