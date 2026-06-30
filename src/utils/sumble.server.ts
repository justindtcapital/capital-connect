// Sumble integration — company / technographic / org-intelligence data.
// Docs: https://docs.sumble.com/api   Base: https://api.sumble.com/v6/
// Auth: Authorization: Bearer <SUMBLE_API_KEY>  (read server-side only).
//
// Request/response shapes below match Sumble's documented v6 schemas
// (organizations.md / jobs.md). Every response includes credits_used /
// credits_remaining, which we surface so the UI can show the cost of a call.

import { callGeminiJSON } from "./gemini.server";

const SUMBLE_API_URL = "https://api.sumble.com/v6";

// Concrete JSON type — TanStack server functions require serializable returns.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface SumbleResponse<T extends JsonValue = JsonValue> {
  found: boolean;
  error?: string;
  /** "no_key" | "unauthorized" | "no_credits" | "rate_limited" | "bad_request" | "server" | "network" */
  errorCode?: string;
  status?: number;
  data?: T;
}

// ── Typed shapes used by the PortCo Intelligence UI ──────────────
export interface SumbleOrg { id: number; slug?: string; name?: string; domain?: string; }
export interface SumbleJob {
  id: number;
  title: string;
  date?: string;
  jobFunction?: string;
  location?: string;
  teams?: string;
  technologies?: string;
  url?: string;
}
export interface SumbleTech {
  name: string;
  /** Date the detection was last corroborated (e.g. most recent job post). */
  lastJobPost?: string;
  jobsCount?: number;
  peopleCount?: number;
  teamsCount?: number;
  /** Detection confidence 0–100, when Sumble supplies it. */
  confidence?: number;
}
export interface SumbleBrief { ready: boolean; title?: string; body?: string; url?: string; }
export interface SumbleCredits { used?: number; remaining?: number; }

function sumbleErrorCode(status: number): string {
  switch (status) {
    case 401: return "unauthorized";
    case 402: return "no_credits";
    case 429: return "rate_limited";
    case 400: return "bad_request";
    case 422: return "bad_request";
    default: return status >= 500 ? "server" : "error";
  }
}

function sumbleErrorMessage(code: string, status: number): string {
  switch (code) {
    case "unauthorized": return "Sumble API key is invalid or missing.";
    case "no_credits": return "Sumble request failed: insufficient credits.";
    case "rate_limited": return "Sumble rate limit hit (10 req/sec). Try again shortly.";
    case "bad_request": return "Sumble rejected the request (bad parameters).";
    case "server": return "Sumble server error — try again later.";
    default: return `Sumble API error (${status}).`;
  }
}

// Core request helper — handles auth, JSON, GET/POST, and Sumble error codes.
async function sumbleFetch<T extends JsonValue = JsonValue>(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<SumbleResponse<T>> {
  const apiKey = process.env.SUMBLE_API_KEY;
  if (!apiKey) {
    return { found: false, error: "SUMBLE_API_KEY is not configured", errorCode: "no_key" };
  }

  let res: Response;
  try {
    res = await fetch(`${SUMBLE_API_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body || {}) } : {}),
    });
  } catch (err) {
    return { found: false, error: err instanceof Error ? err.message : "Request to Sumble failed", errorCode: "network" };
  }

  if (!res.ok) {
    const code = sumbleErrorCode(res.status);
    let detail = sumbleErrorMessage(code, res.status);
    try {
      const errBody = (await res.json()) as { error?: string; message?: string };
      if (errBody?.message || errBody?.error) detail = String(errBody.message || errBody.error);
    } catch {
      /* keep default message */
    }
    return { found: false, error: detail, errorCode: code, status: res.status };
  }

  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    return { found: false, error: "Could not parse Sumble response", errorCode: "server", status: res.status };
  }
  return { found: true, data, status: res.status };
}

// ── Lookup cache (#8) ────────────────────────────────────────
// Sumble lookups (technologies/find, organizations/find) cost credits and are
// stable over a session, so cache successful responses in-memory (10-min TTL)
// keyed by path+body. Avoids re-spending on repeat searches / refines.
const SUMBLE_CACHE_TTL_MS = 10 * 60 * 1000;
const sumbleCache = new Map<string, { value: SumbleResponse; expires: number }>();

async function sumbleFetchCached<T extends JsonValue = JsonValue>(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<SumbleResponse<T>> {
  const key = `${method} ${path} ${JSON.stringify(body || {})}`;
  const hit = sumbleCache.get(key);
  if (hit && Date.now() < hit.expires) return hit.value as SumbleResponse<T>;
  const res = await sumbleFetch<T>(method, path, body);
  if (res.found) sumbleCache.set(key, { value: res as SumbleResponse, expires: Date.now() + SUMBLE_CACHE_TTL_MS });
  return res;
}

// ── Parsers (tolerant: unknown fields ignored, missing fields → undefined) ──
function asObj(v: JsonValue | undefined): Record<string, JsonValue> {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
function asArr(v: JsonValue | undefined): JsonValue[] {
  return Array.isArray(v) ? v : [];
}
function str(v: JsonValue | undefined): string | undefined {
  return typeof v === "string" && v ? v : v != null && typeof v !== "object" ? String(v) : undefined;
}
function num(v: JsonValue | undefined): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function parseCredits(data: JsonValue | undefined): SumbleCredits {
  const d = asObj(data);
  return { used: num(d.credits_used), remaining: num(d.credits_remaining) };
}

function parseMatch(data: JsonValue | undefined): SumbleOrg | null {
  const results = asArr(asObj(data).results);
  const first = asObj(results[0]);
  const match = asObj(first.match);
  const id = num(match.id);
  if (id == null) return null;
  return { id, slug: str(match.slug), name: str(match.name), domain: str(match.domain) };
}

function parseJobs(data: JsonValue | undefined): SumbleJob[] {
  return asArr(asObj(data).jobs).map((j) => {
    const o = asObj(j);
    return {
      id: num(o.id) ?? 0,
      title: str(o.job_title) || "",
      date: str(o.datetime_pulled),
      jobFunction: str(o.primary_job_function),
      location: str(o.location),
      teams: str(o.teams),
      technologies: str(o.matched_technologies),
      url: str(o.url),
    };
  });
}

function parseTechnologies(data: JsonValue | undefined): SumbleTech[] {
  return asArr(asObj(data).technologies).map((t) => {
    const o = asObj(t);
    // Confidence may arrive as 0–1 or 0–100 under a few possible keys; normalize to 0–100.
    const rawConf = num(o.confidence) ?? num(o.score) ?? num(o.confidence_score);
    const confidence = rawConf == null ? undefined : Math.round(rawConf <= 1 ? rawConf * 100 : rawConf);
    return {
      name: str(o.name) || "",
      lastJobPost: str(o.last_job_post),
      jobsCount: num(o.jobs_count),
      peopleCount: num(o.people_count),
      teamsCount: num(o.teams_count),
      confidence,
    };
  }).filter((t) => t.name);
}

// ══════════════════════════════════════════════════════════════
// High-level PortCo Intelligence orchestration
// ══════════════════════════════════════════════════════════════

export interface PortcoIntelResult {
  found: boolean;
  error?: string;
  errorCode?: string;
  /** Company couldn't be matched in Sumble's database. */
  notFound?: boolean;
  org?: SumbleOrg;
  jobs: SumbleJob[];
  credits?: SumbleCredits;
  /** A previously-generated brief, when served from cache. */
  brief?: SumbleBrief;
  /** True when this came from the sheet cache (no Sumble call / no credits spent). */
  cached?: boolean;
  /** Date the intel was fetched from Sumble (YYYY-MM-DD). */
  fetchedAt?: string;
}

// match → jobs. The cheaper core load (match = 1 credit, jobs ≈ 2-3 each).
export async function buildPortcoIntel(
  name: string,
  website?: string,
  location?: string,
  jobLimit = 8,
): Promise<PortcoIntelResult> {
  const matchRes = await sumbleFetch("POST", "/organizations/match", {
    organizations: [{ name, url: website || undefined, location: location || undefined }],
  });
  if (!matchRes.found) {
    return { found: false, error: matchRes.error, errorCode: matchRes.errorCode, jobs: [] };
  }
  const org = parseMatch(matchRes.data);
  if (!org) {
    return { found: true, notFound: true, jobs: [], credits: parseCredits(matchRes.data) };
  }

  const domain = org.domain || website;
  let jobs: SumbleJob[] = [];
  let credits = parseCredits(matchRes.data);
  if (domain) {
    const jobsRes = await sumbleFetch("POST", "/jobs/find", {
      organization: { domain },
      filters: {}, // required key (Sumble returns 422 without it)
      include_descriptions: false,
      limit: jobLimit,
      offset: 0,
    });
    if (jobsRes.found) {
      jobs = parseJobs(jobsRes.data);
      credits = parseCredits(jobsRes.data); // newest remaining balance
    }
  }
  return { found: true, org, jobs, credits };
}

export interface PortcoBriefResult {
  found: boolean;
  error?: string;
  errorCode?: string;
  /** Sumble is still generating the brief — retry shortly. */
  pending?: boolean;
  brief?: SumbleBrief;
  credits?: SumbleCredits;
}

// Intelligence brief is GET by org id and may return 202 (pending). ~50 credits.
export async function buildPortcoBrief(organizationId: number): Promise<PortcoBriefResult> {
  const res = await sumbleFetch("GET", `/organizations/${organizationId}/intelligence-brief`);
  if (!res.found) {
    return { found: false, error: res.error, errorCode: res.errorCode };
  }
  const d = asObj(res.data);
  if (res.status === 202 || str(d.status) === "pending") {
    return { found: true, pending: true };
  }
  return {
    found: true,
    brief: { ready: true, title: str(d.title), body: str(d.body), url: str(d.sumble_url) },
    credits: parseCredits(res.data),
  };
}

export interface PortcoTechResult {
  found: boolean;
  error?: string;
  errorCode?: string;
  technologies: SumbleTech[];
  credits?: SumbleCredits;
}

// Roll up matched_technologies across job posts into a SumbleTech[] with job-count
// evidence and a last-seen date. Sumble returns matched_technologies as a
// comma/semicolon list per job; a tech counts once per job.
function aggregateJobTechnologies(jobs: SumbleJob[]): SumbleTech[] {
  const acc = new Map<string, { name: string; jobsCount: number; lastJobPost?: string }>();
  for (const j of jobs) {
    const date = (j.date || "").slice(0, 10);
    const seen = new Set<string>();
    for (const raw of (j.technologies || "").split(/[;,]/)) {
      const name = raw.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue; // count a tech at most once per job
      seen.add(key);
      const cur = acc.get(key) || { name, jobsCount: 0, lastJobPost: undefined };
      cur.jobsCount += 1;
      if (date && (!cur.lastJobPost || date > cur.lastJobPost)) cur.lastJobPost = date;
      acc.set(key, cur);
    }
  }
  return [...acc.values()]
    .map((t) => ({ name: t.name, jobsCount: t.jobsCount, lastJobPost: t.lastJobPost }))
    .sort(
      (a, b) =>
        (b.jobsCount ?? 0) - (a.jobsCount ?? 0) ||
        (b.lastJobPost || "").localeCompare(a.lastJobPost || ""),
    );
}

// Default (cheap) tech stack: derived from the company's recent job posts via the
// verified /jobs/find endpoint. Sumble has NO "dump the full stack" call, and
// /organizations/enrich is a per-technology CHECKER (it 422s when asked with no
// technologies), so we aggregate hiring signals instead — one call, no per-tech
// billing. Confidence % is not available here; use verifyPortcoTechStack to add it.
export async function buildPortcoTechStack(domain: string, jobLimit = 20): Promise<PortcoTechResult> {
  // Resolve to Sumble's canonical org first — /jobs/find 404s for a domain Sumble
  // doesn't have as an org record (the raw contact/email domain often isn't one).
  const match = await matchOrganization(domain, domain);
  if (match.error) {
    return { found: false, error: match.error, errorCode: match.errorCode, technologies: [] };
  }
  const orgDomain = match.org?.domain || domain;
  if (!match.org) {
    return { found: false, error: `"${domain}" isn't in Sumble's company database.`, errorCode: "not_found", technologies: [], credits: match.credits };
  }

  const res = await sumbleFetch("POST", "/jobs/find", {
    organization: { domain: orgDomain },
    filters: {}, // required key (Sumble returns 422 without it)
    include_descriptions: false,
    limit: jobLimit,
    offset: 0,
  });
  if (!res.found) {
    // 404 here means the matched org has no job-posting data in Sumble.
    if (res.status === 404) {
      return { found: true, technologies: [], credits: match.credits };
    }
    return { found: false, error: res.error, errorCode: res.errorCode, technologies: [] };
  }
  return { found: true, technologies: aggregateJobTechnologies(parseJobs(res.data)), credits: parseCredits(res.data) };
}

// A curated set of common enterprise technologies, used as the fallback list for
// the enrich checker when the caller has no jobs-derived names to confirm.
export const CURATED_TECHNOLOGIES = [
  "Salesforce", "HubSpot", "AWS", "Google Cloud", "Microsoft Azure", "Snowflake",
  "Databricks", "Okta", "CrowdStrike", "Splunk", "Datadog", "ServiceNow",
  "Workday", "SAP", "Oracle", "MongoDB", "Kubernetes", "Tableau", "Looker", "Segment",
];

// Opt-in confirmation pass: ask Sumble's enrich CHECKER which of these specific
// technologies the company is detected using, returning confidence per tech.
// Billed ~5 cr PER technology checked, so the list is bounded. Falls back to the
// curated set when no names are supplied.
export async function verifyPortcoTechStack(domain: string, technologies: string[]): Promise<PortcoTechResult> {
  const provided = [...new Set(technologies.map((t) => t.trim()).filter(Boolean))];
  const techs = (provided.length > 0 ? provided : CURATED_TECHNOLOGIES).slice(0, 20);
  if (techs.length === 0) return { found: true, technologies: [] };

  // Resolve to Sumble's canonical org domain (same reason as buildPortcoTechStack).
  const match = await matchOrganization(domain, domain);
  if (match.error) return { found: false, error: match.error, errorCode: match.errorCode, technologies: [] };
  if (!match.org) return { found: false, error: `"${domain}" isn't in Sumble's company database.`, errorCode: "not_found", technologies: [] };
  const orgDomain = match.org.domain || domain;

  // enrich's exact request schema isn't documented; try filters.technologies first
  // (matches organizations/find), then a top-level technologies array if Sumble
  // rejects the body. Rejected (422) requests don't spend credits.
  let res = await sumbleFetch("POST", "/organizations/enrich", {
    organization: { domain: orgDomain },
    filters: { technologies: techs },
  });
  if (!res.found && res.errorCode === "bad_request") {
    res = await sumbleFetch("POST", "/organizations/enrich", {
      organization: { domain: orgDomain },
      technologies: techs,
    });
  }
  if (!res.found) {
    return { found: false, error: res.error, errorCode: res.errorCode, technologies: [] };
  }
  return { found: true, technologies: parseTechnologies(res.data), credits: parseCredits(res.data) };
}

// ══════════════════════════════════════════════════════════════
// Network Finder — discover people to add to the network
// Pipeline: resolve focus → technology → companies (orgs/find) →
// people at each company (people/find). Apollo handles emails on add.
// ══════════════════════════════════════════════════════════════

export interface SumbleProspect {
  name: string;
  title: string;
  jobLevel?: string;
  jobFunction?: string;
  location?: string;
  linkedinUrl?: string;
  company: string;
  companyDomain?: string;
  industry?: string;
  /** Set when this prospect came from an Apollo people-search (reveal by id on add). */
  apolloId?: string;
}

export interface ProspectsResult {
  found: boolean;
  error?: string;
  errorCode?: string;
  prospects: SumbleProspect[];
  credits?: SumbleCredits;
  /** The technology name Sumble matched the focus term to. */
  focusResolved?: string;
  companiesScanned?: number;
}

interface OrgLite { id: number; name: string; domain?: string; industry?: string; employees?: number; }

function parseOrgs(data: JsonValue | undefined): OrgLite[] {
  return asArr(asObj(data).organizations).map((o) => {
    const r = asObj(o);
    return {
      id: num(r.id) ?? 0,
      name: str(r.name) || "",
      domain: str(r.domain),
      industry: str(r.industry),
      employees: num(r.total_employees),
    };
  }).filter((o) => o.id);
}

function parsePeople(data: JsonValue | undefined): Array<Omit<SumbleProspect, "company" | "companyDomain" | "industry">> {
  return asArr(asObj(data).people).map((p) => {
    const r = asObj(p);
    return {
      name: str(r.name) || "",
      title: str(r.job_title) || "",
      jobLevel: str(r.job_level),
      jobFunction: str(r.job_function),
      location: str(r.location),
      linkedinUrl: str(r.linkedin_url),
    };
  }).filter((p) => p.name);
}

export interface ProspectCriteria {
  focus: string;
  jobLevels?: string[];
  jobFunctions?: string[];
  countries?: string[];
  /** Optional post-filter on Sumble's coarse industry field. */
  industry?: string;
  /** Optional company-size bands (keys of SIZE_BANDS) — post-filter on headcount. */
  sizes?: string[];
  companyLimit?: number;
  perCompany?: number;
}

// Company-size bands (by employee headcount). Sumble has no size filter param, so
// we filter the response's total_employees against these ranges.
export const SIZE_BANDS: Record<string, { label: string; min: number; max: number }> = {
  "1k_5k": { label: "1,000–5,000", min: 1000, max: 5000 },
  "5k_10k": { label: "5,000–10,000", min: 5001, max: 10000 },
  "10k_50k": { label: "10,000–50,000", min: 10001, max: 50000 },
  "50k_plus": { label: "50,000+", min: 50001, max: Infinity },
  under_1k: { label: "< 1,000", min: 1, max: 999 },
};

// Network Finder seniority chips → Sumble's job_levels vocabulary. Sumble has no
// SVP level, so SVP folds into VP; C-Suite maps to Sumble's "C-Team".
const CHIP_TO_SUMBLE_LEVEL: Record<string, string> = {
  "C-Suite": "C-Team",
  SVP: "VP",
  VP: "VP",
  Director: "Director",
  Manager: "Manager",
};

function matchesSize(employees: number | undefined, sizes: string[]): boolean {
  if (sizes.length === 0) return true;
  if (employees == null) return false; // unknown headcount can't satisfy a size filter
  return sizes.some((key) => {
    const band = SIZE_BANDS[key];
    return band && employees >= band.min && employees <= band.max;
  });
}

// A discovered company (phase 1 of the two-phase Network Finder).
export interface ProspectCompany {
  name: string;
  domain: string;
  industry?: string;
  employees?: number;
}

export interface ProspectCompaniesResult {
  found: boolean;
  error?: string;
  errorCode?: string;
  companies: ProspectCompany[];
  credits?: SumbleCredits;
  focusResolved?: string;
}

// Phase 1: resolve the technology → companies using it (with industry/size
// post-filters). The user prunes this list before the people fan-out.
export async function discoverProspectCompanies(c: ProspectCriteria): Promise<ProspectCompaniesResult> {
  const companyLimit = Math.min(25, Math.max(1, c.companyLimit ?? 5));
  const focus = (c.focus || "").trim();
  const industry = (c.industry || "").trim();
  const term = focus || industry;
  if (!term) return { found: false, companies: [], error: "Provide a focus/technology or a focus area to search." };

  const applyIndustryFilter = !!industry && !!focus;
  const sizes = (c.sizes || []).filter((s) => SIZE_BANDS[s]);
  const applySizeFilter = sizes.length > 0;
  const overfetch = applyIndustryFilter || applySizeFilter;

  const techRes = await sumbleFetchCached("POST", "/technologies/find", { query: term });
  if (!techRes.found) return { found: false, error: techRes.error, errorCode: techRes.errorCode, companies: [] };
  const techName = str(asObj(asArr(asObj(techRes.data).technologies)[0]).name);
  if (!techName) {
    return {
      found: false,
      companies: [],
      error: `Sumble couldn't match "${term}" to a technology. Try a technology, tool, or platform name (e.g. "Kubernetes", "Splunk", "Snowflake").`,
    };
  }

  const orgLimit = overfetch ? Math.min(50, companyLimit * 4) : companyLimit;
  const orgsRes = await sumbleFetchCached("POST", "/organizations/find", {
    filters: { query: term, technologies: [techName] },
    limit: orgLimit,
    offset: 0,
  });
  if (!orgsRes.found) return { found: false, error: orgsRes.error, errorCode: orgsRes.errorCode, companies: [], focusResolved: techName };
  let orgs = parseOrgs(orgsRes.data);
  if (applyIndustryFilter) {
    const want = industry.toLowerCase();
    orgs = orgs.filter((o) => (o.industry || "").toLowerCase().includes(want));
  }
  if (applySizeFilter) orgs = orgs.filter((o) => matchesSize(o.employees, sizes));
  orgs = orgs.filter((o) => o.domain).slice(0, companyLimit);

  const companies: ProspectCompany[] = orgs.map((o) => ({
    name: o.name,
    domain: o.domain as string,
    industry: o.industry,
    employees: o.employees,
  }));
  return { found: true, companies, credits: parseCredits(orgsRes.data), focusResolved: techName };
}

// Phase 2: find people at the (pruned) companies. Sequential — Sumble ~10 req/s.
export async function fetchProspectPeople(
  companies: ProspectCompany[],
  perCompany: number,
  filters: { jobFunctions?: string[]; jobLevels?: string[]; countries?: string[] },
): Promise<{ prospects: SumbleProspect[]; credits?: SumbleCredits }> {
  const per = Math.min(10, Math.max(1, perCompany || 5));
  const peopleFilters: Record<string, unknown> = {};
  if (filters.jobFunctions?.length) peopleFilters.job_functions = filters.jobFunctions;
  if (filters.jobLevels?.length) {
    const mapped = [...new Set(filters.jobLevels.map((l) => CHIP_TO_SUMBLE_LEVEL[l] || l).filter(Boolean))];
    if (mapped.length) peopleFilters.job_levels = mapped;
  }
  if (filters.countries?.length) peopleFilters.countries = filters.countries;

  const prospects: SumbleProspect[] = [];
  let credits: SumbleCredits | undefined;
  for (const org of companies) {
    if (!org.domain) continue;
    const peopleRes = await sumbleFetch("POST", "/people/find", {
      organization: { domain: org.domain },
      filters: peopleFilters,
      limit: per,
      offset: 0,
    });
    if (!peopleRes.found) continue;
    credits = parseCredits(peopleRes.data);
    for (const p of parsePeople(peopleRes.data)) {
      prospects.push({ ...p, company: org.name, companyDomain: org.domain, industry: org.industry });
    }
  }
  return { prospects, credits };
}

// Single-phase convenience wrapper (companies → people in one call).
export async function buildProspects(c: ProspectCriteria): Promise<ProspectsResult> {
  const disc = await discoverProspectCompanies(c);
  if (!disc.found) {
    return { found: false, error: disc.error, errorCode: disc.errorCode, prospects: [], focusResolved: disc.focusResolved };
  }
  const { prospects, credits } = await fetchProspectPeople(disc.companies, c.perCompany ?? 5, {
    jobFunctions: c.jobFunctions,
    jobLevels: c.jobLevels,
    countries: c.countries,
  });
  return { found: true, prospects, credits: credits || disc.credits, focusResolved: disc.focusResolved, companiesScanned: disc.companies.length };
}

// ══════════════════════════════════════════════════════════════
// Customer Discovery Engine — turn a PORTFOLIO COMPANY into a list of
// likely CUSTOMERS, scored by technographic fit + buying signals.
//
// Pipeline (per portfolio company):
//   1. profileSeller (Claude)  → comparable technologies + ICP + decision roles
//   2. discover (Sumble)       → companies already using comparable tech
//   3. score (heuristic)       → tech overlap + industry/size + hiring hits
//   4. enrich top N (Sumble)   → hiring signals + decision-makers
//   5. outreach (Claude)       → angle + suggested match per opportunity
//
// Hybrid by design: the heuristic scores EVERY candidate cheaply; Claude only
// runs twice (one profile call + one batch outreach call) to respect the
// Anthropic per-minute token limit and keep cost predictable.
// ══════════════════════════════════════════════════════════════

/** Claude-derived (or heuristic-fallback) profile of what the portco SELLS. */
export interface SellerProfile {
  category: string;
  valueProp: string;
  /** Searchable in Sumble — competitor/adjacent products a prospect would use. */
  comparableTechnologies: string[];
  /** Industries a good customer tends to be in. */
  targetIndustries: string[];
  /** Job functions for decision-makers (people/find). */
  targetRoles: string[];
  /** Subset of C-Team / VP / Director / Manager / Senior. */
  targetJobLevels: string[];
  /** Phrases in job posts that signal a need (displacement / adoption). */
  buyingSignalKeywords: string[];
  minEmployees?: number;
  maxEmployees?: number;
}

export interface OppEvidence {
  /** Comparable technologies this company is detected using. */
  techMatches: string[];
  /** Job titles whose posting matched a buying-signal keyword. */
  hiringHits: string[];
  industryMatch: boolean;
  sizeMatch: boolean;
}

export interface OpportunityCompany {
  name: string;
  domain?: string;
  industry?: string;
  employees?: number;
  /** 0-100 heuristic fit. */
  fitScore: number;
  likelihood: "High" | "Medium" | "Low";
  evidence: OppEvidence;
  /** One line on why this fits the portfolio company. */
  suggestedMatch: string;
  /** Recommended outreach angle based on observed gaps / tech in use. */
  outreachAngle: string;
  decisionMakers: SumbleProspect[];
}

// One narrowing stage in the discovery funnel (for transparency on why a search
// returned few/zero results).
export interface DiscoveryFunnelStage {
  stage: string;
  count: number;
}

export interface DiscoveryResult {
  found: boolean;
  error?: string;
  errorCode?: string;
  /** The portfolio company we prospected FOR. */
  seller: string;
  profile?: SellerProfile;
  opportunities: OpportunityCompany[];
  credits?: SumbleCredits;
  generatedAt?: string;
  cached?: boolean;
  /** True when Claude profiled the seller / wrote outreach (vs. heuristic-only). */
  usedClaude: boolean;
  /** Stage-by-stage counts so users see WHERE a search narrowed to zero. */
  funnel?: DiscoveryFunnelStage[];
  /** Plain-English reason when zero opportunities/contacts were found. */
  funnelNote?: string;
}

export interface DiscoveryOptions {
  companyName: string;
  sector?: string;
  description?: string;
  website?: string;
  maxTechnologies?: number;
  companiesPerTech?: number;
  topN?: number;
  peoplePerCompany?: number;
  /** User-typed technologies to search by, overriding the profiled set. */
  technologies?: string[];
}

const VALID_LEVELS = ["C-Team", "VP", "Director", "Manager", "Senior"];

const DISCOVERY_SYSTEM = `You are a B2B sales-intelligence analyst. Given a venture-backed company's product, you profile it so we can find its likely CUSTOMERS using technographic data (which companies use which technologies, and what they hire for).

Think about competitive displacement and adjacency: a company that already uses a COMPARABLE or COMPETING product understands the category, has budget, and is a viable target.

Return ONLY a JSON object, no prose, no markdown fences, in exactly this shape:
{
  "category": "short product category",
  "valueProp": "one sentence on what it does",
  "comparableTechnologies": ["..."],
  "targetIndustries": ["..."],
  "targetRoles": ["..."],
  "targetJobLevels": ["..."],
  "buyingSignalKeywords": ["..."],
  "minEmployees": 0,
  "maxEmployees": 0
}

Rules:
- comparableTechnologies: 3-6 REAL, named products/tools/platforms a prospect company would actually use or post jobs about (competitors and adjacent tools), e.g. "Splunk", "Snowflake", "Datadog", "Okta". These drive the search — be concrete, no generic categories.
- targetIndustries: 2-5 industries a strong customer is in (plain English).
- targetRoles: 2-4 decision-maker job FUNCTIONS (e.g. "Engineering", "Security", "Data", "IT", "Operations").
- targetJobLevels: choose from exactly these values: C-Team, VP, Director, Manager, Senior.
- buyingSignalKeywords: 3-6 short phrases that would appear in a prospect's job postings when they have the need this product solves.
- minEmployees / maxEmployees: rough headcount band for an ideal customer (use 0 for "no limit").`;

function buildSellerPrompt(o: DiscoveryOptions): string {
  const lines: string[] = [];
  lines.push(`Company: ${o.companyName}`);
  if (o.sector) lines.push(`Focus area / sector: ${o.sector}`);
  if (o.website) lines.push(`Website: ${o.website}`);
  if (o.description) lines.push(`What they do: ${o.description}`);
  lines.push("");
  lines.push("Profile this company's product and its ideal customer per the schema.");
  return lines.join("\n");
}

function cleanStrArray(v: JsonValue | undefined, max: number): string[] {
  return asArr(v)
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .slice(0, max);
}

function normalizeProfile(d: Record<string, JsonValue>): SellerProfile {
  const levels = cleanStrArray(d.targetJobLevels, 5).filter((l) =>
    VALID_LEVELS.some((v) => v.toLowerCase() === l.toLowerCase()),
  );
  return {
    category: str(d.category) || "",
    valueProp: str(d.valueProp) || "",
    comparableTechnologies: cleanStrArray(d.comparableTechnologies, 6),
    targetIndustries: cleanStrArray(d.targetIndustries, 5),
    targetRoles: cleanStrArray(d.targetRoles, 4),
    targetJobLevels: levels.length ? levels : ["VP", "Director"],
    buyingSignalKeywords: cleanStrArray(d.buyingSignalKeywords, 6),
    minEmployees: num(d.minEmployees) || undefined,
    maxEmployees: num(d.maxEmployees) || undefined,
  };
}

// Heuristic fallback when Claude is unavailable: use the portco's own focus as
// the single comparable "technology" and apply sensible role defaults.
function fallbackProfile(o: DiscoveryOptions): SellerProfile {
  const focus = (o.sector || o.companyName).trim();
  return {
    category: focus,
    valueProp: o.description?.slice(0, 160) || "",
    comparableTechnologies: [focus],
    targetIndustries: [],
    targetRoles: ["Engineering", "IT"],
    targetJobLevels: ["VP", "Director"],
    buyingSignalKeywords: [],
  };
}

async function profileSeller(o: DiscoveryOptions): Promise<{ profile: SellerProfile; usedClaude: boolean }> {
  const res = await callGeminiJSON<Record<string, JsonValue>>(DISCOVERY_SYSTEM, buildSellerPrompt(o), 1200);
  if (res.ok && res.data) {
    const profile = normalizeProfile(res.data);
    if (profile.comparableTechnologies.length > 0) return { profile, usedClaude: true };
  }
  return { profile: fallbackProfile(o), usedClaude: false };
}

function sizeWithin(employees: number | undefined, min?: number, max?: number): boolean {
  if (employees == null) return false;
  if (min && employees < min) return false;
  if (max && employees > max) return false;
  return !!(min || max); // only counts as a "match" when a band was specified
}

// 0-100. Tech overlap is the strongest signal (displacement), then industry/size
// fit, then active hiring against the buying-signal keywords.
function scoreFit(techMatches: number, industryMatch: boolean, sizeMatch: boolean, hiringHits: number): number {
  const tech = Math.min(techMatches, 3) * 15; // up to 45
  const industry = industryMatch ? 20 : 0;
  const size = sizeMatch ? 15 : 0;
  const hiring = Math.min(hiringHits, 4) * 5; // up to 20
  return Math.min(100, tech + industry + size + hiring);
}

function likelihoodFor(score: number): "High" | "Medium" | "Low" {
  if (score >= 70) return "High";
  if (score >= 45) return "Medium";
  return "Low";
}

interface Candidate {
  org: OrgLite;
  techMatches: string[];
  industryMatch: boolean;
  sizeMatch: boolean;
  hiringHits: string[];
  people: SumbleProspect[];
  score: number;
}

// Claude batch pass: write an outreach angle + suggested-match line per company.
// One call for all top opportunities (token-efficient, rate-limit friendly).
async function enrichOutreach(seller: string, profile: SellerProfile, opps: OpportunityCompany[]): Promise<void> {
  if (opps.length === 0) return;
  const system = `You write concise B2B sales guidance. For each prospect company, given the SELLER's product and the evidence we found, return an outreach angle and a one-line fit rationale.

Return ONLY a JSON object: {"items":[{"index":0,"outreachAngle":"...","suggestedMatch":"..."}]}
- outreachAngle: 1-2 sentences. Reference the specific evidence (technologies they use / what they're hiring for) and the gap ${seller} fills. Concrete, not generic. No greeting.
- suggestedMatch: one line on why this company is a good fit for ${seller}.`;

  const lines: string[] = [];
  lines.push(`SELLER: ${seller} — ${profile.category}. ${profile.valueProp}`);
  lines.push(`What signals a customer: uses ${profile.comparableTechnologies.join(", ")}; hires around ${profile.buyingSignalKeywords.join(", ") || "n/a"}.`);
  lines.push("");
  lines.push("PROSPECTS:");
  opps.forEach((o, i) => {
    const ev: string[] = [];
    if (o.evidence.techMatches.length) ev.push(`uses ${o.evidence.techMatches.join(", ")}`);
    if (o.evidence.hiringHits.length) ev.push(`hiring: ${o.evidence.hiringHits.join(", ")}`);
    if (o.evidence.industryMatch) ev.push(`industry fit (${o.industry || ""})`);
    lines.push(`${i}. ${o.name}${o.industry ? ` [${o.industry}]` : ""} — ${ev.join("; ") || "comparable tech in use"}`);
  });

  const res = await callGeminiJSON<{ items?: Array<{ index?: number; outreachAngle?: string; suggestedMatch?: string }> }>(
    system,
    lines.join("\n"),
    1600,
  );
  if (!res.ok || !res.data?.items) return;
  for (const item of res.data.items) {
    const idx = typeof item.index === "number" ? item.index : -1;
    if (idx < 0 || idx >= opps.length) continue;
    if (item.outreachAngle) opps[idx].outreachAngle = String(item.outreachAngle).trim();
    if (item.suggestedMatch) opps[idx].suggestedMatch = String(item.suggestedMatch).trim();
  }
}

export async function buildCustomerDiscovery(o: DiscoveryOptions): Promise<DiscoveryResult> {
  const maxTechnologies = Math.min(6, Math.max(1, o.maxTechnologies ?? 4));
  const companiesPerTech = Math.min(10, Math.max(1, o.companiesPerTech ?? 6));
  const topN = Math.min(10, Math.max(1, o.topN ?? 6));
  const peoplePerCompany = Math.min(5, Math.max(1, o.peoplePerCompany ?? 3));
  const generatedAt = new Date().toISOString().split("T")[0];

  if (!isSumbleConfigured()) {
    return { found: false, error: "SUMBLE_API_KEY is not configured", errorCode: "no_key", seller: o.companyName, opportunities: [], usedClaude: false };
  }

  // 1. Profile the seller (Claude, with heuristic fallback) for ICP + roles.
  const { profile, usedClaude } = await profileSeller(o);
  // User-typed technologies override the profiled set when provided.
  const override = (o.technologies || []).map((t) => t.trim()).filter(Boolean);
  const techs = (override.length > 0 ? override : profile.comparableTechnologies).slice(0, Math.max(maxTechnologies, override.length ? Math.min(6, override.length) : 0));
  // Reflect the actual search set in the returned profile so the UI shows it.
  if (override.length > 0) profile.comparableTechnologies = techs;

  // 2. Discover companies using each comparable technology; aggregate by domain.
  const orgMap = new Map<string, { org: OrgLite; techMatches: Set<string> }>();
  let credits: SumbleCredits | undefined;
  for (const tech of techs) {
    const techRes = await sumbleFetchCached("POST", "/technologies/find", { query: tech });
    if (!techRes.found) {
      if (techRes.errorCode === "unauthorized" || techRes.errorCode === "no_credits") {
        return { found: false, error: techRes.error, errorCode: techRes.errorCode, seller: o.companyName, profile, opportunities: [], usedClaude };
      }
      continue;
    }
    const techName = str(asObj(asArr(asObj(techRes.data).technologies)[0]).name) || tech;
    const orgsRes = await sumbleFetchCached("POST", "/organizations/find", {
      filters: { query: tech, technologies: [techName] },
      limit: companiesPerTech,
      offset: 0,
    });
    if (!orgsRes.found) continue;
    credits = parseCredits(orgsRes.data);
    for (const org of parseOrgs(orgsRes.data)) {
      if (!org.domain) continue;
      const key = org.domain.toLowerCase();
      const entry = orgMap.get(key) || { org, techMatches: new Set<string>() };
      entry.techMatches.add(tech);
      orgMap.set(key, entry);
    }
  }

  if (orgMap.size === 0) {
    return {
      found: true, seller: o.companyName, profile, opportunities: [], credits, generatedAt, usedClaude,
      funnel: [
        { stage: `Comparable technologies (${techs.join(", ") || "none"})`, count: techs.length },
        { stage: "Companies using them", count: 0 },
      ],
      funnelNote: techs.length === 0
        ? "Couldn't identify comparable technologies for this company. Try the technology search box."
        : `No companies found using ${techs.join(", ")}. Try different/broader technologies.`,
    };
  }

  // 3. Heuristic score every candidate (cheap, deterministic).
  const wantIndustries = profile.targetIndustries.map((s) => s.toLowerCase()).filter(Boolean);
  let candidates: Candidate[] = [...orgMap.values()].map(({ org, techMatches }) => {
    const industryMatch = wantIndustries.length > 0 && wantIndustries.some((w) => (org.industry || "").toLowerCase().includes(w));
    const sizeMatch = sizeWithin(org.employees, profile.minEmployees, profile.maxEmployees);
    const tm = [...techMatches];
    return { org, techMatches: tm, industryMatch, sizeMatch, hiringHits: [], people: [], score: scoreFit(tm.length, industryMatch, sizeMatch, 0) };
  });
  candidates.sort((a, b) => b.score - a.score);

  // 4. Enrich the top N: hiring signals + decision-makers (credit-gated).
  const top = candidates.slice(0, topN);
  // Seniority is the reliable, validated filter (C-Team/VP/Director/Manager). We do
  // NOT hard-filter by job_functions: Sumble's function taxonomy is a controlled set,
  // and an unmatched LLM-generated value (e.g. "Security"/"DevOps"/"IT") zeroes the
  // entire AND-filtered result — which is why discovery stopped surfacing contacts.
  const peopleFilters: Record<string, unknown> = {};
  const levels = [...new Set(profile.targetJobLevels.map((l) => CHIP_TO_SUMBLE_LEVEL[l] || l).filter(Boolean))];
  if (levels.length) peopleFilters.job_levels = levels;
  const kws = profile.buyingSignalKeywords.map((k) => k.toLowerCase()).filter(Boolean);

  for (const cand of top) {
    const domain = cand.org.domain;
    if (!domain) continue;

    // Hiring signals → match buying-signal keywords against recent postings.
    if (kws.length) {
      const jobsRes = await sumbleFetch("POST", "/jobs/find", {
        organization: { domain },
        filters: {},
        include_descriptions: false,
        limit: 6,
        offset: 0,
      });
      if (jobsRes.found) {
        credits = parseCredits(jobsRes.data) || credits;
        const hits = new Set<string>();
        for (const j of parseJobs(jobsRes.data)) {
          const hay = `${j.title} ${j.teams || ""} ${j.technologies || ""}`.toLowerCase();
          if (kws.some((k) => hay.includes(k)) && j.title) hits.add(j.title);
        }
        cand.hiringHits = [...hits].slice(0, 4);
      }
    }
    cand.score = scoreFit(cand.techMatches.length, cand.industryMatch, cand.sizeMatch, cand.hiringHits.length);

    // Decision-makers. Try the seniority filter first; if it surfaces nobody, fall
    // back to an unfiltered lookup so we still return senior contacts for the company.
    let peopleRes = await sumbleFetch("POST", "/people/find", {
      organization: { domain },
      filters: peopleFilters,
      limit: peoplePerCompany,
      offset: 0,
    });
    let people = peopleRes.found ? parsePeople(peopleRes.data) : [];
    if (peopleRes.found) credits = parseCredits(peopleRes.data) || credits;
    if (people.length === 0 && Object.keys(peopleFilters).length > 0) {
      peopleRes = await sumbleFetch("POST", "/people/find", {
        organization: { domain },
        filters: {},
        limit: peoplePerCompany,
        offset: 0,
      });
      if (peopleRes.found) {
        credits = parseCredits(peopleRes.data) || credits;
        people = parsePeople(peopleRes.data);
      }
    }
    cand.people = people.map((p) => ({
      ...p,
      company: cand.org.name,
      companyDomain: cand.org.domain,
      industry: cand.org.industry,
    }));
  }
  top.sort((a, b) => b.score - a.score);

  // 5. Shape opportunities; heuristic angle first, then Claude refines (if available).
  const opportunities: OpportunityCompany[] = top.map((c) => ({
    name: c.org.name,
    domain: c.org.domain,
    industry: c.org.industry,
    employees: c.org.employees,
    fitScore: c.score,
    likelihood: likelihoodFor(c.score),
    evidence: { techMatches: c.techMatches, hiringHits: c.hiringHits, industryMatch: c.industryMatch, sizeMatch: c.sizeMatch },
    suggestedMatch: `${o.companyName} — already uses ${c.techMatches.join(", ") || "comparable tech"}.`,
    outreachAngle: c.techMatches.length
      ? `Uses ${c.techMatches.join(", ")}${c.hiringHits.length ? `; hiring for ${c.hiringHits.join(", ")}` : ""} — strong fit to introduce ${o.companyName}.`
      : `Comparable technology in use — candidate for ${o.companyName}.`,
    decisionMakers: c.people,
  }));

  if (usedClaude) {
    try {
      await enrichOutreach(o.companyName, profile, opportunities);
    } catch (e) {
      console.error("[discovery] outreach enrichment failed:", e); // non-fatal
    }
  }

  // Funnel transparency: stage-by-stage counts + a reason when contacts hit zero.
  const withPeople = opportunities.filter((op) => op.decisionMakers.length > 0).length;
  const totalPeople = opportunities.reduce((s, op) => s + op.decisionMakers.length, 0);
  const funnel: DiscoveryFunnelStage[] = [
    { stage: `Comparable technologies (${techs.join(", ")})`, count: techs.length },
    { stage: "Companies using them", count: orgMap.size },
    { stage: "Top candidates examined", count: top.length },
    { stage: "Companies with reachable contacts", count: withPeople },
    { stage: "Decision-makers found", count: totalPeople },
  ];
  let funnelNote: string | undefined;
  if (totalPeople === 0) {
    funnelNote = `Found ${orgMap.size} candidate compan${orgMap.size === 1 ? "y" : "ies"}, but Sumble returned no contacts for the top ${top.length} (even unfiltered). These are likely large/generic companies with thin Sumble people coverage — try a more specific technology so the candidate companies are a tighter fit.`;
  }

  return { found: true, seller: o.companyName, profile, opportunities, credits, generatedAt, usedClaude, funnel, funnelNote };
}

// ══════════════════════════════════════════════════════════════
// Network Search — free-form org search across dimensions, used by the
// Network side-panel search bar (internal results are filtered client-side;
// this supplies the EXTERNAL Sumble companies).
// ══════════════════════════════════════════════════════════════

export type NetworkSearchDimension = "technology" | "company" | "industry" | "product" | "keywords";

export interface NetworkOrgSearchResult {
  found: boolean;
  error?: string;
  errorCode?: string;
  companies: ProspectCompany[];
  credits?: SumbleCredits;
  /** Technology name Sumble matched the term to (technology/product/keyword searches). */
  focusResolved?: string;
}

function orgToCompany(o: OrgLite): ProspectCompany {
  return { name: o.name, domain: o.domain as string, industry: o.industry, employees: o.employees };
}

// Optional refine filters applied to the external org search. Industry + size +
// extra technologies are post-filtered against the Sumble response (Sumble has no
// dedicated size param and only a coarse industry field), so we over-fetch.
export interface NetworkOrgFilters {
  /** Keys of SIZE_BANDS to keep (by headcount). */
  sizes?: string[];
  /** Coarse industry substring to require. */
  industry?: string;
  /** Additional technologies the org must be detected using (ANDed in). */
  technologies?: string[];
}

export async function searchNetworkOrganizations(
  query: string,
  by: NetworkSearchDimension,
  limit = 12,
  opts: NetworkOrgFilters = {},
): Promise<NetworkOrgSearchResult> {
  const q = (query || "").trim();
  if (!q) return { found: false, companies: [], error: "Enter a search term." };
  if (!isSumbleConfigured()) {
    return { found: false, companies: [], error: "SUMBLE_API_KEY is not configured", errorCode: "no_key" };
  }
  const lim = Math.min(25, Math.max(1, limit));
  const sizes = (opts.sizes || []).filter((s) => SIZE_BANDS[s]);
  const extraTech = (opts.technologies || []).map((t) => t.trim()).filter(Boolean);
  // Industry refine: explicit opts.industry, else the query itself for an industry search.
  const wantIndustry = (opts.industry || (by === "industry" ? q : "")).trim().toLowerCase();
  const hasPostFilter = sizes.length > 0 || extraTech.length > 0 || !!wantIndustry;
  const fetchLimit = hasPostFilter ? Math.min(50, lim * 4) : lim;

  let focusResolved: string | undefined;
  const filters: Record<string, unknown> = { query: q };

  // Technology / product / keyword searches resolve the term to a known
  // technology, then pull companies detected using it (the technographic angle).
  if (by === "technology" || by === "product" || by === "keywords") {
    const techRes = await sumbleFetchCached("POST", "/technologies/find", { query: q });
    focusResolved = techRes.found ? str(asObj(asArr(asObj(techRes.data).technologies)[0]).name) : undefined;
    const techs = [...new Set([focusResolved, ...extraTech].filter(Boolean))] as string[];
    if (techs.length) filters.technologies = techs;
  } else if (extraTech.length) {
    // Company / industry search with an extra technologies refine.
    filters.technologies = extraTech;
  }

  const orgsRes = await sumbleFetchCached("POST", "/organizations/find", { filters, limit: fetchLimit, offset: 0 });
  if (!orgsRes.found) {
    return { found: false, error: orgsRes.error, errorCode: orgsRes.errorCode, companies: [], focusResolved };
  }
  let orgs = parseOrgs(orgsRes.data);
  if (wantIndustry) orgs = orgs.filter((o) => (o.industry || "").toLowerCase().includes(wantIndustry));
  if (sizes.length) orgs = orgs.filter((o) => matchesSize(o.employees, sizes));
  const companies = orgs.filter((o) => o.domain).slice(0, lim).map(orgToCompany);
  return { found: true, companies, credits: parseCredits(orgsRes.data), focusResolved };
}

// Resolve a company name → its primary domain via organizations/match (1 credit).
// Used by the Target Accounts finder to turn pasted company names into the
// domains Apollo's people-search needs. Returns null when no confident match.
export async function matchOrganization(
  name: string,
  website?: string,
  location?: string,
): Promise<{ org: SumbleOrg | null; credits: SumbleCredits; error?: string; errorCode?: string }> {
  const res = await sumbleFetch("POST", "/organizations/match", {
    organizations: [{ name, url: website || undefined, location: location || undefined }],
  });
  if (!res.found) return { org: null, credits: {}, error: res.error, errorCode: res.errorCode };
  return { org: parseMatch(res.data), credits: parseCredits(res.data) };
}

export function isSumbleConfigured(): boolean {
  return !!process.env.SUMBLE_API_KEY;
}
