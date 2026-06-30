import { useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MultiSelect } from "@/components/ui/multi-select";
import { Search, Plus, Check, Mail, Phone, MapPin, Loader2 } from "lucide-react";
import { searchContacts, enrichContact } from "@/utils/apollo.functions";
import { addTarget } from "@/utils/sheets.functions";
import type { ApolloPersonResult } from "@/utils/apollo.server";
import type { TargetLead } from "@/lib/types";
import { toast } from "sonner";

interface NetworkBuilderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with a newly added target so the page can show it immediately. */
  onAdded: (target: TargetLead) => void;
}

// Company-size brackets. Label is shown in the multi-select; value is the
// Apollo organization_num_employees_ranges "min,max" string. Selecting none
// means "any size" (no filter).
const HEADCOUNT_OPTIONS: { value: string; label: string }[] = [
  { value: "5000,10000", label: "5,000–10,000" },
  { value: "10000,25000", label: "10,000–25,000" },
  { value: "25000,50000", label: "25,000–50,000" },
  { value: "50000,1000000", label: "50,000+" },
];
const HEADCOUNT_LABELS = HEADCOUNT_OPTIONS.map((o) => o.label);
const HEADCOUNT_LABEL_TO_VALUE = new Map(HEADCOUNT_OPTIONS.map((o) => [o.label, o.value]));

const PER_PAGE = 25;

function splitList(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

export function NetworkBuilderDialog({ open, onOpenChange, onAdded }: NetworkBuilderDialogProps) {
  const [titles, setTitles] = useState("");
  const [locations, setLocations] = useState("");
  const [domains, setDomains] = useState("");
  const [keywords, setKeywords] = useState("");
  const [sizes, setSizes] = useState<string[]>([]);

  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<ApolloPersonResult[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [hasSearched, setHasSearched] = useState(false);

  const [addingId, setAddingId] = useState<string | null>(null);
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());

  const hasCriteria =
    splitList(titles).length > 0 ||
    splitList(locations).length > 0 ||
    splitList(domains).length > 0 ||
    keywords.trim().length > 0;

  const runSearch = async (toPage = 1) => {
    if (!hasCriteria) return;
    setSearching(true);
    setError("");
    try {
      const res = await searchContacts({
        data: {
          titles: splitList(titles),
          locations: splitList(locations),
          organizationDomains: splitList(domains),
          keywords: keywords.trim() || undefined,
          employeeRanges: sizes.length
            ? sizes.map((label) => HEADCOUNT_LABEL_TO_VALUE.get(label)!).filter(Boolean)
            : undefined,
          page: toPage,
          perPage: PER_PAGE,
        },
      });
      setHasSearched(true);
      if (res.error) {
        setError(res.error);
        setResults([]);
        setTotal(0);
      } else {
        setResults(res.people);
        setTotal(res.total);
        setPage(res.page);
      }
    } catch (e) {
      console.error("Apollo search failed:", e);
      setError("The search request failed. Please try again.");
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const addToTarget = async (p: ApolloPersonResult) => {
    setAddingId(p.id);
    try {
      // Reveal the obfuscated record by its Apollo id, then persist as a target.
      const revealed = await enrichContact({ data: { id: p.id } });
      const firstName = revealed.firstName || p.firstName || "";
      const lastName = revealed.lastName || "";
      const company = revealed.company || p.company || "";
      const title = revealed.title || p.title || "";
      const email = revealed.email || "";
      const linkedin = revealed.linkedinUrl || "";
      const location = [revealed.city, revealed.state].filter(Boolean).join(", ");

      await addTarget({
        data: {
          firstName,
          lastName,
          company,
          role: title,
          linkedin,
          email,
          location,
          sector: "",
          stage: "Prospecting",
          source: "Apollo",
          researchPurpose: "",
        },
      });

      const newTarget: TargetLead = {
        id: `t-apollo-${p.id}`,
        name: [firstName, lastName].filter(Boolean).join(" ") || revealed.name || p.firstName,
        title,
        company,
        linkedinUrl: linkedin,
        email,
        phone: revealed.phone || "",
        location,
        sector: "",
        stage: "Prospecting",
        originSource: "Apollo",
        outreach: [],
        notes: "",
      };
      onAdded(newTarget);
      setAddedIds((prev) => new Set(prev).add(p.id));
      toast.success(`Added ${newTarget.name || "contact"} to targets`);
    } catch (e) {
      console.error("Add to target failed:", e);
      toast.error("Couldn't add this contact to targets.");
    } finally {
      setAddingId(null);
    }
  };

  const reset = () => {
    setResults([]);
    setTotal(0);
    setPage(1);
    setError("");
    setHasSearched(false);
    setAddedIds(new Set());
  };

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Network builder · Apollo search</DialogTitle>
          <DialogDescription className="text-xs">
            Find new contacts in Apollo's database by criteria. Add any result to your targets —
            details (email, LinkedIn, location) are revealed on add.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Criteria */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Job titles (comma-separated)
              </Label>
              <Input value={titles} onChange={(e) => setTitles(e.target.value)} placeholder="CISO, VP Security" className="h-9 text-xs" />
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Locations (comma-separated)
              </Label>
              <Input value={locations} onChange={(e) => setLocations(e.target.value)} placeholder="Boston, New York" className="h-9 text-xs" />
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Company domains (optional)
              </Label>
              <Input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="stripe.com, datadoghq.com" className="h-9 text-xs" />
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Company size
              </Label>
              <MultiSelect
                options={HEADCOUNT_LABELS}
                value={sizes}
                onChange={setSizes}
                placeholder="Any size"
                searchable={false}
                className="h-9 text-xs"
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Keywords (optional)
              </Label>
              <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="zero trust, fintech…" className="h-9 text-xs" />
            </div>
          </div>

          <Button onClick={() => runSearch(1)} disabled={!hasCriteria || searching} size="sm" className="text-xs">
            {searching ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Search className="h-3.5 w-3.5 mr-1.5" />}
            {searching ? "Searching…" : "Search Apollo"}
          </Button>

          {/* Results */}
          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}

          {hasSearched && !error && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                  {total.toLocaleString()} match{total !== 1 ? "es" : ""} · page {page} of {totalPages}
                </Label>
                {totalPages > 1 && (
                  <div className="flex items-center gap-1">
                    <Button variant="outline" size="sm" className="h-6 text-[11px] px-2" disabled={page <= 1 || searching} onClick={() => runSearch(page - 1)}>Prev</Button>
                    <Button variant="outline" size="sm" className="h-6 text-[11px] px-2" disabled={page >= totalPages || searching} onClick={() => runSearch(page + 1)}>Next</Button>
                  </div>
                )}
              </div>
              <ScrollArea className="h-64 border border-border rounded">
                {results.length === 0 ? (
                  <p className="text-xs text-muted-foreground p-3">No matches — try broadening your criteria.</p>
                ) : (
                  <div className="divide-y divide-border">
                    {results.map((p) => {
                      const added = addedIds.has(p.id);
                      return (
                        <div key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-foreground truncate">
                              {p.firstName || "Unknown"} <span className="text-muted-foreground/60 font-normal">· last name hidden</span>
                            </div>
                            <div className="text-[11px] text-muted-foreground truncate">
                              {p.title}{p.company ? ` · ${p.company}` : ""}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              {p.hasEmail && <Badge variant="outline" className="text-[9px] gap-0.5 px-1 py-0"><Mail className="h-2.5 w-2.5" />email</Badge>}
                              {p.hasPhone && <Badge variant="outline" className="text-[9px] gap-0.5 px-1 py-0"><Phone className="h-2.5 w-2.5" />phone</Badge>}
                              {p.hasLocation && <Badge variant="outline" className="text-[9px] gap-0.5 px-1 py-0"><MapPin className="h-2.5 w-2.5" />location</Badge>}
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant={added ? "ghost" : "outline"}
                            className="h-7 text-[11px] shrink-0"
                            disabled={added || addingId === p.id}
                            onClick={() => addToTarget(p)}
                          >
                            {added ? <><Check className="h-3 w-3 mr-1" />Added</>
                              : addingId === p.id ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Adding…</>
                              : <><Plus className="h-3 w-3 mr-1" />Add target</>}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </ScrollArea>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
