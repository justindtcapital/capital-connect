import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sparkles, ChevronLeft, Building2, Search } from "lucide-react";
import { CustomerDiscoveryPanel } from "@/components/portfolio/CustomerDiscoveryPanel";
import { portfolioDomains, type PortfolioCompany } from "@/lib/types";
import { toast } from "sonner";

interface NetworkFinderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: () => void | Promise<void>;
  /** Portfolio companies offered as a quick-pick anchor (optional). */
  companies?: PortfolioCompany[];
}

// Build a minimal PortfolioCompany anchor for the discovery engine. It only
// reads name / sector / description / website, so the rest are safe defaults.
function makeAnchor(name: string, sector: string, description = "", website = ""): PortfolioCompany {
  return {
    id: `search-${name.trim().toLowerCase()}-${sector.trim().toLowerCase()}`,
    name: name.trim() || sector.trim() || "Network search",
    sector: sector.trim(),
    domain: portfolioDomains[0],
    website,
    linkedinUrl: "",
    location: "",
    description,
    contactName: "",
    contactEmail: "",
    contactPhone: "",
    employees: [],
    events: [],
    introductions: [],
  };
}

// "Find People" on the Network page: a generalized discovery search by company,
// industry, and/or technology. Whatever the entry point, it runs the Customer
// Discovery engine and lets you add surfaced decision-makers to Targets as Cold.
export function NetworkFinderDialog({ open, onOpenChange, onImported, companies = [] }: NetworkFinderDialogProps) {
  const [company, setCompany] = useState("");
  const [industry, setIndustry] = useState("");
  const [technology, setTechnology] = useState("");
  // The portfolio company picked from the quick-pick (enriches the anchor).
  const [selectedPortco, setSelectedPortco] = useState<PortfolioCompany | null>(null);

  // Active search → drives the discovery panel. `key` forces a fresh run.
  const [run, setRun] = useState<{ anchor: PortfolioCompany; technologies: string[]; key: number } | null>(null);

  const sortedCompanies = useMemo(
    () => [...companies].sort((a, b) => a.name.localeCompare(b.name)),
    [companies]
  );
  // Industry suggestions: DTC focus areas plus any distinct portfolio sectors.
  const industryOptions = useMemo(() => {
    const set = new Set<string>(portfolioDomains as string[]);
    for (const c of companies) if (c.sector?.trim()) set.add(c.sector.trim());
    return [...set].sort();
  }, [companies]);

  const resetForm = () => {
    setCompany("");
    setIndustry("");
    setTechnology("");
    setSelectedPortco(null);
  };

  const reset = () => {
    resetForm();
    setRun(null);
  };

  const choosePortco = (name: string) => {
    const match = companies.find((c) => c.name === name) || null;
    setSelectedPortco(match);
    if (match) {
      setCompany(match.name);
      setIndustry(match.sector || "");
    }
  };

  const startSearch = () => {
    const techs = technology.split(",").map((t) => t.trim()).filter(Boolean);
    const co = company.trim();
    const ind = industry.trim();
    if (!co && !ind && techs.length === 0) {
      toast.error("Enter a company, an industry, or a technology to search.");
      return;
    }
    // Use the picked portfolio company's richer details when it matches the
    // typed company; otherwise build a lightweight anchor from the inputs.
    const anchor =
      selectedPortco && selectedPortco.name === co
        ? makeAnchor(co, ind || selectedPortco.sector, selectedPortco.description, selectedPortco.website)
        : makeAnchor(co || ind || techs.join(", "), ind);
    setRun((prev) => ({ anchor, technologies: techs, key: (prev?.key ?? 0) + 1 }));
  };

  const backToSearch = () => setRun(null);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> Find people
          </DialogTitle>
          <DialogDescription className="text-xs">
            Search by company, industry, and/or technology. Customer Discovery finds look-alike
            companies likely to be customers and surfaces decision-makers — add the ones you want to
            your <span className="font-medium">Targets</span> pipeline as Cold.
          </DialogDescription>
        </DialogHeader>

        {!run ? (
          <div className="space-y-4 py-1">
            {/* Optional quick-pick: anchor on an existing portfolio company. */}
            {sortedCompanies.length > 0 && (
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground flex items-center gap-1.5">
                  <Building2 className="h-3 w-3" /> Portfolio company <span className="font-normal normal-case">(optional quick-pick)</span>
                </Label>
                <Select value={selectedPortco?.name ?? ""} onValueChange={choosePortco}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder="Pick a portfolio company to prefill…" />
                  </SelectTrigger>
                  <SelectContent>
                    {sortedCompanies.map((c) => (
                      <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                  Company
                </Label>
                <Input
                  value={company}
                  onChange={(e) => { setCompany(e.target.value); setSelectedPortco(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") startSearch(); }}
                  placeholder="e.g. Databricks"
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                  Industry
                </Label>
                <Input
                  list="finder-industry-options"
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") startSearch(); }}
                  placeholder="e.g. Cybersecurity"
                  className="h-9 text-sm"
                />
                <datalist id="finder-industry-options">
                  {industryOptions.map((o) => <option key={o} value={o} />)}
                </datalist>
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                Technology <span className="font-normal normal-case">(comma-separated)</span>
              </Label>
              <Input
                value={technology}
                onChange={(e) => setTechnology(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") startSearch(); }}
                placeholder="e.g. Snowflake, Splunk, Kubernetes"
                className="h-9 text-sm"
              />
            </div>

            <p className="text-[10px] text-muted-foreground">
              Provide at least one. A <span className="font-medium">technology</span> drives the search
              directly; a <span className="font-medium">company</span> or <span className="font-medium">industry</span> is
              profiled into comparable technologies first.
            </p>

            <div className="flex justify-end">
              <Button onClick={startSearch}>
                <Search className="h-4 w-4 mr-1" /> Search
              </Button>
            </div>
          </div>
        ) : (
          <div className="py-1">
            <button
              type="button"
              onClick={backToSearch}
              className="inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline"
            >
              <ChevronLeft className="h-3 w-3" /> New search
            </button>
            <div className="mt-2 max-h-[65vh] overflow-y-auto pr-1">
              <CustomerDiscoveryPanel
                key={run.key}
                company={run.anchor}
                initialTechnologies={run.technologies}
                autoRun
                onImported={onImported}
              />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
