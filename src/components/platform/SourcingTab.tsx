import { Link } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Compass, SearchCheck } from "lucide-react";
import type { Thesis, ThesisCoverage, ThesisMatch } from "@/lib/platform-thesis";
import {
  PLATFORM_SEGMENT_CLASS,
  PlatformArticleCard,
  opportunityChipClass,
} from "./PlatformArticleCard";
import { ThesisPanel } from "./ThesisPanel";

// One non-portfolio company ranked from stored signals (computed in the
// /platform loader's deferred sourcing lens — no new scans, no LLM calls).
export interface SourcingRow {
  company: string;
  segment: string;
  headline: string;
  timeLabel: string;
  sortTs: number;
  opportunity: number;
  networkLevel: string;
  networkCount: number;
  signalCount: number;
  /** Optional logo domain from the winning FeedCard. */
  logoDomain?: string;
  /** Optional summary from the winning signal. */
  summary?: string;
}

export function SourcingSkeleton() {
  return (
    <div className="mx-auto max-w-4xl space-y-3 animate-pulse">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-36 rounded-xl bg-muted/50" />
      ))}
    </div>
  );
}

// Deal-sourcing lens over the existing Signal Radar (non-portfolio companies
// ranked by grounded opportunity score) with the thesis registry on top:
// define criteria once, screen on demand, promote matches into Targets.
export function SourcingTab({
  rows,
  theses,
  matches,
  coverage,
  companyContacts,
  userEmail,
  onThesesChanged,
  onMatchesChanged,
  onDiligence,
}: {
  rows: SourcingRow[];
  theses: Thesis[];
  matches: ThesisMatch[];
  coverage: Record<string, ThesisCoverage>;
  companyContacts: Record<string, number>;
  userEmail: string;
  onThesesChanged: (next: Thesis[]) => void;
  onMatchesChanged: (next: ThesisMatch[]) => void;
  onDiligence: (company: string) => void;
}) {
  const thesisPanel = (
    <ThesisPanel
      theses={theses}
      matches={matches}
      coverage={coverage}
      companyContacts={companyContacts}
      userEmail={userEmail}
      onThesesChanged={onThesesChanged}
      onMatchesChanged={onMatchesChanged}
      onDiligence={onDiligence}
    />
  );

  if (rows.length === 0) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        {thesisPanel}
        <div className="text-center py-16 rounded-xl border border-dashed border-border">
          <Compass className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">No sourcing signals yet.</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            This view ranks non-portfolio companies from stored signals.{" "}
            <Link to="/signals" className="text-primary hover:underline">
              Run a scan on Signals
            </Link>{" "}
            to populate it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-3">
      {thesisPanel}
      <div className="flex items-center justify-between px-0.5 pt-3">
        <p className="text-xs text-muted-foreground">
          {rows.length} compan{rows.length === 1 ? "y" : "ies"} from stored signals
        </p>
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Sorted by opportunity
        </p>
      </div>

      {rows.map((r) => {
        const summaryParts = [
          r.summary,
          r.networkCount > 0
            ? `${r.networkCount} warm path${r.networkCount !== 1 ? "s" : ""} in network`
            : null,
          r.signalCount > 1
            ? `+${r.signalCount - 1} more signal${r.signalCount > 2 ? "s" : ""}`
            : null,
        ].filter(Boolean);

        return (
          <PlatformArticleCard
            key={r.company}
            company={r.company}
            domain={r.logoDomain}
            timeLabel={r.timeLabel}
            headline={r.headline || r.company}
            summary={summaryParts.join(" · ") || undefined}
            badges={
              <>
                <span className="text-muted-foreground/60">·</span>
                <Badge variant="outline" className="text-[10px] bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-900">
                  Sourcing
                </Badge>
                {r.segment && (
                  <Badge
                    variant="outline"
                    className={`text-[10px] ${PLATFORM_SEGMENT_CLASS[r.segment] || ""}`}
                  >
                    {r.segment}
                  </Badge>
                )}
              </>
            }
            footer={
              <>
                <Badge
                  variant="outline"
                  className={`text-[10px] tabular-nums ${opportunityChipClass(r.opportunity)}`}
                >
                  Opportunity {r.opportunity}
                </Badge>
                {r.networkLevel && r.networkLevel !== "none" && (
                  <span className="text-[11px] text-muted-foreground">
                    Network · {r.networkLevel}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1.5">
                  <Button asChild size="sm" variant="ghost" className="h-7 text-xs px-2">
                    <Link to="/companies" search={{ c: r.company }}>
                      Brief
                    </Link>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs px-2"
                    onClick={() => onDiligence(r.company)}
                  >
                    <SearchCheck className="h-3 w-3 mr-1" /> Diligence
                  </Button>
                </div>
              </>
            }
          />
        );
      })}
    </div>
  );
}
