import { createServerFn } from "@tanstack/react-start";
import { buildProspects, discoverProspectCompanies, fetchProspectPeople, type ProspectsResult, type ProspectCompany, type ProspectCompaniesResult, type SumbleProspect } from "./sumble.server";
import { enrichPerson, searchPeople } from "./apollo.server";
import {
  buildContacts,
  buildTargets,
  addContactRow,
  appendSheetRows,
  appendTargetRows,
  ensureTab,
  ensureColumn,
  TAB_NAMES,
  SUMBLE_PROSPECT_HEADERS,
  type TargetRowInput,
} from "./sheets.server";

const today = () => new Date().toISOString().split("T")[0];

function prospectLogRow(p: SumbleProspect, focus: string, status: string, email = "", reason = ""): string[] {
  return [
    today(),
    focus,
    p.industry || "",
    p.name,
    p.title || "",
    p.jobLevel || "",
    p.company,
    p.companyDomain || "",
    p.location || "",
    p.linkedinUrl || "",
    status,
    email,
    reason,
  ];
}

// ── Apollo attribute-search mode ─────────────────────────────────
// When no focus/industry anchor is given, Sumble can't search (it discovers
// companies BY technology). Instead search Apollo by people attributes —
// role / seniority / company-size / country — which Apollo supports natively.
interface ProspectInput {
  focus: string;
  jobLevels?: string[];
  jobFunctions?: string[];
  countries?: string[];
  industry?: string;
  sizes?: string[];
  companyLimit?: number;
  perCompany?: number;
}

// Each seniority chip fans out to a set of Apollo person_titles (one request,
// not one-call-per-title) plus the matching person_seniorities facet for
// precision. Sent together in a single searchPeople() call.
const SENIORITY_TITLE_MAP: Record<string, { seniority: string; titles: string[] }> = {
  "C-Suite": {
    seniority: "c_suite",
    titles: [
      "CEO", "CIO", "CTO", "CISO", "CFO", "COO",
      "Chief Digital Officer", "Chief Data Officer",
      "Chief Information Security Officer", "Chief Technology Officer",
    ],
  },
  SVP: { seniority: "vp", titles: ["SVP", "Senior Vice President", "EVP", "Executive Vice President"] },
  VP: { seniority: "vp", titles: ["VP", "Vice President", "Head of"] },
  Director: { seniority: "director", titles: ["Director", "Senior Director", "Managing Director"] },
  Manager: { seniority: "manager", titles: ["Manager", "Senior Manager", "Group Manager"] },
};
// Apollo organization_num_employees_ranges expects "min,max" strings.
const SIZE_TO_APOLLO_RANGE: Record<string, string> = {
  "1k_5k": "1000,5000",
  "5k_10k": "5001,10000",
  "10k_50k": "10001,50000",
  "50k_plus": "50001,1000000",
  under_1k: "1,999",
};

async function apolloAttributeSearch(data: ProspectInput): Promise<ProspectsResult> {
  // Seniority chips fan out to titles; freeform job functions add more titles.
  const seniorityTitles = (data.jobLevels || []).flatMap((l) => SENIORITY_TITLE_MAP[l]?.titles || []);
  const fnTitles = (data.jobFunctions || []).map((s) => s.trim()).filter(Boolean);
  const titles = [...new Set([...seniorityTitles, ...fnTitles])];
  const seniorities = [
    ...new Set((data.jobLevels || []).map((l) => SENIORITY_TITLE_MAP[l]?.seniority).filter(Boolean)),
  ];
  const employeeRanges = (data.sizes || []).map((s) => SIZE_TO_APOLLO_RANGE[s]).filter(Boolean);
  const locations = (data.countries || []).map((s) => s.trim()).filter(Boolean);

  if (!titles.length && !seniorities.length && !employeeRanges.length && !locations.length) {
    return {
      found: false,
      prospects: [],
      error: "Add a focus/industry, or at least one of role, seniority, company size, or country.",
    };
  }

  const perPage = Math.min(100, Math.max(5, (data.companyLimit ?? 5) * (data.perCompany ?? 5)));
  let res;
  try {
    res = await searchPeople({ titles, seniorities, locations, employeeRanges, perPage });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (/APOLLO_API_KEY/.test(msg)) return { found: false, prospects: [], error: "APOLLO_API_KEY is not configured." };
    return { found: false, prospects: [], error: "Apollo search failed — see console." };
  }
  if (res.accessDenied) {
    return { found: false, prospects: [], error: res.error || "Apollo people-search isn't accessible on this plan." };
  }
  // Apollo results are obfuscated (first name + title + company + id); the Apollo
  // id lets us reveal full contact info on add (enrichPerson by id).
  const prospects: SumbleProspect[] = res.people.map((p) => ({
    name: p.firstName,
    title: p.title,
    company: p.company,
    apolloId: p.id,
  }));
  const companies = new Set(prospects.map((p) => p.company.toLowerCase()).filter(Boolean));
  return { found: true, prospects, focusResolved: "Apollo people search", companiesScanned: companies.size };
}

// Find people to expand the network. With a focus/industry it uses Sumble
// (technographic); with none it uses Apollo (people attributes). Logs found
// prospects to the Sumble Prospects tab.
export const findProspects = createServerFn({ method: "POST" })
  .inputValidator((data: ProspectInput) => data)
  .handler(async ({ data }): Promise<ProspectsResult> => {
    const hasAnchor = !!(data.focus?.trim() || data.industry?.trim());
    try {
      const res = hasAnchor ? await buildProspects(data) : await apolloAttributeSearch(data);
      // Log everything found (audit trail), best-effort.
      const logTerm = data.focus?.trim() || data.industry?.trim() || res.focusResolved || "Apollo search";
      if (res.found && res.prospects.length > 0) {
        try {
          await ensureTab(TAB_NAMES.sumbleProspects, SUMBLE_PROSPECT_HEADERS);
          await appendSheetRows(
            TAB_NAMES.sumbleProspects,
            res.prospects.map((p) => prospectLogRow(p, logTerm, "Found")),
          );
        } catch (e) {
          console.error("[prospects] log-found failed:", e);
        }
      }
      return res;
    } catch (err) {
      console.error("[prospects] findProspects failed:", err);
      return { found: false, error: err instanceof Error ? err.message : "Prospect search failed", prospects: [] };
    }
  });

// Two-phase Network Finder, Sumble path. Phase 1: discover companies (cheap,
// cached) so the user can prune before the per-company people fan-out.
export const findProspectCompanies = createServerFn({ method: "POST" })
  .inputValidator((data: { focus: string; industry?: string; sizes?: string[]; companyLimit?: number }) => data)
  .handler(async ({ data }): Promise<ProspectCompaniesResult> => {
    try {
      return await discoverProspectCompanies({
        focus: data.focus,
        industry: data.industry,
        sizes: data.sizes,
        companyLimit: data.companyLimit,
      });
    } catch (err) {
      console.error("[prospects] findProspectCompanies failed:", err);
      return { found: false, error: err instanceof Error ? err.message : "Company search failed", companies: [] };
    }
  });

// Phase 2: people at the (pruned) companies. Logs found prospects to the tab.
export const findProspectPeople = createServerFn({ method: "POST" })
  .inputValidator((data: {
    companies: ProspectCompany[];
    perCompany?: number;
    jobLevels?: string[];
    jobFunctions?: string[];
    countries?: string[];
    focus?: string;
  }) => data)
  .handler(async ({ data }): Promise<ProspectsResult> => {
    const companies = (data.companies || []).filter((c) => c.domain);
    if (companies.length === 0) return { found: true, prospects: [], companiesScanned: 0 };
    try {
      const { prospects, credits } = await fetchProspectPeople(companies, data.perCompany ?? 5, {
        jobFunctions: data.jobFunctions,
        jobLevels: data.jobLevels,
        countries: data.countries,
      });
      if (prospects.length > 0) {
        try {
          await ensureTab(TAB_NAMES.sumbleProspects, SUMBLE_PROSPECT_HEADERS);
          await appendSheetRows(
            TAB_NAMES.sumbleProspects,
            prospects.map((p) => prospectLogRow(p, data.focus?.trim() || "Sumble companies", "Found")),
          );
        } catch (e) {
          console.error("[prospects] log-found (people) failed:", e);
        }
      }
      return { found: true, prospects, credits, companiesScanned: companies.length };
    } catch (err) {
      console.error("[prospects] findProspectPeople failed:", err);
      return { found: false, error: err instanceof Error ? err.message : "People search failed", prospects: [] };
    }
  });

// Decision-makers at a single company — used by Network Search to pull the
// senior people responsible for a technology before adding them to Targets.
// Tries a seniority filter first, then falls back to unfiltered (Sumble's
// AND-filtering can zero out otherwise-valid companies), mirroring Customer
// Discovery. Industry is carried over from the company onto each prospect.
export const findCompanyDecisionMakers = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      company: ProspectCompany;
      perCompany?: number;
      /** People-search refine filters (Network Search advanced filters). */
      jobLevels?: string[];
      jobFunctions?: string[];
      countries?: string[];
    }) => data,
  )
  .handler(async ({ data }): Promise<ProspectsResult> => {
    const company = data.company;
    if (!company?.domain) return { found: true, prospects: [], companiesScanned: 0 };
    const per = Math.min(10, Math.max(1, data.perCompany ?? 5));
    // Use the caller's seniority filter when provided, else a sensible default.
    const jobLevels = data.jobLevels?.length ? data.jobLevels : ["C-Suite", "VP", "Director"];
    const jobFunctions = data.jobFunctions?.length ? data.jobFunctions : undefined;
    const countries = data.countries?.length ? data.countries : undefined;
    try {
      let { prospects, credits } = await fetchProspectPeople([company], per, { jobLevels, jobFunctions, countries });
      // Fall back to an unfiltered lookup if the refined filters surfaced nobody.
      if (prospects.length === 0) {
        ({ prospects, credits } = await fetchProspectPeople([company], per, {}));
      }
      return { found: true, prospects, credits, companiesScanned: 1 };
    } catch (err) {
      console.error("[prospects] findCompanyDecisionMakers failed:", err);
      return { found: false, error: err instanceof Error ? err.message : "Decision-maker lookup failed", prospects: [] };
    }
  });

export interface AddProspectsResult {
  success: boolean;
  added: number;
  duplicates: number;
  enriched: number;
  failed: number;
  error?: string;
}

// Enrich selected prospects via Apollo and add them as COLD contacts.
// Dedupes against existing contact emails. Logs each add to Sumble Prospects.
export const addProspectsToContacts = createServerFn({ method: "POST" })
  .inputValidator((data: { prospects: SumbleProspect[]; focus?: string }) => data)
  .handler(async ({ data }): Promise<AddProspectsResult> => {
    const result: AddProspectsResult = { success: true, added: 0, duplicates: 0, enriched: 0, failed: 0 };
    if (!data.prospects?.length) return result;

    // Existing emails for dedupe.
    let existing = new Set<string>();
    try {
      const contacts = await buildContacts();
      existing = new Set(
        contacts.flatMap((c) => (c.email || "").split(";").map((e) => e.trim().toLowerCase())).filter(Boolean),
      );
    } catch {
      /* if we can't read contacts, proceed without dedupe */
    }

    // Ensure the canonical Source column exists before header-aware appends.
    try {
      await ensureColumn(TAB_NAMES.contacts, "Source");
    } catch (e) {
      console.error("[prospects] ensure Source column failed:", e);
    }

    const logRows: string[][] = [];
    const seen = new Set<string>();

    for (const p of data.prospects) {
      // Apollo enrichment (email/phone/location/title) from name + company + LinkedIn.
      let email = "";
      let phone = "";
      let location = p.location || "";
      let title = p.title || "";
      let revealedName = "";
      let linkedin = p.linkedinUrl || "";
      const company = p.company || "";
      try {
        // Apollo-sourced prospects carry an id → reveal by id (exact). Sumble-sourced
        // ones enrich by name + company + LinkedIn.
        const parts = p.name.trim().split(/\s+/);
        const r = p.apolloId
          ? await enrichPerson({ id: p.apolloId, organizationName: company || undefined })
          : await enrichPerson({
              firstName: parts[0] || undefined,
              lastName: parts.slice(1).join(" ") || undefined,
              organizationName: company || undefined,
              linkedinUrl: p.linkedinUrl || undefined,
            });
        if (r.found) {
          result.enriched++;
          email = r.email || "";
          phone = r.phone || "";
          title = title || r.title || "";
          revealedName = r.name || "";
          if (r.linkedinUrl) linkedin = r.linkedinUrl;
          const city = [r.city, r.state].filter(Boolean).join(", ");
          if (city) location = city;
        }
      } catch (e) {
        console.error("[prospects] enrich failed for", p.name, e);
      }

      const key = email.trim().toLowerCase();
      if (key && (existing.has(key) || seen.has(key))) {
        result.duplicates++;
        continue;
      }
      if (key) seen.add(key);

      try {
        await addContactRow({
          name: revealedName || p.name,
          role: title,
          company,
          email,
          phone,
          location,
          linkedin,
          prime: "",
          sector: p.industry || "",
          temperature: "Cold", // new prospects always enter Cold
          // Engine-based attribution: Apollo-sourced prospects carry an apolloId.
          source: p.apolloId ? "Apollo" : "Sumble",
        });
        result.added++;
        logRows.push(prospectLogRow(p, data.focus || "", "Added", email));
      } catch (e) {
        console.error("[prospects] add failed for", p.name, e);
        result.failed++;
      }
    }

    // Log the adds to the Sumble Prospects tab (best-effort).
    if (logRows.length > 0) {
      try {
        await ensureTab(TAB_NAMES.sumbleProspects, SUMBLE_PROSPECT_HEADERS);
        await appendSheetRows(TAB_NAMES.sumbleProspects, logRows);
      } catch (e) {
        console.error("[prospects] log-added failed:", e);
      }
    }

    return result;
  });

// Enrich selected prospects via Apollo and add them to the TARGETS pipeline
// (stage "Prospecting"), retaining WHY each was surfaced (per-prospect `reason`)
// and WHERE it came from (`source`). Dedupes against existing target emails.
// This is the destination for Customer Discovery + Network Finder adds.
export const addProspectsToTargets = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      prospects: Array<SumbleProspect & { reason?: string }>;
      /** Free-text origin label (kept for the audit log / focus). */
      source?: string;
      /** Canonical RecordSource override (e.g. "Customer Discovery"). When omitted,
       *  source is derived per prospect by engine: apolloId → "Apollo", else "Sumble". */
      sourceKind?: string;
      focus?: string;
    }) => data,
  )
  .handler(async ({ data }): Promise<AddProspectsResult> => {
    const result: AddProspectsResult = { success: true, added: 0, duplicates: 0, enriched: 0, failed: 0 };
    if (!data.prospects?.length) return result;

    // Existing target emails for dedupe.
    let existing = new Set<string>();
    try {
      const targets = await buildTargets();
      existing = new Set(
        targets.flatMap((t) => (t.email || "").split(";").map((e) => e.trim().toLowerCase())).filter(Boolean),
      );
    } catch {
      /* if we can't read targets, proceed without dedupe */
    }

    const today2 = new Date().toISOString().split("T")[0];
    const source = data.source || "";
    // Canonical source for the Targets "Source" column: explicit override (e.g.
    // "Customer Discovery") wins; otherwise per-prospect by engine.
    const canonicalSource = (p: SumbleProspect): string => data.sourceKind || (p.apolloId ? "Apollo" : "Sumble");
    const targetRows: TargetRowInput[] = [];
    const logRows: string[][] = [];
    const seen = new Set<string>();

    for (const p of data.prospects) {
      let email = "";
      let phone = "";
      let location = p.location || "";
      let title = p.title || "";
      let revealedName = "";
      const company = p.company || "";
      try {
        const parts = p.name.trim().split(/\s+/);
        const r = p.apolloId
          ? await enrichPerson({ id: p.apolloId, organizationName: company || undefined })
          : await enrichPerson({
              firstName: parts[0] || undefined,
              lastName: parts.slice(1).join(" ") || undefined,
              organizationName: company || undefined,
              linkedinUrl: p.linkedinUrl || undefined,
            });
        if (r.found) {
          result.enriched++;
          email = r.email || "";
          phone = r.phone || "";
          title = title || r.title || "";
          revealedName = r.name || "";
          const city = [r.city, r.state].filter(Boolean).join(", ");
          if (city) location = city;
        }
      } catch (e) {
        console.error("[prospects] enrich failed for", p.name, e);
      }

      const key = email.trim().toLowerCase();
      if (key && (existing.has(key) || seen.has(key))) {
        result.duplicates++;
        continue;
      }
      if (key) seen.add(key);

      const fullName = (revealedName || p.name || "").trim();
      const firstName = fullName.split(/\s+/)[0] || "";
      const lastName = fullName.split(/\s+/).slice(1).join(" ");

      // Header-aware append stamps a stable URID and tolerates column order.
      targetRows.push({
        firstName,
        lastName,
        company,
        role: title,
        linkedin: p.linkedinUrl || "",
        email,
        phone,
        location,
        sector: p.industry || "",
        stage: "Prospecting",
        source: canonicalSource(p),
        researchPurpose: "",
        dateAdded: today2,
        reasonSurfaced: p.reason || "",
      });
      logRows.push(prospectLogRow(p, data.focus || source, "Added → Target", email, p.reason || ""));
    }

    if (targetRows.length > 0) {
      try {
        await appendTargetRows(targetRows);
        result.added = targetRows.length;
      } catch (e) {
        console.error("[prospects] add-to-targets failed:", e);
        result.failed = targetRows.length;
        result.success = false;
        result.error = e instanceof Error ? e.message : "Failed to write targets";
      }
    }

    // Audit trail (best-effort) — includes the Reason each was surfaced.
    if (logRows.length > 0) {
      try {
        await ensureTab(TAB_NAMES.sumbleProspects, SUMBLE_PROSPECT_HEADERS);
        await ensureColumn(TAB_NAMES.sumbleProspects, "Reason");
        await appendSheetRows(TAB_NAMES.sumbleProspects, logRows);
      } catch (e) {
        console.error("[prospects] log-added (targets) failed:", e);
      }
    }

    return result;
  });
