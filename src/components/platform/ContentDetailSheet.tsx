import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Check, ExternalLink, FileDown, Loader2, Plus, Printer, Star } from "lucide-react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { MarkdownMessage } from "@/components/query/MarkdownMessage";
import { ContentTypeBadge } from "./ContentHistoryList";
import { downloadWordDoc, printContentPdf } from "./export-content";
import { addRadarEntry } from "@/utils/platform.functions";
import type {
  BoardArticlePayload,
  Confidence,
  DiligencePayload,
  ExecBriefPayload,
  LandscapePlayer,
  MgmtQuestionsPayload,
  PlatformContentRow,
  RadarEntry,
} from "@/lib/platform-content";

const sectionLabel = "text-[10px] uppercase tracking-wider font-semibold text-muted-foreground";

type SourceMeta = { url: string; title: string; domain: string };

/** Bare hostname for a URL (fallback when no publisher metadata is stored). */
function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

/** A readable citation label: "Publisher · domain", or just the domain. */
function citeLabel(url: string, meta?: Map<string, SourceMeta>): string {
  const m = meta?.get(url);
  const domain = m?.domain || hostname(url);
  const title = (m?.title || "").trim();
  return title && title.toLowerCase() !== domain.toLowerCase() ? `${title} · ${domain}` : domain;
}

/** Inline source citation — shows the publisher, not the raw URL. */
function Cite({
  url,
  meta,
  className = "",
}: {
  url?: string;
  meta?: Map<string, SourceMeta>;
  className?: string;
}) {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline align-baseline ${className}`}
    >
      <ExternalLink className="h-3 w-3 shrink-0" />
      {citeLabel(url, meta)}
    </a>
  );
}

function SourceLinks({ urls, meta }: { urls: string[]; meta?: Map<string, SourceMeta> }) {
  if (urls.length === 0) return null;
  return (
    <div>
      <p className={sectionLabel}>Sources (grounded)</p>
      <ul className="mt-1 space-y-1">
        {urls.map((u, i) => (
          <li key={i} className="text-[11px] leading-tight">
            <a
              href={u}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-1 font-medium"
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              {citeLabel(u, meta)}
            </a>
            <span className="text-muted-foreground break-all"> — {u}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function QuestionList({
  questions,
}: {
  questions: { area: string; question: string; why: string }[];
}) {
  const areas = [...new Set(questions.map((q) => q.area || "General"))];
  return (
    <div className="space-y-3">
      {areas.map((area) => (
        <div key={area}>
          <p className={sectionLabel}>{area}</p>
          <ul className="mt-1 space-y-2">
            {questions
              .filter((q) => (q.area || "General") === area)
              .map((q, i) => (
                <li key={i} className="text-sm">
                  <p className="text-foreground">{q.question}</p>
                  {q.why && (
                    <p className="text-[11px] text-muted-foreground mt-0.5">Why: {q.why}</p>
                  )}
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function LandscapeTier({
  label,
  players,
  meta,
  ctx,
  theme,
}: {
  label: string;
  players: LandscapePlayer[];
  meta?: Map<string, SourceMeta>;
  ctx?: WatchCtx;
  theme?: string;
}) {
  if (!players?.length) return null;
  return (
    <div>
      <p className="text-[11px] font-semibold text-foreground/80">{label}</p>
      <ul className="mt-1 space-y-1">
        {players.map((x, i) => (
          <li key={i} className="text-sm flex items-start gap-1.5 flex-wrap">
            <CompanyLink name={x.company} />
            {x.note && <span className="text-muted-foreground">— {x.note}</span>}
            <Cite url={x.sourceUrl} meta={meta} />
            <WatchButton company={x.company} segment={label} theme={theme} ctx={ctx} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Connectivity + visualization primitives ──────────────────────

/** Shared context for the "Watch → Competitive Radar" action. */
type WatchCtx = {
  userEmail?: string;
  watched: Set<string>;
  onWatched: (company: string, entry: RadarEntry) => void;
};

/** A company name linked to its entity page (/companies). */
function CompanyLink({ name, className = "" }: { name: string; className?: string }) {
  if (!name) return null;
  return (
    <Link
      to="/companies"
      search={{ c: name }}
      className={`font-medium text-foreground hover:text-primary hover:underline ${className}`}
    >
      {name}
    </Link>
  );
}

/** Adds a company to the Competitive Radar; hidden when no user context. */
function WatchButton({
  company,
  segment,
  theme,
  note,
  ctx,
}: {
  company: string;
  segment?: string;
  theme?: string;
  note?: string;
  ctx?: WatchCtx;
}) {
  const [busy, setBusy] = useState(false);
  if (!ctx?.userEmail || !company) return null;
  const done = ctx.watched.has(company.toLowerCase());
  const onClick = async () => {
    if (done || busy) return;
    setBusy(true);
    try {
      const entry = await addRadarEntry({
        data: { entry: { company, segment, theme, note }, addedBy: ctx.userEmail! },
      });
      ctx.onWatched(company, entry);
      toast.success(`Watching ${company}.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't add to the radar.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || done}
      title={done ? "On the competitive radar" : "Add to competitive radar"}
      className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-primary hover:border-primary disabled:opacity-60 shrink-0"
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : done ? (
        <Check className="h-3 w-3" />
      ) : (
        <Plus className="h-3 w-3" />
      )}
      {done ? "Watching" : "Watch"}
    </button>
  );
}

function Stars({ n, max = 5 }: { n: number; max?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${n} of ${max}`}>
      {Array.from({ length: max }, (_, i) => (
        <Star
          key={i}
          className={`h-3.5 w-3.5 ${i < n ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30"}`}
        />
      ))}
    </span>
  );
}

function StatTile({ label, value, accent }: { label: string; value: ReactNode; accent?: boolean }) {
  return (
    <div
      className={`rounded-lg border p-2.5 ${accent ? "border-primary/50 bg-primary/5" : "border-border"}`}
    >
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="mt-1 text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}

function ScoreBar({ label, score, note }: { label: string; score: number; note?: string }) {
  const pct = Math.max(0, Math.min(10, score)) * 10;
  const color =
    score >= 8
      ? "bg-emerald-500"
      : score >= 6
        ? "bg-primary"
        : score >= 4
          ? "bg-amber-500"
          : "bg-red-500";
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-0.5">
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted-foreground tabular-nums">{score}/10</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      {note && <p className="text-[10px] text-muted-foreground mt-0.5">{note}</p>}
    </div>
  );
}

function ConfidenceBadge({ level }: { level?: Confidence }) {
  if (!level) return null;
  const map: Record<Confidence, string> = {
    high: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30",
    medium: "bg-amber-500/10 text-amber-600 border-amber-500/30",
    speculative: "bg-muted text-muted-foreground border-border",
  };
  return (
    <Badge variant="outline" className={`text-[9px] capitalize ${map[level]}`}>
      {level}
    </Badge>
  );
}

function RiskColumn({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null;
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-[11px] font-semibold text-foreground/80 mb-1">{title}</p>
      <ul className="space-y-1 list-disc pl-4">
        {items.map((r, i) => (
          <li key={i} className="text-[11px] text-muted-foreground">
            {r}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExecBriefBody({
  p,
  subject,
  userEmail,
  onRadarAdded,
}: {
  p: ExecBriefPayload;
  subject: string;
  userEmail?: string;
  onRadarAdded?: (entry: RadarEntry) => void;
}) {
  const meta = new Map<string, SourceMeta>(
    (p.sourceMeta ?? []).map((m) => [m.url, m] as [string, SourceMeta]),
  );
  const [watched, setWatched] = useState<Set<string>>(new Set());
  const ctx: WatchCtx = {
    userEmail,
    watched,
    onWatched: (company, entry) => {
      setWatched((prev) => new Set(prev).add(company.toLowerCase()));
      onRadarAdded?.(entry);
    },
  };
  const theme = subject;

  const g = p.atAGlance;
  const glanceOn =
    !!g &&
    (g.stageAttractiveness ||
      g.marketMaturity ||
      g.capitalIntensity ||
      g.competitiveDensity ||
      g.exitWindow ||
      g.convictionScore);
  const dyn = p.marketDynamics;
  const dynFields: { label: string; value?: string }[] = [
    { label: "Budget owners", value: dyn?.budgetOwners },
    { label: "Buying cycle", value: dyn?.buyingCycle },
    { label: "Existing spend", value: dyn?.existingSpend },
    { label: "New spend", value: dyn?.newSpend },
    { label: "Adoption curve", value: dyn?.adoptionCurve },
    { label: "Procurement friction", value: dyn?.procurementFriction },
    { label: "Replacement vs. net-new", value: dyn?.replacementVsNetNew },
    { label: "Unit economics", value: dyn?.unitEconomics },
    { label: "Purchasing drivers", value: dyn?.purchasingDrivers },
  ].filter((f) => f.value);
  const legacyLand = p.marketLandscape;
  const legacyLandCount =
    (legacyLand?.incumbents?.length ?? 0) +
    (legacyLand?.upstarts?.length ?? 0) +
    (legacyLand?.emerging?.length ?? 0);
  const fund = p.fundingLandscape;
  const exit = p.exitLandscape;
  const risksOn =
    (p.technicalRisks?.length ?? 0) +
      (p.commercialRisks?.length ?? 0) +
      (p.regulatoryRisks?.length ?? 0) >
    0;

  return (
    <div className="space-y-5">
      {/* Investment thesis */}
      {(p.thesis || p.tldr) && (
        <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
          <p className={sectionLabel}>Investment thesis</p>
          <MarkdownMessage text={p.thesis || p.tldr} />
        </div>
      )}

      {/* At a glance */}
      {glanceOn && (
        <div>
          <p className={sectionLabel}>At a glance</p>
          <div className="mt-1.5 grid grid-cols-2 sm:grid-cols-3 gap-2">
            {g!.convictionScore != null && (
              <StatTile
                label="VC conviction"
                accent
                value={<span className="text-lg">{g!.convictionScore.toFixed(1)} / 10</span>}
              />
            )}
            {g!.stageAttractiveness != null && (
              <StatTile label="Stage attractiveness" value={<Stars n={g!.stageAttractiveness} />} />
            )}
            {g!.marketMaturity && <StatTile label="Market maturity" value={g!.marketMaturity} />}
            {g!.capitalIntensity && (
              <StatTile label="Capital intensity" value={g!.capitalIntensity} />
            )}
            {g!.competitiveDensity && (
              <StatTile label="Competitive density" value={g!.competitiveDensity} />
            )}
            {g!.exitWindow && <StatTile label="Exit window" value={g!.exitWindow} />}
          </div>
        </div>
      )}

      {/* Investment scorecard */}
      {(p.scorecard?.length ?? 0) > 0 && (
        <div>
          <p className={sectionLabel}>Investment scorecard</p>
          <p className="text-[10px] text-muted-foreground mb-2">
            10 = most attractive to an investor.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
            {p.scorecard!.map((s, i) => (
              <ScoreBar key={i} label={s.category} score={s.score} note={s.note} />
            ))}
          </div>
        </div>
      )}

      {/* Why now */}
      {(p.whyNow?.length ?? 0) > 0 && (
        <div>
          <p className={sectionLabel}>Why now</p>
          <ul className="mt-1 space-y-1.5">
            {p.whyNow!.map((w, i) => (
              <li key={i} className="text-sm">
                <span className="font-medium text-foreground">{w.driver}</span>
                {w.detail && <span className="text-muted-foreground"> — {w.detail}</span>}
                {w.sourceUrl && <Cite url={w.sourceUrl} meta={meta} className="ml-1" />}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Market dynamics */}
      {(dyn?.narrative || dynFields.length > 0) && (
        <div>
          <p className={sectionLabel}>Market dynamics</p>
          {dyn?.narrative && <MarkdownMessage text={dyn.narrative} />}
          {dynFields.length > 0 && (
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
              {dynFields.map((f, i) => (
                <div key={i} className="rounded-lg border border-border p-2">
                  <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
                    {f.label}
                  </p>
                  <p className="text-xs text-foreground mt-0.5">{f.value}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Market sizing */}
      {(p.marketSizing?.narrative || (p.marketSizing?.figures?.length ?? 0) > 0) && (
        <div>
          <p className={sectionLabel}>Market sizing &amp; study</p>
          {p.marketSizing?.narrative && <MarkdownMessage text={p.marketSizing.narrative} />}
          {(p.marketSizing?.figures?.length ?? 0) > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {p.marketSizing!.figures.map((f, i) => (
                <div key={i} className="rounded-lg border border-border px-3 py-1.5">
                  <span className="text-sm font-semibold text-foreground tabular-nums">
                    {f.value}
                  </span>
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {f.label}
                  </p>
                  {f.sourceUrl && <Cite url={f.sourceUrl} meta={meta} className="mt-0.5" />}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Competitive landscape (grouped) */}
      {(p.competitiveLandscape?.length ?? 0) > 0 && (
        <div>
          <p className={sectionLabel}>Competitive landscape</p>
          <div className="mt-1 space-y-3">
            {p.competitiveLandscape!.map((grp, i) => (
              <div key={i}>
                <p className="text-[11px] font-semibold text-foreground/80">{grp.category}</p>
                <ul className="mt-1 space-y-1">
                  {grp.companies.map((c, j) => (
                    <li key={j} className="text-sm flex items-start gap-1.5 flex-wrap">
                      <CompanyLink name={c.company} />
                      {c.tier && (
                        <Badge variant="outline" className="text-[9px] capitalize">
                          {c.tier}
                        </Badge>
                      )}
                      {c.note && <span className="text-muted-foreground">— {c.note}</span>}
                      {c.sourceUrl && <Cite url={c.sourceUrl} meta={meta} />}
                      <WatchButton
                        company={c.company}
                        segment={grp.category}
                        theme={theme}
                        ctx={ctx}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Legacy three-tier landscape (older rows only) */}
      {(p.competitiveLandscape?.length ?? 0) === 0 && legacyLandCount > 0 && (
        <div>
          <p className={sectionLabel}>Market landscape</p>
          <div className="mt-1 space-y-3">
            <LandscapeTier
              label="Large incumbents"
              players={legacyLand!.incumbents}
              meta={meta}
              ctx={ctx}
              theme={theme}
            />
            <LandscapeTier
              label="Mid-size upstarts"
              players={legacyLand!.upstarts}
              meta={meta}
              ctx={ctx}
              theme={theme}
            />
            <LandscapeTier
              label="Emerging startups"
              players={legacyLand!.emerging}
              meta={meta}
              ctx={ctx}
              theme={theme}
            />
          </div>
        </div>
      )}

      {/* Funding landscape */}
      {fund && (fund.summary || fund.largestRounds?.length || fund.benchmarks?.length) && (
        <div>
          <p className={sectionLabel}>Funding landscape</p>
          {fund.summary && <MarkdownMessage text={fund.summary} />}
          {(fund.benchmarks?.length ?? 0) > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {fund.benchmarks!.map((b, i) => (
                <div key={i} className="rounded-lg border border-border px-3 py-1.5">
                  <span className="text-sm font-semibold text-foreground tabular-nums">
                    {b.value}
                  </span>
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {b.label}
                  </p>
                </div>
              ))}
            </div>
          )}
          {(fund.largestRounds?.length ?? 0) > 0 && (
            <div className="mt-2 space-y-1">
              {fund.largestRounds!.map((r, i) => (
                <div key={i} className="text-sm flex items-start gap-1.5 flex-wrap">
                  <CompanyLink name={r.company} />
                  {r.amount && (
                    <span className="font-semibold text-emerald-600 tabular-nums">{r.amount}</span>
                  )}
                  {r.stage && (
                    <Badge variant="outline" className="text-[9px]">
                      {r.stage}
                    </Badge>
                  )}
                  {r.investors && <span className="text-muted-foreground">— {r.investors}</span>}
                  {r.sourceUrl && <Cite url={r.sourceUrl} meta={meta} />}
                </div>
              ))}
            </div>
          )}
          {(fund.activeInvestors?.length ?? 0) > 0 && (
            <div className="mt-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                Most active investors
              </p>
              <div className="flex flex-wrap gap-1.5">
                {fund.activeInvestors!.map((inv, i) => (
                  <span
                    key={i}
                    className="text-[11px] px-2 py-0.5 rounded-full border border-border bg-muted/40"
                  >
                    {inv}
                  </span>
                ))}
              </div>
            </div>
          )}
          {(fund.recentAcquisitions?.length ?? 0) > 0 && (
            <ul className="mt-2 space-y-1 list-disc pl-4">
              {fund.recentAcquisitions!.map((a, i) => (
                <li key={i} className="text-xs text-muted-foreground">
                  {a.detail}
                  {a.sourceUrl && <Cite url={a.sourceUrl} meta={meta} className="ml-1" />}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Legacy capital flows (older rows only) */}
      {!fund && (p.capitalFlows?.summary || (p.capitalFlows?.hotspots?.length ?? 0) > 0) && (
        <div>
          <p className={sectionLabel}>Where the VC dollars are flowing</p>
          {p.capitalFlows?.summary && <MarkdownMessage text={p.capitalFlows.summary} />}
          {(p.capitalFlows?.hotspots?.length ?? 0) > 0 && (
            <ul className="mt-1 space-y-2">
              {p.capitalFlows!.hotspots.map((h, i) => (
                <li key={i} className="text-sm">
                  <span className="font-medium text-foreground">{h.area}</span>
                  {h.detail && <span className="text-muted-foreground"> — {h.detail}</span>}
                  {h.sourceUrl && <Cite url={h.sourceUrl} meta={meta} className="ml-1" />}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Founder map */}
      {(p.founderMap?.length ?? 0) > 0 && (
        <div>
          <p className={sectionLabel}>Founder map</p>
          <div className="mt-1 space-y-2">
            {p.founderMap!.map((f, i) => (
              <div key={i} className="rounded-lg border border-border p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <CompanyLink name={f.company} />
                  {f.location && (
                    <span className="text-[11px] text-muted-foreground">{f.location}</span>
                  )}
                  {f.sourceUrl && <Cite url={f.sourceUrl} meta={meta} />}
                </div>
                <p className="text-xs text-foreground mt-1">{f.founders}</p>
                {f.background && (
                  <p className="text-[11px] text-muted-foreground mt-0.5">{f.background}</p>
                )}
                {f.investors && (
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    <span className="font-semibold">Backers:</span> {f.investors}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Value chain / ecosystem */}
      {(p.valueChain?.length ?? 0) > 0 && (
        <div>
          <p className={sectionLabel}>Ecosystem &amp; value chain</p>
          <div className="mt-1.5 space-y-1">
            {p.valueChain!.map((l, i) => (
              <div key={i}>
                <div className="rounded-lg border border-border p-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground">{l.layer}</span>
                    {l.players && (
                      <span className="text-[10px] text-muted-foreground">{l.players}</span>
                    )}
                  </div>
                  {l.description && (
                    <p className="text-[11px] text-muted-foreground mt-0.5">{l.description}</p>
                  )}
                </div>
                {i < p.valueChain!.length - 1 && (
                  <div className="text-center text-muted-foreground/50 text-xs leading-none">↓</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* White space */}
      {(p.whiteSpace?.length ?? 0) > 0 && (
        <div>
          <p className={sectionLabel}>White space — what doesn't exist yet</p>
          <div className="mt-1 space-y-2">
            {p.whiteSpace!.map((w, i) => (
              <div key={i} className="rounded-lg border border-dashed border-border p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-foreground">{w.opportunity}</span>
                  {w.category && (
                    <Badge variant="outline" className="text-[9px]">
                      {w.category}
                    </Badge>
                  )}
                  <ConfidenceBadge level={w.confidence} />
                </div>
                {w.rationale && <p className="text-xs text-muted-foreground mt-1">{w.rationale}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Where we would invest */}
      {(p.investHere?.length ?? 0) > 0 && (
        <div>
          <p className={sectionLabel}>Where we would invest</p>
          <div className="mt-1 space-y-1.5">
            {[...p.investHere!]
              .sort((a, b) => b.conviction - a.conviction)
              .map((iv, i) => (
                <div key={i} className="text-sm">
                  <div className="flex items-center gap-2">
                    <Stars n={iv.conviction} />
                    <span className="font-medium text-foreground">{iv.area}</span>
                  </div>
                  {iv.rationale && (
                    <p className="text-[11px] text-muted-foreground">{iv.rationale}</p>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Where we wouldn't invest */}
      {(p.avoidHere?.length ?? 0) > 0 && (
        <div>
          <p className={sectionLabel}>Where we wouldn't invest</p>
          <ul className="mt-1 space-y-1">
            {p.avoidHere!.map((a, i) => (
              <li key={i} className="text-sm">
                <span className="font-medium text-foreground">{a.area}</span>
                {a.reason && <span className="text-muted-foreground"> — {a.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Bull / base / bear */}
      {p.scenarios && (p.scenarios.bull || p.scenarios.base || p.scenarios.bear) && (
        <div>
          <p className={sectionLabel}>Bull · base · bear</p>
          <div className="mt-1 space-y-2">
            {p.scenarios.bull && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2.5">
                <p className="text-[11px] font-semibold text-emerald-600">Bull</p>
                <p className="text-xs text-foreground mt-0.5">{p.scenarios.bull}</p>
              </div>
            )}
            {p.scenarios.base && (
              <div className="rounded-lg border border-border p-2.5">
                <p className="text-[11px] font-semibold text-foreground/80">Base</p>
                <p className="text-xs text-foreground mt-0.5">{p.scenarios.base}</p>
              </div>
            )}
            {p.scenarios.bear && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-2.5">
                <p className="text-[11px] font-semibold text-red-600">Bear</p>
                <p className="text-xs text-foreground mt-0.5">{p.scenarios.bear}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Risks */}
      {risksOn && (
        <div>
          <p className={sectionLabel}>Risks</p>
          <div className="mt-1 grid grid-cols-1 sm:grid-cols-3 gap-2">
            <RiskColumn title="Technical" items={p.technicalRisks} />
            <RiskColumn title="Commercial" items={p.commercialRisks} />
            <RiskColumn title="Regulatory" items={p.regulatoryRisks} />
          </div>
        </div>
      )}

      {/* Recent developments */}
      {p.keyDevelopments?.length > 0 && (
        <div>
          <p className={sectionLabel}>Recent developments</p>
          <ul className="mt-1 space-y-2">
            {p.keyDevelopments.map((d, i) => (
              <li key={i} className="text-sm">
                <p className="font-medium text-foreground">{d.point}</p>
                {d.detail && <p className="text-xs text-muted-foreground mt-0.5">{d.detail}</p>}
                {d.sourceUrl && <Cite url={d.sourceUrl} meta={meta} className="mt-0.5" />}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Emerging startups */}
      {(p.prospectiveCompanies?.length ?? 0) > 0 && (
        <div>
          <p className={sectionLabel}>Emerging startups to explore (Seed–Series B)</p>
          <div className="mt-1 space-y-2">
            {p.prospectiveCompanies!.map((c, i) => (
              <div key={i} className="rounded-lg border border-border p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <CompanyLink name={c.company} />
                  {c.stage && (
                    <Badge
                      variant="outline"
                      className="text-[9px] bg-emerald-500/10 text-emerald-600 border-emerald-500/30"
                    >
                      {c.stage}
                    </Badge>
                  )}
                  {c.sourceUrl && <Cite url={c.sourceUrl} meta={meta} />}
                  <WatchButton
                    company={c.company}
                    segment={c.stage}
                    theme={theme}
                    note={c.whyFits}
                    ctx={ctx}
                  />
                </div>
                {c.whatTheyDo && (
                  <p className="text-xs text-muted-foreground mt-1">{c.whatTheyDo}</p>
                )}
                {c.whyFits && (
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    <span className="font-semibold">Thesis fit:</span> {c.whyFits}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Open source */}
      {(p.openSource?.length ?? 0) > 0 && (
        <div>
          <p className={sectionLabel}>Open-source &amp; research traction</p>
          <ul className="mt-1 space-y-1.5">
            {p.openSource!.map((o, i) => (
              <li key={i} className="text-sm">
                <span className="font-medium text-foreground">{o.project}</span>
                {o.detail && <span className="text-muted-foreground"> — {o.detail}</span>}
                {o.sourceUrl && <Cite url={o.sourceUrl} meta={meta} className="ml-1" />}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Exit landscape */}
      {exit &&
        (exit.note ||
          exit.likelyAcquirers?.length ||
          exit.ipoCandidates?.length ||
          exit.recentDeals?.length) && (
          <div>
            <p className={sectionLabel}>Exit landscape</p>
            {exit.note && <MarkdownMessage text={exit.note} />}
            {(exit.likelyAcquirers?.length ?? 0) > 0 && (
              <div className="mt-1.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                  Likely acquirers
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {exit.likelyAcquirers!.map((a, i) => (
                    <span
                      key={i}
                      className="text-[11px] px-2 py-0.5 rounded-full border border-border bg-muted/40"
                    >
                      <CompanyLink name={a} />
                    </span>
                  ))}
                </div>
              </div>
            )}
            {(exit.ipoCandidates?.length ?? 0) > 0 && (
              <div className="mt-1.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                  IPO candidates
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {exit.ipoCandidates!.map((a, i) => (
                    <span
                      key={i}
                      className="text-[11px] px-2 py-0.5 rounded-full border border-border bg-muted/40"
                    >
                      <CompanyLink name={a} />
                    </span>
                  ))}
                </div>
              </div>
            )}
            {(exit.recentDeals?.length ?? 0) > 0 && (
              <ul className="mt-1.5 space-y-1 list-disc pl-4">
                {exit.recentDeals!.map((d, i) => (
                  <li key={i} className="text-xs text-muted-foreground">
                    {d.detail}
                    {d.sourceUrl && <Cite url={d.sourceUrl} meta={meta} className="ml-1" />}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

      {/* Enterprise angle */}
      {(p.enterpriseAngle?.length ?? 0) > 0 && (
        <div>
          <p className={sectionLabel}>Enterprise perspective</p>
          <ul className="mt-1 space-y-1.5">
            {p.enterpriseAngle!.map((e, i) => (
              <li key={i} className="text-sm">
                <span className="font-medium text-foreground">{e.area}</span>
                {e.whyItMatters && (
                  <span className="text-muted-foreground"> — {e.whyItMatters}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Portfolio implications */}
      {p.portfolioImplications?.length > 0 && (
        <div>
          <p className={sectionLabel}>Portfolio implications</p>
          <ul className="mt-1 space-y-1.5">
            {p.portfolioImplications.map((x, i) => (
              <li key={i} className="text-sm">
                <CompanyLink name={x.company} />
                <span className="text-muted-foreground">: {x.implication}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Metrics to watch */}
      {(p.metricsToWatch?.length ?? 0) > 0 && (
        <div>
          <p className={sectionLabel}>Key metrics to watch</p>
          <ul className="mt-1 space-y-1 list-disc pl-4">
            {p.metricsToWatch!.map((m, i) => (
              <li key={i} className="text-xs text-muted-foreground">
                {m}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Recommended actions */}
      {(p.recommendedActions?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <p className={sectionLabel}>Recommended next actions</p>
          <ul className="mt-1.5 space-y-2">
            {p.recommendedActions!.map((a, i) => (
              <li key={i} className="text-sm">
                <div className="flex items-start gap-1.5 flex-wrap">
                  {a.category && (
                    <Badge variant="outline" className="text-[9px]">
                      {a.category}
                    </Badge>
                  )}
                  <span className="text-foreground">{a.action}</span>
                </div>
                {(a.entities?.length ?? 0) > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1 pl-1">
                    {a.entities!.map((e, j) => (
                      <span
                        key={j}
                        className="text-[11px] px-2 py-0.5 rounded-full border border-border bg-background inline-flex items-center gap-1"
                      >
                        <CompanyLink name={e} />
                        <WatchButton company={e} theme={theme} ctx={ctx} />
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Watchlist suggestions */}
      {p.watchlistSuggestions?.length > 0 && (
        <div>
          <p className={sectionLabel}>Watchlist suggestions</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {p.watchlistSuggestions.map((w, i) => (
              <span
                key={i}
                className="text-[11px] px-2 py-0.5 rounded-full border border-border bg-muted/40 inline-flex items-center gap-1"
              >
                <CompanyLink name={w} />
                <WatchButton company={w} theme={theme} ctx={ctx} />
              </span>
            ))}
          </div>
        </div>
      )}

      <SourceLinks urls={p.sources ?? []} meta={meta} />
    </div>
  );
}

function BoardArticlesBody({ p }: { p: BoardArticlePayload }) {
  return (
    <div className="space-y-4">
      {p.digest && (
        <div>
          <p className={sectionLabel}>Digest</p>
          <MarkdownMessage text={p.digest} />
        </div>
      )}
      <div className="space-y-2">
        {(p.articles ?? []).map((a, i) => (
          <div key={i} className="rounded-lg border border-border p-3">
            <a
              href={a.url}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-medium text-primary hover:underline inline-flex items-start gap-1"
            >
              {a.title}
              <ExternalLink className="h-3 w-3 mt-1 shrink-0" />
            </a>
            {a.whyRead && <p className="text-xs text-muted-foreground mt-1">{a.whyRead}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

function DiligenceBody({ p }: { p: DiligencePayload }) {
  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold text-foreground">{p.score || "—"}</span>
        <span className="text-sm text-muted-foreground">/ 10 thesis fit</span>
      </div>
      {p.dimensions?.length > 0 && (
        <div className="space-y-2">
          {p.dimensions.map((d, i) => (
            <div key={i}>
              <div className="flex items-center justify-between text-xs mb-0.5">
                <span className="font-medium">{d.name}</span>
                <span className="text-muted-foreground tabular-nums">{d.score}/10</span>
              </div>
              <Progress value={Math.max(0, Math.min(10, d.score)) * 10} className="h-1.5" />
              {d.note && <p className="text-[11px] text-muted-foreground mt-0.5">{d.note}</p>}
            </div>
          ))}
        </div>
      )}
      {p.rationale && (
        <div>
          <p className={sectionLabel}>Rationale</p>
          <MarkdownMessage text={p.rationale} />
        </div>
      )}
      {p.questions?.length > 0 && (
        <div>
          <p className={`${sectionLabel} mb-1`}>Questions for management</p>
          <QuestionList questions={p.questions} />
        </div>
      )}
      {(p.signalsUsed?.length ?? 0) > 0 && (
        <div>
          <p className={sectionLabel}>Internal signals used</p>
          <ul className="mt-1 space-y-1">
            {p.signalsUsed!.map((s, i) => (
              <li key={i} className="text-[11px] text-muted-foreground">
                • {s}
              </li>
            ))}
          </ul>
        </div>
      )}
      <SourceLinks urls={p.sources ?? []} />
    </div>
  );
}

// Right-side sheet rendering any saved Platform Content row by type.
export function ContentDetailSheet({
  row,
  onOpenChange,
  userEmail,
  onRadarAdded,
}: {
  row: PlatformContentRow | null;
  onOpenChange: (open: boolean) => void;
  /** When set, exec-brief companies show a "Watch" (add to radar) action. */
  userEmail?: string;
  onRadarAdded?: (entry: RadarEntry) => void;
}) {
  return (
    <Sheet open={!!row} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        {row && (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2">
                <ContentTypeBadge type={row.type} />
                <span className="text-[11px] text-muted-foreground">
                  {row.generatedAt ? new Date(row.generatedAt).toLocaleString() : ""}
                  {row.generatedBy ? ` · ${row.generatedBy}` : ""}
                </span>
                <span className="flex items-center gap-1 ml-auto mr-6">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs px-2"
                    onClick={() => downloadWordDoc(row)}
                    title="Download as a Word document"
                  >
                    <FileDown className="h-3 w-3 mr-1" /> Word
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs px-2"
                    onClick={() => {
                      if (!printContentPdf(row))
                        toast.error("Popup blocked — allow popups to export as PDF.");
                    }}
                    title="Print / save as PDF"
                  >
                    <Printer className="h-3 w-3 mr-1" /> PDF
                  </Button>
                </span>
              </div>
              <SheetTitle className="text-base">{row.title || row.subject}</SheetTitle>
              <SheetDescription className="text-xs">{row.subject}</SheetDescription>
            </SheetHeader>
            <div className="mt-4">
              {row.type === "exec_brief" && (
                <ExecBriefBody
                  p={row.payload as ExecBriefPayload}
                  subject={row.subject}
                  userEmail={userEmail}
                  onRadarAdded={onRadarAdded}
                />
              )}
              {row.type === "board_article" && (
                <BoardArticlesBody p={row.payload as BoardArticlePayload} />
              )}
              {row.type === "mgmt_questions" && (
                <QuestionList questions={(row.payload as MgmtQuestionsPayload).questions ?? []} />
              )}
              {row.type === "diligence" && <DiligenceBody p={row.payload as DiligencePayload} />}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
