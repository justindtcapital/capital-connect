import { useEffect, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Lightbulb, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { saveThesis } from "@/utils/platform.functions";
import {
  THESIS_STAGES,
  joinList,
  splitList,
  type NewThesis,
  type Thesis,
} from "@/lib/platform-thesis";

const labelClass =
  "text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block";

const EMPTY: NewThesis = {
  name: "",
  sectors: [],
  stages: [],
  geos: [],
  keywords: [],
  exclusions: "",
  narrative: "",
};

// Create or edit an investment thesis (DealDesk's ThesisForm, adapted:
// revenue/EBITDA bands become the fund's funding-stage entry window).
export function ThesisDialog({
  open,
  onOpenChange,
  userEmail,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  userEmail: string;
  /** When set, the dialog edits this thesis in place. */
  editing?: Thesis | null;
  onSaved: (thesis: Thesis | null, updatedInPlace: NewThesis | null) => void;
}) {
  const [name, setName] = useState("");
  const [sectors, setSectors] = useState("");
  const [stages, setStages] = useState<string[]>([]);
  const [geos, setGeos] = useState("");
  const [keywords, setKeywords] = useState("");
  const [exclusions, setExclusions] = useState("");
  const [narrative, setNarrative] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const src: NewThesis = editing ?? EMPTY;
    setName(src.name);
    setSectors(joinList(src.sectors));
    setStages(src.stages);
    setGeos(joinList(src.geos));
    setKeywords(joinList(src.keywords));
    setExclusions(src.exclusions);
    setNarrative(src.narrative);
    setBusy(false);
  }, [open, editing]);

  const values = (): NewThesis => ({
    name: name.trim(),
    sectors: splitList(sectors),
    stages,
    geos: splitList(geos),
    keywords: splitList(keywords),
    exclusions: exclusions.trim(),
    narrative: narrative.trim(),
  });

  const canSubmit = name.trim().length > 0 && splitList(sectors).length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    const v = values();
    try {
      const res = await saveThesis({
        data: { thesis: v, id: editing?.id, savedBy: userEmail },
      });
      if (res.updated) {
        toast.success(`Updated "${v.name}".`);
        onSaved(null, v);
      } else if (res.thesis) {
        toast.success(`Thesis "${res.thesis.name}" created.`);
        onSaved(res.thesis, null);
      }
      onOpenChange(false);
    } catch (e) {
      console.error("saveThesis failed", e);
      toast.error(e instanceof Error ? e.message : "Couldn't save the thesis.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit thesis" : "New investment thesis"}</DialogTitle>
          <DialogDescription className="text-xs">
            Criteria drive on-demand screening of stored signals + grounded web research; nothing
            runs unattended. Matches land below the thesis with a 0–100 fit score.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 py-2">
          <div className="col-span-2">
            <Label className={labelClass}>Thesis name *</Label>
            <Input
              className="h-8 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Agentic AI security"
              autoFocus
            />
          </div>
          <div className="col-span-2">
            <Label className={labelClass}>Sectors * (comma-separated)</Label>
            <Input
              className="h-8 text-sm"
              value={sectors}
              onChange={(e) => setSectors(e.target.value)}
              placeholder="Security, AI"
            />
          </div>
          <div className="col-span-2">
            <Label className={labelClass}>Funding-stage window</Label>
            <div className="flex flex-wrap gap-3 text-sm">
              {THESIS_STAGES.map((s) => (
                <label key={s} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={stages.includes(s)}
                    onChange={(e) =>
                      setStages((prev) =>
                        e.target.checked ? [...prev, s] : prev.filter((x) => x !== s),
                      )
                    }
                  />
                  {s}
                </label>
              ))}
              <span className="text-[10px] text-muted-foreground self-center">
                (none checked = any early stage)
              </span>
            </div>
          </div>
          <div>
            <Label className={labelClass}>Geographies</Label>
            <Input
              className="h-8 text-sm"
              value={geos}
              onChange={(e) => setGeos(e.target.value)}
              placeholder="US, Israel"
            />
          </div>
          <div>
            <Label className={labelClass}>Keywords</Label>
            <Input
              className="h-8 text-sm"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="agentic, runtime, SBOM"
            />
          </div>
          <div className="col-span-2">
            <Label className={labelClass}>Exclusions</Label>
            <Input
              className="h-8 text-sm"
              value={exclusions}
              onChange={(e) => setExclusions(e.target.value)}
              placeholder="No consumer apps; no services businesses"
            />
          </div>
          <div className="col-span-2">
            <Label className={labelClass}>Narrative</Label>
            <Textarea
              rows={3}
              className="text-sm"
              value={narrative}
              onChange={(e) => setNarrative(e.target.value)}
              placeholder="Describe the thesis in your own words — the screen prompt quotes this verbatim."
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !canSubmit}>
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <Lightbulb className="h-3.5 w-3.5 mr-1" />
            )}
            {editing ? "Save changes" : "Create thesis"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
