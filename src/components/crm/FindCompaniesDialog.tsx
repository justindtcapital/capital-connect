import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Building2,
  Loader2,
  Search,
  UserPlus,
  Mail,
  Phone,
  MapPin,
  Users,
  AlertTriangle,
} from "lucide-react";
import { findInstallCompanies } from "@/utils/sumble.functions";
import type { FoundCompany } from "@/utils/sumble.server";
import {
  findAccountPeople,
  findPeopleByLocation,
  addAccountPeople,
  type AccountPerson,
} from "@/utils/accounts.functions";
import type { PortfolioCompany } from "@/lib/types";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: () => void | Promise<void>;
  /** Portfolio companies offered for optional tagging on the found targets. */
  companies?: PortfolioCompany[];
}

// Headcount bands — keys mirror the server's SIZE_BANDS so the selection maps
// straight through to findInstallCompanies.
const SIZE_BANDS: { key: string; label: string }[] = [
  { key: "under_1k", label: "< 1k" },
  { key: "1k_5k", label: "1k–5k" },
  { key: "5k_10k", label: "5k–10k" },
  { key: "10k_50k", label: "10k–50k" },
  { key: "50k_plus", label: "50k+" },
];

// Apollo person_seniorities facet values — keys go straight to the API.
const SENIORITY_OPTIONS: { key: string; label: string }[] = [
  { key: "owner", label: "Owner" },
  { key: "founder", label: "Founder" },
  { key: "c_suite", label: "C-Suite" },
  { key: "partner", label: "Partner" },
  { key: "vp", label: "VP" },
  { key: "head", label: "Head" },
  { key: "director", label: "Director" },
  { key: "manager", label: "Manager" },
  { key: "senior", label: "Senior IC" },
  { key: "entry", label: "Entry" },
  { key: "intern", label: "Intern" },
];

const PURPOSES = [
  { value: "PortDev", label: "Portfolio Dev" },
  { value: "Investor/CVC", label: "Investor / CVC" },
  { value: "Both", label: "Both" },
];

// Two-phase prospecting: Sumble company search (by installed technology) →
// Apollo people search at the selected companies → add to Targets as Prospecting.
export function FindCompaniesDialog({ open, onOpenChange, onImported, companies = [] }: Props) {
  // Phase 1 — company criteria
  const [technology, setTechnology] = useState("");
  const [city, setCity] = useState("");
  const [limit, setLimit] = useState("15");
  const [sizes, setSizes] = useState<Set<string>>(new Set());
  const [taggedPortcos, setTaggedPortcos] = useState<string[]>([]);

  const [searchingCompanies, setSearchingCompanies] = useState(false);
  const [companyResults, setCompanyResults] = useState<FoundCompany[] | null>(null);
  const [techResolved, setTechResolved] = useState("");
  const [selectedCompanies, setSelectedCompanies] = useState<Set<number>>(new Set());

  // Phase 2 — people criteria
  const [seniorities, setSeniorities] = useState<Set<string>>(new Set());
  const [roleTerms, setRoleTerms] = useState("");
  const [purpose, setPurpose] = useState("PortDev");
  const [perCompany, setPerCompany] = useState("5");

  const [searchingPeople, setSearchingPeople] = useState(false);
  const [people, setPeople] = useState<AccountPerson[] | null>(null);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [selectedPeople, setSelectedPeople] = useState<Set<number>>(new Set());
  const [accessDenied, setAccessDenied] = useState(false);
  const [adding, setAdding] = useState(false);

  const portcoOptions = useMemo(
    () => [...new Set(companies.map((c) => c.name).filter(Boolean))].sort(),
    [companies],
  );

  // Location-only mode: no installed technology, but a location is given → skip
  // Sumble company discovery and search Apollo directly for people there.
  const locationOnlyMode = !technology.trim() && !!city.trim();

  const reset = () => {
    setTechnology("");
    setCity("");
    setLimit("15");
    setSizes(new Set());
    setTaggedPortcos([]);
    setSearchingCompanies(false);
    setCompanyResults(null);
    setTechResolved("");
    setSelectedCompanies(new Set());
    setSeniorities(new Set());
    setRoleTerms("");
    setPurpose("PortDev");
    setPerCompany("5");
    setSearchingPeople(false);
    setPeople(null);
    setUnresolved([]);
    setSelectedPeople(new Set());
    setAccessDenied(false);
    setAdding(false);
  };

  // The technology context we attribute the sourcing to (audit + why-surfaced).
  const techContext = () => techResolved || technology.trim();

  const toggleSize = (key: string) =>
    setSizes((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const toggleSeniority = (key: string) =>
    setSeniorities((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  // Free-text role/keyword/title terms — the primary people filter.
  const titles = (): string[] =>
    roleTerms
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  // ── Phase 1: company search ────────────────────────────────────
  const searchCompanies = async () => {
    if (locationOnlyMode) return; // no technology → company discovery is skipped
    if (!technology.trim()) {
      toast.error("Enter a technology, or a location below to search people directly via Apollo.");
      return;
    }
    setSearchingCompanies(true);
    setCompanyResults(null);
    setSelectedCompanies(new Set());
    // Company criteria changed — invalidate any downstream people results.
    setPeople(null);
    setSelectedPeople(new Set());
    setAccessDenied(false);
    try {
      const res = await findInstallCompanies({
        data: {
          technology: technology.trim(),
          city: city.trim() || undefined,
          sizes: [...sizes],
          limit: Number(limit) || 15,
        },
      });
      if (!res.found) {
        toast.error(res.error || "Company search failed.");
        return;
      }
      setTechResolved(res.techResolved || "");
      setCompanyResults(res.companies);
      // Pre-select all returned companies (the user prunes down).
      setSelectedCompanies(new Set(res.companies.map((_, i) => i)));
      if (res.companies.length === 0) {
        toast.info(
          `No companies matched${res.techResolved ? ` for ${res.techResolved}` : ""}. Try a different technology, drop the city, or widen the size bands.`,
        );
      } else {
        toast.success(
          `Found ${res.companies.length} compan${res.companies.length === 1 ? "y" : "ies"}${res.techResolved ? ` using ${res.techResolved}` : ""}`,
        );
      }
    } catch (e) {
      console.error("findInstallCompanies failed", e);
      toast.error("Company search failed — see console.");
    } finally {
      setSearchingCompanies(false);
    }
  };

  const toggleCompany = (i: number) =>
    setSelectedCompanies((prev) => {
      const n = new Set(prev);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  const allCompaniesSelected =
    !!companyResults &&
    companyResults.length > 0 &&
    selectedCompanies.size === companyResults.length;
  const selectAllCompanies = () =>
    setSelectedCompanies(
      allCompaniesSelected ? new Set() : new Set((companyResults || []).map((_, i) => i)),
    );

  // Selected companies → "Name | domain" lines for the Apollo people search.
  const selectedCompanyLines = (): string[] =>
    (companyResults || [])
      .filter((_, i) => selectedCompanies.has(i))
      .map((c) => (c.domain ? `${c.name} | ${c.domain}` : c.name));

  // ── Phase 2: people search ─────────────────────────────────────
  const searchPeople = async () => {
    const ts = titles();
    const sens = [...seniorities];
    if (ts.length === 0 && sens.length === 0) {
      toast.error("Enter role/keyword terms or pick at least one seniority.");
      return;
    }
    const lines = locationOnlyMode ? [] : selectedCompanyLines();
    if (!locationOnlyMode && lines.length === 0) {
      toast.error("Select at least one company.");
      return;
    }
    setSearchingPeople(true);
    setPeople(null);
    setSelectedPeople(new Set());
    setAccessDenied(false);
    try {
      // Location-only mode: no companies — search Apollo by person location.
      if (locationOnlyMode) {
        const loc = city.trim();
        const res = await findPeopleByLocation({
          data: {
            location: loc,
            titles: ts,
            seniorities: sens,
            purpose,
            sizes: [...sizes],
            limit: Number(perCompany),
            portcos: taggedPortcos,
          },
        });
        if (res.accessDenied) {
          setAccessDenied(true);
          return;
        }
        if (!res.found) {
          toast.error(res.error || "People search failed.");
          return;
        }
        setPeople(res.people);
        setUnresolved([]);
        setSelectedPeople(
          new Set(res.people.map((p, i) => (p.hasEmail ? i : -1)).filter((i) => i >= 0)),
        );
        if (res.people.length === 0) {
          toast.info(`No people matched in ${loc}. Try broader roles or a wider location.`);
        } else {
          toast.success(
            `Found ${res.people.length} people in ${loc}${res.totalMatches > res.people.length ? ` (of ${res.totalMatches})` : ""}`,
          );
        }
        return;
      }

      const res = await findAccountPeople({
        data: {
          companies: lines,
          titles: ts,
          seniorities: sens,
          purpose,
          perCompany: Number(perCompany),
          portcos: taggedPortcos,
          techContext: techContext(),
        },
      });
      if (res.accessDenied) {
        setAccessDenied(true);
        return;
      }
      if (!res.found) {
        toast.error(res.error || "People search failed.");
        return;
      }
      setPeople(res.people);
      setUnresolved(res.unresolved);
      // Pre-check people who have an email on file.
      setSelectedPeople(
        new Set(res.people.map((p, i) => (p.hasEmail ? i : -1)).filter((i) => i >= 0)),
      );
      if (res.people.length === 0) {
        toast.info(
          `No people matched across ${res.companiesSearched} compan${res.companiesSearched === 1 ? "y" : "ies"}. Try broader roles or more people/company.`,
        );
      } else {
        toast.success(
          `Found ${res.people.length} people across ${res.companiesSearched} companies`,
        );
      }
    } catch (e) {
      console.error("people search failed", e);
      toast.error("People search failed — see console.");
    } finally {
      setSearchingPeople(false);
    }
  };

  const togglePerson = (i: number) =>
    setSelectedPeople((prev) => {
      const n = new Set(prev);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });

  // Group people by account for display.
  const grouped: { account: string; domain: string; items: { p: AccountPerson; i: number }[] }[] =
    [];
  if (people) {
    const byAccount = new Map<string, { p: AccountPerson; i: number }[]>();
    people.forEach((p, i) => {
      const arr = byAccount.get(p.account) || [];
      arr.push({ p, i });
      byAccount.set(p.account, arr);
    });
    for (const [account, items] of byAccount) {
      grouped.push({ account, domain: items[0]?.p.accountDomain || "", items });
    }
  }

  const toggleGroup = (items: { p: AccountPerson; i: number }[]) => {
    const idxs = items.map((it) => it.i);
    const allOn = idxs.every((i) => selectedPeople.has(i));
    setSelectedPeople((prev) => {
      const n = new Set(prev);
      idxs.forEach((i) => (allOn ? n.delete(i) : n.add(i)));
      return n;
    });
  };

  // ── Add selected people to Targets as Prospecting ──────────────
  const addSelected = async () => {
    if (!people || selectedPeople.size === 0) return;
    setAdding(true);
    try {
      const chosen = people.filter((_, i) => selectedPeople.has(i));
      const res = await addAccountPeople({
        data: {
          people: chosen,
          purpose,
          portcos: taggedPortcos,
          techContext: locationOnlyMode ? "" : techContext(),
          location: locationOnlyMode ? city.trim() : "",
        },
      });
      if (!res.success && res.error) {
        toast.error(res.error);
        return;
      }
      const parts = [`Added ${res.added} prospecting target${res.added !== 1 ? "s" : ""}`];
      if (res.enriched) parts.push(`${res.enriched} revealed`);
      if (res.duplicates) parts.push(`${res.duplicates} dup${res.duplicates !== 1 ? "s" : ""}`);
      if (res.noEmail) parts.push(`${res.noEmail} without email`);
      if (res.failed) parts.push(`${res.failed} failed`);
      (res.failed ? toast.warning : toast.success)(parts.join(" · "));
      if (res.added > 0) await onImported?.();
      reset();
      onOpenChange(false);
    } catch (e) {
      console.error("addAccountPeople failed", e);
      toast.error("Adding failed — see console.");
    } finally {
      setAdding(false);
    }
  };

  const showPeoplePhase = locationOnlyMode || (!!companyResults && selectedCompanies.size > 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-3xl max-h-[90vh] grid-rows-[auto_1fr_auto]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-primary" /> Find companies by installed tech
          </DialogTitle>
          <DialogDescription className="text-xs">
            Search Sumble for companies running a specific technology, pick the ones you want, then
            find decision-makers via Apollo. Leave technology blank and enter a location to search
            people directly via Apollo. Selected people enter the Targets pipeline as{" "}
            <span className="font-medium">Prospecting</span>.
          </DialogDescription>
        </DialogHeader>

        {/* Body scrolls; header + footer stay pinned so "Add as Prospecting" is always reachable. */}
        <div className="space-y-4 py-1 min-h-0 overflow-y-auto -mx-6 px-6">
          {/* ── Phase 1: company criteria ── */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div className="sm:col-span-2 space-y-1">
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                Installed technology <span className="font-normal normal-case">(optional)</span>
              </Label>
              <Input
                value={technology}
                onChange={(e) => setTechnology(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") searchCompanies();
                }}
                placeholder="e.g. Splunk, Snowflake, Kubernetes"
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                {locationOnlyMode ? "Location" : "HQ State / Country"}{" "}
                <span className="font-normal normal-case">
                  {locationOnlyMode ? "(Apollo people search)" : "(optional)"}
                </span>
              </Label>
              <Input
                value={city}
                onChange={(e) => setCity(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") searchCompanies();
                }}
                placeholder="e.g. California or United States"
                className="h-8 text-sm"
              />
            </div>
            {!locationOnlyMode && (
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                  Max companies
                </Label>
                <Select value={limit} onValueChange={setLimit}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[10, 15, 25, 40, 50].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                Company size <span className="font-normal normal-case">(optional)</span>
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {SIZE_BANDS.map((b) => (
                  <button
                    key={b.key}
                    type="button"
                    onClick={() => toggleSize(b.key)}
                    className={`text-[11px] px-2 py-1 rounded border ${
                      sizes.has(b.key)
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                Tag portfolio companies <span className="font-normal normal-case">(optional)</span>
              </Label>
              <MultiSelect
                options={portcoOptions}
                value={taggedPortcos}
                onChange={setTaggedPortcos}
                placeholder="None — general prospecting"
              />
            </div>
          </div>

          {!locationOnlyMode && (
            <div className="flex items-center justify-end">
              <Button onClick={searchCompanies} disabled={searchingCompanies}>
                {searchingCompanies ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" /> Searching…
                  </>
                ) : (
                  <>
                    <Search className="h-4 w-4 mr-1" /> Search companies
                  </>
                )}
              </Button>
            </div>
          )}

          {/* ── Company results ── */}
          {!locationOnlyMode && companyResults && companyResults.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                  {companyResults.length} found · {selectedCompanies.size} selected
                  {techResolved && (
                    <span className="font-normal normal-case"> · {techResolved}</span>
                  )}
                </Label>
                <button
                  type="button"
                  onClick={selectAllCompanies}
                  className="text-[10px] text-primary hover:underline"
                >
                  {allCompaniesSelected ? "Clear all" : "Select all"}
                </button>
              </div>
              <ScrollArea className="h-52 border border-border rounded">
                <div className="divide-y divide-border">
                  {companyResults.map((c, i) => (
                    <div key={`${c.domain}-${i}`} className="flex items-center gap-2 px-2 py-1.5">
                      <Checkbox
                        checked={selectedCompanies.has(i)}
                        onCheckedChange={() => toggleCompany(i)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium truncate">{c.name}</span>
                          <span className="text-[10px] font-mono text-muted-foreground/70 truncate">
                            {c.domain}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                          {c.industry && <span className="truncate">{c.industry}</span>}
                          {c.location && (
                            <span className="inline-flex items-center gap-0.5 truncate">
                              <MapPin className="h-2.5 w-2.5" /> {c.location}
                            </span>
                          )}
                          {c.employees != null && (
                            <span className="inline-flex items-center gap-0.5 shrink-0">
                              <Users className="h-2.5 w-2.5" /> {c.employees.toLocaleString()}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}
          {!locationOnlyMode && companyResults && companyResults.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-3">
              No companies matched. Try a different technology, drop the location, or widen the size
              bands.
            </p>
          )}

          {/* ── Phase 2: people criteria (after companies selected) ── */}
          {showPeoplePhase && !accessDenied && (
            <div className="space-y-3 border-t border-border pt-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                    Purpose
                  </Label>
                  <Select value={purpose} onValueChange={setPurpose}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PURPOSES.map((p) => (
                        <SelectItem key={p.value} value={p.value}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                    {locationOnlyMode ? "Max people" : "People / company"}
                  </Label>
                  <Select value={perCompany} onValueChange={setPerCompany}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[3, 5, 10, 15, 25].map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-end">
                  <p className="text-[10px] text-muted-foreground">
                    {locationOnlyMode ? (
                      <>Searching people located in {city.trim()} via Apollo.</>
                    ) : (
                      <>
                        Searching {selectedCompanies.size} selected compan
                        {selectedCompanies.size === 1 ? "y" : "ies"}.
                      </>
                    )}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                    Role / keywords / titles <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    value={roleTerms}
                    onChange={(e) => setRoleTerms(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") searchPeople();
                    }}
                    placeholder="Comma-separated, e.g. CISO, Head of Cloud, Corporate Development"
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                    Seniority <span className="font-normal normal-case">(optional filter)</span>
                  </Label>
                  <div className="flex flex-wrap gap-1.5">
                    {SENIORITY_OPTIONS.map((s) => (
                      <button
                        key={s.key}
                        type="button"
                        onClick={() => toggleSeniority(s.key)}
                        className={`text-[11px] px-2 py-1 rounded border ${
                          seniorities.has(s.key)
                            ? "bg-primary text-primary-foreground border-primary"
                            : "border-border hover:bg-accent"
                        }`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Either works alone — keywords search titles, seniority filters Apollo's level
                    facet; combine them to narrow.
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end">
                <Button onClick={searchPeople} disabled={searchingPeople} variant="secondary">
                  {searchingPeople ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" /> Searching…
                    </>
                  ) : (
                    <>
                      <Search className="h-4 w-4 mr-1" /> Find people
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}

          {/* Apollo access issue */}
          {accessDenied && (
            <div className="rounded border border-dashed border-amber-500/40 bg-amber-500/5 p-4 text-xs text-muted-foreground flex gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
              <div>
                Apollo people-search isn't accessible with the current API key/plan. Check the key
                in <span className="font-mono">.env</span> and that your plan permits people search,
                then try again.
              </div>
            </div>
          )}

          {/* Unresolved company lines */}
          {unresolved.length > 0 && (
            <p className="text-[10px] text-amber-600">Couldn't resolve: {unresolved.join("; ")}.</p>
          )}

          {/* ── People results ── */}
          {people && people.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                  {people.length} people · {selectedPeople.size} selected
                </Label>
                <span className="text-[10px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Mail className="h-3 w-3 text-emerald-600" /> = email on file
                  </span>
                </span>
              </div>
              <ScrollArea className="h-72 border border-border rounded">
                <div className="divide-y divide-border">
                  {grouped.map((g) => {
                    const groupAllOn = g.items.every(({ i }) => selectedPeople.has(i));
                    return (
                      <div key={g.account}>
                        <div className="sticky top-0 z-10 bg-muted/60 px-2 py-1">
                          <div className="flex items-center gap-2">
                            <Checkbox
                              checked={groupAllOn}
                              onCheckedChange={() => toggleGroup(g.items)}
                            />
                            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                              {g.account} ({g.items.length})
                            </span>
                            {g.domain && (
                              <span className="text-[10px] font-mono text-muted-foreground/70">
                                → {g.domain}
                              </span>
                            )}
                          </div>
                        </div>
                        {g.items.map(({ p, i }) => (
                          <div key={i} className="flex items-center gap-2 px-2 py-1.5">
                            <Checkbox
                              checked={selectedPeople.has(i)}
                              onCheckedChange={() => togglePerson(i)}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-medium truncate">
                                  {p.firstName || "—"}
                                </span>
                                <span className="text-[10px] text-muted-foreground truncate">
                                  {p.title}
                                </span>
                              </div>
                              <span className="text-[10px] text-muted-foreground truncate">
                                {p.company}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <Mail
                                className={`h-3 w-3 ${p.hasEmail ? "text-emerald-600" : "text-muted-foreground/30"}`}
                              />
                              <Phone
                                className={`h-3 w-3 ${p.hasPhone ? "text-emerald-600" : "text-muted-foreground/30"}`}
                              />
                              <MapPin
                                className={`h-3 w-3 ${p.hasLocation ? "text-emerald-600" : "text-muted-foreground/30"}`}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </div>
          )}
          {people && people.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-3">
              {locationOnlyMode
                ? "No people matched in that location. Try broader roles or a wider location."
                : "No people matched. Try broader roles, more people/company, or a different set of companies."}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={addSelected}
            disabled={adding || accessDenied || !people || selectedPeople.size === 0}
          >
            {adding ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" /> Adding…
              </>
            ) : (
              <>
                <UserPlus className="h-4 w-4 mr-1" /> Add {selectedPeople.size || ""} as Prospecting
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
