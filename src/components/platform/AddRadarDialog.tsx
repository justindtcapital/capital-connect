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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Radar } from "lucide-react";
import { toast } from "sonner";
import { addRadarEntry } from "@/utils/platform.functions";
import type { RadarEntry } from "@/lib/platform-content";

const SEGMENTS = ["AI", "Data", "Security", "Cloud", "Supply Chain", "Logistics", "Silicon", "Other"];

const labelClass =
  "text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block";

// Add a company to the firm-level competitive radar (curated watchlist —
// distinct from the derived per-company competitor list on /companies).
export function AddRadarDialog({
  open,
  onOpenChange,
  userEmail,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  userEmail: string;
  onAdded?: (entry: RadarEntry) => void;
}) {
  const [company, setCompany] = useState("");
  const [website, setWebsite] = useState("");
  const [segment, setSegment] = useState("");
  const [theme, setTheme] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setCompany("");
    setWebsite("");
    setSegment("");
    setTheme("");
    setNote("");
    setBusy(false);
  };

  const submit = async () => {
    if (!company.trim()) return;
    setBusy(true);
    try {
      const entry = await addRadarEntry({
        data: {
          entry: {
            company: company.trim(),
            website: website.trim(),
            segment,
            theme: theme.trim(),
            note: note.trim(),
          },
          addedBy: userEmail,
        },
      });
      toast.success(`Watching ${entry.company}.`);
      onAdded?.(entry);
      reset();
      onOpenChange(false);
    } catch (e) {
      console.error("addRadarEntry failed", e);
      toast.error(e instanceof Error ? e.message : "Couldn't add to the radar.");
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
          <DialogTitle>Watch a company</DialogTitle>
          <DialogDescription className="text-xs">
            Adds the company to the firm-level competitive radar. Tag it with a theme to have it
            surface in themed executive briefs.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 py-2">
          <div className="col-span-2">
            <Label className={labelClass}>Company *</Label>
            <Input
              className="h-8 text-sm"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="Anthropic"
              autoFocus
            />
          </div>
          <div>
            <Label className={labelClass}>Website</Label>
            <Input
              className="h-8 text-sm"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="anthropic.com"
            />
          </div>
          <div>
            <Label className={labelClass}>Segment</Label>
            <Select value={segment} onValueChange={setSegment}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="Pick…" />
              </SelectTrigger>
              <SelectContent>
                {SEGMENTS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2">
            <Label className={labelClass}>Theme tag</Label>
            <Input
              className="h-8 text-sm"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              placeholder="agentic AI, supply-chain visibility…"
            />
          </div>
          <div className="col-span-2">
            <Label className={labelClass}>Why we watch it</Label>
            <Input
              className="h-8 text-sm"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Competes with PortCo X on…"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !company.trim()}>
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <Radar className="h-3.5 w-3.5 mr-1" />
            )}
            Watch company
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
