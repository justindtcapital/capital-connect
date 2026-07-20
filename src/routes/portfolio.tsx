import { useState, useEffect, useMemo } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  fetchPortfolioCompanies,
  fetchContacts,
  fetchEmailActivity,
} from "@/utils/sheets.functions";
import { fetchAsanaPortcoData, type AsanaPortcoData } from "@/utils/asana.functions";
import type { PortfolioCompany, Contact, PortfolioDomain, EmailActivityRecord } from "@/lib/types";
import { PortfolioCard } from "@/components/portfolio/PortfolioCard";
import { PortfolioDetail } from "@/components/portfolio/PortfolioDetail";
import { AddPortfolioCompanyDialog } from "@/components/portfolio/AddPortfolioCompanyDialog";
import { ContactDetail } from "@/components/crm/ContactDetail";
import { ContactAvatar } from "@/components/crm/ContactAvatar";
import { Button } from "@/components/ui/button";
import { Building2, Users, Plus } from "lucide-react";
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
  loader: async (): Promise<{
    companies: PortfolioCompany[];
    contacts: Contact[];
    emailActivity: EmailActivityRecord[];
  }> => {
    const [companies, contacts, asana, emailActivity] = await Promise.all([
      fetchPortfolioCompanies(),
      fetchContacts(),
      fetchAsanaPortcoData().catch(
        (): AsanaPortcoData => ({
          fieldsByCompanyName: {},
          namesByCompanyName: {},
          eventsByCompanyName: {},
        }),
      ),
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
function buildCompanyFromAsana(
  key: string,
  asana: AsanaPortcoData,
  index: number,
): PortfolioCompany {
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
  company: PortfolioCompany,
): PortfolioCompanyCounts {
  const people = matched.length + company.employees.length;
  const events =
    matched.reduce(
      (sum, c) => sum + (c.eventsAttended?.length || 0) + (c.eventsInvited?.length || 0),
      0,
    ) + company.events.length;
  const intros = crmIntros.length + company.introductions.length;
  return { people, events, intros };
}

// Find CRM contacts who have logged an intro to this portfolio company (by name match).
function findCrmIntros(allContacts: Contact[], companyName: string): Contact[] {
  const target = companyName.trim().toLowerCase();
  return allContacts.filter((c) =>
    (c.portCoIntros || []).some((p) => p.trim().toLowerCase() === target),
  );
}

function PortfolioPage() {
  const router = useRouter();
  const loaderData = Route.useLoaderData() as {
    companies: PortfolioCompany[];
    contacts: Contact[];
    emailActivity: EmailActivityRecord[];
  };
  const { emailActivity } = loaderData;
  // Local companies so PortCo Asana/Web sync can patch the open company + cards
  // without waiting on a full loader invalidate.
  const [companies, setCompanies] = useState<PortfolioCompany[]>(loaderData.companies);
  // Keep a local contacts copy so notes/events/intros logged via the person popup stay reflected in the UI.
  const [contacts, setContacts] = useState<Contact[]>(loaderData.contacts);
  const [selectedCompany, setSelectedCompany] = useState<PortfolioCompany | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [activeContact, setActiveContact] = useState<Contact | null>(null);
  const [contactDetailOpen, setContactDetailOpen] = useState(false);
  // When on, group companies by sector and reveal the PortCo contacts (people whose
  // email domain matches a company in that sector) under each sector.
  const [showContactsBySector, setShowContactsBySector] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const { filters } = usePortfolioFilters();
  const { updateOptions } = useFilterOptions();

  useEffect(() => {
    setCompanies(loaderData.companies);
    setContacts(loaderData.contacts);
    // Keep an open person panel's Interaction Trail current after sync/invalidate.
    setActiveContact((prev) => {
      if (!prev) return prev;
      const match = loaderData.contacts.find(
        (c) =>
          c.id === prev.id ||
          (!!c.urid && !!prev.urid && c.urid === prev.urid) ||
          (!!c.email &&
            !!prev.email &&
            c.email.split(";")[0]?.trim().toLowerCase() ===
              prev.email.split(";")[0]?.trim().toLowerCase()),
      );
      return match || prev;
    });
  }, [loaderData.companies, loaderData.contacts]);

  useEffect(() => {
    const domains = [...new Set(companies.map((c) => c.domain).filter(Boolean))].sort();
    const names = [...new Set(companies.map((c) => c.name).filter(Boolean))].sort();
    const cities = [...new Set(companies.map((c) => c.location).filter(Boolean))].sort();
    const priorities = [
      ...new Set(
        companies
          .map((c) => c.asanaFields?.["DTC Priority"] || c.asanaFields?.["DTC Priority "])
          .filter((v): v is string => !!v),
      ),
    ].sort();
    updateOptions({
      portfolioDomains: domains,
      portfolioCompanies: names,
      portfolioCities: cities,
      portfolioDtcPriorities: priorities,
    });
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
    [selectedCompany, contactsByDomain],
  );

  const selectedCompanyCrmIntros = useMemo(
    () => (selectedCompany ? findCrmIntros(contacts, selectedCompany.name) : []),
    [selectedCompany, contacts],
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

  // Filtered companies grouped by sector, each with the deduped set of PortCo
  // contacts (people whose email domain matches a company in that sector).
  const sectorGroups = useMemo(() => {
    const map = new Map<string, PortfolioCompany[]>();
    for (const c of filtered) {
      const s = (c.sector || "").trim() || "Uncategorized";
      const arr = map.get(s) || [];
      arr.push(c);
      map.set(s, arr);
    }
    return [...map.entries()]
      .map(([sector, comps]) => {
        const seen = new Set<string>();
        const people: Contact[] = [];
        for (const co of comps) {
          const d = extractDomain(co.website);
          for (const person of d ? contactsByDomain.get(d) || [] : []) {
            if (!seen.has(person.id)) {
              seen.add(person.id);
              people.push(person);
            }
          }
        }
        return { sector, companies: comps, people };
      })
      .sort((a, b) => a.sector.localeCompare(b.sector));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, contactsByDomain]);

  const handleCardClick = (company: PortfolioCompany) => {
    setSelectedCompany(company);
    setDetailOpen(true);
  };

  const handleCompanyUpdate = (updated: PortfolioCompany) => {
    setSelectedCompany(updated);
    setCompanies((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    void router.invalidate();
  };

  const handlePersonClick = (contact: Contact) => {
    setActiveContact(contact);
    setContactDetailOpen(true);
  };

  const handleContactUpdate = (updated: Contact) => {
    setContacts((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    setActiveContact(updated);
  };

  // After a company is deleted from the detail panel: drop it from the local grid,
  // close the panel, and invalidate the loader so the sheet re-read is authoritative.
  const handleCompanyDeleted = (deleted: PortfolioCompany) => {
    setCompanies((prev) => prev.filter((c) => c.id !== deleted.id));
    setDetailOpen(false);
    setSelectedCompany(null);
    void router.invalidate();
  };

  // Re-pull contacts after a person is added via the PortCo panel so they surface
  // in Key People (matched by the company's email domain) without a full reload.
  const refreshContacts = async () => {
    try {
      setContacts((await fetchContacts()) as Contact[]);
    } catch (e) {
      console.error("refresh contacts failed", e);
    }
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
        <div className="flex items-center gap-2">
          <Button
            variant={showContactsBySector ? "default" : "outline"}
            size="sm"
            className="h-8 text-xs"
            onClick={() => setShowContactsBySector((v) => !v)}
          >
            <Users className="h-3.5 w-3.5 mr-1.5" />
            {showContactsBySector ? "Hide PortCo contacts" : "Show PortCo contacts"}
          </Button>
          <Button size="sm" className="h-8 text-xs" onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add company
          </Button>
        </div>
      </div>

      {showContactsBySector ? (
        <div className="space-y-8">
          {sectorGroups.map(({ sector, companies: comps, people }) => (
            <section key={sector}>
              <div className="flex items-center gap-2 mb-3">
                <h2 className="text-sm font-semibold text-foreground">{sector}</h2>
                <span className="text-[11px] text-muted-foreground">
                  {comps.length} compan{comps.length !== 1 ? "ies" : "y"} · {people.length} contact
                  {people.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {comps.map((company) => (
                  <PortfolioCard
                    key={company.id}
                    company={company}
                    counts={computeCounts(
                      matchedFor(company),
                      findCrmIntros(contacts, company.name),
                      company,
                    )}
                    onClick={() => handleCardClick(company)}
                  />
                ))}
              </div>
              {people.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {people.map((person) => (
                    <button
                      key={person.id}
                      type="button"
                      onClick={() => handlePersonClick(person)}
                      className="flex items-center gap-1.5 rounded-full border border-border bg-card pl-1 pr-2.5 py-0.5 text-xs hover:bg-accent/50 transition-colors"
                      title={`${person.title || ""}${person.company ? ` · ${person.company}` : ""}`}
                    >
                      <ContactAvatar contact={person} size="sm" />
                      <span className="font-medium text-foreground">{person.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((company) => (
            <PortfolioCard
              key={company.id}
              company={company}
              counts={computeCounts(
                matchedFor(company),
                findCrmIntros(contacts, company.name),
                company,
              )}
              onClick={() => handleCardClick(company)}
            />
          ))}
        </div>
      )}

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
        emails={
          selectedCompany
            ? emailActivity.filter((e) =>
                (e.linkedPortco || "")
                  .split(/[;,]/)
                  .map((s) => s.trim().toLowerCase())
                  .includes(selectedCompany.name.trim().toLowerCase()),
              )
            : []
        }
        onPersonClick={handlePersonClick}
        onPersonAdded={refreshContacts}
        onCompanyUpdate={handleCompanyUpdate}
        onCompanyDeleted={handleCompanyDeleted}
      />

      <AddPortfolioCompanyDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={() => router.invalidate()}
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
