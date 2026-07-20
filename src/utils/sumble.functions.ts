import { createServerFn } from "@tanstack/react-start";
import {
  buildPortcoIntel,
  buildPortcoBrief,
  buildPortcoTechStack,
  buildTechUsage,
  searchNetworkOrganizations,
  findCompaniesByTech,
  matchOrganization,
  isSumbleConfigured,
  type PortcoIntelResult,
  type PortcoBriefResult,
  type PortcoTechResult,
  type NetworkOrgSearchResult,
  type NetworkSearchDimension,
  type FindCompaniesResult,
  type SumbleOrg,
  type SumbleJob,
  type SumbleBrief,
  type SumbleCredits,
  type SumbleTech,
  type DiscoveryResult,
} from "./sumble.server";
import {
  fetchSheetTab,
  ensureTab,
  appendSheetRow,
  writeSheetRow,
  bulkMergeContactFields,
  logOpsEvent,
  buildPortfolioCompanies,
  TAB_NAMES,
  PORTCO_INTEL_HEADERS,
  type BulkMergeUpdate,
} from "./sheets.server";
import {
  annotateTechnologies,
  buildPortcoOfferingIndex,
} from "@/lib/portco-tech-similarity";
import { serializeTechStackField } from "@/lib/tech-stack-storage";

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
async function readIntelCache(
  companyName: string,
): Promise<{ record: CachedIntel; rowNumber: number } | null> {
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
  .inputValidator(
    (data: { name: string; website?: string; location?: string; force?: boolean }) => data,
  )
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
      if (!res.found || res.notFound) {
        await logOpsEvent({
          action: "enrich",
          source: "sumble_refresh",
          status: res.notFound ? "ok" : "error",
          summary: res.notFound
            ? `Sumble · ${data.name} not found`
            : res.error || `Sumble refresh failed for ${data.name}`,
          records: 0,
          details: {
            company: data.name,
            force: !!data.force,
            notFound: !!res.notFound,
          },
        });
        return res;
      }

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
      await logOpsEvent({
        action: "enrich",
        source: "sumble_refresh",
        status: "ok",
        summary: `Sumble refresh · ${data.name} · ${res.jobs.length} jobs` +
          (data.force ? " (forced)" : " (cache miss)"),
        records: res.jobs.length,
        details: {
          company: data.name,
          force: !!data.force,
          orgId: res.org?.id ?? "",
          domain: res.org?.domain || "",
          jobs: res.jobs.length,
          creditsRemaining: res.credits?.remaining ?? "",
        },
        items: res.jobs.slice(0, 20).map(
          (j) => `${j.title || "Untitled"}${j.location ? ` · ${j.location}` : ""}`,
        ),
      });
      return { ...res, cached: false, fetchedAt: record.fetchedAt, brief: record.brief };
    } catch (err) {
      console.error("[sumble] getPortcoIntel failed:", err);
      const message = err instanceof Error ? err.message : "Sumble request failed";
      await logOpsEvent({
        action: "enrich",
        source: "sumble_refresh",
        status: "error",
        summary: message,
        records: 0,
        details: { company: data.name, force: !!data.force },
      });
      return {
        found: false,
        error: message,
        jobs: [],
      };
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
        await logOpsEvent({
          action: "enrich",
          source: "sumble_brief",
          status: "ok",
          summary: `Sumble brief · ${data.companyName}`,
          records: 1,
          details: {
            company: data.companyName,
            organizationId: data.organizationId,
            pending: !!res.pending,
          },
        });
      } else if (res.pending) {
        await logOpsEvent({
          action: "enrich",
          source: "sumble_brief",
          status: "ok",
          summary: `Sumble brief pending · ${data.companyName}`,
          records: 0,
          details: { company: data.companyName, organizationId: data.organizationId },
        });
      } else if (!res.found) {
        await logOpsEvent({
          action: "enrich",
          source: "sumble_brief",
          status: "error",
          summary: res.error || `Sumble brief failed for ${data.companyName}`,
          records: 0,
          details: { company: data.companyName, organizationId: data.organizationId },
        });
      }
      return res;
    } catch (err) {
      console.error("[sumble] getPortcoBrief failed:", err);
      const message = err instanceof Error ? err.message : "Sumble request failed";
      await logOpsEvent({
        action: "enrich",
        source: "sumble_brief",
        status: "error",
        summary: message,
        records: 0,
        details: { company: data.companyName, organizationId: data.organizationId },
      });
      return { found: false, error: message };
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
      return {
        found: false,
        error: err instanceof Error ? err.message : "Sumble search failed",
        companies: [],
      };
    }
  });

// Install-tech company search — phase 1 of the Targeting "Find" flow. Wraps
// findCompaniesByTech: companies running a given installed technology, optionally
// narrowed by city and headcount band. People come from Apollo in phase 2.
export const findInstallCompanies = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { technology: string; city?: string; sizes?: string[]; limit?: number }) => data,
  )
  .handler(async ({ data }): Promise<FindCompaniesResult> => {
    try {
      return await findCompaniesByTech({
        technology: data.technology,
        city: data.city,
        sizes: data.sizes,
        limit: data.limit,
      });
    } catch (err) {
      console.error("[sumble] findInstallCompanies failed:", err);
      return {
        found: false,
        error: err instanceof Error ? err.message : "Sumble search failed",
        companies: [],
      };
    }
  });

// Detected technology stack from recent job posts (~2 cr/job; opt-in, not cached).
export const getPortcoTechStack = createServerFn({ method: "POST" })
  .inputValidator((data: { domain: string }) => data)
  .handler(async ({ data }): Promise<PortcoTechResult> => {
    try {
      return await buildPortcoTechStack(data.domain);
    } catch (err) {
      console.error("[sumble] getPortcoTechStack failed:", err);
      return {
        found: false,
        error: err instanceof Error ? err.message : "Sumble request failed",
        technologies: [],
      };
    }
  });

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "msn.com",
]);

function hostOf(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname
      .replace(/^www\./, "")
      .toLowerCase();
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

/** Load comparableTechnologies from Customer Discovery cache (no LLM spend). */
async function loadDiscoveryComparables(): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  try {
    const rows = await fetchSheetTab(TAB_NAMES.customerDiscovery);
    if (rows.length < 2) return map;
    const headers = rows[0].map((h) => h.trim().toLowerCase());
    const companyIdx = headers.indexOf("portfolio company");
    const dataIdx = headers.indexOf("data");
    if (companyIdx === -1 || dataIdx === -1) return map;
    for (let i = 1; i < rows.length; i++) {
      const name = (rows[i][companyIdx] || "").trim().toLowerCase();
      if (!name) continue;
      try {
        const record = JSON.parse(rows[i][dataIdx] || "{}") as DiscoveryResult;
        const comps = record.profile?.comparableTechnologies || [];
        if (comps.length) map.set(name, comps);
      } catch {
        /* skip corrupt row */
      }
    }
  } catch {
    /* tab missing */
  }
  return map;
}

/** Tag each detected company technology with PortCo offering overlap notes. */
async function withPortcoSimilarity(technologies: SumbleTech[]): Promise<SumbleTech[]> {
  if (technologies.length === 0) return technologies;
  try {
    const [portfolio, discovery] = await Promise.all([
      buildPortfolioCompanies().catch(() => []),
      loadDiscoveryComparables(),
    ]);
    if (portfolio.length === 0) return technologies.map((t) => ({ ...t, portcoSimilarity: [] }));
    const index = buildPortcoOfferingIndex(portfolio, discovery);
    return annotateTechnologies(technologies, index);
  } catch (e) {
    console.error("[sumble] portco similarity annotate failed:", e);
    return technologies;
  }
}

// Tech stack for a contact OR company profile. Resolves a domain from whatever
// the record has (explicit domain → website host → corporate email domain →
// Sumble org match by name), then reads the technologies from its recent job posts.
// Opt-in (button-triggered) in the UI since the jobs lookup is billed. Returns the
// resolved domain so the UI can show what it looked up (and pass it to enrichment).
// Each technology is annotated with notes when it overlaps a DTC PortCo offering.
export const getCompanyTechStack = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { domain?: string; website?: string; email?: string; company?: string }) => data,
  )
  .handler(async ({ data }): Promise<PortcoTechResult & { domain?: string }> => {
    try {
      let domain = (data.domain || "")
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/.*$/, "");
      if (!domain && data.website) domain = hostOf(data.website);
      if (!domain && data.email) domain = emailDomainOf(data.email); // "" for free providers
      if (!domain && data.company) {
        const m = await matchOrganization(data.company, data.website);
        domain = m.org?.domain || "";
      }
      if (!domain) {
        return {
          found: false,
          error: "Couldn't resolve a company domain for this record.",
          technologies: [],
        };
      }
      const res = await buildPortcoTechStack(domain);
      if (!res.found) return { ...res, domain };
      const technologies = await withPortcoSimilarity(res.technologies);
      return { ...res, technologies, domain };
    } catch (err) {
      console.error("[sumble] getCompanyTechStack failed:", err);
      return {
        found: false,
        error: err instanceof Error ? err.message : "Sumble request failed",
        technologies: [],
      };
    }
  });

// Opt-in usage enrichment: for the tech-stack names already loaded, fetch Sumble's
// v9 whole-company "actively used" counts and derive a 0–100 confidence per tech.
// The domain is supplied by the client from the initial load (no re-resolution).
// Billed ~1 credit per technology checked, so it's gated behind its own button.
export const enrichTechUsage = createServerFn({ method: "POST" })
  .inputValidator((data: { domain: string; technologies: string[] }) => data)
  .handler(async ({ data }): Promise<PortcoTechResult> => {
    try {
      const domain = (data.domain || "").trim().toLowerCase();
      if (!domain)
        return { found: false, error: "No company domain to check usage against.", technologies: [] };
      const res = await buildTechUsage(domain, data.technologies || []);
      if (!res.found) return res;
      // Re-attach PortCo notes (usage enrichment returns counts only).
      const technologies = await withPortcoSimilarity(res.technologies);
      return { ...res, technologies };
    } catch (err) {
      console.error("[sumble] enrichTechUsage failed:", err);
      return {
        found: false,
        error: err instanceof Error ? err.message : "Sumble usage check failed",
        technologies: [],
      };
    }
  });

/**
 * Re-annotate saved technology names with PortCo offering overlap — no Sumble
 * credits. Used when hydrating a stored stack so notes stay fresh.
 */
export const annotateSavedTechStack = createServerFn({ method: "POST" })
  .inputValidator((data: { technologies: string[] }) => data)
  .handler(async ({ data }): Promise<{ technologies: SumbleTech[] }> => {
    const names = [...new Set((data.technologies || []).map((n) => n.trim()).filter(Boolean))];
    if (names.length === 0) return { technologies: [] };
    const stub: SumbleTech[] = names.map((name) => ({ name }));
    const technologies = await withPortcoSimilarity(stub);
    return { technologies };
  });

// Mass tech-stack load: resolve each selected contact's company to a Sumble org,
// aggregate its hiring-signal tech stack ONCE per unique company (dedup avoids
// re-spending credits), and persist the top technologies to each contact's
// "Tech Stack" column in a single batched write. Credit-costly (Sumble jobs are
// billed), so the UI gates this behind a confirm showing the unique-company
// count. Contacts whose company can't be resolved are skipped.
const TECH_STACK_MAX = 12; // how many technologies to store per contact
export const bulkLoadTechStack = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      contacts: {
        email: string;
        urid?: string;
        company?: string;
        website?: string;
        linkedinUrl?: string;
      }[];
    }) => data,
  )
  .handler(async ({ data }) => {
    if (!isSumbleConfigured()) {
      return {
        companies: 0,
        resolved: 0,
        updated: 0,
        skipped: data.contacts.length,
        error: "Sumble isn't configured (SUMBLE_API_KEY missing).",
      };
    }

    // Group contacts by a normalized company key so each company is priced once.
    const groups = new Map<
      string,
      { company: string; website?: string; members: typeof data.contacts }
    >();
    let skipped = 0;
    for (const c of data.contacts) {
      const company = (c.company || "").trim();
      if (!company) {
        skipped++;
        continue;
      }
      const key = company.toLowerCase();
      if (!groups.has(key)) groups.set(key, { company, website: c.website, members: [] });
      groups.get(key)!.members.push(c);
    }

    const updates: BulkMergeUpdate[] = [];
    let resolved = 0;
    let creditsRemaining: number | undefined;

    for (const { company, website, members } of groups.values()) {
      try {
        // Resolve to a Sumble org: website host first, else match by name.
        let domain = hostOf(website);
        if (!domain) {
          const m = await matchOrganization(company, website);
          domain = m.org?.domain || "";
        }
        if (!domain) {
          skipped += members.length;
          continue;
        }

        const res = await buildPortcoTechStack(domain);
        if (res.credits?.remaining !== undefined) creditsRemaining = res.credits.remaining;
        if (!res.found || res.technologies.length === 0) {
          skipped += members.length;
          continue;
        }
        resolved++;
        const annotated = await withPortcoSimilarity(res.technologies);
        const top = annotated.slice(0, TECH_STACK_MAX);
        const stack = serializeTechStackField({
          domain,
          fetchedAt: new Date().toISOString(),
          usageChecked: false,
          technologies: top,
        });
        for (const m of members) {
          updates.push({ email: m.email, urid: m.urid, fields: { techStack: stack } });
        }
      } catch (e) {
        console.error("[bulkLoadTechStack] failed for", company, e);
        skipped += members.length;
      }
    }

    const merge = await bulkMergeContactFields(updates, "user");
    return { companies: groups.size, resolved, updated: merge.updated, skipped, creditsRemaining };
  });
