import { useRef, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { FileText, Loader2, Sparkles, Save, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { addKpiPoints, extractKpisFromPaste } from "@/utils/platform.functions";
import {
  currentPeriod,
  metricDef,
  normalizePeriod,
  type KpiPasteAttachment,
  type NewKpiPoint,
} from "@/lib/platform-kpi";

interface ReviewRow {
  metric: string;
  valueText: string;
  periodText: string;
  quote: string;
  checked: boolean;
}

interface FileDraft {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  dataBase64: string;
}

const MAX_FILES = 4;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const ACCEPT =
  ".pdf,.ppt,.pptx,.doc,.docx,.png,.jpg,.jpeg,.webp,.gif,.txt,.csv,.md,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*,text/plain,text/csv,text/markdown";

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const i = result.indexOf(",");
      resolve(i >= 0 ? result.slice(i + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Smart paste: Gemini extracts KPI values from pasted text and/or uploaded
// decks/docs/PDFs. Nothing is written until the user reviews rows and the
// reporting period (AI-estimated, user-overridable).
export function KpiPasteDialog({
  open,
  onOpenChange,
  company,
  userEmail,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  company: { urid?: string; name: string };
  userEmail: string;
  onSaved?: () => void | Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<FileDraft[]>([]);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [packPeriod, setPackPeriod] = useState(currentPeriod());
  const [periodEvidence, setPeriodEvidence] = useState("");
  const [periodConfidence, setPeriodConfidence] = useState<"high" | "medium" | "low" | "">("");

  const reset = () => {
    setText("");
    setFiles([]);
    setRows([]);
    setExtracting(false);
    setSaving(false);
    setPackPeriod(currentPeriod());
    setPeriodEvidence("");
    setPeriodConfidence("");
    if (fileRef.current) fileRef.current.value = "";
  };

  const onFiles = async (list: FileList | null) => {
    if (!list) return;
    const next: FileDraft[] = [];
    for (const file of Array.from(list)) {
      if (files.length + next.length >= MAX_FILES) {
        toast.error(`Up to ${MAX_FILES} files per extract.`);
        break;
      }
      if (file.size > MAX_FILE_BYTES) {
        toast.error(`${file.name} is over 12 MB — export a leaner PDF if needed.`);
        continue;
      }
      try {
        next.push({
          id: `${file.name}-${file.size}-${file.lastModified}`,
          filename: file.name,
          mimeType: file.type || guessMime(file.name),
          sizeBytes: file.size,
          dataBase64: await readBase64(file),
        });
      } catch {
        toast.error(`Couldn't read ${file.name}.`);
      }
    }
    setFiles((prev) => [...prev, ...next]);
    if (fileRef.current) fileRef.current.value = "";
  };

  const extract = async () => {
    if (!text.trim() && files.length === 0) return;
    setExtracting(true);
    try {
      const attachments: KpiPasteAttachment[] = files.map((f) => ({
        filename: f.filename,
        mimeType: f.mimeType,
        sizeBytes: f.sizeBytes,
        dataBase64: f.dataBase64,
      }));
      const res = await extractKpisFromPaste({
        data: {
          urid: company.urid,
          name: company.name,
          text,
          attachments,
        },
      });
      if (!res.ok && res.items.length === 0) {
        toast.error(res.error || "Extraction failed.");
        return;
      }
      if (res.error && res.items.length > 0) {
        toast.message(res.error);
      }
      if (res.items.length === 0) {
        toast.info("No recognizable KPI values found. Try a clearer PDF export of the deck.");
        return;
      }

      const estimated =
        (res.documentPeriod && (normalizePeriod(res.documentPeriod) || res.documentPeriod)) ||
        currentPeriod();
      setPackPeriod(estimated);
      setPeriodEvidence(res.documentPeriodEvidence || "");
      setPeriodConfidence(
        res.documentPeriodConfidence === "high" ||
          res.documentPeriodConfidence === "medium" ||
          res.documentPeriodConfidence === "low"
          ? res.documentPeriodConfidence
          : "",
      );

      setRows(
        res.items.map((it) => ({
          metric: it.metric,
          valueText: String(it.value),
          // Prefer per-metric period; fall back to document estimate.
          periodText: it.period ?? estimated,
          quote: it.quote,
          checked: true,
        })),
      );
    } catch (e) {
      console.error("extractKpisFromPaste failed", e);
      toast.error(e instanceof Error ? e.message : "Extraction failed.");
    } finally {
      setExtracting(false);
    }
  };

  const applyPeriodToAll = () => {
    const normalized = normalizePeriod(packPeriod) || packPeriod.trim();
    if (!normalized) {
      toast.error("Enter a period like 2025-09 or Q3 2025.");
      return;
    }
    const canonical = normalizePeriod(packPeriod) || normalized;
    setPackPeriod(canonical);
    setRows((prev) => prev.map((r) => ({ ...r, periodText: canonical })));
    toast.success("Applied reporting period to all rows.");
  };

  const patchRow = (i: number, patch: Partial<ReviewRow>) =>
    setRows((prev) => prev.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  const checkedRows = rows.filter((r) => r.checked);
  const invalidChecked = checkedRows.some(
    (r) =>
      !Number.isFinite(Number(r.valueText.replace(/[$,%\s]/g, ""))) || !normalizePeriod(r.periodText),
  );

  const save = async () => {
    if (checkedRows.length === 0 || invalidChecked) return;
    setSaving(true);
    try {
      const points: NewKpiPoint[] = checkedRows.map((r) => ({
        portcoUrid: company.urid ?? "",
        companyName: company.name,
        metric: r.metric,
        period: normalizePeriod(r.periodText) || r.periodText,
        value: Number(r.valueText.replace(/[$,%\s]/g, "")),
        source: "smart_paste",
        note: r.quote,
      }));
      await addKpiPoints({ data: { points, enteredBy: userEmail } });
      toast.success(
        `Saved ${points.length} datapoint${points.length !== 1 ? "s" : ""} for ${company.name}.`,
      );
      await onSaved?.();
      reset();
      onOpenChange(false);
    } catch (e) {
      console.error("addKpiPoints (smart paste) failed", e);
      toast.error(e instanceof Error ? e.message : "Couldn't save the datapoints.");
    } finally {
      setSaving(false);
    }
  };

  const canExtract = !!(text.trim() || files.length > 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Smart paste — {company.name}</DialogTitle>
          <DialogDescription className="text-xs">
            Paste an update and/or upload a board deck, PDF, or document. The AI reads the full
            file to extract stated KPIs and estimate the reporting period — you can override the
            date before saving.
          </DialogDescription>
        </DialogHeader>

        {rows.length === 0 ? (
          <div className="space-y-3">
            <Textarea
              className="text-sm min-h-[120px] font-mono"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={`Optional notes, e.g. "ARR ended Q3 2025 at $4.2M…" — or just upload the deck below.`}
            />

            <div className="rounded-lg border border-dashed border-border p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-medium text-foreground">Upload materials</p>
                  <p className="text-[11px] text-muted-foreground">
                    PDF preferred for slides. Also accepts PPTX, DOCX, images, TXT/CSV. Max{" "}
                    {MAX_FILES} files · 12 MB each.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs shrink-0"
                  onClick={() => fileRef.current?.click()}
                  disabled={extracting || files.length >= MAX_FILES}
                >
                  <Upload className="h-3.5 w-3.5 mr-1" />
                  Add files
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  accept={ACCEPT}
                  multiple
                  onChange={(e) => onFiles(e.target.files)}
                />
              </div>
              {files.length > 0 && (
                <ul className="space-y-1.5">
                  {files.map((f) => (
                    <li
                      key={f.id}
                      className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs"
                    >
                      <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="truncate flex-1 font-medium">{f.filename}</span>
                      <span className="text-muted-foreground shrink-0">{formatBytes(f.sizeBytes)}</span>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => setFiles((prev) => prev.filter((x) => x.id !== f.id))}
                        aria-label={`Remove ${f.filename}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                  Reporting period for this pack
                </Label>
                {periodConfidence && (
                  <Badge variant="outline" className="text-[9px]">
                    AI confidence · {periodConfidence}
                  </Badge>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className={`h-8 w-36 text-sm ${!normalizePeriod(packPeriod) ? "border-amber-500" : ""}`}
                  value={packPeriod}
                  onChange={(e) => setPackPeriod(e.target.value)}
                  placeholder="2025-09 or Q3 2025"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={applyPeriodToAll}
                >
                  Apply to all rows
                </Button>
              </div>
              {periodEvidence ? (
                <p className="text-[11px] text-muted-foreground leading-snug">
                  Date evidence: {periodEvidence}
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  Enter the as-of / board date if you know it (YYYY-MM or Q3 2025). Override any
                  row below individually.
                </p>
              )}
            </div>

            <div className="max-h-[300px] overflow-y-auto rounded border border-border divide-y divide-border">
              {rows.map((r, i) => {
                const def = metricDef(r.metric);
                const badPeriod = !normalizePeriod(r.periodText);
                const badValue = !Number.isFinite(Number(r.valueText.replace(/[$,%\s]/g, "")));
                return (
                  <div key={i} className={`p-2.5 ${r.checked ? "" : "opacity-50"}`}>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={r.checked}
                        onCheckedChange={(v) => patchRow(i, { checked: v === true })}
                      />
                      <span className="text-sm font-medium flex-1">
                        {def?.label ?? r.metric}
                        <span className="text-muted-foreground text-xs ml-1">({def?.unit})</span>
                      </span>
                      <Input
                        className={`h-7 w-24 text-sm ${r.checked && badValue ? "border-red-500" : ""}`}
                        value={r.valueText}
                        onChange={(e) => patchRow(i, { valueText: e.target.value })}
                      />
                      <Input
                        className={`h-7 w-28 text-sm ${r.checked && badPeriod ? "border-red-500" : ""}`}
                        value={r.periodText}
                        onChange={(e) => patchRow(i, { periodText: e.target.value })}
                        placeholder="2025-09"
                      />
                    </div>
                    {r.quote && (
                      <p className="mt-1 ml-6 text-[11px] text-muted-foreground italic">
                        “{r.quote}”
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <DialogFooter>
          {rows.length > 0 && (
            <Button variant="ghost" onClick={() => setRows([])} disabled={saving}>
              Back
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={extracting || saving}
          >
            Cancel
          </Button>
          {rows.length === 0 ? (
            <Button onClick={extract} disabled={extracting || !canExtract}>
              {extracting ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5 mr-1" />
              )}
              {extracting ? "Reading…" : "Extract KPIs"}
            </Button>
          ) : (
            <Button onClick={save} disabled={saving || checkedRows.length === 0 || invalidChecked}>
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5 mr-1" />
              )}
              Save {checkedRows.length} datapoint{checkedRows.length !== 1 ? "s" : ""}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    pdf: "application/pdf",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ppt: "application/vnd.ms-powerpoint",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    txt: "text/plain",
    csv: "text/csv",
    md: "text/markdown",
  };
  return map[ext] || "application/octet-stream";
}
