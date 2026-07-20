import { useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Building2, Loader2, Search, UserPlus, Mail, Phone, AlertTriangle } from "lucide-react";
import {
  findAccountPeople,
  addAccountPeople,
  type AccountPerson,
} from "@/utils/accounts.functions";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: () => void | Promise<void>;
}

// Preset roles, grouped for scanning. Click to toggle; free-text adds more.
const ROLE_GROUPS: { label: string; roles: string[] }[] = [
  {
    label: "Technology leadership",
    roles: [
      "CIO",
      "CTO",
      "CISO",
      "Chief Data Officer",
      "Chief Digital Officer",
      "Head of Platform",
      "VP Engineering",
      "Head of Infrastructure",
    ],
  },
  {
    label: "Portfolio / corp dev",
    roles: [
      "Corporate Development",
      "Business Development",
      "Market Development",
      "Head of Partnerships",
    ],
  },
  {
    label: "Investor / CVC",
    roles: ["Managing Director", "Principal", "Partner", "Investment Director", "Head of Ventures"],
  },
];

const PURPOSES = [
  { value: "PortDev", label: "Portfolio Dev" },
  { value: "Investor/CVC", label: "Investor / CVC" },
  { value: "Both", label: "Both" },
];

export function TargetAccountsDialog({ open, onOpenChange, onImported }: Props) {
  const [companies, setCompanies] = useState("");
  const [roles, setRoles] = useState<Set<string>>(new Set());
  const [extraTitles, setExtraTitles] = useState("");
  const [purpose, setPurpose] = useState("PortDev");
  const [perCompany, setPerCompany] = useState("5");

  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [people, setPeople] = useState<AccountPerson[] | null>(null);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [accessDenied, setAccessDenied] = useState(false);

  const reset = () => {
    setCompanies("");
    setRoles(new Set());
    setExtraTitles("");
    setPurpose("PortDev");
    setPerCompany("5");
    setPeople(null);
    setUnresolved([]);
    setSelected(new Set());
    setSearching(false);
    setAdding(false);
    setAccessDenied(false);
  };

  const toggleRole = (r: string) => {
    setRoles((prev) => {
      const n = new Set(prev);
      if (n.has(r)) n.delete(r);
      else n.add(r);
      return n;
    });
  };

  const titles = (): string[] => [
    ...roles,
    ...extraTitles
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ];

  const companyLines = (): string[] =>
    companies
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

  const search = async () => {
    const lines = companyLines();
    const ts = titles();
    if (lines.length === 0) {
      toast.error("Add at least one company (one per line).");
      return;
    }
    if (ts.length === 0) {
      toast.error("Pick at least one role or add a title.");
      return;
    }
    setSearching(true);
    setPeople(null);
    setSelected(new Set());
    setAccessDenied(false);
    try {
      const res = await findAccountPeople({
        data: { companies: lines, titles: ts, purpose, perCompany: Number(perCompany) },
      });
      if (res.accessDenied) {
        setAccessDenied(true);
        return;
      }
      if (!res.found) {
        toast.error(res.error || "Search failed.");
        return;
      }
      setPeople(res.people);
      setUnresolved(res.unresolved);
      // Pre-select people who have an email available (the only ones we can add).
      setSelected(new Set(res.people.map((p, i) => (p.hasEmail ? i : -1)).filter((i) => i >= 0)));
      if (res.people.length === 0) {
        toast.info(
          `No people matched across ${res.companiesSearched} compan${res.companiesSearched === 1 ? "y" : "ies"}.`,
        );
      } else {
        toast.success(
          `Found ${res.people.length} people across ${res.companiesSearched} companies`,
        );
      }
    } catch (e) {
      console.error("findAccountPeople failed", e);
      toast.error("Search failed — see console.");
    } finally {
      setSearching(false);
    }
  };

  const toggle = (i: number) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  };

  const addSelected = async () => {
    if (!people || selected.size === 0) return;
    setAdding(true);
    try {
      const chosen = people.filter((_, i) => selected.has(i));
      const res = await addAccountPeople({ data: { people: chosen, purpose } });
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

  // Group results by account for display.
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

  // Toggle every person in one account group at once.
  const toggleGroup = (items: { p: AccountPerson; i: number }[]) => {
    const idxs = items.map((it) => it.i);
    const allOn = idxs.every((i) => selected.has(i));
    setSelected((prev) => {
      const n = new Set(prev);
      idxs.forEach((i) => (allOn ? n.delete(i) : n.add(i)));
      return n;
    });
  };

  // A resolved domain that doesn't look related to the typed name is a red flag
  // (e.g. "JP Morgan Chase" → linkedin.com). Surface it so it can be corrected.
  const looksSuspicious = (account: string, domain: string): boolean => {
    if (!domain) return false;
    const host = domain.split(".")[0]?.toLowerCase() || "";
    const acct = account.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!host || !acct) return false;
    // Related if the account name and domain share a meaningful token.
    const tokens = account
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3);
    const related =
      tokens.some((t) => host.includes(t) || t.includes(host)) ||
      acct.includes(host) ||
      host.includes(acct.slice(0, 5));
    return !related;
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-primary" /> Find people at target accounts
          </DialogTitle>
          <DialogDescription className="text-xs">
            Paste your target companies and pick the roles you want to reach (CIOs, CTOs, CVC
            partners…). Apollo finds matching people; contact info is revealed on add. New people
            enter the Targets pipeline as <span className="font-medium">Prospecting</span>, tagged
            by purpose.
          </DialogDescription>
        </DialogHeader>

        {accessDenied ? (
          <div className="rounded border border-dashed border-amber-500/40 bg-amber-500/5 p-4 text-xs text-muted-foreground flex gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            <div>
              Apollo people-search isn't accessible with the current API key/plan. Check that the
              key in <span className="font-mono">.env</span> is valid and your plan permits people
              search, then try again.
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-1">
            {/* Companies + purpose */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2 space-y-1">
                <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                  Target companies{" "}
                  <span className="font-normal normal-case">(one per line — name or domain)</span>
                </Label>
                <textarea
                  value={companies}
                  onChange={(e) => setCompanies(e.target.value)}
                  rows={5}
                  placeholder={
                    "JPMorgan Chase\nGoldman Sachs\nCiti Ventures | citi.com\ncapitalone.com"
                  }
                  className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
                />
                <p className="text-[10px] text-muted-foreground">
                  Names are resolved to domains via Sumble (1 credit each). Paste a domain to skip
                  that.
                </p>
              </div>
              <div className="space-y-3">
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
                    People / company
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
              </div>
            </div>

            {/* Roles */}
            <div className="space-y-2">
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                Roles to target <span className="text-red-500">*</span>
              </Label>
              {ROLE_GROUPS.map((g) => (
                <div key={g.label}>
                  <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70 mb-1">
                    {g.label}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {g.roles.map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => toggleRole(r)}
                        className={`text-[11px] px-2 py-1 rounded border ${
                          roles.has(r)
                            ? "bg-primary text-primary-foreground border-primary"
                            : "border-border hover:bg-accent"
                        }`}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <Input
                value={extraTitles}
                onChange={(e) => setExtraTitles(e.target.value)}
                placeholder="Additional titles, comma-separated (e.g. Head of Cloud, GenAI Lead)"
                className="h-8 text-sm mt-1"
              />
            </div>

            <div className="flex items-center justify-end gap-2">
              <Button onClick={search} disabled={searching}>
                {searching ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" /> Searching…
                  </>
                ) : (
                  <>
                    <Search className="h-4 w-4 mr-1" /> Search accounts
                  </>
                )}
              </Button>
            </div>

            {/* Unresolved */}
            {unresolved.length > 0 && (
              <p className="text-[10px] text-amber-600">
                Couldn't resolve: {unresolved.join("; ")}. Paste a domain for these (e.g. "Name |
                domain.com").
              </p>
            )}

            {/* Results */}
            {people && people.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                    {people.length} found · {selected.size} selected
                  </Label>
                  <span className="text-[10px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Mail className="h-3 w-3 text-emerald-600" /> = email on file
                    </span>
                    . Others are added without one — fill it in later.
                  </span>
                </div>
                <ScrollArea className="h-72 border border-border rounded">
                  <div className="divide-y divide-border">
                    {grouped.map((g) => {
                      const groupAllOn = g.items.every(({ i }) => selected.has(i));
                      const suspicious = looksSuspicious(g.account, g.domain);
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
                                <span
                                  className={`text-[10px] font-mono ${suspicious ? "text-amber-600" : "text-muted-foreground/70"}`}
                                >
                                  → {g.domain}
                                </span>
                              )}
                            </div>
                            {suspicious && (
                              <p className="text-[10px] text-amber-600 mt-0.5 ml-6 normal-case font-normal flex items-center gap-1">
                                <AlertTriangle className="h-3 w-3 shrink-0" />
                                That domain doesn't look like “{g.account}”. If it's wrong,
                                re-search with “{g.account} | realdomain.com”.
                              </p>
                            )}
                          </div>
                          {g.items.map(({ p, i }) => (
                            <div key={i} className="flex items-center gap-2 px-2 py-1.5">
                              <Checkbox
                                checked={selected.has(i)}
                                onCheckedChange={() => toggle(i)}
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
                No people matched. Try broader roles, more people/company, or check the company
                names.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={addSelected}
            disabled={adding || accessDenied || !people || selected.size === 0}
          >
            {adding ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" /> Adding…
              </>
            ) : (
              <>
                <UserPlus className="h-4 w-4 mr-1" /> Add {selected.size || ""} as Prospecting
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
