import { useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { addKpiPoints } from "@/utils/platform.functions";
import {
  KPI_CATEGORIES,
  KPI_CATEGORY_LABELS,
  KPI_METRICS,
  currentPeriod,
  metricDef,
  normalizePeriod,
} from "@/lib/platform-kpi";

const labelClass =
  "text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block";

// Manually add one KPI datapoint for the selected portco. Appends a row to the
// "PortCo KPIs" tab (source "manual"); corrections are just another add for the
// same metric + month (latest entry wins on read).
export function AddKpiDialog({
  open,
  onOpenChange,
  company,
  userEmail,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  company: { urid?: string; name: string };
  userEmail: string;
  onAdded?: () => void | Promise<void>;
}) {
  const [metric, setMetric] = useState("");
  const [value, setValue] = useState("");
  const [period, setPeriod] = useState(currentPeriod());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const def = metricDef(metric);
  const numValue = Number(value.replace(/[$,%\s]/g, ""));
  const canSave = !!def && value.trim() !== "" && Number.isFinite(numValue) && !!normalizePeriod(period);

  const reset = () => {
    setMetric("");
    setValue("");
    setPeriod(currentPeriod());
    setNote("");
    setBusy(false);
  };

  const submit = async () => {
    if (!canSave || !def) return;
    setBusy(true);
    try {
      await addKpiPoints({
        data: {
          points: [
            {
              portcoUrid: company.urid ?? "",
              companyName: company.name,
              metric,
              period,
              value: numValue,
              source: "manual",
              note: note.trim(),
            },
          ],
          enteredBy: userEmail,
        },
      });
      toast.success(`Saved ${def.label} for ${company.name}.`);
      await onAdded?.();
      reset();
      onOpenChange(false);
    } catch (e) {
      console.error("addKpiPoints failed", e);
      toast.error(e instanceof Error ? e.message : "Couldn't save the datapoint.");
    } finally {
      setBusy(false);
    }
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
          <DialogTitle>Add KPI datapoint</DialogTitle>
          <DialogDescription className="text-xs">
            One observation for {company.name}. Re-entering the same metric and month later simply
            supersedes this value — full history is kept.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 py-2">
          <div className="col-span-2">
            <Label className={labelClass}>Metric *</Label>
            <Select value={metric} onValueChange={setMetric}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="Pick a metric…" />
              </SelectTrigger>
              <SelectContent>
                {KPI_CATEGORIES.map((cat) => (
                  <SelectGroup key={cat}>
                    <SelectLabel>{KPI_CATEGORY_LABELS[cat]}</SelectLabel>
                    {KPI_METRICS[cat].map((m) => (
                      <SelectItem key={m.key} value={m.key}>
                        {m.label} ({m.unit})
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className={labelClass}>Value{def ? ` (${def.unit})` : ""} *</Label>
            <Input
              className="h-8 text-sm"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={def?.unit === "$M" ? "4.2" : "0"}
              inputMode="decimal"
            />
          </div>
          <div>
            <Label className={labelClass}>Month *</Label>
            <Input
              className="h-8 text-sm"
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            />
          </div>
          <div className="col-span-2">
            <Label className={labelClass}>Note</Label>
            <Input
              className="h-8 text-sm"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Q3 board deck / founder update…"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !canSave}>
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5 mr-1" />
            )}
            Save datapoint
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
