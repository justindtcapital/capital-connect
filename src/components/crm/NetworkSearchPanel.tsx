import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Search,
  Loader2,
  Building2,
  Users,
  Target,
  ExternalLink,
  Globe,
  UserPlus,
  ChevronDown,
  ChevronRight,
  Linkedin,
} from "lucide-react";
import { fetchContacts, fetchTargets } from "@/utils/sheets.functions";
import { searchNetworkOrgs } from "@/utils/sumble.functions";
import { findCompanyDecisionMakers, addProspectsToTargets } from "@/utils/prospects.functions";
import type { Contact, TargetLead } from "@/lib/types";
import type { ProspectCompany, NetworkSearchDimension, SumbleProspect } from "@/utils/sumble.server";
import { companyLogoSources } from "@/lib/domain-utils";
import { seniorityOf, departmentOf, SENIORITY_LEVELS, DEPARTMENTS } from "@/lib/people-classify";
import { SlidersHorizontal, X } from "lucide-react";
import { toast } from "sonner";

/** Tiny company mark with Clearbit-free fallback ladder. */
function CompanyMiniLogo({ domain }: { domain: string }) {
  const [stage, setStage] = useState(0);
  const sources = useMemo(() => companyLogoSources(domain, "high"), [domain]);
  useEffect(() => {
    setStage(0);
  }, [sources.join("|")]);
  if (stage < sources.length) {
    const src = sources[stage];
    return (
      <img
        key={src}
        src={src}
        alt=""
        className="h-5 w-5 rounded border border-border object-contain bg-white shrink-0"
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setStage((s) => s + 1)}
      />
    );
  }
  return (
    <div className="h-5 w-5 rounded border border-border bg-muted flex items-center justify-center shrink-0">
      <Building2 className="h-3 w-3 text-muted-foreground" />
    </div>
  );
}

// Company-size bands (keys MUST match SIZE_BANDS in sumble.server.ts). External
// (Sumble) lane only — internal contacts have no headcount data.
const SIZE_OPTIONS: { key: string; label: string }[] = [
  { key: "under_1k", label: "<1k" },
  { key: "1k_5k", label: "1k–5k" },
  { key: "5k_10k", label: "5k–10k" },
  { key: "10k_50k", label: "10k–50k" },
  { key: "50k_plus", label: "50k+" },
];
const REL_STATUSES = ["Hot", "Warm", "Cold"];

// Search dimensions offered in the Network side panel. "product" and "keywords"
// both route to Sumble's technographic search server-side; they differ here only
// in which internal fields they match (product = capability/title; keywords = broad).
const DIMENSIONS: { key: NetworkSearchDimension; label: string }[] = [
  { key: "technology", label: "Technology" },
  { key: "company", label: "Company" },
  { key: "industry", label: "Industry" },
  { key: "product", label: "Product" },
  { key: "keywords", label: "Keywords" },
];

// Build the internal haystack a contact/target is matched against for a given
// dimension. Company/industry are narrow (one field); the rest are broad.
function contactHaystack(c: Contact, by: NetworkSearchDimension): string {
  if (by === "company") return `${c.company} ${c.portCoIntros.join(" ")}`;
  if (by === "industry") return `${c.sector} ${c.areasOfInterest.join(" ")}`;
  // technology / product / keywords — broad capability/interest match.
  return [
    c.title, c.company, c.sector, c.areasOfInterest.join(" "),
    c.portCoIntros.join(" "), c.interactions.map((i) => i.summary).join(" "),
  ].join(" ");
}

function targetHaystack(t: TargetLead, by: NetworkSearchDimension): string {
  if (by === "company") return t.company;
  if (by === "industry") return t.sector;
  return [t.title, t.company, t.sector, t.reasonSurfaced || "", t.originSource, t.notes].join(" ");
}

// Substring match; for "keywords" any whitespace/comma-separated token may match.
function matches(hay: string, query: string, by: NetworkSearchDimension): boolean {
  const h = hay.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return false;
  if (by === "keywords") {
    const tokens = q.split(/[\s,]+/).filter(Boolean);
    return tokens.some((t) => h.includes(t));
  }
  return h.includes(q);
}

// Per-company decision-maker lookup state in the results dialog.
interface CompanyDM {
  open: boolean;
  loading: boolean;
  people: SumbleProspect[];
  error?: string;
  /** Selected person keys to add to Targets. */
  selected: Set<string>;
  adding: boolean;
  added: number;
}

function FilterLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1">{children}</div>;
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
        active ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function fmtEmployees(n?: number): string {
  if (!n) return "";
  if (n >= 1000) return `${Math.round(n / 1000)}k employees`;
  return `${n} employees`;
}

interface NetworkSearchPanelProps {
  /** Notify the host when results should refresh the page (reserved; unused now). */
  onAddedToTargets?: () => void;
}

export function NetworkSearchPanel(_props: NetworkSearchPanelProps = {}) {
  const [query, setQuery] = useState("");
  const [by, setBy] = useState<NetworkSearchDimension>("technology");
  const [open, setOpen] = useState(false);

  const submit = () => {
    if (!query.trim()) return;
    setOpen(true);
  };

  return (
    <>
      <div className="space-y-2">
        <Select value={by} onValueChange={(v) => setBy(v as NetworkSearchDimension)}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DIMENSIONS.map((d) => (
              <SelectItem key={d.key} value={d.key}>
                Search by {d.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder={`Search ${by}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            className="pl-8 h-8 text-xs"
          />
        </div>
        <Button size="sm" className="w-full h-8 text-xs" onClick={submit} disabled={!query.trim()}>
          <Search className="h-3.5 w-3.5 mr-1.5" />
          Search network
        </Button>
        <p className="text-[10px] leading-tight text-muted-foreground">
          Searches your contacts &amp; targets plus external Sumble company data.
        </p>
      </div>

      <NetworkSearchDialog open={open} onOpenChange={setOpen} initialQuery={query} initialBy={by} />
    </>
  );
}

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialQuery: string;
  initialBy: NetworkSearchDimension;
}

function NetworkSearchDialog({ open, onOpenChange, initialQuery, initialBy }: DialogProps) {
  const [q, setQ] = useState(initialQuery);
  const [by, setBy] = useState<NetworkSearchDimension>(initialBy);

  // Internal data — fetched once, lazily, on first open.
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [targets, setTargets] = useState<TargetLead[]>([]);
  const [internalLoaded, setInternalLoaded] = useState(false);

  // External (Sumble) — fetched per explicit search.
  const [extLoading, setExtLoading] = useState(false);
  const [extCompanies, setExtCompanies] = useState<ProspectCompany[]>([]);
  const [extError, setExtError] = useState<string | null>(null);
  const [extResolved, setExtResolved] = useState<string | undefined>(undefined);
  const [ranQuery, setRanQuery] = useState("");
  const [ranBy, setRanBy] = useState<NetworkSearchDimension>(initialBy);

  // Per-company decision-maker state (keyed by domain).
  const [dm, setDm] = useState<Record<string, CompanyDM>>({});

  // ── Advanced filters ──────────────────────────────────────────
  const [showFilters, setShowFilters] = useState(false);
  // People filters — applied to internal contacts/targets AND external decision-makers.
  const [fSeniority, setFSeniority] = useState<string[]>([]);
  const [fDepartment, setFDepartment] = useState<string[]>([]);
  const [fGeography, setFGeography] = useState("");
  // Company filters — internal (sector) + external (Sumble org).
  const [fIndustry, setFIndustry] = useState("");
  // External-only (no internal data): company size + technologies.
  const [fSizes, setFSizes] = useState<string[]>([]);
  const [fTechnologies, setFTechnologies] = useState("");
  // Internal contacts-only filters.
  const [fRelStatus, setFRelStatus] = useState<string[]>([]);
  const [fOwner, setFOwner] = useState("");

  const activeFilterCount =
    fSeniority.length + fDepartment.length + fSizes.length + fRelStatus.length +
    (fGeography.trim() ? 1 : 0) + (fIndustry.trim() ? 1 : 0) + (fTechnologies.trim() ? 1 : 0) + (fOwner.trim() ? 1 : 0);

  const toggleIn = (arr: string[], set: (v: string[]) => void, val: string) =>
    set(arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val]);

  const clearFilters = () => {
    setFSeniority([]); setFDepartment([]); setFGeography(""); setFIndustry("");
    setFSizes([]); setFTechnologies(""); setFRelStatus([]); setFOwner("");
  };

  const techList = () => fTechnologies.split(",").map((t) => t.trim()).filter(Boolean);
  const countryList = () => fGeography.split(",").map((t) => t.trim()).filter(Boolean);

  // Internal-record predicates for the advanced filters (substring / membership).
  const advContactPass = (c: Contact): boolean => {
    if (fSeniority.length && !fSeniority.includes(seniorityOf(c.title))) return false;
    if (fDepartment.length && !fDepartment.includes(departmentOf(c.title))) return false;
    if (fGeography.trim() && !(c.location || "").toLowerCase().includes(fGeography.trim().toLowerCase())) return false;
    if (fIndustry.trim() && !(c.sector || "").toLowerCase().includes(fIndustry.trim().toLowerCase())) return false;
    if (fRelStatus.length && !fRelStatus.includes(c.temperature)) return false;
    if (fOwner.trim() && !(c.prime || "").toLowerCase().includes(fOwner.trim().toLowerCase())) return false;
    return true;
  };
  const advTargetPass = (t: TargetLead): boolean => {
    // Relationship status + contact owner are contacts-only → targets ignore them.
    if (fSeniority.length && !fSeniority.includes(seniorityOf(t.title))) return false;
    if (fDepartment.length && !fDepartment.includes(departmentOf(t.title))) return false;
    if (fGeography.trim() && !(t.location || "").toLowerCase().includes(fGeography.trim().toLowerCase())) return false;
    if (fIndustry.trim() && !(t.sector || "").toLowerCase().includes(fIndustry.trim().toLowerCase())) return false;
    return true;
  };

  const personKey = (p: SumbleProspect) => `${p.name}__${p.title}`.toLowerCase();

  // Why a target is being surfaced — references the matched technology when we
  // have one, else the search dimension + term (e.g. "Uses Splunk" / "Network
  // Search (industry: fintech)").
  const surfacedReason = (): string =>
    extResolved
      ? `Uses ${extResolved}`
      : `Network Search (${ranBy}: ${ranQuery})`;
  const surfacedSource = (): string =>
    `Network Search — ${extResolved || ranQuery || q.trim()}`;

  // Sync controls to the seed values whenever the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setQ(initialQuery);
      setBy(initialBy);
    }
  }, [open, initialQuery, initialBy]);

  // Lazy-load internal contacts + targets the first time the dialog opens.
  useEffect(() => {
    if (!open || internalLoaded) return;
    let cancelled = false;
    (async () => {
      try {
        const [cs, ts] = await Promise.all([fetchContacts(), fetchTargets()]);
        if (cancelled) return;
        setContacts(cs as Contact[]);
        setTargets(ts as TargetLead[]);
        setInternalLoaded(true);
      } catch (e) {
        console.error("NetworkSearch: failed to load internal data", e);
        if (!cancelled) setInternalLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, internalLoaded]);

  const runExternalSearch = async (term: string, dim: NetworkSearchDimension) => {
    const t = term.trim();
    if (!t) return;
    setExtLoading(true);
    setExtError(null);
    setRanQuery(t);
    setRanBy(dim);
    setDm({}); // clear decision-maker state from the previous search
    try {
      const res = await searchNetworkOrgs({
        data: {
          query: t,
          by: dim,
          limit: 12,
          sizes: fSizes.length ? fSizes : undefined,
          industry: fIndustry.trim() || undefined,
          technologies: techList().length ? techList() : undefined,
        },
      });
      if (!res.found) {
        setExtCompanies([]);
        setExtError(res.error || "No external results.");
        setExtResolved(undefined);
      } else {
        setExtCompanies(res.companies);
        setExtResolved(res.focusResolved);
      }
    } catch (e) {
      console.error("NetworkSearch: external search failed", e);
      setExtCompanies([]);
      setExtError("External search failed — see console.");
    } finally {
      setExtLoading(false);
    }
  };

  // Auto-run the external search when the dialog opens with a seed query.
  useEffect(() => {
    if (open && initialQuery.trim()) {
      void runExternalSearch(initialQuery, initialBy);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const internalContacts = useMemo(
    () => (q.trim() ? contacts.filter((c) => matches(contactHaystack(c, by), q, by) && advContactPass(c)).slice(0, 50) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contacts, q, by, fSeniority, fDepartment, fGeography, fIndustry, fRelStatus, fOwner],
  );
  const internalTargets = useMemo(
    () => (q.trim() ? targets.filter((t) => matches(targetHaystack(t, by), q, by) && advTargetPass(t)).slice(0, 50) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targets, q, by, fSeniority, fDepartment, fGeography, fIndustry],
  );

  const internalCount = internalContacts.length + internalTargets.length;

  // Expand a company → fetch its decision-makers (once), all selected by default.
  const toggleDecisionMakers = async (co: ProspectCompany) => {
    const key = co.domain;
    const existing = dm[key];
    if (existing) {
      setDm((m) => ({ ...m, [key]: { ...existing, open: !existing.open } }));
      return;
    }
    setDm((m) => ({ ...m, [key]: { open: true, loading: true, people: [], selected: new Set(), adding: false, added: 0 } }));
    try {
      const res = await findCompanyDecisionMakers({
        data: {
          company: co,
          perCompany: 6,
          jobLevels: fSeniority.length ? fSeniority : undefined,
          jobFunctions: fDepartment.length ? fDepartment : undefined,
          countries: countryList().length ? countryList() : undefined,
        },
      });
      const people = res.found ? res.prospects : [];
      setDm((m) => ({
        ...m,
        [key]: {
          open: true,
          loading: false,
          people,
          error: res.found ? undefined : res.error || "Lookup failed.",
          selected: new Set(people.map(personKey)),
          adding: false,
          added: 0,
        },
      }));
    } catch (e) {
      console.error("decision-maker lookup failed", e);
      setDm((m) => ({
        ...m,
        [key]: { open: true, loading: false, people: [], error: "Lookup failed — see console.", selected: new Set(), adding: false, added: 0 },
      }));
    }
  };

  const togglePerson = (domain: string, pk: string) => {
    setDm((m) => {
      const entry = m[domain];
      if (!entry) return m;
      const selected = new Set(entry.selected);
      if (selected.has(pk)) selected.delete(pk);
      else selected.add(pk);
      return { ...m, [domain]: { ...entry, selected } };
    });
  };

  // Add the selected decision-makers to the Targets pipeline (enriched + deduped
  // server-side), tagging each with WHY surfaced and WHERE from.
  const addCompanyToTargets = async (co: ProspectCompany) => {
    const key = co.domain;
    const entry = dm[key];
    if (!entry) return;
    const chosen = entry.people.filter((p) => entry.selected.has(personKey(p)));
    if (chosen.length === 0) {
      toast.error("Select at least one decision-maker to add.");
      return;
    }
    setDm((m) => ({ ...m, [key]: { ...entry, adding: true } }));
    const reason = surfacedReason();
    try {
      const res = await addProspectsToTargets({
        data: {
          prospects: chosen.map((p) => ({ ...p, company: co.name, companyDomain: co.domain, industry: p.industry || co.industry, reason })),
          source: surfacedSource(),
          focus: ranQuery,
        },
      });
      setDm((m) => ({ ...m, [key]: { ...m[key], adding: false, added: res.added } }));
      if (res.added > 0) {
        toast.success(
          `Added ${res.added} to Targets${res.duplicates ? ` · ${res.duplicates} already there` : ""}${res.enriched ? ` · ${res.enriched} enriched` : ""}.`,
        );
      } else if (res.duplicates > 0) {
        toast.info(`All ${res.duplicates} selected are already in Targets.`);
      } else {
        toast.error(res.error || "Nothing added (no contact details resolved).");
      }
    } catch (e) {
      console.error("addProspectsToTargets failed", e);
      setDm((m) => ({ ...m, [key]: { ...m[key], adding: false } }));
      toast.error("Failed to add to Targets — see console.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Search className="h-4 w-4 text-primary" /> Network Search
          </DialogTitle>
          <DialogDescription>
            Search your contacts &amp; targets and external Sumble company data by technology, company, industry,
            product, or keyword.
          </DialogDescription>
        </DialogHeader>

        {/* Refine controls */}
        <div className="flex items-center gap-2">
          <Select value={by} onValueChange={(v) => setBy(v as NetworkSearchDimension)}>
            <SelectTrigger className="h-9 w-40 text-sm shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DIMENSIONS.map((d) => (
                <SelectItem key={d.key} value={d.key}>
                  By {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              autoFocus
              placeholder={`Search ${by}…`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runExternalSearch(q, by);
              }}
              className="pl-8 h-9 text-sm"
            />
          </div>
          <Button
            variant={showFilters || activeFilterCount > 0 ? "secondary" : "outline"}
            className="h-9 shrink-0"
            onClick={() => setShowFilters((s) => !s)}
          >
            <SlidersHorizontal className="h-4 w-4" />
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </Button>
          <Button className="h-9 shrink-0" onClick={() => void runExternalSearch(q, by)} disabled={!q.trim() || extLoading}>
            {extLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Search
          </Button>
        </div>

        {/* Advanced filters */}
        {showFilters && (
          <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold">Filters</span>
              {activeFilterCount > 0 && (
                <button onClick={clearFilters} className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5">
                  <X className="h-3 w-3" /> Clear ({activeFilterCount})
                </button>
              )}
            </div>

            <div>
              <FilterLabel>Seniority</FilterLabel>
              <div className="flex flex-wrap gap-1">
                {SENIORITY_LEVELS.map((s) => (
                  <Chip key={s} active={fSeniority.includes(s)} onClick={() => toggleIn(fSeniority, setFSeniority, s)}>{s}</Chip>
                ))}
              </div>
            </div>

            <div>
              <FilterLabel>Department</FilterLabel>
              <div className="flex flex-wrap gap-1">
                {DEPARTMENTS.map((d) => (
                  <Chip key={d} active={fDepartment.includes(d)} onClick={() => toggleIn(fDepartment, setFDepartment, d)}>{d}</Chip>
                ))}
              </div>
            </div>

            <div>
              <FilterLabel>Relationship status <span className="font-normal normal-case text-muted-foreground/70">(contacts)</span></FilterLabel>
              <div className="flex flex-wrap gap-1">
                {REL_STATUSES.map((r) => (
                  <Chip key={r} active={fRelStatus.includes(r)} onClick={() => toggleIn(fRelStatus, setFRelStatus, r)}>{r}</Chip>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <FilterLabel>Geography</FilterLabel>
                <Input value={fGeography} onChange={(e) => setFGeography(e.target.value)} placeholder="City or country…" className="h-8 text-xs" />
              </div>
              <div>
                <FilterLabel>Industry</FilterLabel>
                <Input value={fIndustry} onChange={(e) => setFIndustry(e.target.value)} placeholder="e.g. Fintech" className="h-8 text-xs" />
              </div>
              <div>
                <FilterLabel>Contact owner <span className="font-normal normal-case text-muted-foreground/70">(contacts)</span></FilterLabel>
                <Input value={fOwner} onChange={(e) => setFOwner(e.target.value)} placeholder="Prime name…" className="h-8 text-xs" />
              </div>
              <div>
                <FilterLabel>Technologies <span className="font-normal normal-case text-muted-foreground/70">(external)</span></FilterLabel>
                <Input value={fTechnologies} onChange={(e) => setFTechnologies(e.target.value)} placeholder="Splunk, Okta…" className="h-8 text-xs" />
              </div>
            </div>

            <div>
              <FilterLabel>Company size <span className="font-normal normal-case text-muted-foreground/70">(external)</span></FilterLabel>
              <div className="flex flex-wrap gap-1">
                {SIZE_OPTIONS.map((s) => (
                  <Chip key={s.key} active={fSizes.includes(s.key)} onClick={() => toggleIn(fSizes, setFSizes, s.key)}>{s.label}</Chip>
                ))}
              </div>
            </div>

            <p className="text-[10px] text-muted-foreground leading-tight">
              People filters (seniority, department, geography) refine internal results and the decision-makers pulled per company.
              Company size &amp; technologies apply to external Sumble results only. Re-run search after changing company filters.
            </p>
          </div>
        )}

        <ScrollArea className="flex-1 -mx-6 px-6">
          <div className="space-y-6 py-2">
            {/* Internal */}
            <section>
              <div className="flex items-center gap-2 mb-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">Your network</h3>
                <Badge variant="secondary" className="text-[10px]">{internalCount}</Badge>
              </div>

              {!internalLoaded ? (
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading contacts &amp; targets…
                </p>
              ) : internalCount === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {q.trim() ? "No internal contacts or targets match." : "Type a term to search your network."}
                </p>
              ) : (
                <div className="space-y-3">
                  {internalContacts.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                        Contacts ({internalContacts.length})
                      </p>
                      {internalContacts.map((c) => (
                        <div key={c.id} className="rounded-md border border-border p-2.5 text-xs">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate">{c.name}</span>
                            {c.temperature && <Badge variant="outline" className="text-[9px]">{c.temperature}</Badge>}
                          </div>
                          <p className="text-muted-foreground truncate">
                            {[c.title, c.company].filter(Boolean).join(" · ")}
                          </p>
                          {(c.sector || c.areasOfInterest.length > 0) && (
                            <p className="text-[10px] text-muted-foreground/80 truncate">
                              {[c.sector, ...c.areasOfInterest].filter(Boolean).join(" · ")}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {internalTargets.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground flex items-center gap-1">
                        <Target className="h-3 w-3" /> Targets ({internalTargets.length})
                      </p>
                      {internalTargets.map((t) => (
                        <div key={t.id} className="rounded-md border border-border p-2.5 text-xs">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate">{t.name}</span>
                            <Badge variant="outline" className="text-[9px]">{t.stage}</Badge>
                          </div>
                          <p className="text-muted-foreground truncate">
                            {[t.title, t.company].filter(Boolean).join(" · ")}
                          </p>
                          {t.reasonSurfaced && (
                            <p className="text-[10px] text-muted-foreground/80 truncate">{t.reasonSurfaced}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* External (Sumble) */}
            <section>
              <div className="flex items-center gap-2 mb-2">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">External companies</h3>
                <Badge variant="secondary" className="text-[10px]">{extCompanies.length}</Badge>
                <span className="text-[10px] text-muted-foreground ml-auto">via Sumble</span>
              </div>

              {extResolved && (
                <p className="text-[11px] text-muted-foreground mb-2">
                  Matched technology: <span className="font-medium text-foreground">{extResolved}</span>
                </p>
              )}

              {extLoading ? (
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" /> Searching Sumble…
                </p>
              ) : extError ? (
                <p className="text-xs text-amber-700">{extError}</p>
              ) : extCompanies.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {ranQuery ? "No external companies found." : "Run a search to find external companies."}
                </p>
              ) : (
                <div className="space-y-2">
                  {extCompanies.map((co) => {
                    const entry = dm[co.domain];
                    const selectedCount = entry ? entry.selected.size : 0;
                    return (
                      <div key={co.domain} className="rounded-md border border-border text-xs">
                        <div className="p-2.5">
                          <div className="flex items-center gap-2">
                            <CompanyMiniLogo domain={co.domain} />
                            <span className="font-medium truncate flex-1">{co.name}</span>
                            {entry?.added ? (
                              <Badge variant="secondary" className="text-[9px]">{entry.added} added</Badge>
                            ) : null}
                          </div>
                          <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                            {[co.industry, fmtEmployees(co.employees)].filter(Boolean).join(" · ")}
                          </p>
                          <div className="flex items-center gap-3 mt-1.5">
                            <a
                              href={`https://${co.domain}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline inline-flex items-center gap-0.5 text-[10px]"
                            >
                              <Globe className="h-2.5 w-2.5" /> {co.domain} <ExternalLink className="h-2.5 w-2.5" />
                            </a>
                            <button
                              type="button"
                              onClick={() => void toggleDecisionMakers(co)}
                              className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 ml-auto"
                            >
                              {entry?.open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                              Decision makers
                            </button>
                          </div>
                        </div>

                        {entry?.open && (
                          <div className="border-t border-border/60 p-2.5 space-y-2 bg-muted/20">
                            {entry.loading ? (
                              <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                                <Loader2 className="h-3 w-3 animate-spin" /> Finding decision makers…
                              </p>
                            ) : entry.error ? (
                              <p className="text-[11px] text-amber-700">{entry.error}</p>
                            ) : entry.people.length === 0 ? (
                              <p className="text-[11px] text-muted-foreground">No decision makers found for this company.</p>
                            ) : (
                              <>
                                <p className="text-[10px] text-muted-foreground">
                                  {extResolved ? `Senior people responsible for ${extResolved}` : "Senior decision makers"} — select who to add.
                                </p>
                                <div className="space-y-1">
                                  {entry.people.map((p) => {
                                    const pk = personKey(p);
                                    return (
                                      <label key={pk} className="flex items-start gap-2 cursor-pointer py-0.5">
                                        <Checkbox
                                          checked={entry.selected.has(pk)}
                                          onCheckedChange={() => togglePerson(co.domain, pk)}
                                          className="h-3.5 w-3.5 mt-0.5"
                                        />
                                        <span className="flex-1 min-w-0">
                                          <span className="flex items-center gap-1.5">
                                            <span className="font-medium truncate">{p.name}</span>
                                            {p.jobLevel && <Badge variant="outline" className="text-[8px]">{p.jobLevel}</Badge>}
                                            {p.linkedinUrl && (
                                              <a
                                                href={p.linkedinUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                onClick={(e) => e.stopPropagation()}
                                                className="text-[#0a66c2] shrink-0"
                                              >
                                                <Linkedin className="h-3 w-3" />
                                              </a>
                                            )}
                                          </span>
                                          {p.title && <span className="block text-[10px] text-muted-foreground truncate">{p.title}</span>}
                                        </span>
                                      </label>
                                    );
                                  })}
                                </div>
                                <Button
                                  size="sm"
                                  className="h-7 text-[11px] w-full"
                                  onClick={() => void addCompanyToTargets(co)}
                                  disabled={entry.adding || selectedCount === 0}
                                >
                                  {entry.adding ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <UserPlus className="h-3 w-3" />
                                  )}
                                  {entry.adding ? "Adding…" : `Add ${selectedCount} to Targets`}
                                </Button>
                                <p className="text-[9px] text-muted-foreground">
                                  Reason recorded: “{surfacedReason()}”
                                </p>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
