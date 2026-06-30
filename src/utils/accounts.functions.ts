import { createServerFn } from "@tanstack/react-start";
import { searchPeople, enrichPerson } from "./apollo.server";
import { matchOrganization, isSumbleConfigured } from "./sumble.server";
import {
  buildContacts,
  addContactRow,
  appendSheetRows,
  ensureTab,
  TAB_NAMES,
  TARGET_ACCOUNT_HEADERS,
} from "./sheets.server";

const today = () => new Date().toISOString().split("T")[0];

// A search result for a named target account. Emails/last names are obfuscated
// by Apollo until revealed (via enrichPerson by id on add).
export interface AccountPerson {
  apolloId: string;
  firstName: string;
  title: string;
  company: string;
  account: string;
  accountDomain: string;
  roleSearched: string;
  hasEmail: boolean;
  hasPhone: boolean;
  hasLocation: boolean;
}

export interface FindAccountPeopleResult {
  found: boolean;
  error?: string;
  accessDenied?: boolean;
  people: AccountPerson[];
  /** Pasted lines we couldn't resolve to a domain. */
  unresolved: string[];
  companiesSearched: number;
}

// "jpmorganchase.com" style — a bare domain, no spaces.
function looksLikeDomain(s: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s.trim()) && !/\s/.test(s.trim());
}

// Parse a pasted line into { name, domain }. Accepts "Name", "domain.com",
// "Name | domain.com", or "Name, domain.com".
function parseLine(line: string): { name: string; domain?: string } {
  const raw = line.trim();
  const sep = raw.match(/^(.*?)[|,]\s*([^\s|,]+)\s*$/);
  if (sep && looksLikeDomain(sep[2])) {
    return { name: sep[1].trim() || sep[2].trim(), domain: sep[2].trim().toLowerCase() };
  }
  if (looksLikeDomain(raw)) return { name: raw, domain: raw.toLowerCase() };
  return { name: raw };
}

function logRow(p: AccountPerson, purpose: string, status: string, revealed?: { email?: string; phone?: string; name?: string; location?: string; linkedinUrl?: string }): string[] {
  return [
    today(),
    purpose,
    p.account,
    p.accountDomain,
    p.roleSearched,
    revealed?.name || p.firstName,
    p.title,
    revealed?.email || "",
    revealed?.phone || "",
    revealed?.location || "",
    revealed?.linkedinUrl || "",
    status,
  ];
}

// Find decision-makers at a pasted list of named accounts, filtered by title.
// Resolves company names → domains via Sumble; searches each via Apollo.
export const findAccountPeople = createServerFn({ method: "POST" })
  .inputValidator((data: {
    companies: string[];
    titles: string[];
    purpose: string;
    perCompany?: number;
  }) => data)
  .handler(async ({ data }): Promise<FindAccountPeopleResult> => {
    const lines = (data.companies || []).map((c) => c.trim()).filter(Boolean);
    const titles = (data.titles || []).map((t) => t.trim()).filter(Boolean);
    if (lines.length === 0) return { found: false, error: "Add at least one company.", people: [], unresolved: [], companiesSearched: 0 };
    if (titles.length === 0) return { found: false, error: "Add at least one role / title.", people: [], unresolved: [], companiesSearched: 0 };

    const perCompany = Math.min(25, Math.max(1, data.perCompany ?? 5));
    const roleLabel = titles.join(", ");
    const people: AccountPerson[] = [];
    const unresolved: string[] = [];
    const foundRows: string[][] = [];
    let companiesSearched = 0;

    for (const line of lines) {
      const { name, domain: pastedDomain } = parseLine(line);
      let domain = pastedDomain;

      // Resolve name → domain via Sumble when not pasted directly.
      if (!domain) {
        if (!isSumbleConfigured()) {
          unresolved.push(`${name} (paste a domain — Sumble not configured to resolve names)`);
          continue;
        }
        try {
          const m = await matchOrganization(name);
          if (m.org?.domain) domain = m.org.domain.toLowerCase();
        } catch (e) {
          console.error("[accounts] match failed for", name, e);
        }
        if (!domain) {
          unresolved.push(name);
          continue;
        }
      }

      try {
        const res = await searchPeople({ titles, organizationDomains: [domain], perPage: perCompany });
        if (res.accessDenied) {
          return { found: false, accessDenied: true, error: res.error || "Apollo people-search isn't accessible with this API key/plan.", people, unresolved, companiesSearched };
        }
        companiesSearched++;
        for (const r of res.people) {
          const person: AccountPerson = {
            apolloId: r.id,
            firstName: r.firstName,
            title: r.title,
            company: r.company || name,
            account: name,
            accountDomain: domain,
            roleSearched: roleLabel,
            hasEmail: r.hasEmail,
            hasPhone: r.hasPhone,
            hasLocation: r.hasLocation,
          };
          people.push(person);
          foundRows.push(logRow(person, data.purpose, "Found"));
        }
      } catch (e) {
        console.error("[accounts] search failed for", name, domain, e);
        const msg = e instanceof Error ? e.message : "";
        if (/APOLLO_API_KEY/.test(msg)) {
          return { found: false, error: "APOLLO_API_KEY is not configured.", people, unresolved, companiesSearched };
        }
        unresolved.push(`${name} (search failed)`);
      }
    }

    // Log everything found (audit trail), best-effort.
    if (foundRows.length > 0) {
      try {
        await ensureTab(TAB_NAMES.targetAccounts, TARGET_ACCOUNT_HEADERS);
        await appendSheetRows(TAB_NAMES.targetAccounts, foundRows);
      } catch (e) {
        console.error("[accounts] log-found failed:", e);
      }
    }

    return { found: true, people, unresolved, companiesSearched };
  });

export interface AddAccountPeopleResult {
  success: boolean;
  added: number;
  duplicates: number;
  enriched: number;
  noEmail: number;
  failed: number;
  error?: string;
}

// Reveal selected people via Apollo (by id) and add them as COLD contacts,
// tagged with the purpose (PortDev / Investor·CVC / Both). Dedupes by email.
export const addAccountPeople = createServerFn({ method: "POST" })
  .inputValidator((data: { people: AccountPerson[]; purpose: string }) => data)
  .handler(async ({ data }): Promise<AddAccountPeopleResult> => {
    const result: AddAccountPeopleResult = { success: true, added: 0, duplicates: 0, enriched: 0, noEmail: 0, failed: 0 };
    if (!data.people?.length) return result;

    // Dedupe keys for an identity: email(s), LinkedIn URL, and name|company.
    // Lets us dedupe people we add without an email (no email = no email key).
    const dedupeKeys = (name: string, company: string, email: string, linkedinUrl: string): string[] => {
      const keys: string[] = [];
      for (const e of (email || "").split(";")) {
        const k = e.trim().toLowerCase();
        if (k) keys.push(k);
      }
      const li = (linkedinUrl || "").trim().toLowerCase().replace(/\/+$/, "");
      if (li) keys.push(`li:${li}`);
      const nc = `${(name || "").trim()}|${(company || "").trim()}`.toLowerCase();
      if (nc.length > 1) keys.push(`nc:${nc}`);
      return keys;
    };

    // Existing contacts for dedupe (by any identity key).
    const existing = new Set<string>();
    try {
      const contacts = await buildContacts();
      for (const c of contacts) {
        for (const k of dedupeKeys(c.name, c.company, c.email, c.linkedinUrl || "")) existing.add(k);
      }
    } catch {
      /* proceed without dedupe */
    }

    const addedRows: string[][] = [];
    const seen = new Set<string>();

    for (const p of data.people) {
      let email = "";
      let phone = "";
      let name = p.firstName;
      let title = p.title;
      let location = "";
      let linkedinUrl = "";

      try {
        const r = await enrichPerson({ id: p.apolloId, organizationName: p.company });
        if (r.accessDenied) {
          return { ...result, success: false, error: r.error || "Apollo enrichment isn't accessible with this API key/plan." };
        }
        if (r.found) {
          result.enriched++;
          email = r.email || "";
          // Skip the org switchboard fallback — it stamps the same company
          // number on every person at the account, which is misleading.
          phone = r.phoneSource === "company" ? "" : (r.phone || "");
          name = r.name || name;
          title = r.title || title;
          linkedinUrl = r.linkedinUrl || "";
          location = [r.city, r.state].filter(Boolean).join(", ");
        }
      } catch (e) {
        console.error("[accounts] enrich failed for", p.firstName, e);
        const msg = e instanceof Error ? e.message : "";
        if (/APOLLO_API_KEY/.test(msg)) {
          return { ...result, success: false, error: "APOLLO_API_KEY is not configured." };
        }
      }

      // Add even without an email — dedupe by LinkedIn or name+company instead.
      const keys = dedupeKeys(name, p.company, email, linkedinUrl);
      if (keys.length === 0) {
        // Nothing to identify the person by — can't add or dedupe.
        result.failed++;
        continue;
      }
      if (keys.some((k) => existing.has(k) || seen.has(k))) {
        result.duplicates++;
        continue;
      }
      keys.forEach((k) => seen.add(k));
      if (!email) result.noEmail++; // added, just without an email on file

      try {
        await addContactRow({
          name,
          role: title,
          company: p.company,
          email,
          phone,
          location,
          prime: "",
          sector: "",
          temperature: "Cold",
          source: data.purpose,
        });
        result.added++;
        addedRows.push(logRow(p, data.purpose, "Added", { email, phone, name, location, linkedinUrl }));
      } catch (e) {
        console.error("[accounts] add failed for", name, e);
        result.failed++;
      }
    }

    if (addedRows.length > 0) {
      try {
        await ensureTab(TAB_NAMES.targetAccounts, TARGET_ACCOUNT_HEADERS);
        await appendSheetRows(TAB_NAMES.targetAccounts, addedRows);
      } catch (e) {
        console.error("[accounts] log-added failed:", e);
      }
    }

    return result;
  });
