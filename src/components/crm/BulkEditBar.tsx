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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Check, ChevronDown, Cpu, Loader2, Sparkles, Tag, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "@tanstack/react-router";
import { useSelection } from "@/lib/selection-context";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { bulkUpdateContacts, bulkDeleteContacts, bulkEnrichContacts, bulkLoadInterests } from "@/utils/sheets.functions";
import { bulkLoadTechStack } from "@/utils/sumble.functions";
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

// Selectable Contact Primes for the bulk-edit multi-select.
const PRIMES = ["Julia", "Hillock", "Falloon"] as const;

// In-list bulk editor: appears above the contact table once rows are selected.
// Persists the change to the Contacts sheet (bulkUpdateContacts) and reflects it
// locally via the selection context's onBulkUpdate.
export function BulkEditBar() {
  const { selectedContacts, selectedIds, clearSelection, onBulkUpdate, onBulkDelete } =
    useSelection();
  const router = useRouter();
  const [field, setField] = useState<BulkEditField>("status");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Which mass action is currently running ("" = none). Disables the whole bar.
  const [action, setAction] = useState<"" | "enrich" | "interests" | "tech">("");
  const [techConfirmOpen, setTechConfirmOpen] = useState(false);

  if (selectedIds.size === 0) return null;

  const count = selectedIds.size;
  const anyBusy = busy || deleting || action !== "";

  // Mass Apollo enrichment: fill blank fields + headline/employment/sector for
  // every selected contact, non-destructively. Refreshes the list from the sheet.
  const runEnrich = async () => {
    setAction("enrich");
    try {
      const contacts = selectedContacts
        .filter((c) => c.email)
        .map((c) => ({ email: c.email, name: c.name, company: c.company, urid: c.urid }));
      if (contacts.length === 0) {
        toast.error("None of the selected contacts have an email to match on.");
        return;
      }
      const res = await bulkEnrichContacts({ data: { contacts } });
      toast.success(
        `Apollo: enriched ${res.updated} of ${contacts.length} · ${res.matched} matched, ${res.notFound} no match` +
          (res.failed ? `, ${res.failed} failed` : ""),
      );
      await router.invalidate();
      clearSelection();
    } catch (e) {
      console.error("BulkEditBar: bulkEnrichContacts failed", e);
      toast.error("Mass enrich failed — see console.");
    } finally {
      setAction("");
    }
  };

  // Mass interest-area load: infer + persist to the sheet (fill-only).
  const runInterests = async () => {
    setAction("interests");
    try {
      const contacts = selectedContacts.map((c) => ({
        email: c.email,
        urid: c.urid,
        title: c.title,
        company: c.company,
        sector: c.sector,
      }));
      const res = await bulkLoadInterests({ data: { contacts } });
      toast.success(
        `Loaded interest areas for ${res.updated} contact${res.updated !== 1 ? "s" : ""}` +
          (res.inferred - res.updated > 0 ? ` (${res.inferred - res.updated} already had areas)` : ""),
      );
      await router.invalidate();
      clearSelection();
    } catch (e) {
      console.error("BulkEditBar: bulkLoadInterests failed", e);
      toast.error("Loading interest areas failed — see console.");
    } finally {
      setAction("");
    }
  };

  // Mass tech-stack load (Sumble, credit-costly → confirmed first).
  const runTechStack = async () => {
    setTechConfirmOpen(false);
    setAction("tech");
    try {
      const contacts = selectedContacts
        .filter((c) => c.company)
        .map((c) => ({ email: c.email, urid: c.urid, company: c.company }));
      if (contacts.length === 0) {
        toast.error("None of the selected contacts have a company to look up.");
        return;
      }
      const res = await bulkLoadTechStack({ data: { contacts } });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(
        `Tech stack loaded for ${res.updated} contact${res.updated !== 1 ? "s" : ""} across ${res.resolved}/${res.companies} companies` +
          (res.creditsRemaining !== undefined ? ` · ${res.creditsRemaining} Sumble credits left` : ""),
      );
      await router.invalidate();
      clearSelection();
    } catch (e) {
      console.error("BulkEditBar: bulkLoadTechStack failed", e);
      toast.error("Loading tech stack failed — see console.");
    } finally {
      setAction("");
    }
  };

  // Unique companies among the selection — shown in the tech-stack cost confirm.
  const uniqueCompanies = new Set(
    selectedContacts.map((c) => (c.company || "").trim().toLowerCase()).filter(Boolean),
  ).size;

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

  // Hard-delete the selected contacts from the Contacts sheet. Confirmed first.
  const doDelete = async () => {
    setDeleting(true);
    try {
      const emails = selectedContacts.map((c) => c.email).filter(Boolean);
      const res = await bulkDeleteContacts({ data: { emails } });
      toast.success(`Deleted ${res.deleted} contact${res.deleted !== 1 ? "s" : ""}.`);
      onBulkDelete?.(selectedContacts.map((c) => c.id));
      clearSelection();
    } catch (e) {
      console.error("BulkEditBar: bulkDeleteContacts failed", e);
      toast.error("Delete failed — see console.");
    } finally {
      setDeleting(false);
      setConfirmOpen(false);
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
    if (field === "prime") {
      const selected = value.split(",").map((s) => s.trim()).filter(Boolean);
      const toggle = (name: string) => {
        const next = selected.includes(name)
          ? selected.filter((s) => s !== name)
          : [...selected, name];
        setValue(next.join(", "));
      };
      return (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 w-56 justify-between text-sm font-normal">
              <span className={selected.length ? "" : "text-muted-foreground"}>
                {selected.length ? selected.join(", ") : "Choose prime(s)…"}
              </span>
              <ChevronDown className="h-3.5 w-3.5 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-56 p-1">
            {PRIMES.map((name) => (
              <label
                key={name}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
              >
                <Checkbox
                  checked={selected.includes(name)}
                  onCheckedChange={() => toggle(name)}
                />
                {name}
              </label>
            ))}
          </PopoverContent>
        </Popover>
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
      <Button size="sm" className="h-8 text-xs" onClick={apply} disabled={anyBusy || !value.trim()}>
        {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1" />}
        Apply to {count}
      </Button>

      {/* Mass actions — operations over the selection (not a single field set). */}
      <div className="mx-1 h-5 w-px bg-border" />
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={runEnrich} disabled={anyBusy}>
        {action === "enrich" ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-1" />}
        Enrich w/ Apollo
      </Button>
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={runInterests} disabled={anyBusy}>
        {action === "interests" ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Tag className="h-3.5 w-3.5 mr-1" />}
        Load interests
      </Button>
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setTechConfirmOpen(true)} disabled={anyBusy}>
        {action === "tech" ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Cpu className="h-3.5 w-3.5 mr-1" />}
        Load tech stack
      </Button>

      <Button
        size="sm"
        variant="outline"
        className="h-8 text-xs ml-auto text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
        onClick={() => setConfirmOpen(true)}
        disabled={anyBusy}
      >
        <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
      </Button>
      <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={clearSelection} disabled={anyBusy}>
        <X className="h-3.5 w-3.5 mr-1" /> Clear
      </Button>

      <AlertDialog open={techConfirmOpen} onOpenChange={setTechConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Load tech stack for {count} contact{count !== 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              This queries Sumble for {uniqueCompanies} unique compan{uniqueCompanies !== 1 ? "ies" : "y"}
              {" "}(deduped, so shared employers are priced once) and writes each company's top
              technologies to the contacts' “Tech Stack” column. Sumble job lookups consume credits.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void runTechStack(); }}>
              Load for {uniqueCompanies} compan{uniqueCompanies !== 1 ? "ies" : "y"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {count} contact{count !== 1 ? "s" : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes {count === 1 ? "this contact" : "these contacts"} from the
              Contacts sheet. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void doDelete();
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Deleting…
                </>
              ) : (
                <>Delete {count}</>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
