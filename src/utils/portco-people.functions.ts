import { createServerFn } from "@tanstack/react-start";
import { searchPeople, enrichPerson } from "./apollo.server";
import {
  addContactRow,
  buildContacts,
  ensureColumn,
  logOpsEvent,
  TAB_NAMES,
} from "./sheets.server";

export interface PortcoPersonCandidate {
  apolloId: string;
  firstName: string;
  title: string;
  company: string;
  hasEmail: boolean;
  hasPhone: boolean;
  hasLocation: boolean;
}

export interface FindPortcoPeopleResult {
  ok: boolean;
  error?: string;
  accessDenied?: boolean;
  domain: string;
  companyName: string;
  people: PortcoPersonCandidate[];
  total: number;
  /** Already in CRM (by apollo-less name+company or email domain). */
  alreadyKnown: number;
}

export interface AddPortcoPeopleResult {
  ok: boolean;
  error?: string;
  added: number;
  enriched: number;
  duplicates: number;
  failed: number;
  noEmail: number;
  created: string[];
}

// Leadership-ish Apollo facets for PortCo Key People.
const PORTCO_SENIORITIES = ["c_suite", "founder", "vp", "director"];

function dedupeKeys(name: string, company: string, email: string, linkedin: string): string[] {
  const keys: string[] = [];
  const e = (email || "").trim().toLowerCase();
  if (e) keys.push(`e:${e}`);
  const li = (linkedin || "").trim().toLowerCase().replace(/\/$/, "");
  if (li) keys.push(`li:${li}`);
  const nc = `${(name || "").trim()}|${(company || "").trim()}`.toLowerCase();
  if (nc.length > 1) keys.push(`nc:${nc}`);
  return keys;
}

/** Normalize a website or bare domain to an Apollo-friendly domain (no www/protocol). */
export function domainFromWebsite(website?: string): string {
  const raw = (website || "").trim();
  if (!raw) return "";
  try {
    const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const host = new URL(withProto).hostname.replace(/^www\./i, "");
    return host.toLowerCase();
  } catch {
    return raw
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .split("/")[0]
      .trim()
      .toLowerCase();
  }
}

// Apollo people search scoped to this PortCo's website domain. Results are
// obfuscated until add (enrich by apollo id). Ops source: `portco_people_search`.
export const findPortcoPeople = createServerFn({ method: "POST" })
  .inputValidator((data: { companyName: string; website?: string; perPage?: number }) => data)
  .handler(async ({ data }): Promise<FindPortcoPeopleResult> => {
    const companyName = (data.companyName || "").trim();
    const domain = domainFromWebsite(data.website);
    const empty: FindPortcoPeopleResult = {
      ok: true,
      domain,
      companyName,
      people: [],
      total: 0,
      alreadyKnown: 0,
    };

    if (!companyName) {
      return { ...empty, ok: false, error: "Company name is required" };
    }
    if (!domain) {
      const error = "Add a website first (Web Sync) so we can search by company domain";
      await logOpsEvent({
        action: "enrich",
        source: "portco_people_search",
        status: "error",
        summary: error,
        records: 0,
        details: { company: companyName },
      });
      return { ...empty, ok: false, error };
    }

    try {
      const res = await searchPeople({
        organizationDomains: [domain],
        seniorities: PORTCO_SENIORITIES,
        perPage: Math.min(25, Math.max(5, data.perPage || 15)),
      });

      if (res.accessDenied) {
        await logOpsEvent({
          action: "enrich",
          source: "portco_people_search",
          status: "error",
          summary: res.error || "Apollo people search access denied",
          records: 0,
          details: { company: companyName, domain },
        });
        return {
          ...empty,
          ok: false,
          accessDenied: true,
          error: res.error || "Apollo people-search isn't accessible with this API key/plan.",
        };
      }

      // Soft filter: people already in CRM at this company (name match).
      let known = new Set<string>();
      try {
        const contacts = await buildContacts();
        known = new Set(
          contacts
            .filter((c) => (c.company || "").trim().toLowerCase() === companyName.toLowerCase())
            .map((c) => (c.name || "").trim().toLowerCase())
            .filter(Boolean),
        );
        // Also treat same email domain as "known" for counting vaguely-
        // similar first names is unreliable — just flag company name matches.
      } catch {
        /* proceed */
      }

      const people: PortcoPersonCandidate[] = res.people.map((p) => ({
        apolloId: p.id,
        firstName: p.firstName,
        title: p.title,
        company: p.company || companyName,
        hasEmail: p.hasEmail,
        hasPhone: p.hasPhone,
        hasLocation: p.hasLocation,
      }));

      const alreadyKnown = people.filter((p) =>
        known.has(p.firstName.trim().toLowerCase()),
      ).length;

      await logOpsEvent({
        action: "enrich",
        source: "portco_people_search",
        status: "ok",
        summary: `Apollo people search for ${companyName} (@${domain}) · ${people.length} hits`,
        records: people.length,
        details: {
          company: companyName,
          domain,
          total: res.total,
          returned: people.length,
          alreadyKnown,
        },
        items: people.map(
          (p) =>
            `${p.firstName || "(name locked)"} · ${p.title || "—"} · ${p.company}` +
            `${p.hasEmail ? " · email" : ""}${p.hasPhone ? " · phone" : ""}`,
        ),
      });

      return {
        ok: true,
        domain,
        companyName,
        people,
        total: res.total,
        alreadyKnown,
      };
    } catch (err) {
      console.error("[portco-people] findPortcoPeople failed:", err);
      const message =
        err instanceof Error && /APOLLO_API_KEY/.test(err.message)
          ? "APOLLO_API_KEY is not configured"
          : err instanceof Error
            ? err.message
            : "Apollo search failed";
      await logOpsEvent({
        action: "enrich",
        source: "portco_people_search",
        status: "error",
        summary: message,
        records: 0,
        details: { company: companyName, domain },
      });
      return { ...empty, ok: false, error: message };
    }
  });

// Reveal selected Apollo candidates and add them as Portfolio-sector contacts.
// Ops source: `portco_people_add`.
export const addPortcoPeopleFromApollo = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      companyName: string;
      companyLocation?: string;
      people: PortcoPersonCandidate[];
    }) => data,
  )
  .handler(async ({ data }): Promise<AddPortcoPeopleResult> => {
    const companyName = (data.companyName || "").trim();
    const result: AddPortcoPeopleResult = {
      ok: true,
      added: 0,
      enriched: 0,
      duplicates: 0,
      failed: 0,
      noEmail: 0,
      created: [],
    };
    if (!companyName || !data.people?.length) {
      return { ...result, ok: false, error: "Select at least one person to add" };
    }

    try {
      const existing = new Set<string>();
      try {
        const contacts = await buildContacts();
        for (const c of contacts) {
          for (const k of dedupeKeys(c.name, c.company, c.email, c.linkedinUrl || "")) {
            existing.add(k);
          }
        }
      } catch {
        /* proceed without full dedupe */
      }

      await ensureColumn(TAB_NAMES.contacts, "Source");
      await ensureColumn(TAB_NAMES.contacts, "Source Context");

      const seen = new Set<string>();
      const createdItems: string[] = [];

      for (const p of data.people) {
        let email = "";
        let phone = "";
        let name = p.firstName;
        let title = p.title;
        let location = data.companyLocation || "";
        let linkedinUrl = "";

        try {
          const r = await enrichPerson({ id: p.apolloId, organizationName: p.company || companyName });
          if (r.accessDenied) {
            await logOpsEvent({
              action: "enrich",
              source: "portco_people_add",
              status: "error",
              summary: r.error || "Apollo enrichment access denied",
              records: result.added,
              details: { company: companyName },
            });
            return {
              ...result,
              ok: false,
              error: r.error || "Apollo enrichment isn't accessible with this API key/plan.",
            };
          }
          if (r.found) {
            result.enriched++;
            email = r.email || "";
            phone = r.phoneSource === "company" ? "" : r.phone || "";
            name = r.name || name;
            title = r.title || title;
            linkedinUrl = r.linkedinUrl || "";
            const loc = [r.city, r.state].filter(Boolean).join(", ");
            if (loc) location = loc;
          }
        } catch (e) {
          console.error("[portco-people] enrich failed for", p.firstName, e);
          const msg = e instanceof Error ? e.message : "";
          if (/APOLLO_API_KEY/.test(msg)) {
            return { ...result, ok: false, error: "APOLLO_API_KEY is not configured." };
          }
        }

        const keys = dedupeKeys(name, p.company || companyName, email, linkedinUrl);
        if (keys.length === 0) {
          result.failed++;
          continue;
        }
        if (keys.some((k) => existing.has(k) || seen.has(k))) {
          result.duplicates++;
          continue;
        }
        keys.forEach((k) => {
          seen.add(k);
          existing.add(k);
        });
        if (!email) result.noEmail++;

        try {
          await addContactRow({
            name: name.trim() || p.firstName,
            role: title || "",
            company: companyName,
            email,
            phone,
            location,
            prime: "",
            sector: "Portfolio",
            temperature: "Warm",
            linkedin: linkedinUrl,
            source: "Apollo",
            sourceContext: `PortCo Key People · ${companyName}`,
          });
          result.added++;
          const label = `${name.trim()}${email ? ` <${email}>` : linkedinUrl ? ` · ${linkedinUrl}` : ""}`;
          result.created.push(label);
          createdItems.push(label);
        } catch (e) {
          console.error("[portco-people] addContactRow failed:", e);
          result.failed++;
        }
      }

      await logOpsEvent({
        action: "enrich",
        source: "portco_people_add",
        status: result.added > 0 || result.duplicates > 0 ? "ok" : "error",
        summary: `Added ${result.added} Key People to ${companyName} via Apollo` +
          (result.duplicates ? ` · ${result.duplicates} already in CRM` : ""),
        records: result.added,
        details: {
          company: companyName,
          requested: data.people.length,
          added: result.added,
          enriched: result.enriched,
          duplicates: result.duplicates,
          failed: result.failed,
          noEmail: result.noEmail,
        },
        items: createdItems,
      });

      if (result.added === 0 && result.duplicates === data.people.length) {
        return { ...result, ok: true }; // all dupes is a successful no-op
      }
      if (result.added === 0 && result.failed > 0) {
        return { ...result, ok: false, error: "Couldn't add any of the selected people" };
      }
      return result;
    } catch (err) {
      console.error("[portco-people] addPortcoPeopleFromApollo failed:", err);
      const message = err instanceof Error ? err.message : "Add people failed";
      await logOpsEvent({
        action: "enrich",
        source: "portco_people_add",
        status: "error",
        summary: message,
        records: 0,
        details: { company: companyName },
      });
      return { ...result, ok: false, error: message };
    }
  });
