import { useEffect, useMemo, useState } from "react";
import { Plus, BarChart3, Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Dimension } from "@/lib/use-chart-drill";
import {
  loadCharts,
  saveCharts,
  newChartId,
  chartTitle,
  type ChartSpec,
  type ChartStyle,
  type Metric,
} from "@/lib/chart-spec";
import { ConfiguredChart } from "./ConfiguredChart";
import { recommendDashboardChart } from "@/utils/insights.functions";
import { toast } from "sonner";

const STYLES: { value: ChartStyle; label: string }[] = [
  { value: "bar", label: "Bar (vertical)" },
  { value: "hbar", label: "Bar (horizontal)" },
  { value: "line", label: "Line" },
  { value: "pie", label: "Pie" },
];

const MAX_CHARTS = 12;
const RECORD_COUNT = "count";

/** Curated page charts Gemini must not re-suggest (matched on groupBy+metric). */
export type BlockedChart = {
  groupBy: string;
  metric: string;
  splitBy?: string;
  compare?: string;
  label?: string;
};

interface Props<T> {
  /** localStorage key — unique per page (e.g. contacts vs events). */
  storageKey: string;
  dims: Dimension<T>[];
  /** Page measures (record count is added automatically). */
  metrics: Metric<T>[];
  /** The already cross-filtered items the charts aggregate over. */
  items: T[];
  focus: (dim: string, value: string | number | null | undefined) => void;
  /** Show Gemini "Build recommended chart" (default false). */
  aiRecommend?: boolean;
  /** Hardcoded charts already on the page — excluded from AI recommendations. */
  blockedCharts?: BlockedChart[];
}

function topValuesForDim<T>(items: T[], dim: Dimension<T>, limit = 8): { value: string; count: number }[] {
  const m = new Map<string, number>();
  for (const item of items) {
    const raw = dim.get(item);
    const vals = (Array.isArray(raw) ? raw : [raw]).map((v) =>
      v == null || String(v).trim() === "" ? "Unspecified" : String(v).trim(),
    );
    for (const v of vals) m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

// User-built charts: an Asana-style "add chart" surface on top of the dimension
// registry. Specs persist in localStorage so a user's custom layout survives
// reloads; every chart still cross-filters the page on click.
export function ChartBuilder<T>({
  storageKey,
  dims,
  metrics,
  items,
  focus,
  aiRecommend = false,
  blockedCharts = [],
}: Props<T>) {
  const allMetrics = useMemo<Metric<T>[]>(
    () => [{ key: RECORD_COUNT, label: "Record count", get: () => 1 }, ...metrics],
    [metrics],
  );

  const [specs, setSpecs] = useState<ChartSpec[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [open, setOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  useEffect(() => {
    setSpecs(loadCharts(storageKey));
    setHydrated(true);
  }, [storageKey]);
  useEffect(() => {
    if (hydrated) saveCharts(storageKey, specs);
  }, [hydrated, storageKey, specs]);

  const add = (spec: ChartSpec) => setSpecs((prev) => [...prev, spec]);
  const remove = (id: string) => setSpecs((prev) => prev.filter((s) => s.id !== id));

  const atCap = specs.length >= MAX_CHARTS;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-xs font-semibold flex items-center gap-1.5 text-muted-foreground uppercase tracking-wider">
          <BarChart3 className="h-3.5 w-3.5" /> Custom charts
        </h2>
        <div className="flex items-center gap-1.5">
          {aiRecommend && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              onClick={() => setAiOpen(true)}
              disabled={atCap || items.length === 0}
            >
              <Sparkles className="h-3 w-3 mr-1" /> Build recommended chart
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            onClick={() => setOpen(true)}
            disabled={atCap}
          >
            <Plus className="h-3 w-3 mr-1" /> Add chart
          </Button>
        </div>
      </div>

      {specs.length === 0 ? (
        <p className="text-xs text-muted-foreground border border-dashed border-border rounded-lg py-6 text-center">
          {aiRecommend
            ? "Ask Gemini to recommend a chart from the network in view, or add one manually. Charts persist in this browser and cross-filter on click."
            : "Build your own charts — pick any field to group by, a measure, and a style. They persist in this browser and cross-filter the page on click."}
        </p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {specs.map((spec) => (
            <ConfiguredChart
              key={spec.id}
              spec={spec}
              dims={dims}
              metrics={allMetrics}
              items={items}
              focus={focus}
              onRemove={() => remove(spec.id)}
            />
          ))}
        </div>
      )}

      <AddChartDialog
        open={open}
        onOpenChange={setOpen}
        dims={dims}
        metrics={allMetrics}
        onAdd={(s) => {
          add(s);
          setOpen(false);
        }}
      />

      {aiRecommend && (
        <RecommendChartDialog
          open={aiOpen}
          onOpenChange={setAiOpen}
          dims={dims}
          metrics={allMetrics}
          items={items}
          existingSpecs={specs}
          blockedCharts={blockedCharts}
          onAdd={(s) => {
            add(s);
            setAiOpen(false);
          }}
        />
      )}
    </section>
  );
}

const NONE = "none";

function RecommendChartDialog<T>({
  open,
  onOpenChange,
  dims,
  metrics,
  items,
  existingSpecs,
  blockedCharts,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dims: Dimension<T>[];
  metrics: Metric<T>[];
  items: T[];
  existingSpecs: ChartSpec[];
  blockedCharts: BlockedChart[];
  onAdd: (spec: ChartSpec) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<{
    spec: ChartSpec;
    rationale?: string;
  } | null>(null);

  const reset = () => {
    setPrompt("");
    setPreview(null);
    setLoading(false);
  };

  const run = async () => {
    setLoading(true);
    setPreview(null);
    try {
      const distributions = dims.map((d) => ({
        dim: d.dim,
        label: d.label,
        top: topValuesForDim(items, d),
      }));
      const metricTotals = metrics.map((m) => ({
        key: m.key,
        label: m.label,
        total: items.reduce((sum, item) => sum + (Number(m.get(item)) || 0), 0),
      }));
      const existingTitles = existingSpecs.map((s) => chartTitle(s, dims, metrics));

      const res = await recommendDashboardChart({
        data: {
          prompt: prompt.trim() || undefined,
          dims: dims.map((d) => ({ key: d.dim, label: d.label })),
          metrics: metrics.map((m) => ({ key: m.key, label: m.label })),
          styles: STYLES.map((s) => s.value),
          distributions,
          metricTotals,
          recordCount: items.length,
          existingTitles,
          blockedCharts,
          existingCharts: existingSpecs.map((s) => ({
            groupBy: s.groupBy,
            metric: s.metric,
            splitBy: s.splitBy,
            compare: s.compare,
          })),
        },
      });

      if (!res.ok || !res.groupBy || !res.metric || !res.style) {
        toast.error(res.error || "Couldn't recommend a chart.");
        return;
      }

      const spec: ChartSpec = {
        id: newChartId(),
        groupBy: res.groupBy,
        metric: res.metric,
        style: res.style,
        title: res.title,
      };
      if (res.splitBy) spec.splitBy = res.splitBy;
      if (res.compare) spec.compare = res.compare;

      setPreview({ spec, rationale: res.rationale });
    } catch (e) {
      console.error("recommendDashboardChart failed", e);
      toast.error("Chart recommendation failed — see console.");
    } finally {
      setLoading(false);
    }
  };

  const confirm = () => {
    if (!preview) return;
    onAdd(preview.spec);
    toast.success(preview.spec.title ? `Added “${preview.spec.title}”` : "Recommended chart added");
    reset();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" /> Build recommended chart
          </DialogTitle>
          <DialogDescription className="text-xs">
            Ask Gemini for a chart from the network in view — or leave blank for a pick. It skips
            charts already hardcoded on this page and ones you’ve already added.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
              What do you want to see?
            </Label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder='e.g. “Horizontal bar of PortCo intros by sector” or “Pie of temperature mix”'
              className="min-h-[88px] text-sm resize-none"
              disabled={loading}
            />
          </div>

          {preview && (
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                Recommendation
              </p>
              <p className="text-sm font-semibold text-foreground">
                {preview.spec.title || chartTitle(preview.spec, dims, metrics)}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {dims.find((d) => d.dim === preview.spec.groupBy)?.label || preview.spec.groupBy}
                {" · "}
                {metrics.find((m) => m.key === preview.spec.metric)?.label || preview.spec.metric}
                {" · "}
                {preview.spec.style}
                {preview.spec.splitBy
                  ? ` · split by ${dims.find((d) => d.dim === preview.spec.splitBy)?.label || preview.spec.splitBy}`
                  : ""}
                {preview.spec.compare
                  ? ` · vs ${metrics.find((m) => m.key === preview.spec.compare)?.label || preview.spec.compare}`
                  : ""}
              </p>
              {preview.rationale && (
                <p className="text-[11px] text-foreground/80 leading-snug">{preview.rationale}</p>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          {preview ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={run}
                disabled={loading}
              >
                Try another
              </Button>
              <Button size="sm" className="h-8 text-xs" onClick={confirm}>
                Add chart
              </Button>
            </>
          ) : (
            <Button size="sm" className="h-8 text-xs" onClick={run} disabled={loading || items.length === 0}>
              {loading ? (
                <>
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" /> Thinking…
                </>
              ) : (
                <>
                  <Sparkles className="h-3 w-3 mr-1" /> Recommend
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddChartDialog<T>({
  open,
  onOpenChange,
  dims,
  metrics,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dims: Dimension<T>[];
  metrics: Metric<T>[];
  onAdd: (spec: ChartSpec) => void;
}) {
  const [groupBy, setGroupBy] = useState(dims[0]?.dim ?? "");
  const [metric, setMetric] = useState(metrics[0]?.key ?? RECORD_COUNT);
  const [style, setStyle] = useState<ChartStyle>("bar");
  const [second, setSecond] = useState<string>(NONE);

  const reset = () => {
    setGroupBy(dims[0]?.dim ?? "");
    setMetric(metrics[0]?.key ?? RECORD_COUNT);
    setStyle("bar");
    setSecond(NONE);
  };

  const isPie = style === "pie";

  const submit = () => {
    const spec: ChartSpec = {
      id: newChartId(),
      groupBy,
      metric,
      style,
    };
    if (!isPie && second !== NONE) {
      if (second.startsWith("split:")) spec.splitBy = second.slice("split:".length);
      else if (second.startsWith("metric:")) spec.compare = second.slice("metric:".length);
    }
    onAdd(spec);
    reset();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4 text-primary" /> Add chart
          </DialogTitle>
          <DialogDescription className="text-xs">
            Group any field by a measure. Add a breakdown for a stacked chart, or a second measure
            to compare.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <Field label="Group by">
            <Select value={groupBy} onValueChange={setGroupBy}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dims.map((d) => (
                  <SelectItem key={d.dim} value={d.dim} className="text-sm">
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Measure">
            <Select value={metric} onValueChange={setMetric}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {metrics.map((m) => (
                  <SelectItem key={m.key} value={m.key} className="text-sm">
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Chart type">
            <Select value={style} onValueChange={(v) => setStyle(v as ChartStyle)}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STYLES.map((s) => (
                  <SelectItem key={s.value} value={s.value} className="text-sm">
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Second series (optional)">
            <Select value={second} onValueChange={setSecond} disabled={isPie}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE} className="text-sm">
                  None
                </SelectItem>
                <SelectGroup>
                  <SelectLabel>Break down by (stacked)</SelectLabel>
                  {dims
                    .filter((d) => d.dim !== groupBy)
                    .map((d) => (
                      <SelectItem
                        key={`split:${d.dim}`}
                        value={`split:${d.dim}`}
                        className="text-sm"
                      >
                        {d.label}
                      </SelectItem>
                    ))}
                </SelectGroup>
                <SelectGroup>
                  <SelectLabel>Compare measure</SelectLabel>
                  {metrics
                    .filter((m) => m.key !== metric)
                    .map((m) => (
                      <SelectItem
                        key={`metric:${m.key}`}
                        value={`metric:${m.key}`}
                        className="text-sm"
                      >
                        {m.label}
                      </SelectItem>
                    ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {isPie && (
              <p className="text-[10px] text-muted-foreground mt-1">
                Pie charts show a single measure.
              </p>
            )}
          </Field>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button size="sm" className="h-8 text-xs" onClick={submit} disabled={!groupBy || !metric}>
            Add chart
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
