import { useState, useEffect, useMemo, useCallback } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  fetchPortfolioCompanies,
  fetchContacts,
  fetchEmailActivity,
  bulkDeletePortfolioCompanies,
} from "@/utils/sheets.functions";
import { fetchAsanaPortcoData, type AsanaPortcoData } from "@/utils/asana.functions";
import { syncPortcoFromAsana, syncPortcoFromWeb } from "@/utils/portco-sync.functions";
import type { PortfolioCompany, Contact, PortfolioDomain, EmailActivityRecord } from "@/lib/types";
import { matchSheetToAsanaKeys } from "@/lib/portco-names";
import { PortfolioCard } from "@/components/portfolio/PortfolioCard";
import { PortfolioDetail } from "@/components/portfolio/PortfolioDetail";
import { AddPortfolioCompanyDialog } from "@/components/portfolio/AddPortfolioCompanyDialog";
import { ContactDetail } from "@/components/crm/ContactDetail";
import { ContactAvatar } from "@/components/crm/ContactAvatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Building2, Users, Plus, Trash2, RefreshCw, Globe, Loader2, X } from "lucide-react";
import { usePortfolioFilters } from "@/lib/portfolio-filter-context";
import { useFilterOptions } from "@/lib/filter-options-context";
import { extractDomain } from "@/lib/domain-utils";
import { canonicalLocations, locationMatches } from "@/lib/location-utils";
import { canonicalFocusAreas, focusAreaMatches } from "@/lib/focus-area-utils";
import { toast } from "sonner";

export const Route = createFileRoute("/portfolio")({
  head: () => ({
    meta: [
      { title: "Portfolio Companies — VenturePulse" },
      {
        name: "description",
        content:
          "Track portfolio company activity, KPIs, customer discovery and relationship coverage across the Dell Technologies Capital portfolio.",
      },
      { property: "og:title", content: "Portfolio Companies — VenturePulse" },
      {
        property: "og:description",
        content:
          "Track portfolio company activity, KPIs, customer discovery and relationship coverage across the Dell Technologies Capital portfolio.",
      },
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
    const asanaKeys = Object.keys(asana.fieldsByCompanyName);
    // Fuzzy Sheet↔Asana name map so "VAST" merges into "VAST Data", etc.
    const sheetToAsana = matchSheetToAsanaKeys(
      sheetCompanies.map((c) => c.name),
      asanaKeys,
      (key) => asana.namesByCompanyName[key] || key,
    );
    const claimedAsana = new Set(sheetToAsana.values());

    // Sheet companies, enriched with matching Asana fields + events (by name).
    const merged = sheetCompanies.map((c) => {
      const asanaKey = sheetToAsana.get(c.name);
      const asanaFields = asanaKey ? asana.fieldsByCompanyName[asanaKey] : undefined;
      const asanaEvents = asanaKey ? asana.eventsByCompanyName[asanaKey] || [] : [];
      return {
        ...c,
        asanaFields: asanaFields && Object.keys(asanaFields).length > 0 ? asanaFields : undefined,
        events: [...c.events, ...asanaEvents],
      };
    });

    // Companies that exist in the Asana portco project but still have no Sheet
    // row after fuzzy matching — surface them so the Asana project populates the tab.
    const asanaOnly = asanaKeys
      .filter((key) => !claimedAsana.has(key))
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

/** Case-insensitive Asana custom-field lookup (first non-empty alias wins). */
function asanaFieldOf(company: PortfolioCompany, aliases: string[]): string {
  const fields = company.asanaFields;
  if (!fields) return "";
  const lowered = Object.keys(fields).reduce<Record<string, string>>((acc, k) => {
    acc[k.toLowerCase().trim()] = fields[k];
    return acc;
  }, {});
  for (const a of aliases) {
    const v = (lowered[a.toLowerCase().trim()] || "").trim();
    if (v) return v;
  }
  return "";
}

function dtcPriorityOf(company: PortfolioCompany): string {
  return asanaFieldOf(company, ["DTC Priority"]);
}

function companyStageOf(company: PortfolioCompany): string {
  return asanaFieldOf(company, ["Company Stage", "Stage"]);
}

function leadInvestorOf(company: PortfolioCompany): string {
  return asanaFieldOf(company, ["Lead Investor"]);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort((a, b) => a.localeCompare(b));
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [asanaSyncing, setAsanaSyncing] = useState(false);
  const [webSyncing, setWebSyncing] = useState(false);
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
    const domains = uniqueSorted(companies.map((c) => c.domain));
    const names = uniqueSorted(companies.map((c) => c.name));
    const cities = canonicalLocations(companies.map((c) => c.location));
    const sectors = canonicalFocusAreas(companies.map((c) => c.sector));
    const priorities = uniqueSorted(companies.map(dtcPriorityOf));
    const stages = uniqueSorted(companies.map(companyStageOf));
    const leadInvestors = uniqueSorted(companies.map(leadInvestorOf));
    updateOptions({
      portfolioDomains: domains,
      portfolioCompanies: names,
      portfolioCities: cities,
      portfolioSectors: sectors,
      portfolioDtcPriorities: priorities,
      portfolioCompanyStages: stages,
      portfolioLeadInvestors: leadInvestors,
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

  const filtered = useMemo(
    () =>
      companies.filter((c) => {
        if (
          filters.search &&
          !c.name.toLowerCase().includes(filters.search.toLowerCase()) &&
          !c.description.toLowerCase().includes(filters.search.toLowerCase())
        )
          return false;
        if (filters.sector.length && !focusAreaMatches(c.sector, filters.sector)) return false;
        if (filters.domain.length && !filters.domain.includes(c.domain)) return false;
        if (filters.city.length && !locationMatches(c.location, filters.city)) return false;
        if (filters.dtcPriority.length) {
          const p = dtcPriorityOf(c);
          if (!p || !filters.dtcPriority.includes(p)) return false;
        }
        if (filters.companyStage.length) {
          const stage = companyStageOf(c);
          if (!stage || !filters.companyStage.includes(stage)) return false;
        }
        if (filters.leadInvestor.length) {
          const inv = leadInvestorOf(c);
          if (!inv || !filters.leadInvestor.includes(inv)) return false;
        }
        return true;
      }),
    [companies, filters],
  );

  // Drop selections that are no longer in the filtered set (e.g. after filter/delete).
  useEffect(() => {
    const visible = new Set(filtered.map((c) => c.id));
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visible.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [filtered]);

  const selectedCompanies = useMemo(
    () => filtered.filter((c) => selectedIds.has(c.id)),
    [filtered, selectedIds],
  );
  // Asana-only cards (no Sheet row) can't be deleted from the sheet.
  const sheetSelected = useMemo(
    () => selectedCompanies.filter((c) => !c.id.startsWith("asana-pc-")),
    [selectedCompanies],
  );
  const allSelected = filtered.length > 0 && filtered.every((c) => selectedIds.has(c.id));
  const someSelected = selectedIds.size > 0 && !allSelected;
  const busy = deleting || asanaSyncing || webSyncing;

  const toggleId = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (filtered.length > 0 && filtered.every((c) => prev.has(c.id))) return new Set();
      return new Set(filtered.map((c) => c.id));
    });
  }, [filtered]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const patchCompanyLocal = useCallback((updated: PortfolioCompany) => {
    setCompanies((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    setSelectedCompany((prev) => (prev?.id === updated.id ? updated : prev));
  }, []);

  const deleteSelected = async () => {
    if (sheetSelected.length === 0) {
      toast.error("Selected companies are Asana-only — nothing to delete from the sheet.");
      setConfirmDeleteOpen(false);
      return;
    }
    setDeleting(true);
    try {
      const entries = sheetSelected.map((c) => ({ urid: c.urid, name: c.name }));
      const res = await bulkDeletePortfolioCompanies({ data: { entries } });
      const goneIds = new Set(sheetSelected.map((c) => c.id));
      setCompanies((prev) => prev.filter((c) => !goneIds.has(c.id)));
      if (selectedCompany && goneIds.has(selectedCompany.id)) {
        setDetailOpen(false);
        setSelectedCompany(null);
      }
      clearSelection();
      toast.success(`Deleted ${res.deleted} compan${res.deleted !== 1 ? "ies" : "y"}.`);
      void router.invalidate();
    } catch (e) {
      console.error("bulkDeletePortfolioCompanies failed", e);
      toast.error("Delete failed — see console.");
    } finally {
      setDeleting(false);
      setConfirmDeleteOpen(false);
    }
  };

  const bulkAsanaSync = async () => {
    const chosen = selectedCompanies;
    if (chosen.length === 0) return;
    setAsanaSyncing(true);
    let ok = 0;
    let failed = 0;
    try {
      for (const company of chosen) {
        try {
          const res = await syncPortcoFromAsana({ data: { companyName: company.name } });
          if (!res.ok) {
            failed += 1;
            continue;
          }
          ok += 1;
          const profileWebsite =
            Object.entries(res.asanaFields).find(([k]) => /website|^url$|web\s*site/i.test(k))?.[1] ||
            "";
          const profileLinkedin =
            Object.entries(res.asanaFields).find(([k]) => /linkedin/i.test(k))?.[1] || "";
          const profileLocation =
            Object.entries(res.asanaFields).find(([k]) =>
              /^hq$|headquarter|location|city|geograph/i.test(k),
            )?.[1] || "";
          const profileDescription =
            Object.entries(res.asanaFields).find(([k]) =>
              /summary|description|about|overview/i.test(k),
            )?.[1] || "";
          patchCompanyLocal({
            ...company,
            asanaFields:
              Object.keys(res.asanaFields).length > 0 ? res.asanaFields : company.asanaFields,
            events: res.events,
            website: company.website || profileWebsite || company.website,
            linkedinUrl: company.linkedinUrl || profileLinkedin || company.linkedinUrl,
            location: company.location || profileLocation || company.location,
            description: company.description || profileDescription || company.description,
          });
        } catch {
          failed += 1;
        }
      }
      const parts = [`${ok} synced`];
      if (failed) parts.push(`${failed} failed`);
      (failed ? toast.warning : toast.success)(`Asana sync · ${parts.join(" · ")}`);
      if (ok > 0) void router.invalidate();
    } finally {
      setAsanaSyncing(false);
    }
  };

  const bulkWebSync = async () => {
    const chosen = selectedCompanies;
    if (chosen.length === 0) return;
    setWebSyncing(true);
    let ok = 0;
    let failed = 0;
    try {
      for (const company of chosen) {
        try {
          const res = await syncPortcoFromWeb({
            data: {
              companyName: company.name,
              website: company.website || undefined,
              location: company.location || undefined,
            },
          });
          if (!res.ok) {
            failed += 1;
            continue;
          }
          ok += 1;
          patchCompanyLocal({
            ...company,
            website: company.website || res.website || company.website,
            linkedinUrl: company.linkedinUrl || res.linkedinUrl || company.linkedinUrl,
            location: company.location || res.location || company.location,
            description: company.description || res.description || company.description,
          });
        } catch {
          failed += 1;
        }
      }
      const parts = [`${ok} synced`];
      if (failed) parts.push(`${failed} failed`);
      (failed ? toast.warning : toast.success)(`Web sync · ${parts.join(" · ")}`);
      if (ok > 0) void router.invalidate();
    } finally {
      setWebSyncing(false);
    }
  };

  const actionBtnClass = "h-8 text-xs";

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

      {/* Count + multi-select bulk actions */}
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Checkbox
            checked={allSelected ? true : someSelected ? "indeterminate" : false}
            onCheckedChange={toggleAll}
            disabled={filtered.length === 0 || busy}
            aria-label="Select all portfolio companies"
          />
          <p className="text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">{filtered.length}</span> compan
            {filtered.length !== 1 ? "ies" : "y"}
            {selectedIds.size > 0 && (
              <>
                {" · "}
                <span className="font-semibold text-foreground">{selectedIds.size}</span> selected
              </>
            )}
          </p>
        </div>
        {selectedIds.size > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className={actionBtnClass}
              onClick={() => void bulkAsanaSync()}
              disabled={busy}
            >
              {asanaSyncing ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-1" />
              )}
              {asanaSyncing ? "Syncing Asana…" : "Asana Sync"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className={actionBtnClass}
              onClick={() => void bulkWebSync()}
              disabled={busy}
            >
              {webSyncing ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Globe className="h-3 w-3 mr-1" />
              )}
              {webSyncing ? "Syncing Web…" : "Web Sync"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className={`${actionBtnClass} text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive`}
              onClick={() => setConfirmDeleteOpen(true)}
              disabled={busy || sheetSelected.length === 0}
              title={
                sheetSelected.length === 0
                  ? "Asana-only companies can't be deleted from the sheet"
                  : undefined
              }
            >
              <Trash2 className="h-3 w-3 mr-1" />
              Delete
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={actionBtnClass}
              onClick={clearSelection}
              disabled={busy}
            >
              <X className="h-3 w-3 mr-1" />
              Clear
            </Button>
          </div>
        )}
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
                    selected={selectedIds.has(company.id)}
                    onToggleSelect={toggleId}
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
              selected={selectedIds.has(company.id)}
              onToggleSelect={toggleId}
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

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {sheetSelected.length} compan{sheetSelected.length !== 1 ? "ies" : "y"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes{" "}
              {sheetSelected.length === 1 ? "this company" : "these companies"} from the Portfolio
              Companies sheet. Asana-only cards in the selection are skipped. This can&apos;t be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void deleteSelected();
              }}
              disabled={deleting || sheetSelected.length === 0}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Deleting…
                </>
              ) : (
                <>Delete {sheetSelected.length}</>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
