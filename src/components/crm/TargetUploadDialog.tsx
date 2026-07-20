import { useMemo, useState } from "react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { importTargets } from "@/utils/sheets.functions";
import { enrichContact } from "@/utils/apollo.functions";
import { normalizeEmails } from "@/lib/email";
import { targetKeyOf, RECORD_SOURCES } from "@/lib/types";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** targetKeyOf() for existing targets — used to preview duplicate skips. */
  existingKeys?: string[];
  onImported?: () => void | Promise<void>;
}

interface ParsedRow {
  name: string;
  firstName: string;
  lastName: string;
  title: string;
  company: string;
  email: string;
  phone: string;
  location: string;
  linkedin: string;
  sector: string;
}

type FieldKey = keyof ParsedRow;
type Mapping = Record<FieldKey, number>;

const FIELDS: { key: FieldKey; label: string; hint?: string }[] = [
  { key: "name", label: "Full name" },
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "title", label: "Title" },
  { key: "company", label: "Company" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "location", label: "Location" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "sector", label: "Sector" },
];

const NO_COLUMN = -1;

function emptyMapping(): Mapping {
  return {
    name: NO_COLUMN, firstName: NO_COLUMN, lastName: NO_COLUMN, title: NO_COLUMN,
    company: NO_COLUMN, email: NO_COLUMN, phone: NO_COLUMN, location: NO_COLUMN,
    linkedin: NO_COLUMN, sector: NO_COLUMN,
  };
}

// Header alias → field. Recognizes First/Last name, company/title/linkedin/region
// aliases so a paste from Apollo/Sales Nav/LinkedIn exports auto-maps.
const HEADER_MAP: Record<string, FieldKey> = {
  name: "name", "full name": "name", "contact name": "name",
  "first name": "firstName", firstname: "firstName", first: "firstName", "given name": "firstName",
  "last name": "lastName", lastname: "lastName", last: "lastName", surname: "lastName", "family name": "lastName",
  title: "title", role: "title", "job title": "title", position: "title", headline: "title",
  company: "company", organization: "company", organisation: "company", account: "company", employer: "company",
  email: "email", "email address": "email", "work email": "email", "e-mail": "email",
  phone: "phone", "phone number": "phone", mobile: "phone", telephone: "phone",
  location: "location", city: "location", region: "location", state: "location", geography: "location", "location name": "location", country: "location",
  linkedin: "linkedin", "linkedin url": "linkedin", "linkedin profile": "linkedin", "person linkedin url": "linkedin", profile: "linkedin",
  sector: "sector", industry: "sector", vertical: "sector",
};

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) || "";
  const candidates = [",", ";", "\t"];
  let best = ",";
  let bestCount = -1;
  for (const d of candidates) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === d && !inQuotes) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

function parseCsv(text: string, delim = ","): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === delim) {
        row.push(cell);
        cell = "";
      } else if (ch === "\n") {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else if (ch === "\r") {
        /* skip */
      } else cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

function autoMap(headers: string[]): Mapping {
  const result = emptyMapping();
  headers.forEach((h, i) => {
    const field = HEADER_MAP[h.trim().toLowerCase()];
    if (field && result[field] === NO_COLUMN) result[field] = i;
  });
  return result;
}

function normalizeLinkedin(url: string): string {
  const u = (url || "").trim();
  if (!u) return "";
  const withScheme = /^https?:\/\//i.test(u) ? u : `https://${u}`;
  return withScheme.replace(/\/+$/, "");
}

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") };
}

// The effective display name: combined First/Last when those columns are mapped,
// otherwise the single Name column.
function effectiveName(r: ParsedRow): string {
  if (r.firstName || r.lastName) return `${r.firstName} ${r.lastName}`.trim();
  return r.name;
}

async function enrichRow(r: ParsedRow): Promise<{ row: ParsedRow; enriched: boolean }> {
  if (r.title && r.company && r.phone && r.location && r.sector && r.email)
    return { row: r, enriched: false };
  const nm = splitName(effectiveName(r));
  try {
    const result = await enrichContact({
      data: {
        email: r.email || undefined,
        firstName: nm.firstName || undefined,
        lastName: nm.lastName || undefined,
        company: r.company || undefined,
        linkedinUrl: r.linkedin || undefined,
      },
    });
    if (!result.found) return { row: r, enriched: false };
    const apolloLocation = [result.city, result.state].filter(Boolean).join(", ");
    const row: ParsedRow = {
      ...r,
      title: r.title || result.title || "",
      company: r.company || result.company || "",
      email: r.email || result.email || "",
      phone: r.phone || result.phone || "",
      location: r.location || apolloLocation,
      sector: r.sector || result.industry || "",
      linkedin: r.linkedin || normalizeLinkedin(result.linkedinUrl || ""),
    };
    const enriched =
      row.title !== r.title ||
      row.company !== r.company ||
      row.email !== r.email ||
      row.phone !== r.phone ||
      row.location !== r.location ||
      row.sector !== r.sector ||
      row.linkedin !== r.linkedin;
    return { row, enriched };
  } catch (e) {
    console.error("target upload enrich failed", r.email, e);
    return { row: r, enriched: false };
  }
}

export function TargetUploadDialog({ open, onOpenChange, existingKeys = [], onImported }: Props) {
  const [grid, setGrid] = useState<string[][] | null>(null);
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState<Mapping>(emptyMapping());
  const [source, setSource] = useState<string>("CSV Import");
  const [enrichOnImport, setEnrichOnImport] = useState(true);
  const [busy, setBusy] = useState(false);

  const headers = grid?.[0] ?? [];
  const hasNameSource = mapping.name !== NO_COLUMN || mapping.firstName !== NO_COLUMN;

  const handleFile = async (file: File) => {
    setFileName(file.name);
    const text = await file.text();
    const g = parseCsv(text, detectDelimiter(text));
    if (g.length < 2) {
      setGrid(null);
      toast.error("That file has no data rows.");
      return;
    }
    setGrid(g);
    setMapping(autoMap(g[0]));
  };

  const setFieldColumn = (field: FieldKey, idx: number) =>
    setMapping((m) => ({ ...m, [field]: idx }));

  const report = useMemo(() => {
    if (!grid || grid.length < 2) {
      return { rows: [] as ParsedRow[], skipped: 0, missingName: 0, dataRows: 0 };
    }
    const cell = (r: string[], idx: number) => (idx >= 0 && idx < r.length ? (r[idx] || "").trim() : "");
    const all: ParsedRow[] = grid.slice(1).map((r) => ({
      name: cell(r, mapping.name),
      firstName: cell(r, mapping.firstName),
      lastName: cell(r, mapping.lastName),
      title: cell(r, mapping.title),
      company: cell(r, mapping.company),
      email: normalizeEmails(cell(r, mapping.email)),
      phone: cell(r, mapping.phone),
      location: cell(r, mapping.location),
      linkedin: normalizeLinkedin(cell(r, mapping.linkedin)),
      sector: cell(r, mapping.sector),
    }));

    const existing = new Set(existingKeys.map((k) => k.trim().toLowerCase()).filter(Boolean));
    const seen = new Set<string>();
    const unique: ParsedRow[] = [];
    let dupes = 0;
    let missingName = 0;
    for (const r of all) {
      const nm = effectiveName(r);
      if (!nm && !r.email && !r.linkedin) {
        missingName++;
        continue;
      }
      const key = targetKeyOf({ email: r.email, name: nm, company: r.company });
      if (key && (existing.has(key) || seen.has(key))) {
        dupes++;
        continue;
      }
      if (key) seen.add(key);
      unique.push(r);
    }
    return { rows: unique, skipped: dupes, missingName, dataRows: all.length };
  }, [grid, mapping, existingKeys]);

  const { rows, skipped } = report;

  const reset = () => {
    setGrid(null);
    setFileName("");
    setMapping(emptyMapping());
    setSource("CSV Import");
    setEnrichOnImport(true);
    setBusy(false);
  };

  const submit = async () => {
    if (rows.length === 0) return;
    setBusy(true);
    let enrichedCount = 0;
    const built = [];
    for (const original of rows) {
      let r = original;
      if (enrichOnImport) {
        const res = await enrichRow(original);
        r = res.row;
        if (res.enriched) enrichedCount++;
      }
      const nm = effectiveName(r);
      const parts = r.firstName || r.lastName ? { firstName: r.firstName, lastName: r.lastName } : splitName(nm);
      built.push({
        firstName: parts.firstName || nm || r.email,
        lastName: parts.lastName,
        company: r.company,
        role: r.title,
        linkedin: r.linkedin,
        email: r.email,
        phone: r.phone,
        location: r.location,
        sector: r.sector,
        stage: "Prospecting",
        source: source.trim() || "CSV Import",
        researchPurpose: "",
        reasonSurfaced: "",
      });
    }

    try {
      const res = await importTargets({ data: { targets: built } });
      const parts = [`Imported ${res.added} target${res.added !== 1 ? "s" : ""}`];
      if (enrichOnImport) parts.push(`${enrichedCount} enriched`);
      if (res.duplicates) parts.push(`${res.duplicates} duplicate${res.duplicates !== 1 ? "s" : ""} skipped`);
      toast.success(parts.join(" · "));
      if (res.added > 0) await onImported?.();
      reset();
      onOpenChange(false);
    } catch (e) {
      console.error("importTargets (upload) failed", e);
      toast.error("Import failed — see console.");
    } finally {
      setBusy(false);
    }
  };

  const preview = useMemo(() => rows.slice(0, 8), [rows]);

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
          <DialogTitle>Upload targets (CSV)</DialogTitle>
          <DialogDescription className="text-xs">
            Upload a CSV — columns auto-match by header (First/Last name, title, company, LinkedIn,
            region…). Adjust the mapping if anything's off. New rows enter as{" "}
            <span className="font-medium">Prospecting</span>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
              CSV file
            </Label>
            <Input
              type="file"
              accept=".csv,text/csv"
              className="h-9 text-xs"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
          </div>

          {grid && (
            <>
              <div>
                <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                  Map columns
                </Label>
                <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                  {FIELDS.map((field) => (
                    <div key={field.key} className="flex items-center gap-2">
                      <span className="text-[11px] w-20 shrink-0 text-muted-foreground">
                        {field.label}
                      </span>
                      <Select
                        value={String(mapping[field.key])}
                        onValueChange={(v) => setFieldColumn(field.key, Number(v))}
                      >
                        <SelectTrigger className="h-8 text-xs flex-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={String(NO_COLUMN)}>— Not mapped —</SelectItem>
                          {headers.map((h, i) => (
                            <SelectItem key={i} value={String(i)}>
                              {h.trim() || `Column ${i + 1}`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
                {!hasNameSource && (
                  <p className="text-[11px] text-destructive mt-1.5">
                    Map a Full name (or First name) column to enable import.
                  </p>
                )}
              </div>

              {rows.length > 0 ? (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                        Source
                      </Label>
                      <Select value={source} onValueChange={setSource}>
                        <SelectTrigger className="h-9 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {RECORD_SOURCES.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer sm:pt-6">
                      <Checkbox
                        checked={enrichOnImport}
                        onCheckedChange={(v) => setEnrichOnImport(v === true)}
                        className="mt-0.5"
                      />
                      <span>Auto-enrich missing fields with Apollo.</span>
                    </label>
                  </div>

                  <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px]">
                    <div className="font-semibold text-foreground mb-1">Validation report</div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground">
                      <span>Data rows in file</span>
                      <span className="text-right tabular-nums">{report.dataRows}</span>
                      <span className="text-emerald-600 font-medium">Ready to import</span>
                      <span className="text-right tabular-nums text-emerald-600 font-medium">
                        {rows.length}
                      </span>
                      {skipped > 0 && (
                        <>
                          <span>Duplicates skipped</span>
                          <span className="text-right tabular-nums">{skipped}</span>
                        </>
                      )}
                      {report.missingName > 0 && (
                        <>
                          <span className="text-amber-600">No name/email/LinkedIn</span>
                          <span className="text-right tabular-nums text-amber-600">
                            {report.missingName}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  <div>
                    <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Preview · first {Math.min(rows.length, 8)} of {rows.length}
                    </Label>
                    <ScrollArea className="h-44 border border-border rounded">
                      <table className="w-full text-[11px]">
                        <thead className="bg-muted/40 sticky top-0">
                          <tr className="text-left">
                            <th className="px-2 py-1 font-semibold">Name</th>
                            <th className="px-2 py-1 font-semibold">Email</th>
                            <th className="px-2 py-1 font-semibold">Company</th>
                            <th className="px-2 py-1 font-semibold">Title</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.map((r, i) => (
                            <tr key={i} className="border-t border-border">
                              <td className="px-2 py-1">{effectiveName(r) || "—"}</td>
                              <td className="px-2 py-1 text-muted-foreground">{r.email}</td>
                              <td className="px-2 py-1">{r.company}</td>
                              <td className="px-2 py-1 text-muted-foreground">{r.title}</td>
                            </tr>
                          ))}
                          {rows.length > preview.length && (
                            <tr>
                              <td colSpan={4} className="px-2 py-1 text-muted-foreground italic">
                                …and {rows.length - preview.length} more
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </ScrollArea>
                  </div>
                </>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  {!hasNameSource
                    ? "Map a name column above to continue."
                    : skipped > 0
                      ? `All ${skipped} row${skipped !== 1 ? "s" : ""} are already targets.`
                      : "No importable rows — check your column mapping."}
                </p>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={rows.length === 0 || busy} onClick={submit}>
            {busy
              ? enrichOnImport
                ? "Enriching & importing…"
                : "Importing…"
              : `Import ${rows.length || ""} target${rows.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
