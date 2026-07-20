import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowDownRight,
  ArrowUpRight,
  ClipboardPaste,
  ExternalLink,
  Globe,
  Landmark,
  ListChecks,
  Loader2,
  Minus,
  Plus,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";
import type { PortfolioCompany } from "@/lib/types";
import {
  KPI_CATEGORIES,
  KPI_CATEGORY_LABELS,
  KPI_METRICS,
  formatKpiValue,
  formatPeriod,
  latestWins,
  lowerIsBetter,
  pointsForCompany,
  seriesFor,
  type KpiMetricDef,
  type KpiPoint,
} from "@/lib/platform-kpi";
import {
  parseAsanaOwnershipValuation,
  type OwnershipValuationField,
} from "@/lib/ownership-valuation";
import type { PlatformContentRow } from "@/lib/platform-content";
import {
  generateMgmtQuestions,
  refreshDigitalTraction,
  refreshPublicValuation,
} from "@/utils/platform.functions";
import { AddKpiDialog } from "./AddKpiDialog";
import { KpiPasteDialog } from "./KpiPasteDialog";
import { KpiTrendChart } from "./KpiTrendChart";
import { ContentDetailSheet } from "./ContentDetailSheet";

const sectionLabel =
  "text-[10px] uppercase tracking-wider font-semibold text-muted-foreground";

function firstUrl(text: string): string | null {
  const m = /https?:\/\/\S+/.exec(text);
  return m ? m[0] : null;
}

// One metric's stat card: latest value + period, prior-period delta (colored
// with lower-is-better awareness), provenance badge for web-sourced numbers,
// and a trend line once two or more periods exist.
function MetricCard({
  def,
  points,
}: {
  def: KpiMetricDef;
  points: KpiPoint[];
}) {
  const series = seriesFor(points, def.key);
  const current = latestWins(points.filter((p) => p.metric === def.key)).sort((a, b) =>
    a.period < b.period ? -1 : 1,
  );
  const latest = current[current.length - 1];
  const prev = current.length > 1 ? current[current.length - 2] : null;
  if (!latest) return null;

  const delta = prev ? latest.value - prev.value : null;
  const good = delta != null && (lowerIsBetter(def.key) ? delta < 0 : delta > 0);
  const isWeb = latest.source === "gemini_web";
  const evidence = isWeb ? firstUrl(latest.note) : null;

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <p className={sectionLabel}>{def.label}</p>
          {isWeb && (
            <Badge variant="outline" className="text-[9px] bg-cyan-500/10 text-cyan-600 border-cyan-500/30">
              web · best effort
            </Badge>
          )}
        </div>
        <p className="text-2xl font-bold text-foreground mt-1">
          {formatKpiValue(latest.value, def.unit)}
        </p>
        <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground">
          <span>{formatPeriod(latest.period)}</span>
          {delta != null && (
            <span className={`flex items-center gap-0.5 ${good ? "text-emerald-600" : "text-red-600"}`}>
              {delta === 0 ? (
                <Minus className="h-3 w-3" />
              ) : delta > 0 ? (
                <ArrowUpRight className="h-3 w-3" />
              ) : (
                <ArrowDownRight className="h-3 w-3" />
              )}
              {formatKpiValue(Math.abs(delta), def.unit)} vs {formatPeriod(prev!.period)}
            </span>
          )}
          {evidence && (
            <a
              href={evidence}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-0.5"
            >
              <ExternalLink className="h-3 w-3" /> evidence
            </a>
          )}
        </div>
        {series.length >= 2 && (
          <div className="mt-2">
            <KpiTrendChart series={series} unit={def.unit} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function KpisTab({
  companies,
  kpis,
  content,
  userEmail,
  onRefresh,
  onContent,
}: {
  companies: PortfolioCompany[];
  kpis: KpiPoint[];
  content: PlatformContentRow[];
  userEmail: string;
  onRefresh: () => Promise<void>;
  onContent: (row: PlatformContentRow) => void;
}) {
  const sorted = useMemo(
    () => [...companies].sort((a, b) => a.name.localeCompare(b.name)),
    [companies],
  );
  const [companyKey, setCompanyKey] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [webBusy, setWebBusy] = useState(false);
  const [valuationBusy, setValuationBusy] = useState(false);
  const [questionsBusy, setQuestionsBusy] = useState(false);
  const [detailRow, setDetailRow] = useState<PlatformContentRow | null>(null);

  const company = sorted.find((c) => (c.urid || c.name) === companyKey);
  const sel = company ? { urid: company.urid, name: company.name } : null;
  const companyPoints = sel ? pointsForCompany(kpis, sel) : [];
  const asanaCapital = useMemo(
    () => parseAsanaOwnershipValuation(company?.asanaFields),
    [company?.asanaFields],
  );
  const questionHistory = sel
    ? content.filter(
        (r) =>
          r.type === "mgmt_questions" &&
          (r.portcoUrid && sel.urid ? r.portcoUrid === sel.urid : r.subject === sel.name),
      )
    : [];

  const runWebRefresh = async () => {
    if (!company) return;
    setWebBusy(true);
    try {
      const res = await refreshDigitalTraction({
        data: {
          urid: company.urid,
          name: company.name,
          website: company.website,
          enteredBy: userEmail,
        },
      });
      toast[res.added > 0 ? "success" : "info"](res.note);
      if (res.added > 0) await onRefresh();
    } catch (e) {
      console.error("refreshDigitalTraction failed", e);
      toast.error(e instanceof Error ? e.message : "Web refresh failed.");
    } finally {
      setWebBusy(false);
    }
  };

  const runValuationRefresh = async () => {
    if (!company) return;
    setValuationBusy(true);
    try {
      const res = await refreshPublicValuation({
        data: {
          urid: company.urid,
          name: company.name,
          website: company.website,
          enteredBy: userEmail,
        },
      });
      toast[res.added > 0 ? "success" : "info"](res.note);
      if (res.added > 0) await onRefresh();
    } catch (e) {
      console.error("refreshPublicValuation failed", e);
      toast.error(e instanceof Error ? e.message : "Valuation refresh failed.");
    } finally {
      setValuationBusy(false);
    }
  };

  const runQuestions = async () => {
    if (!company) return;
    setQuestionsBusy(true);
    try {
      const row = await generateMgmtQuestions({
        data: { urid: company.urid, name: company.name, generatedBy: userEmail },
      });
      onContent(row);
      setDetailRow(row);
      toast.success(`Questions ready for ${company.name}.`);
    } catch (e) {
      console.error("generateMgmtQuestions failed", e);
      toast.error(e instanceof Error ? e.message : "Question generation failed.");
    } finally {
      setQuestionsBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={companyKey} onValueChange={setCompanyKey}>
          <SelectTrigger className="h-8 w-64 text-sm">
            <SelectValue placeholder="Pick a portfolio company…" />
          </SelectTrigger>
          <SelectContent>
            {sorted.map((c) => (
              <SelectItem key={c.urid || c.name} value={c.urid || c.name}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {company && (
          <div className="flex flex-wrap items-center gap-2 ml-auto">
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setAddOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Add data point
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setPasteOpen(true)}>
              <ClipboardPaste className="h-3.5 w-3.5 mr-1" /> Smart paste
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={runQuestions}
              disabled={questionsBusy}
            >
              {questionsBusy ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <ListChecks className="h-3.5 w-3.5 mr-1" />
              )}
              Questions for management
            </Button>
          </div>
        )}
      </div>

      {!company ? (
        <div className="text-center py-16 rounded-lg border border-dashed border-border">
          <TrendingUp className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">
            Pick a portfolio company to see and track its KPIs.
          </p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Ownership & valuation pull from Asana plus optional public web data. Commercial and PMF
            are entered manually; digital traction refreshes from the web.
          </p>
        </div>
      ) : (
        <>
          {companyPoints.length === 0 && asanaCapital.length === 0 && (
            <div className="text-center py-8 rounded-lg border border-dashed border-border">
              <p className="text-sm text-muted-foreground">
                No KPI data for {company.name} yet.
              </p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                Add a data point, smart-paste the latest founder update, refresh public valuation, or
                ensure Asana has DTC Ownership / Investment fields.
              </p>
            </div>
          )}

          {KPI_CATEGORIES.map((cat) => {
            const withData = KPI_METRICS[cat].filter((m) =>
              companyPoints.some((p) => p.metric === m.key),
            );
            const missing = KPI_METRICS[cat].filter(
              (m) => !companyPoints.some((p) => p.metric === m.key),
            );
            const isCapital = cat === "capital";
            return (
              <div key={cat}>
                <div className="flex items-center justify-between mb-2 gap-2">
                  <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                    {isCapital && <Landmark className="h-3.5 w-3.5 text-primary" />}
                    {KPI_CATEGORY_LABELS[cat]}
                  </h3>
                  <div className="flex items-center gap-1.5">
                    {isCapital && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={runValuationRefresh}
                        disabled={valuationBusy}
                        title="Grounded web search for post-money / last round (best effort)."
                      >
                        {valuationBusy ? (
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        ) : (
                          <Globe className="h-3 w-3 mr-1" />
                        )}
                        Refresh public valuation
                      </Button>
                    )}
                    {cat === "digital" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={runWebRefresh}
                        disabled={webBusy}
                        title="Runs a grounded web search; only verifiable numbers are stored."
                      >
                        {webBusy ? (
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        ) : (
                          <Globe className="h-3 w-3 mr-1" />
                        )}
                        Refresh web data
                      </Button>
                    )}
                  </div>
                </div>

                {isCapital && (
                  <AsanaCapitalStrip
                    fields={asanaCapital}
                    emptyHint={
                      asanaCapital.length === 0
                        ? "No Asana ownership/investment fields matched for this company yet."
                        : undefined
                    }
                  />
                )}

                {withData.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {withData.map((def) => (
                      <MetricCard key={def.key} def={def} points={companyPoints} />
                    ))}
                  </div>
                ) : !isCapital || asanaCapital.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2">No data yet.</p>
                ) : null}
                {withData.length > 0 && missing.length > 0 && (
                  <p className="text-[11px] text-muted-foreground mt-2">
                    No sheet data: {missing.map((m) => m.label).join(", ")}
                  </p>
                )}
                {isCapital && (
                  <p className="text-[11px] text-muted-foreground mt-2">
                    Asana fields are live from the portco project. Public valuation is best-effort
                    web data and never overwrites Asana.
                  </p>
                )}
              </div>
            );
          })}

          {questionHistory.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-foreground mb-2">
                Management question history
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {questionHistory.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setDetailRow(r)}
                    className="text-[11px] px-2 py-1 rounded-full border border-border bg-muted/40 hover:bg-accent"
                  >
                    {r.generatedAt
                      ? new Date(r.generatedAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })
                      : "set"}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {company && (
        <>
          <AddKpiDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            company={{ urid: company.urid, name: company.name }}
            userEmail={userEmail}
            onAdded={onRefresh}
          />
          <KpiPasteDialog
            open={pasteOpen}
            onOpenChange={setPasteOpen}
            company={{ urid: company.urid, name: company.name }}
            userEmail={userEmail}
            onSaved={onRefresh}
          />
        </>
      )}
      <ContentDetailSheet row={detailRow} onOpenChange={(o) => !o && setDetailRow(null)} />
    </div>
  );
}

function AsanaCapitalStrip({
  fields,
  emptyHint,
}: {
  fields: OwnershipValuationField[];
  emptyHint?: string;
}) {
  if (fields.length === 0) {
    return emptyHint ? (
      <p className="text-xs text-muted-foreground py-2 mb-2">{emptyHint}</p>
    ) : null;
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mb-3">
      {fields.map((f) => (
        <Card key={f.key}>
          <CardContent className="p-4">
            <div className="flex items-start justify-between gap-2">
              <p className={sectionLabel}>{f.label}</p>
              <Badge
                variant="outline"
                className="text-[9px] bg-violet-500/10 text-violet-700 border-violet-500/30 dark:text-violet-300"
              >
                asana
              </Badge>
            </div>
            <p className="text-2xl font-bold text-foreground mt-1 truncate" title={f.display}>
              {f.display}
            </p>
            <p className="text-[11px] text-muted-foreground mt-0.5">From Asana portco task</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
