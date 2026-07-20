import { useState } from "react";
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
import { Building2, Loader2 } from "lucide-react";
import { addPortfolioCompany } from "@/utils/sheets.functions";
import { toast } from "sonner";

const labelClass =
  "text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block";

// Create a new portfolio company. Writes a row to the "Portfolio Companies" sheet
// tab via addPortfolioCompany; onAdded refreshes the page loader so the card shows.
export function AddPortfolioCompanyDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAdded?: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [focusArea, setFocusArea] = useState("");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setName("");
    setWebsite("");
    setFocusArea("");
    setLocation("");
    setDescription("");
    setBusy(false);
  };

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await addPortfolioCompany({
        data: {
          name: name.trim(),
          website: website.trim(),
          focusArea: focusArea.trim(),
          location: location.trim(),
          description: description.trim(),
        },
      });
      toast.success(`Added ${name.trim()} to the portfolio.`);
      await onAdded?.();
      reset();
      onOpenChange(false);
    } catch (e) {
      console.error("addPortfolioCompany failed", e);
      toast.error("Couldn't add the company — see console.");
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
          <DialogTitle>Add portfolio company</DialogTitle>
          <DialogDescription className="text-xs">
            Creates a new row in the Portfolio Companies tab. The website domain is used to match
            Key People (contacts on the same email domain).
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 py-2">
          <div className="col-span-2">
            <Label className={labelClass}>Company name *</Label>
            <Input
              className="h-8 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Coactive AI"
              autoFocus
            />
          </div>
          <div className="col-span-2">
            <Label className={labelClass}>Website</Label>
            <Input
              className="h-8 text-sm"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="coactive.ai"
            />
          </div>
          <div>
            <Label className={labelClass}>Focus area</Label>
            <Input
              className="h-8 text-sm"
              value={focusArea}
              onChange={(e) => setFocusArea(e.target.value)}
              placeholder="AI / Data"
            />
          </div>
          <div>
            <Label className={labelClass}>HQ</Label>
            <Input
              className="h-8 text-sm"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="San Jose, CA"
            />
          </div>
          <div className="col-span-2">
            <Label className={labelClass}>Summary</Label>
            <Textarea
              className="text-sm min-h-[64px]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What the company does…"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <Building2 className="h-3.5 w-3.5 mr-1" />
            )}
            Add company
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
