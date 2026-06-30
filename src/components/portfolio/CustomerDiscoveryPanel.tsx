import { useEffect, useState } from "react";
import type { PortfolioCompany } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Target,
  Loader2,
  RefreshCw,
  ExternalLink,
  Linkedin,
  UserPlus,
  Sparkles,
  Cpu,
  Briefcase,
  Lightbulb,
  Swords,
  Check,
  Search,
} from "lucide-react";
import { discoverCustomers } from "@/utils/discovery.functions";
import { suggestCompetitors } from "@/utils/insights.functions";
import { addProspectsToTargets } from "@/utils/prospects.functions";
import type { DiscoveryResult, OpportunityCompany, SumbleProspect } from "@/utils/sumble.server";
import { toast } from "sonner";

interface Props {
  company: PortfolioCompany;
  onImported?: () => void | Promise<void>;
  /** Pre-seed the technology search box (e.g. a generalized network search). */
  initialTechnologies?: string[];
  /** Run discovery immediately on mount (skips the "Find customers" click). */
  autoRun?: boolean;
}

// Fit-score → color (matches likelihood bands in the engine: ≥70 High, ≥45 Medium).
function scoreClasses(score: number): string {
  if (score >= 70) return "bg-emerald-500/15 text-emerald-600 border-emerald-500/30";
  if (score >= 45) return "bg-amber-500/15 text-amber-600 border-amber-500/30";
  return "bg-muted text-muted-foreground border-border";
}

export function CustomerDiscoveryPanel({ company, onImported, initialTechnologies, autoRun }: Props) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [techQuery, setTechQuery] = useState((initialTechnologies || []).join(", "));
  const [competitors, setCompetitors] = useState<string[] | null>(null);
  const [selectedComps, setSelectedComps] = useState<Set<string>>(new Set());
  const [loadingComps, setLoadingComps] = useState(false);
  // Selected decision-makers, keyed "oppIndex:personIndex".
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addingIdx, setAddingIdx] = useState<number | null>(null);

  const run = async (force = false, technologies?: string[]) => {
    setLoading(true);
    if (force) setResult(null);
    try {
      const res = await discoverCustomers({
        data: {
          name: company.name,
          sector: company.sector,
          description: company.description,
          website: company.website,
          force,
          technologies,
        },
      });
      if (res.errorCode === "no_key") {
        setNotConfigured(true);
        return;
      }
      if (!res.found && res.error) {
        toast.error(res.error);
        return;
      }
      setResult(res);
      // Pre-select every decision-maker we found.
      const next = new Set<string>();
      res.opportunities.forEach((o, oi) => o.decisionMakers.forEach((_, pi) => next.add(`${oi}:${pi}`)));
      setSelected(next);
      if (res.opportunities.length === 0) {
        toast.info("No strong customer matches found. Try Refresh, or check the company's website/summary.");
      } else if (force) {
        toast.success(`Found ${res.opportunities.length} opportunities`);
      }
    } catch (e) {
      console.error("discoverCustomers failed", e);
      toast.error("Customer discovery failed — see console.");
    } finally {
      setLoading(false);
    }
  };

  // Generalized network search: kick off discovery on mount. A live run (force)
  // is used so an ad-hoc company/industry/technology search is always fresh
  // rather than served from a portfolio company's cache.
  useEffect(() => {
    if (!autoRun) return;
    const techs = (initialTechnologies || []).map((t) => t.trim()).filter(Boolean);
    void run(true, techs.length ? techs : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Run discovery against user-typed technologies (comma-separated).
  const runTechSearch = () => {
    const techs = techQuery.split(",").map((t) => t.trim()).filter(Boolean);
    if (techs.length === 0) {
      toast.error("Type at least one technology (e.g. Snowflake, Splunk).");
      return;
    }
    void run(true, techs);
  };

  // #9 — suggest the portco's competitors as selectable chips.
  const loadCompetitors = async () => {
    setLoadingComps(true);
    try {
      const res = await suggestCompetitors({
        data: { company: company.name, sector: company.sector, description: company.description },
      });
      if (res.ok && res.competitors) {
        setCompetitors(res.competitors);
        setSelectedComps(new Set());
        if (res.competitors.length === 0) toast.info("No competitors suggested for this company.");
      } else {
        toast.error(res.error || "Couldn't suggest competitors.");
      }
    } catch (e) {
      console.error("suggestCompetitors failed", e);
      toast.error("Competitor suggestion failed — see console.");
    } finally {
      setLoadingComps(false);
    }
  };

  const toggleComp = (c: string) => {
    setSelectedComps((prev) => {
      const n = new Set(prev);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n;
    });
  };

  const searchSelectedCompetitors = () => {
    const techs = [...selectedComps];
    if (techs.length === 0) {
      toast.error("Pick at least one competitor.");
      return;
    }
    void run(true, techs);
  };

  const togglePerson = (key: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  };

  const addForOpportunity = async (opp: OpportunityCompany, oi: number) => {
    const chosen: SumbleProspect[] = opp.decisionMakers.filter((_, pi) => selected.has(`${oi}:${pi}`));
    if (chosen.length === 0) {
      toast.error("Select at least one person to add.");
      return;
    }
    // Why each was surfaced — the company's evidence — retained on the target row.
    const reasonBits: string[] = [];
    if (opp.evidence?.techMatches?.length) reasonBits.push(`Uses ${opp.evidence.techMatches.slice(0, 3).join(", ")}`);
    if (opp.evidence?.hiringHits?.length) reasonBits.push(`Hiring: ${opp.evidence.hiringHits.slice(0, 2).join(", ")}`);
    if (opp.fitScore) reasonBits.push(`Fit ${opp.fitScore}/100`);
    const reason = reasonBits.join(" · ") || opp.suggestedMatch || `Potential customer for ${company.name}`;
    const withReason = chosen.map((p) => ({ ...p, reason }));

    setAddingIdx(oi);
    try {
      const res = await addProspectsToTargets({
        data: { prospects: withReason, source: `Customer Discovery — ${company.name}`, sourceKind: "Customer Discovery", focus: company.name },
      });
      const parts = [`Added ${res.added} target${res.added !== 1 ? "s" : ""}`];
      if (res.enriched) parts.push(`${res.enriched} enriched`);
      if (res.duplicates) parts.push(`${res.duplicates} dup${res.duplicates !== 1 ? "s" : ""} skipped`);
      if (res.failed) parts.push(`${res.failed} failed`);
      (res.failed ? toast.warning : toast.success)(parts.join(" · "));
      if (res.added > 0) await onImported?.();
    } catch (e) {
      console.error("addProspectsToTargets failed", e);
      toast.error("Adding failed — see console.");
    } finally {
      setAddingIdx(null);
    }
  };

  const header = (
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground flex items-center gap-1.5">
        <Target className="h-3 w-3 text-primary" /> Customer Discovery
      </h3>
      {result && result.opportunities.length > 0 && (
        <span className="flex items-center gap-2">
          {result.credits?.remaining != null && (
            <span className="text-[10px] text-muted-foreground">{result.credits.remaining.toLocaleString()} credits</span>
          )}
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" onClick={() => run(true)} disabled={loading}>
            <RefreshCw className={`h-3 w-3 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </span>
      )}
    </div>
  );

  if (notConfigured) {
    return (
      <div>
        {header}
        <div className="rounded border border-dashed border-border p-3 text-xs text-muted-foreground">
          Sumble isn't connected. Add <span className="font-mono">SUMBLE_API_KEY</span> to your{" "}
          <span className="font-mono">.env</span> to enable customer discovery.
        </div>
      </div>
    );
  }

  return (
    <div>
      {header}

      {/* Search by specific technologies (overrides the auto-profiled set). */}
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <Input
            value={techQuery}
            onChange={(e) => setTechQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runTechSearch(); }}
            placeholder="Search by technology (e.g. Snowflake, Splunk)"
            className="h-7 pl-7 text-[11px]"
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-[11px] shrink-0"
          onClick={runTechSearch}
          disabled={loading || !techQuery.trim()}
        >
          {loading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Search className="h-3 w-3 mr-1" />}
          Search
        </Button>
      </div>

      {/* #9 — suggested competitors as multi-select chips → drive the search. */}
      <div className="mb-3">
        {!competitors ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-[11px] px-2"
            onClick={loadCompetitors}
            disabled={loadingComps}
          >
            {loadingComps ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Swords className="h-3 w-3 mr-1" />}
            Suggest {company.name}'s competitors
          </Button>
        ) : (
          <div className="rounded-md border border-border bg-muted/20 p-2.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground inline-flex items-center gap-1">
                <Swords className="h-3 w-3" /> Competitors of {company.name}
              </span>
              <button
                type="button"
                onClick={loadCompetitors}
                disabled={loadingComps}
                className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                <RefreshCw className={`h-2.5 w-2.5 ${loadingComps ? "animate-spin" : ""}`} /> Regenerate
              </button>
            </div>
            {competitors.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">None suggested.</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {competitors.map((c) => {
                    const on = selectedComps.has(c);
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={() => toggleComp(c)}
                        className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                          on ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-accent"
                        }`}
                      >
                        {c}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between gap-2 pt-0.5">
                  <span className="text-[10px] text-muted-foreground">
                    Find companies already using the selected competitor{selectedComps.size !== 1 ? "s" : ""} (displacement targets).
                  </span>
                  <Button
                    size="sm"
                    className="h-7 text-[11px] shrink-0"
                    onClick={searchSelectedCompetitors}
                    disabled={loading || selectedComps.size === 0}
                  >
                    {loading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Search className="h-3 w-3 mr-1" />}
                    Search {selectedComps.size || ""}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {loading && !result ? (
        <DiscoveryLoading companyName={company.name} />
      ) : !result ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Find companies that already use comparable products and are likely customers for{" "}
            <span className="font-medium text-foreground">{company.name}</span>, or search specific technologies above.
          </p>
          <Button size="sm" className="h-7 text-[11px] shrink-0" onClick={() => run()} disabled={loading}>
            <Target className="h-3 w-3 mr-1" /> Find customers
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Run meta + seller profile */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
            {result.generatedAt && (
              <span title={result.cached ? "Loaded from saved cache — no credits spent" : "Freshly generated"}>
                {result.cached ? "Saved" : "Generated"} {result.generatedAt}
              </span>
            )}
            <span className="flex items-center gap-1">
              <Sparkles className="h-2.5 w-2.5" />
              {result.usedClaude ? "Gemini-scored" : "Heuristic-only"}
            </span>
          </div>

          {result.profile && result.profile.comparableTechnologies.length > 0 && (
            <div className="text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground">Looking for customers using:</span>{" "}
              {result.profile.comparableTechnologies.join(", ")}
            </div>
          )}

          {/* #1 Funnel transparency — where the search narrowed (and why zero). */}
          {result.funnel && result.funnel.length > 0 && (
            <div className="rounded-md border border-border bg-muted/20 p-2.5">
              <div className="text-[9px] uppercase tracking-wider font-semibold text-muted-foreground mb-1.5">
                Search funnel
              </div>
              <div className="space-y-0.5">
                {result.funnel.map((s, i) => (
                  <div key={i} className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground truncate pr-2">{s.stage}</span>
                    <span className={`font-semibold tabular-nums ${s.count === 0 ? "text-amber-600" : "text-foreground"}`}>
                      {s.count.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
              {result.funnelNote && (
                <p className="text-[10px] text-amber-700 mt-1.5 pt-1.5 border-t border-border">{result.funnelNote}</p>
              )}
            </div>
          )}

          {result.opportunities.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {result.funnelNote || "No strong customer matches found. Try Refresh, the technology search box, or make sure the company's summary describes its product."}
            </p>
          ) : (
            <div className="space-y-2.5">
              {result.opportunities.map((opp, oi) => (
                <OpportunityCard
                  key={`${opp.domain || opp.name}-${oi}`}
                  opp={opp}
                  oi={oi}
                  competitiveSet={result.profile?.comparableTechnologies ?? []}
                  selected={selected}
                  onToggle={togglePerson}
                  onAdd={() => addForOpportunity(opp, oi)}
                  adding={addingIdx === oi}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Multi-step loading screen shown while a discovery run is in flight. The
// engine doesn't emit progress events, so we cycle through the real stages it
// works through to give a sense of motion, backed by skeleton opportunity cards.
const DISCOVERY_STAGES = [
  "Profiling the product & ideal customer…",
  "Scanning technographic data for comparable tools…",
  "Matching companies & scoring fit…",
  "Surfacing decision-makers…",
  "Writing outreach angles…",
];

function DiscoveryLoading({ companyName }: { companyName: string }) {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setStage((s) => Math.min(s + 1, DISCOVERY_STAGES.length - 1));
    }, 2200);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-muted/20 p-3">
        <div className="flex items-center gap-2">
          <span className="relative flex h-4 w-4 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/40" />
            <Target className="relative h-4 w-4 text-primary" />
          </span>
          <span className="text-xs font-medium text-foreground">
            Finding likely customers for {companyName}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin shrink-0" />
          <span key={stage} className="animate-in fade-in slide-in-from-bottom-1 duration-300">
            {DISCOVERY_STAGES[stage]}
          </span>
        </div>
        {/* Stage progress pips */}
        <div className="mt-2 flex gap-1">
          {DISCOVERY_STAGES.map((_, i) => (
            <span
              key={i}
              className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
                i <= stage ? "bg-primary" : "bg-border"
              }`}
            />
          ))}
        </div>
      </div>

      {/* Skeleton opportunity cards. */}
      {[0, 1, 2].map((i) => (
        <div key={i} className="border border-border rounded-md p-2.5 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1.5">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-2 w-20" />
            </div>
            <Skeleton className="h-4 w-16 rounded-full" />
          </div>
          <div className="flex gap-1">
            <Skeleton className="h-3.5 w-14 rounded-full" />
            <Skeleton className="h-3.5 w-16 rounded-full" />
            <Skeleton className="h-3.5 w-12 rounded-full" />
          </div>
          <Skeleton className="h-8 w-full rounded" />
        </div>
      ))}
    </div>
  );
}

function OpportunityCard({
  opp,
  oi,
  competitiveSet,
  selected,
  onToggle,
  onAdd,
  adding,
}: {
  opp: OpportunityCompany;
  oi: number;
  competitiveSet: string[];
  selected: Set<string>;
  onToggle: (key: string) => void;
  onAdd: () => void;
  adding: boolean;
}) {
  const selectedCount = opp.decisionMakers.filter((_, pi) => selected.has(`${oi}:${pi}`)).length;

  return (
    <div className="border border-border rounded-md p-2.5 space-y-2">
      {/* Header: company + fit score */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold truncate">{opp.name}</span>
            {opp.domain && (
              <a
                href={`https://${opp.domain}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary shrink-0"
                title={opp.domain}
              >
                <ExternalLink className="h-2.5 w-2.5" />
              </a>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-1.5 text-[10px] text-muted-foreground">
            {opp.industry && <span>{opp.industry}</span>}
            {opp.employees != null && <span>· {opp.employees.toLocaleString()} emp</span>}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <CompetitorPopover opp={opp} competitiveSet={competitiveSet} />
          <Badge variant="outline" className={`text-[10px] ${scoreClasses(opp.fitScore)}`}>
            {opp.fitScore} · {opp.likelihood}
          </Badge>
        </div>
      </div>

      {/* Evidence chips */}
      <div className="flex flex-wrap gap-1">
        {opp.evidence.techMatches.map((t) => (
          <Badge key={`t-${t}`} variant="secondary" className="text-[9px] px-1 py-0 flex items-center gap-0.5">
            <Cpu className="h-2.5 w-2.5" /> {t}
          </Badge>
        ))}
        {opp.evidence.hiringHits.map((h) => (
          <Badge key={`h-${h}`} variant="secondary" className="text-[9px] px-1 py-0 flex items-center gap-0.5">
            <Briefcase className="h-2.5 w-2.5" /> {h}
          </Badge>
        ))}
        {opp.evidence.industryMatch && (
          <Badge variant="secondary" className="text-[9px] px-1 py-0">industry fit</Badge>
        )}
        {opp.evidence.sizeMatch && (
          <Badge variant="secondary" className="text-[9px] px-1 py-0">size fit</Badge>
        )}
      </div>

      {/* Outreach angle */}
      {opp.outreachAngle && (
        <div className="rounded bg-muted/40 border border-border/60 p-1.5 flex gap-1.5">
          <Lightbulb className="h-3 w-3 text-amber-500 shrink-0 mt-0.5" />
          <p className="text-[10px] text-muted-foreground leading-snug">{opp.outreachAngle}</p>
        </div>
      )}

      {/* Decision-makers */}
      {opp.decisionMakers.length > 0 ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[9px] uppercase tracking-wider font-semibold text-muted-foreground">
              Decision-makers ({opp.decisionMakers.length})
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-1.5 text-[10px]"
              onClick={onAdd}
              disabled={adding || selectedCount === 0}
            >
              {adding ? (
                <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Adding…</>
              ) : (
                <><UserPlus className="h-3 w-3 mr-1" /> Add {selectedCount || ""} as Cold</>
              )}
            </Button>
          </div>
          {opp.decisionMakers.map((p, pi) => {
            const key = `${oi}:${pi}`;
            return (
              <div key={key} className="flex items-center gap-2 py-0.5">
                <Checkbox checked={selected.has(key)} onCheckedChange={() => onToggle(key)} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] font-medium truncate">{p.name}</span>
                    {p.jobLevel && <Badge variant="secondary" className="text-[8px] px-1 py-0">{p.jobLevel}</Badge>}
                  </div>
                  <p className="text-[10px] text-muted-foreground truncate">{p.title || "—"}</p>
                </div>
                {p.linkedinUrl && (
                  <a href={p.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-primary shrink-0">
                    <Linkedin className="h-3 w-3" />
                  </a>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-[10px] text-muted-foreground">No decision-makers surfaced for this company.</p>
      )}
    </div>
  );
}

// A popup that shows the competitor products this prospect already runs (from the
// detected tech matches) against the portco's full competitive set. Competitors
// already in use = displacement targets; an empty set = greenfield.
function CompetitorPopover({ opp, competitiveSet }: { opp: OpportunityCompany; competitiveSet: string[] }) {
  const inUse = opp.evidence.techMatches;
  const inUseLower = new Set(inUse.map((t) => t.toLowerCase()));
  // Competitors in the seller's set that this prospect is NOT detected using.
  const notDetected = competitiveSet.filter((t) => !inUseLower.has(t.toLowerCase()));

  // Nothing to show.
  if (inUse.length === 0 && competitiveSet.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-0.5 rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          title="View competitors in use"
        >
          <Swords className="h-2.5 w-2.5" />
          {inUse.length > 0 && <span>{inUse.length}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3 space-y-2.5">
        <div className="flex items-center gap-1.5">
          <Swords className="h-3.5 w-3.5 text-primary" />
          <span className="text-xs font-semibold">Competitors in use</span>
        </div>
        <p className="text-[10px] text-muted-foreground -mt-1">{opp.name}</p>

        <div className="space-y-1">
          {inUse.length > 0 ? (
            <>
              <span className="text-[9px] uppercase tracking-wider font-semibold text-emerald-600">
                Already running ({inUse.length})
              </span>
              <div className="flex flex-wrap gap-1">
                {inUse.map((t) => (
                  <Badge
                    key={`u-${t}`}
                    variant="outline"
                    className="text-[9px] px-1 py-0 bg-emerald-500/10 text-emerald-700 border-emerald-500/30 flex items-center gap-0.5"
                  >
                    <Cpu className="h-2.5 w-2.5" /> {t}
                  </Badge>
                ))}
              </div>
            </>
          ) : (
            <p className="text-[10px] text-muted-foreground">
              No competitor products detected in use — likely a greenfield account.
            </p>
          )}
        </div>

        {competitiveSet.length > 0 && (
          <div className="space-y-1 border-t border-border pt-2">
            <span className="text-[9px] uppercase tracking-wider font-semibold text-muted-foreground">
              Full competitive set
            </span>
            <div className="flex flex-wrap gap-1">
              {competitiveSet.map((t) => {
                const used = inUseLower.has(t.toLowerCase());
                return (
                  <Badge
                    key={`s-${t}`}
                    variant="outline"
                    className={`text-[9px] px-1 py-0 flex items-center gap-0.5 ${
                      used ? "bg-emerald-500/10 text-emerald-700 border-emerald-500/30" : "text-muted-foreground"
                    }`}
                  >
                    {used && <Check className="h-2.5 w-2.5" />} {t}
                  </Badge>
                );
              })}
            </div>
            {notDetected.length > 0 && inUse.length > 0 && (
              <p className="text-[9px] text-muted-foreground">Not detected: {notDetected.join(", ")}.</p>
            )}
          </div>
        )}

        <p className="text-[10px] text-muted-foreground border-t border-border pt-2 flex gap-1">
          <Lightbulb className="h-3 w-3 text-amber-500 shrink-0 mt-0.5" />
          {inUse.length > 0
            ? "Already invested in a competitor — lead with a displacement angle and switching cost."
            : "No competitor in place — lead with the category value prop, not displacement."}
        </p>
      </PopoverContent>
    </Popover>
  );
}
