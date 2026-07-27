import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChevronRight, Loader2, Plus, SearchCheck, X } from "lucide-react";
import { toast } from "sonner";
import type { DiligencePayload, PlatformContentRow } from "@/lib/platform-content";
import { runPlatformDiligence } from "@/utils/platform.functions";
import { ContentDetailSheet } from "./ContentDetailSheet";
import {
  PlatformArticleCard,
  opportunityChipClass,
  relativeTimeLabel,
} from "./PlatformArticleCard";

const labelClass =
  "text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block";

// Common grading dimensions offered as one-tap chips. Free-text entry covers
// everything else; leaving the rubric empty lets the model pick its own.
const PRESET_METRICS = [
  "Team",
  "Market size",
  "Technology / moat",
  "Traction",
  "Competition",
  "Go-to-market",
  "Business model",
  "Regulatory risk",
] as const;

const MAX_METRICS = 10;

function diligenceScore(row: PlatformContentRow): number | null {
  const p = row.payload as DiligencePayload | undefined;
  const n = Number(p?.score);
  return Number.isFinite(n) ? n : null;
}

// Quick diligence: grounded web research → thesis-fit score (score_company_dna)
// → grounded questions for management. Past runs use Signals-style article cards.
export function DiligenceTab({
  content,
  prefillCompany,
  userEmail,
  onContent,
}: {
  content: PlatformContentRow[];
  prefillCompany: string;
  userEmail: string;
  onContent: (row: PlatformContentRow) => void;
}) {
  const [company, setCompany] = useState(prefillCompany);
  const [website, setWebsite] = useState("");
  const [metrics, setMetrics] = useState<string[]>([]);
  const [metricDraft, setMetricDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [detailRow, setDetailRow] = useState<PlatformContentRow | null>(null);

  // A "Diligence" click on the Sourcing tab lands here with the company set.
  useEffect(() => {
    if (prefillCompany) setCompany(prefillCompany);
  }, [prefillCompany]);

  const history = content.filter((r) => r.type === "diligence");

  const addMetric = (raw: string) => {
    const m = raw.trim().slice(0, 60);
    if (!m) return;
    setMetrics((prev) =>
      prev.length >= MAX_METRICS ||
      prev.some((x) => x.toLowerCase() === m.toLowerCase())
        ? prev
        : [...prev, m],
    );
    setMetricDraft("");
  };

  const removeMetric = (m: string) => setMetrics((prev) => prev.filter((x) => x !== m));

  const run = async () => {
    if (!company.trim()) return;
    setBusy(true);
    try {
      const row = await runPlatformDiligence({
        data: {
          company: company.trim(),
          website: website.trim() || undefined,
          generatedBy: userEmail,
          criteria: metrics.length > 0 ? metrics : undefined,
        },
      });
      onContent(row);
      setDetailRow(row);
      toast.success(`Diligence run complete for ${company.trim()}.`);
    } catch (e) {
      console.error("runPlatformDiligence failed", e);
      toast.error(e instanceof Error ? e.message : "Diligence run failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
          <div>
            <Label className={labelClass}>Company *</Label>
            <Input
              className="h-8 text-sm"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="Company to evaluate…"
            />
          </div>
          <div>
            <Label className={labelClass}>Website (optional)</Label>
            <Input
              className="h-8 text-sm"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="example.com"
            />
          </div>
          <Button className="h-8 text-xs" onClick={run} disabled={busy || !company.trim()}>
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <SearchCheck className="h-3.5 w-3.5 mr-1" />
            )}
            {busy ? "Researching…" : "Run diligence"}
          </Button>
        </div>

        {/* Grading rubric — optional user-defined dimensions the scorer must use */}
        <div className="mt-3">
          <Label className={labelClass}>Grading metrics (optional)</Label>
          <div className="flex flex-wrap items-center gap-1.5">
            {metrics.map((m) => (
              <Badge key={m} variant="secondary" className="text-[11px] gap-1 pr-1">
                {m}
                <button
                  type="button"
                  onClick={() => removeMetric(m)}
                  className="rounded-full hover:bg-muted-foreground/20 p-0.5"
                  title={`Remove ${m}`}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </Badge>
            ))}
            <Input
              className="h-7 w-56 text-xs"
              value={metricDraft}
              onChange={(e) => setMetricDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addMetric(metricDraft);
                }
              }}
              placeholder={
                metrics.length >= MAX_METRICS
                  ? `Max ${MAX_METRICS} metrics`
                  : "Type a metric and press Enter…"
              }
              disabled={metrics.length >= MAX_METRICS}
            />
          </div>
          <div className="flex flex-wrap items-center gap-1 mt-1.5">
            {PRESET_METRICS.filter(
              (p) => !metrics.some((m) => m.toLowerCase() === p.toLowerCase()),
            ).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => addMetric(p)}
                disabled={metrics.length >= MAX_METRICS}
                className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full border border-dashed border-border text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40"
              >
                <Plus className="h-2.5 w-2.5" /> {p}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground/70 mt-1">
            {metrics.length > 0
              ? "The report will grade the company on exactly these dimensions."
              : "Leave empty and the AI picks the 4–6 most material dimensions itself."}
          </p>
        </div>

        <p className="text-[11px] text-muted-foreground mt-2">
          Runs grounded web research, folds in Signal Radar items, scores thesis fit (1–10), and
          drafts management questions — 2 AI calls. If Vertex is rate-limited (429), it backs off
          automatically; wait for the run to finish rather than clicking again.
        </p>
      </div>

      <div className="mx-auto max-w-4xl space-y-3">
        <div className="flex items-center justify-between px-0.5">
          <h3 className="text-sm font-semibold text-foreground">Past runs</h3>
          {history.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {history.length} report{history.length !== 1 ? "s" : ""}
            </p>
          )}
        </div>

        {history.length === 0 ? (
          <div className="text-center py-14 rounded-xl border border-dashed border-border">
            <SearchCheck className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">No diligence runs yet</p>
            <p className="text-xs text-muted-foreground/70 mt-1 max-w-sm mx-auto">
              Enter a company above, or jump here from a Sourcing article.
            </p>
          </div>
        ) : (
          history.map((row) => {
            const score = diligenceScore(row);
            const dimCount = (row.payload as DiligencePayload | undefined)?.dimensions?.length ?? 0;
            const qCount = (row.payload as DiligencePayload | undefined)?.questions?.length ?? 0;
            const rationale = (row.payload as DiligencePayload | undefined)?.rationale?.trim();
            const headline = row.title || `Diligence — ${row.subject}`;
            const summary =
              rationale ||
              [
                dimCount > 0 ? `${dimCount} thesis dimensions` : null,
                qCount > 0 ? `${qCount} management questions` : null,
                row.generatedBy ? `by ${row.generatedBy}` : null,
              ]
                .filter(Boolean)
                .join(" · ");

            // Map 1–10 thesis score to a 0–100 chip band (same colors as opportunity).
            const chipScore = score != null ? Math.round(score * 10) : 0;

            return (
              <PlatformArticleCard
                key={row.id || `${row.type}-${row.generatedAt}`}
                company={row.subject || "Company"}
                timeLabel={relativeTimeLabel(row.generatedAt)}
                headline={headline}
                summary={summary || undefined}
                active={detailRow?.id === row.id}
                onOpen={() => setDetailRow(row)}
                badges={
                  <>
                    <span className="text-muted-foreground/60">·</span>
                    <Badge
                      variant="outline"
                      className="text-[10px] bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900"
                    >
                      Diligence
                    </Badge>
                  </>
                }
                footer={
                  <>
                    {score != null && (
                      <Badge
                        variant="outline"
                        className={`text-[10px] tabular-nums ${opportunityChipClass(chipScore)}`}
                      >
                        Thesis {score}/10
                      </Badge>
                    )}
                    {dimCount > 0 && (
                      <span className="text-[11px] text-muted-foreground">
                        {dimCount} dimension{dimCount !== 1 ? "s" : ""}
                      </span>
                    )}
                    {qCount > 0 && (
                      <span className="text-[11px] text-muted-foreground">
                        {qCount} question{qCount !== 1 ? "s" : ""}
                      </span>
                    )}
                    <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-primary font-medium">
                      Open report <ChevronRight className="h-3.5 w-3.5" />
                    </span>
                  </>
                }
              />
            );
          })
        )}
      </div>

      <ContentDetailSheet row={detailRow} onOpenChange={(o) => !o && setDetailRow(null)} />
    </div>
  );
}
