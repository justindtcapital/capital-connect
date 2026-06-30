import { useState, useEffect, useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { fetchPortfolioCompanies, fetchContacts, fetchEmailActivity } from "@/utils/sheets.functions";
import { fetchAsanaPortcoData, type AsanaPortcoData } from "@/utils/asana.functions";
import type { PortfolioCompany, Contact, PortfolioDomain, EmailActivityRecord } from "@/lib/types";
import { PortfolioCard } from "@/components/portfolio/PortfolioCard";
import { PortfolioDetail } from "@/components/portfolio/PortfolioDetail";
import { ContactDetail } from "@/components/crm/ContactDetail";
import { Building2 } from "lucide-react";
import { usePortfolioFilters } from "@/lib/portfolio-filter-context";
import { useFilterOptions } from "@/lib/filter-options-context";
import { extractDomain } from "@/lib/domain-utils";

export const Route = createFileRoute("/portfolio")({
  head: () => ({
    meta: [
      { title: "Portfolio Companies — VenturePulse" },
      { name: "description", content: "Track and manage portfolio company activity" },
    ],
  }),
  loader: async (): Promise<{ companies: PortfolioCompany[]; contacts: Contact[]; emailActivity: EmailActivityRecord[] }> => {
    const [companies, contacts, asana, emailActivity] = await Promise.all([
      fetchPortfolioCompanies(),
      fetchContacts(),
      fetchAsanaPortcoData().catch((): AsanaPortcoData => ({ fieldsByCompanyName: {}, namesByCompanyName: {}, eventsByCompanyName: {} })),
      fetchEmailActivity().catch((): EmailActivityRecord[] => []),
    ]);

    const sheetCompanies = companies as PortfolioCompany[];
    // Sheet companies, enriched with matching Asana fields + events (by name).
    const merged = sheetCompanies.map((c) => {
      const key = c.name.trim().toLowerCase();
      const asanaFields = asana.fieldsByCompanyName[key];
      const asanaEvents = asana.eventsByCompanyName[key] || [];
      return {
        ...c,
        asanaFields: asanaFields && Object.keys(asanaFields).length > 0 ? asanaFields : undefined,
        events: [...c.events, ...asanaEvents],
      };
    });

    // Companies that exist in the Asana portco project but have no Sheet row —
    // surface them so the Asana project itself populates the tab.
    const sheetKeys = new Set(sheetCompanies.map((c) => c.name.trim().toLowerCase()));
    const asanaOnly = Object.keys(asana.fieldsByCompanyName)
      .filter((key) => !sheetKeys.has(key))
      .map((key, i) => buildCompanyFromAsana(key, asana, i));

    return { companies: [...merged, ...asanaOnly], contacts: contacts as Contact[], emailActivity };
  },
  component: PortfolioPage,
});

// Map a free-text sector/industry string to the closest PortfolioDomain.
// Order matters — more specific keywords are checked first.
function deriveDomainFromSector(sector: string): PortfolioDomain {
  const s = sector.toLowerCase();
  if (!s) return "Cloud";
  const map: [string, PortfolioDomain][] = [
    ["supply chain", "Supply Chain"],
    ["security", "Security"],
    ["cyber", "Security"],
    ["artificial intelligence", "AI"],
    ["machine learning", "AI"],
    ["ai", "AI"],
    ["analytics", "Data"],
    ["data", "Data"],
    ["logistics", "Logistics"],
    ["silicon", "Silicon"],
    ["semiconductor", "Silicon"],
    ["chip", "Silicon"],
    ["hardware", "Silicon"],
    ["cloud", "Cloud"],
    ["infrastructure", "Cloud"],
    ["devops", "Cloud"],
    ["developer", "Cloud"],
    ["saas", "Cloud"],
    ["platform", "Cloud"],
  ];
  for (const [kw, domain] of map) if (s.includes(kw)) return domain;
  return "Cloud";
}

// Build a PortfolioCompany from an Asana-only portco (present in the Asana portco
// project but with no matching Google Sheet row). Pulls what it can from the
// task's custom fields; leaves unknowns blank.
function buildCompanyFromAsana(key: string, asana: AsanaPortcoData, index: number): PortfolioCompany {
  const fields = asana.fieldsByCompanyName[key] || {};
  const name = asana.namesByCompanyName[key] || key;
  // Match a field by a pattern against its *name* (Asana labels vary), returning
  // the first non-empty value. More forgiving than exact-name lookups.
  const fieldByPattern = (pattern: RegExp): string => {
    for (const [k, v] of Object.entries(fields)) {
      if (v && pattern.test(k)) return v;
    }
    return "";
  };
  const sector = fieldByPattern(/industry|sector|vertical|theme|focus\s*area|category/i);
  return {
    id: `asana-pc-${index}`,
    name,
    sector,
    domain: deriveDomainFromSector(sector),
    website: fieldByPattern(/website|^url$|web\s*site/i),
    linkedinUrl: fieldByPattern(/linkedin/i),
    location: fieldByPattern(/^hq$|headquarter|location|city|geograph/i),
    description: fieldByPattern(/summary|description|about|overview/i),
    contactName: "",
    contactEmail: "",
    contactPhone: "",
    employees: [],
    events: asana.eventsByCompanyName[key] || [],
    introductions: [],
    asanaFields: Object.keys(fields).length > 0 ? fields : undefined,
  };
}

export interface PortfolioCompanyCounts {
  people: number;
  events: number;
  intros: number;
}

function computeCounts(
  matched: Contact[],
  crmIntros: Contact[],
  company: PortfolioCompany
): PortfolioCompanyCounts {
  const people = matched.length + company.employees.length;
  const events =
    matched.reduce(
      (sum, c) => sum + (c.eventsAttended?.length || 0) + (c.eventsInvited?.length || 0),
      0
    ) + company.events.length;
  const intros = crmIntros.length + company.introductions.length;
  return { people, events, intros };
}

// Find CRM contacts who have logged an intro to this portfolio company (by name match).
function findCrmIntros(allContacts: Contact[], companyName: string): Contact[] {
  const target = companyName.trim().toLowerCase();
  return allContacts.filter((c) =>
    (c.portCoIntros || []).some((p) => p.trim().toLowerCase() === target)
  );
}

function PortfolioPage() {
  const loaderData = Route.useLoaderData() as { companies: PortfolioCompany[]; contacts: Contact[]; emailActivity: EmailActivityRecord[] };
  const { companies, emailActivity } = loaderData;
  // Keep a local contacts copy so notes/events/intros logged via the person popup stay reflected in the UI.
  const [contacts, setContacts] = useState<Contact[]>(loaderData.contacts);
  const [selectedCompany, setSelectedCompany] = useState<PortfolioCompany | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [activeContact, setActiveContact] = useState<Contact | null>(null);
  const [contactDetailOpen, setContactDetailOpen] = useState(false);
  const { filters } = usePortfolioFilters();
  const { updateOptions } = useFilterOptions();

  useEffect(() => {
    const domains = [...new Set(companies.map((c) => c.domain).filter(Boolean))].sort();
    const names = [...new Set(companies.map((c) => c.name).filter(Boolean))].sort();
    const cities = [...new Set(companies.map((c) => c.location).filter(Boolean))].sort();
    const priorities = [
      ...new Set(
        companies
          .map((c) => c.asanaFields?.["DTC Priority"] || c.asanaFields?.["DTC Priority "])
          .filter((v): v is string => !!v)
      ),
    ].sort();
    updateOptions({ portfolioDomains: domains, portfolioCompanies: names, portfolioCities: cities, portfolioDtcPriorities: priorities });
  }, [companies, updateOptions]);

  // Index contacts by their email domain so we can match them to portfolio companies by website.
  const contactsByDomain = useMemo(() => {
    const map = new Map<string, Contact[]>();
    for (const c of contacts) {
      const d = extractDomain(c.email);
      if (!d) continue;
      const list = map.get(d) || [];
      list.push(c);
      map.set(d, list);
    }
    return map;
  }, [contacts]);

  const matchedFor = (company: PortfolioCompany): Contact[] => {
    const d = extractDomain(company.website);
    if (!d) return [];
    return contactsByDomain.get(d) || [];
  };

  const selectedCompanyContacts = useMemo(
    () => (selectedCompany ? matchedFor(selectedCompany) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedCompany, contactsByDomain]
  );

  const selectedCompanyCrmIntros = useMemo(
    () => (selectedCompany ? findCrmIntros(contacts, selectedCompany.name) : []),
    [selectedCompany, contacts]
  );

  const filtered = companies.filter((c) => {
    if (
      filters.search &&
      !c.name.toLowerCase().includes(filters.search.toLowerCase()) &&
      !c.description.toLowerCase().includes(filters.search.toLowerCase())
    )
      return false;
    if (filters.sector !== "all" && c.sector !== filters.sector) return false;
    if (filters.domain !== "all" && c.domain !== filters.domain) return false;
    if (filters.city !== "all" && c.location !== filters.city) return false;
    if (filters.dtcPriority !== "all") {
      const p = c.asanaFields?.["DTC Priority"] || c.asanaFields?.["DTC Priority "];
      if (p !== filters.dtcPriority) return false;
    }
    return true;
  });

  const handleCardClick = (company: PortfolioCompany) => {
    setSelectedCompany(company);
    setDetailOpen(true);
  };

  const handlePersonClick = (contact: Contact) => {
    setActiveContact(contact);
    setContactDetailOpen(true);
  };

  const handleContactUpdate = (updated: Contact) => {
    setContacts((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    setActiveContact(updated);
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-bold text-foreground">Portfolio Companies</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Track activity and introductions across your portfolio
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((company) => (
          <PortfolioCard
            key={company.id}
            company={company}
            counts={computeCounts(matchedFor(company), findCrmIntros(contacts, company.name), company)}
            onClick={() => handleCardClick(company)}
          />
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12">
          <Building2 className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">No portfolio companies match your filters</p>
        </div>
      )}

      <PortfolioDetail
        company={selectedCompany}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        crmContacts={selectedCompanyContacts}
        crmIntros={selectedCompanyCrmIntros}
        emails={selectedCompany
          ? emailActivity.filter((e) =>
              (e.linkedPortco || "")
                .split(/[;,]/)
                .map((s) => s.trim().toLowerCase())
                .includes(selectedCompany.name.trim().toLowerCase())
            )
          : []}
        onPersonClick={handlePersonClick}
      />

      <ContactDetail
        contact={activeContact}
        open={contactDetailOpen}
        onOpenChange={setContactDetailOpen}
        onContactUpdate={handleContactUpdate}
      />
    </div>
  );
}
