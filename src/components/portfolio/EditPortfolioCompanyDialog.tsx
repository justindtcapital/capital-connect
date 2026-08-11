import { useEffect, useState } from "react";
import type { PortfolioCompany, PortfolioDomain } from "@/lib/types";
import { portfolioDomains } from "@/lib/types";
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
import { Loader2, Pencil } from "lucide-react";
import { updatePortfolioCompany } from "@/utils/sheets.functions";
import { normalizeFocusArea } from "@/lib/focus-area-utils";
import { toast } from "sonner";

const labelClass =
  "text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block";

function domainFromFocus(focusArea: string): PortfolioDomain {
  const n = normalizeFocusArea(focusArea);
  return (portfolioDomains as string[]).includes(n) ? (n as PortfolioDomain) : "Cloud";
}

// Edit sheet-backed fields for an existing portfolio company. Persists via
// updatePortfolioCompany and returns the patched company for live UI update.
export function EditPortfolioCompanyDialog({
  company,
  open,
  onOpenChange,
  onSaved,
}: {
  company: PortfolioCompany | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved?: (updated: PortfolioCompany) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [focusArea, setFocusArea] = useState("");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !company) return;
    setName(company.name || "");
    setWebsite(company.website || "");
    setFocusArea(company.sector || "");
    setLocation(company.location || "");
    setDescription(company.description || "");
    setBusy(false);
  }, [open, company]);

  const submit = async () => {
    if (!company || !name.trim()) return;
    setBusy(true);
    try {
      const payload = {
        urid: company.urid,
        matchName: company.name,
        name: name.trim(),
        website: website.trim(),
        focusArea: focusArea.trim(),
        location: location.trim(),
        description: description.trim(),
      };
      const res = await updatePortfolioCompany({ data: payload });
      if (!res.updated) {
        toast.error("Couldn't find that company in the sheet to update.");
        return;
      }
      const updated: PortfolioCompany = {
        ...company,
        name: payload.name,
        website: payload.website,
        sector: payload.focusArea,
        domain: domainFromFocus(payload.focusArea),
        location: payload.location,
        description: payload.description,
      };
      toast.success(`Updated ${payload.name}.`);
      await onSaved?.(updated);
      onOpenChange(false);
    } catch (e) {
      console.error("updatePortfolioCompany failed", e);
      toast.error("Couldn't update the company — see console.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit portfolio company</DialogTitle>
          <DialogDescription className="text-xs">
            Updates the Portfolio Companies sheet row. Website domain is used to match Key People.
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
          <Button onClick={() => void submit()} disabled={busy || !name.trim()}>
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <Pencil className="h-3.5 w-3.5 mr-1" />
            )}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
