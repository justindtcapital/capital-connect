import { createServerFn } from "@tanstack/react-start";
import {
  buildPortcoIntel,
  buildPortcoBrief,
  buildPortcoTechStack,
  verifyPortcoTechStack,
  searchNetworkOrganizations,
  matchOrganization,
  isSumbleConfigured,
  type PortcoIntelResult,
  type PortcoBriefResult,
  type PortcoTechResult,
  type NetworkOrgSearchResult,
  type NetworkSearchDimension,
  type SumbleOrg,
  type SumbleJob,
  type SumbleBrief,
  type SumbleCredits,
} from "./sumble.server";
import {
  fetchSheetTab,
  ensureTab,
  appendSheetRow,
  writeSheetRow,
  TAB_NAMES,
  PORTCO_INTEL_HEADERS,
} from "./sheets.server";

// ── Sheet cache for Sumble PortCo intel ──────────────────────────
// Results are cached to the "PortCo Intel" tab so reopening a company reads from
// the sheet instead of re-calling Sumble (which costs credits). The full record
// is stored as JSON in the "Data" column; flat columns are for readability.

interface CachedIntel {
  org?: SumbleOrg;
  jobs: SumbleJob[];
  brief?: SumbleBrief;
  credits?: SumbleCredits;
  fetchedAt: string;
  briefFetchedAt?: string;
}

const today = () => new Date().toISOString().split("T")[0];
const normKey = (name: string) => name.trim().toLowerCase();

function rowFromCache(companyName: string, c: CachedIntel): string[] {
  return [
    companyName,
    c.org?.id != null ? String(c.org.id) : "",
    c.org?.name || "",
    c.org?.domain || "",
    String(c.jobs.length),
    c.brief?.body ? "yes" : "no",
    c.fetchedAt,
    c.briefFetchedAt || "",
    c.credits?.remaining != null ? String(c.credits.remaining) : "",
    JSON.stringify(c),
  ];
}

// Returns the cached record and its 1-based sheet row number, if present.
async function readIntelCache(companyName: string): Promise<{ record: CachedIntel; rowNumber: number } | null> {
  let rows: string[][];
  try {
    rows = await fetchSheetTab(TAB_NAMES.portcoIntel);
  } catch {
    return null; // tab doesn't exist yet
  }
  if (rows.length < 2) return null;
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const companyIdx = headers.indexOf("company");
  const dataIdx = headers.indexOf("data");
  if (companyIdx === -1 || dataIdx === -1) return null;

  const target = normKey(companyName);
  for (let i = 1; i < rows.length; i++) {
    if (normKey(rows[i][companyIdx] || "") !== target) continue;
    try {
      const record = JSON.parse(rows[i][dataIdx] || "{}") as CachedIntel;
      if (!Array.isArray(record.jobs)) record.jobs = [];
      return { record, rowNumber: i + 1 };
    } catch {
      return null; // corrupt JSON — treat as a miss so we refetch
    }
  }
  return null;
}

async function upsertIntelCache(companyName: string, record: CachedIntel): Promise<void> {
  await ensureTab(TAB_NAMES.portcoIntel, PORTCO_INTEL_HEADERS);
  const existing = await readIntelCache(companyName);
  const row = rowFromCache(companyName, record);
  if (existing) {
    await writeSheetRow(TAB_NAMES.portcoIntel, existing.rowNumber, row);
  } else {
    await appendSheetRow(TAB_NAMES.portcoIntel, row);
  }
}

// ── Server functions (key stays server-side) ─────────────────────

export const sumbleStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ configured: boolean }> => ({ configured: isSumbleConfigured() }),
);

// PortCo Intelligence — match + hiring signals. Served from the sheet cache
// unless `force` is set (Refresh), in which case it re-calls Sumble and re-caches.
export const getPortcoIntel = createServerFn({ method: "POST" })
  .inputValidator((data: { name: string; website?: string; location?: string; force?: boolean }) => data)
  .handler(async ({ data }): Promise<PortcoIntelResult> => {
    try {
      // 1. Serve from cache unless a refresh was requested.
      if (!data.force) {
        const cached = await readIntelCache(data.name);
        if (cached) {
          const c = cached.record;
          return {
            found: true,
            org: c.org,
            jobs: c.jobs,
            brief: c.brief,
            credits: c.credits,
            cached: true,
            fetchedAt: c.fetchedAt,
          };
        }
      }

      // 2. Live call to Sumble.
      const res = await buildPortcoIntel(data.name, data.website, data.location);
      if (!res.found || res.notFound) return res; // don't cache errors / non-matches

      // 3. Persist to the sheet (preserve any previously-cached brief).
      const prior = await readIntelCache(data.name);
      const record: CachedIntel = {
        org: res.org,
        jobs: res.jobs,
        brief: prior?.record.brief,
        briefFetchedAt: prior?.record.briefFetchedAt,
        credits: res.credits,
        fetchedAt: today(),
      };
      try {
        await upsertIntelCache(data.name, record);
      } catch (e) {
        console.error("[sumble] cache write failed:", e); // non-fatal
      }
      return { ...res, cached: false, fetchedAt: record.fetchedAt, brief: record.brief };
    } catch (err) {
      console.error("[sumble] getPortcoIntel failed:", err);
      return { found: false, error: err instanceof Error ? err.message : "Sumble request failed", jobs: [] };
    }
  });

// Generate / fetch the org intelligence brief (~50 credits; may be pending).
// On success it's merged into the company's cached row so it isn't re-purchased.
export const getPortcoBrief = createServerFn({ method: "POST" })
  .inputValidator((data: { organizationId: number; companyName: string }) => data)
  .handler(async ({ data }): Promise<PortcoBriefResult> => {
    try {
      const res = await buildPortcoBrief(data.organizationId);
      if (res.found && res.brief?.body) {
        const prior = await readIntelCache(data.companyName);
        if (prior) {
          const record: CachedIntel = {
            ...prior.record,
            brief: res.brief,
            briefFetchedAt: today(),
            credits: res.credits || prior.record.credits,
          };
          try {
            await upsertIntelCache(data.companyName, record);
          } catch (e) {
            console.error("[sumble] brief cache write failed:", e); // non-fatal
          }
        }
      }
      return res;
    } catch (err) {
      console.error("[sumble] getPortcoBrief failed:", err);
      return { found: false, error: err instanceof Error ? err.message : "Sumble request failed" };
    }
  });

// Network Search — external Sumble companies for the side-panel search bar.
// Internal contacts/targets are matched client-side; this is the external lane.
export const searchNetworkOrgs = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      query: string;
      by: NetworkSearchDimension;
      limit?: number;
      sizes?: string[];
      industry?: string;
      technologies?: string[];
    }) => data,
  )
  .handler(async ({ data }): Promise<NetworkOrgSearchResult> => {
    try {
      return await searchNetworkOrganizations(data.query, data.by, data.limit, {
        sizes: data.sizes,
        industry: data.industry,
        technologies: data.technologies,
      });
    } catch (err) {
      console.error("[sumble] searchNetworkOrgs failed:", err);
      return { found: false, error: err instanceof Error ? err.message : "Sumble search failed", companies: [] };
    }
  });

// Full detected technology stack (~5 credits per technology; opt-in, not cached).
export const getPortcoTechStack = createServerFn({ method: "POST" })
  .inputValidator((data: { domain: string }) => data)
  .handler(async ({ data }): Promise<PortcoTechResult> => {
    try {
      return await buildPortcoTechStack(data.domain);
    } catch (err) {
      console.error("[sumble] getPortcoTechStack failed:", err);
      return { found: false, error: err instanceof Error ? err.message : "Sumble request failed", technologies: [] };
    }
  });

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "msn.com",
]);

function hostOf(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

// Corporate email domain (empty for free providers, which aren't a company domain).
function emailDomainOf(email?: string): string {
  const first = (email || "").split(/[;,]/)[0].trim().toLowerCase();
  const at = first.indexOf("@");
  if (at < 0) return "";
  const d = first.slice(at + 1).trim();
  return !d || FREE_EMAIL_DOMAINS.has(d) ? "" : d;
}

// Tech stack for a contact OR company profile. Resolves a domain from whatever
// the record has (explicit domain → website host → corporate email domain →
// Sumble org match by name), then enriches. ~5 credits per detected technology,
// so it's opt-in (button-triggered) in the UI. Returns the resolved domain so
// the UI can show what it looked up.
export const getCompanyTechStack = createServerFn({ method: "POST" })
  .inputValidator((data: { domain?: string; website?: string; email?: string; company?: string }) => data)
  .handler(async ({ data }): Promise<PortcoTechResult & { domain?: string }> => {
    try {
      let domain = (data.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
      if (!domain && data.website) domain = hostOf(data.website);
      if (!domain && data.email) domain = emailDomainOf(data.email); // "" for free providers
      if (!domain && data.company) {
        const m = await matchOrganization(data.company, data.website);
        domain = m.org?.domain || "";
      }
      if (!domain) {
        return { found: false, error: "Couldn't resolve a company domain for this record.", technologies: [] };
      }
      const res = await buildPortcoTechStack(domain);
      return { ...res, domain };
    } catch (err) {
      console.error("[sumble] getCompanyTechStack failed:", err);
      return { found: false, error: err instanceof Error ? err.message : "Sumble request failed", technologies: [] };
    }
  });

// Opt-in confirmation pass: confirm specific technologies (the jobs-derived names,
// or a curated list when none given) against Sumble's enrich checker and return
// confidence per tech. ~5 credits per technology checked. The domain is supplied
// by the client from the initial tech-stack load (no re-resolution needed).
export const verifyCompanyTechStack = createServerFn({ method: "POST" })
  .inputValidator((data: { domain: string; technologies?: string[] }) => data)
  .handler(async ({ data }): Promise<PortcoTechResult> => {
    try {
      const domain = (data.domain || "").trim().toLowerCase();
      if (!domain) return { found: false, error: "No company domain to verify against.", technologies: [] };
      return await verifyPortcoTechStack(domain, data.technologies || []);
    } catch (err) {
      console.error("[sumble] verifyCompanyTechStack failed:", err);
      return { found: false, error: err instanceof Error ? err.message : "Sumble verify failed", technologies: [] };
    }
  });
