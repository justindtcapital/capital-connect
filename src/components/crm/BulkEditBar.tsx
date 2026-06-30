import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Check, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { useSelection } from "@/lib/selection-context";
import { bulkUpdateContacts } from "@/utils/sheets.functions";
import { RECORD_SOURCES, CONTACT_TYPES, type BulkEditField, type Temperature, type Contact } from "@/lib/types";

// Fields the bulk-edit bar can set, in display order. Mirrors the BulkEditField
// union; each maps to a Contacts-sheet column via bulkUpdateContacts.
const FIELDS: { key: BulkEditField; label: string }[] = [
  { key: "status", label: "Status" },
  { key: "sector", label: "Sector" },
  { key: "prime", label: "Contact Prime" },
  { key: "title", label: "Title" },
  { key: "company", label: "Company" },
  { key: "location", label: "Location" },
  { key: "contactType", label: "Contact Type" },
  { key: "areasOfInterest", label: "Area of Interest" },
  { key: "source", label: "Source" },
];

const TEMPERATURES: Temperature[] = ["Hot", "Warm", "Cold"];

// In-list bulk editor: appears above the contact table once rows are selected.
// Persists the change to the Contacts sheet (bulkUpdateContacts) and reflects it
// locally via the selection context's onBulkUpdate.
export function BulkEditBar() {
  const { selectedContacts, selectedIds, clearSelection, onBulkUpdate } = useSelection();
  const [field, setField] = useState<BulkEditField>("status");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  if (selectedIds.size === 0) return null;

  const count = selectedIds.size;

  const apply = async () => {
    const v = value.trim();
    if (!v) {
      toast.error("Choose a value to apply.");
      return;
    }
    setBusy(true);
    try {
      const emails = selectedContacts.map((c) => c.email).filter(Boolean);
      const res = await bulkUpdateContacts({ data: { emails, field, value: v } });
      if (onBulkUpdate) {
        const updated = selectedContacts.map((c) => {
          const u = { ...c };
          if (field === "status") {
            u.temperature = v as Temperature;
            u.ratingLocked = true; // a hand-set status shouldn't be auto-rescored
          } else if (field === "location") u.location = v;
          else if (field === "sector") u.sector = v;
          else if (field === "prime") u.prime = v;
          else if (field === "title") u.title = v;
          else if (field === "company") u.company = v;
          else if (field === "contactType") u.contactType = v;
          else if (field === "source") u.source = v as Contact["source"];
          else if (field === "areasOfInterest")
            u.areasOfInterest = v.split(",").map((s) => s.trim()).filter(Boolean);
          return u;
        });
        onBulkUpdate(updated);
      }
      const label = FIELDS.find((f) => f.key === field)?.label ?? field;
      toast.success(`Updated ${res.updated} contact${res.updated !== 1 ? "s" : ""} · ${label} → ${v}`);
      setValue("");
      clearSelection();
    } catch (e) {
      console.error("BulkEditBar: bulkUpdateContacts failed", e);
      toast.error("Bulk update failed — see console.");
    } finally {
      setBusy(false);
    }
  };

  // The value control depends on the field: fixed enums get a Select, the rest a
  // free-text input.
  const renderValueControl = () => {
    if (field === "status") {
      return (
        <Select value={value} onValueChange={setValue}>
          <SelectTrigger className="h-8 w-36 text-sm"><SelectValue placeholder="Choose status…" /></SelectTrigger>
          <SelectContent>{TEMPERATURES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
        </Select>
      );
    }
    if (field === "source") {
      return (
        <Select value={value} onValueChange={setValue}>
          <SelectTrigger className="h-8 w-44 text-sm"><SelectValue placeholder="Choose source…" /></SelectTrigger>
          <SelectContent>{RECORD_SOURCES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
        </Select>
      );
    }
    if (field === "contactType") {
      return (
        <Select value={value} onValueChange={setValue}>
          <SelectTrigger className="h-8 w-36 text-sm"><SelectValue placeholder="Choose type…" /></SelectTrigger>
          <SelectContent>{CONTACT_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
        </Select>
      );
    }
    return (
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && value.trim() && !busy) void apply(); }}
        placeholder={field === "areasOfInterest" ? "Comma-separated values…" : "New value…"}
        className="h-8 w-56 text-sm"
      />
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
      <span className="text-xs font-semibold text-foreground">{count} selected</span>
      <span className="text-xs text-muted-foreground">· Set</span>
      <Select
        value={field}
        onValueChange={(f) => { setField(f as BulkEditField); setValue(""); }}
      >
        <SelectTrigger className="h-8 w-40 text-sm"><SelectValue /></SelectTrigger>
        <SelectContent>
          {FIELDS.map((f) => <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <span className="text-xs text-muted-foreground">to</span>
      {renderValueControl()}
      <Button size="sm" className="h-8 text-xs" onClick={apply} disabled={busy || !value.trim()}>
        {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1" />}
        Apply to {count}
      </Button>
      <Button size="sm" variant="ghost" className="h-8 text-xs ml-auto" onClick={clearSelection} disabled={busy}>
        <X className="h-3.5 w-3.5 mr-1" /> Clear
      </Button>
    </div>
  );
}
