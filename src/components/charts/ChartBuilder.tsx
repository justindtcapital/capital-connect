import { useEffect, useMemo, useState } from "react";
import { Plus, BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
  type ChartSpec,
  type ChartStyle,
  type Metric,
} from "@/lib/chart-spec";
import { ConfiguredChart } from "./ConfiguredChart";

const STYLES: { value: ChartStyle; label: string }[] = [
  { value: "bar", label: "Bar (vertical)" },
  { value: "hbar", label: "Bar (horizontal)" },
  { value: "line", label: "Line" },
  { value: "pie", label: "Pie" },
];

const MAX_CHARTS = 12;
const RECORD_COUNT = "count";

interface Props<T> {
  /** localStorage key — unique per page (e.g. contacts vs events). */
  storageKey: string;
  dims: Dimension<T>[];
  /** Page measures (record count is added automatically). */
  metrics: Metric<T>[];
  /** The already cross-filtered items the charts aggregate over. */
  items: T[];
  focus: (dim: string, value: string | number | null | undefined) => void;
}

// User-built charts: an Asana-style "add chart" surface on top of the dimension
// registry. Specs persist in localStorage so a user's custom layout survives
// reloads; every chart still cross-filters the page on click.
export function ChartBuilder<T>({ storageKey, dims, metrics, items, focus }: Props<T>) {
  // Record count is always available; page metrics are sum-style measures.
  const allMetrics = useMemo<Metric<T>[]>(
    () => [{ key: RECORD_COUNT, label: "Record count", get: () => 1 }, ...metrics],
    [metrics],
  );

  const [specs, setSpecs] = useState<ChartSpec[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [open, setOpen] = useState(false);

  // Load after mount (localStorage is client-only — avoids SSR mismatch).
  useEffect(() => {
    setSpecs(loadCharts(storageKey));
    setHydrated(true);
  }, [storageKey]);
  useEffect(() => {
    if (hydrated) saveCharts(storageKey, specs);
  }, [hydrated, storageKey, specs]);

  const add = (spec: ChartSpec) => setSpecs((prev) => [...prev, spec]);
  const remove = (id: string) => setSpecs((prev) => prev.filter((s) => s.id !== id));

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold flex items-center gap-1.5 text-muted-foreground uppercase tracking-wider">
          <BarChart3 className="h-3.5 w-3.5" /> Custom charts
        </h2>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-[11px]"
          onClick={() => setOpen(true)}
          disabled={specs.length >= MAX_CHARTS}
        >
          <Plus className="h-3 w-3 mr-1" /> Add chart
        </Button>
      </div>

      {specs.length === 0 ? (
        <p className="text-xs text-muted-foreground border border-dashed border-border rounded-lg py-6 text-center">
          Build your own charts — pick any field to group by, a measure, and a style. They persist
          in this browser and cross-filter the page on click.
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
    </section>
  );
}

// "second series" is a single control encoding either a split dimension
// ("split:<dim>") or a comparison measure ("metric:<key>"), or "none".
const NONE = "none";

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
