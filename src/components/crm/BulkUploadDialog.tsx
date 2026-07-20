import { useEffect, useMemo, useState } from "react";
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
import { EventPicker } from "@/components/events/EventPicker";
import { MultiSelect } from "@/components/ui/multi-select";
import { addContact, addEvent as addEventToSheet, addPortcoIntro, addNote, fetchContactEmails, logImportResult, fetchImportHistory, storeApolloRaw } from "@/utils/sheets.functions";
import { enrichContact } from "@/utils/apollo.functions";
import { toast } from "sonner";
import { normalizeEmails } from "@/lib/email";
import { normalizeLinkedinUrl } from "@/lib/linkedin";
import { ENGAGEMENT_SOURCES, type EngagementSource } from "@/lib/types";

interface BulkUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Known portfolio-company names, surfaced as suggestions for portco tagging. */
  portcoOptions?: string[];
  /** Emails of contacts that already exist — used to auto-skip duplicate rows. */
  existingEmails?: string[];
  /** Called after a successful import so the caller can refresh its data. */
  onImported?: () => void | Promise<void>;
}

interface ParsedRow {
  name: string;
  title: string;
  company: string;
  email: string;
  phone: string;
  location: string;
  prime: string;
  sector: string;
  linkedin: string;
  // Apollo-enrichment-only (never mapped from CSV columns).
  headline: string;
  employmentHistory: string;
}

interface ImportHistoryRow {
  importId: string;
  timestamp: string;
  filename: string;
  source: string;
  totalRows: number;
  imported: number;
  duplicates: number;
  invalid: number;
  enriched: number;
  failed: number;
}

// headline/employmentHistory are Apollo-only — never CSV columns, so they're
// excluded from the column-mapping keys.
type FieldKey = keyof Omit<ParsedRow, "headline" | "employmentHistory">;
type Mapping = Record<FieldKey, number>;

// The importable fields, in display order. Name + email are required.
const FIELDS: { key: FieldKey; label: string; required?: boolean }[] = [
  { key: "name", label: "Name", required: true },
  { key: "email", label: "Email", required: true },
  { key: "title", label: "Title" },
  { key: "company", label: "Company" },
  { key: "phone", label: "Phone" },
  { key: "location", label: "Location" },
  { key: "prime", label: "Prime" },
  { key: "sector", label: "Sector" },
  { key: "linkedin", label: "LinkedIn" },
];

const NO_COLUMN = -1;

// Pragmatic email check — catches the common malformed cases (missing @, no
// domain) without rejecting valid-but-unusual addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A cell may hold several emails ("a@x.com | b@y.com" / ";"-separated). Take the
// first for validation; the full original string is kept for storage + dedup.
function firstEmail(cell: string): string {
  return cell.split(/[|;,]/)[0]?.trim() || "";
}

function emptyMapping(): Mapping {
  return { name: NO_COLUMN, title: NO_COLUMN, company: NO_COLUMN, email: NO_COLUMN, phone: NO_COLUMN, location: NO_COLUMN, prime: NO_COLUMN, sector: NO_COLUMN, linkedin: NO_COLUMN };
}

// Sniff the delimiter from the first non-empty line by counting candidates
// outside quotes. Handles the classic event-list exports: comma, semicolon, tab.
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
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}

// Minimal CSV parser supporting quoted fields and embedded delimiters/newlines.
// `delim` defaults to comma; pass a sniffed delimiter for semicolon/tab files.
function parseCsv(text: string, delim = ","): string[][] {
  // Strip a UTF-8 BOM so it doesn't end up glued to the first header cell.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { cell += ch; }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === delim) { row.push(cell); cell = ""; }
      else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (ch === "\r") { /* skip */ }
      else cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

// Header alias -> field. Used to pre-fill the mapping on upload.
const HEADER_MAP: Record<string, FieldKey> = {
  name: "name",
  "full name": "name",
  title: "title",
  role: "title",
  company: "company",
  organization: "company",
  email: "email",
  "email address": "email",
  phone: "phone",
  "phone number": "phone",
  location: "location",
  city: "location",
  prime: "prime",
  "relationship prime": "prime",
  sector: "sector",
  industry: "sector",
  linkedin: "linkedin",
  "linkedin url": "linkedin",
  "linkedin profile": "linkedin",
  "linkedin profile url": "linkedin",
  "li url": "linkedin",
  "profile url": "linkedin",
};

// Best-guess mapping from the header row, leaving anything unrecognized unmapped.
function autoMap(headers: string[]): Mapping {
  const result = emptyMapping();
  headers.forEach((h, i) => {
    const field = HEADER_MAP[h.trim().toLowerCase()];
    if (field && result[field] === NO_COLUMN) result[field] = i;
  });
  return result;
}

// Format Apollo employment history into one cell: "Title @ Company (current); …".
function formatEmploymentHistory(
  history?: Array<{ title: string; company: string; current: boolean }>,
): string {
  if (!history || history.length === 0) return "";
  return history
    .map((j) => {
      const base = [j.title, j.company].filter(Boolean).join(" @ ");
      return j.current ? `${base} (current)` : base;
    })
    .filter(Boolean)
    .join("; ");
}

// Best-effort Apollo enrichment for a single row — fills ONLY the blank fields
// (title, company, phone, location, sector), never overwriting what the CSV
// provided, and additionally captures the person's headline + employment
// history (columns the CSV never carries). The portfolio-company sector override
// is applied server-side on add. Returns the row unchanged on no-match/error so
// import never blocks.
async function enrichRow(r: ParsedRow): Promise<{ row: ParsedRow; enriched: boolean }> {
  // Skip the Apollo call only when every enrichable field is already present.
  if (r.title && r.company && r.phone && r.location && r.sector && r.email && r.linkedin)
    return { row: r, enriched: false };
  const parts = r.name.trim().split(/\s+/);
  const firstName = parts[0] || "";
  const lastName = parts.slice(1).join(" ");
  try {
    const result = await enrichContact({
      data: {
        email: r.email || undefined,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
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
      linkedin: r.linkedin || normalizeLinkedinUrl(result.linkedinUrl),
      headline: r.headline || result.headline || "",
      employmentHistory: r.employmentHistory || formatEmploymentHistory(result.employmentHistory),
    };
    const enriched =
      row.title !== r.title ||
      row.company !== r.company ||
      row.email !== r.email ||
      row.phone !== r.phone ||
      row.location !== r.location ||
      row.sector !== r.sector ||
      row.linkedin !== r.linkedin ||
      row.headline !== r.headline ||
      row.employmentHistory !== r.employmentHistory;
    if (enriched && row.email) {
      storeApolloRaw({ data: { email: row.email, payload: result } }).catch(() => {});
    }
    return { row, enriched };
  } catch (e) {
    console.error("apollo enrich failed", r.email, e);
    return { row: r, enriched: false };
  }
}

export function BulkUploadDialog({ open, onOpenChange, portcoOptions = [], existingEmails = [], onImported }: BulkUploadDialogProps) {
  const [grid, setGrid] = useState<string[][] | null>(null);
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState<Mapping>(emptyMapping());
  const [eventName, setEventName] = useState("");
  const [portcoNames, setPortcoNames] = useState<string[]>([]);
  // How the tagged contacts came to engage the selected portcos — written to the
  // "PortCos Introduced" tab's Engagement Source column (defaults to a direct intro).
  const [portcoSource, setPortcoSource] = useState<EngagementSource>("direct introduction");
  const [source, setSource] = useState("");
  // Hands-off by default: imported contacts are auto-enriched unless unchecked.
  const [enrichOnImport, setEnrichOnImport] = useState(true);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ImportHistoryRow[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // Load past imports when the dialog opens (for the Import History panel).
  useEffect(() => {
    if (!open) return;
    fetchImportHistory()
      .then((h) => setHistory(h as ImportHistoryRow[]))
      .catch((e) => console.error("fetchImportHistory failed:", e));
  }, [open]);

  const headers = grid?.[0] ?? [];
  const missingRequired = mapping.name === NO_COLUMN || mapping.email === NO_COLUMN;

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

  // Build importable rows from the current column mapping, then run the pre-flight
  // checks: drop rows missing name/email, flag malformed emails, and dedupe
  // (within-file + against existing contacts). Recomputes as you remap.
  const report = useMemo(() => {
    if (!grid || grid.length < 2) {
      return { rows: [] as ParsedRow[], skipped: 0, invalid: 0, missingRequired: 0, dataRows: 0 };
    }
    const cell = (r: string[], idx: number) => (idx >= 0 && idx < r.length ? (r[idx] || "").trim() : "");
    const all: ParsedRow[] = grid.slice(1).map((r) => ({
      name: cell(r, mapping.name),
      title: cell(r, mapping.title),
      company: cell(r, mapping.company),
      email: normalizeEmails(cell(r, mapping.email)),
      phone: cell(r, mapping.phone),
      location: cell(r, mapping.location),
      prime: cell(r, mapping.prime),
      sector: cell(r, mapping.sector),
      linkedin: normalizeLinkedinUrl(cell(r, mapping.linkedin)),
      headline: "",
      employmentHistory: "",
    }));

    const existing = new Set(existingEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
    const seen = new Set<string>();
    const unique: ParsedRow[] = [];
    let dupes = 0, invalid = 0, missingRequired = 0;
    for (const r of all) {
      if (!r.name || !r.email) { missingRequired++; continue; }
      if (!EMAIL_RE.test(firstEmail(r.email))) { invalid++; continue; }
      const key = r.email.toLowerCase();
      if (existing.has(key) || seen.has(key)) { dupes++; continue; }
      seen.add(key);
      unique.push(r);
    }
    return { rows: unique, skipped: dupes, invalid, missingRequired, dataRows: all.length };
  }, [grid, mapping, existingEmails]);

  const { rows, skipped } = report;

  const reset = () => {
    setGrid(null);
    setFileName("");
    setMapping(emptyMapping());
    setEventName("");
    setPortcoNames([]);
    setPortcoSource("direct introduction");
    setSource("");
    setEnrichOnImport(true);
    setBusy(false);
  };

  const submit = async () => {
    if (rows.length === 0) return;
    setBusy(true);
    const importId =
      typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `imp-${Date.now()}`;
    const evt = eventName.trim();
    const portcos = portcoNames.map((p) => p.trim()).filter(Boolean);
    const src = source.trim();

    // Idempotency: re-read existing emails server-side right before committing so
    // re-importing the same file in one session can't double-create rows the
    // client snapshot didn't know about.
    let toImport = rows;
    let commitDupes = 0;
    try {
      const fresh = new Set((await fetchContactEmails()).map((e) => e.toLowerCase()));
      const filtered = rows.filter((r) => !fresh.has(r.email.toLowerCase()));
      commitDupes = rows.length - filtered.length;
      toImport = filtered;
    } catch (e) {
      console.error("commit-time dedup failed (proceeding with client dedup):", e);
    }

    let added = 0;
    let enrichedCount = 0;
    let taggedEvent = 0;
    let taggedPortco = 0;
    let taggedSource = 0;
    for (const original of toImport) {
      let r = original;
      if (enrichOnImport) {
        const res = await enrichRow(original);
        r = res.row;
        if (res.enriched) enrichedCount++;
      }
      try {
        await addContact({
          data: {
            name: r.name,
            role: r.title,
            company: r.company,
            email: r.email,
            phone: r.phone,
            location: r.location,
            prime: r.prime,
            sector: r.sector,
            linkedinUrl: r.linkedin,
            headline: r.headline,
            employmentHistory: r.employmentHistory,
            temperature: "Warm",
            source: "CSV Import",
          },
        });
        added++;
        // Each tag is best-effort and independent — a failure on one doesn't
        // block the others or the import as a whole.
        if (evt) {
          try {
            await addEventToSheet({ data: { contactEmail: r.email, eventName: evt, type: "attended" } });
            taggedEvent++;
          } catch (e) {
            console.error("event tag failed", r.email, e);
          }
        }
        if (portcos.length > 0) {
          // Tag the contact with each selected portfolio company (independent,
          // best-effort). Count the contact once if any tag lands.
          let taggedAny = false;
          for (const portco of portcos) {
            try {
              await addPortcoIntro({ data: { contactEmail: r.email, portcoName: portco, source: portcoSource } });
              taggedAny = true;
            } catch (e) {
              console.error("portco tag failed", r.email, portco, e);
            }
          }
          if (taggedAny) taggedPortco++;
        }
        if (src) {
          try {
            await addNote({ data: { contactEmail: r.email, noteContent: `Source: ${src}`, requiresFollowUp: false } });
            taggedSource++;
          } catch (e) {
            console.error("source tag failed", r.email, e);
          }
        }
      } catch (e) {
        console.error("add contact failed", r.email, e);
      }
    }
    setBusy(false);

    const failed = toImport.length - added;
    const totalDupes = skipped + commitDupes;

    // Persist the import report (best-effort) so it shows in Import History.
    try {
      await logImportResult({
        data: {
          importId,
          filename: fileName || "upload.csv",
          source: "bulk_upload",
          totalRows: report.dataRows,
          imported: added,
          duplicates: totalDupes,
          invalid: report.invalid,
          enriched: enrichedCount,
          failed,
        },
      });
    } catch (e) {
      console.error("logImportResult failed:", e);
    }

    const parts = [`Imported ${added} contact${added !== 1 ? "s" : ""}`];
    if (enrichOnImport) parts.push(`${enrichedCount} enriched`);
    if (totalDupes > 0) parts.push(`${totalDupes} duplicate${totalDupes !== 1 ? "s" : ""} skipped`);
    if (evt) parts.push(`${taggedEvent} → event "${evt}"`);
    if (portcos.length > 0)
      parts.push(
        `${taggedPortco} → ${portcos.length === 1 ? `portco "${portcos[0]}"` : `${portcos.length} portcos`}`,
      );
    if (src) parts.push(`${taggedSource} → source "${src}"`);
    const message = parts.join(" · ");
    if (failed > 0) toast.warning(`${message} · ${failed} failed (see console)`);
    else toast.success(message);

    // Refresh the caller's data (re-runs the route loader) so the new contacts
    // show up immediately and stay accounted for by dedupe on the next upload.
    if (added > 0) await onImported?.();

    reset();
    onOpenChange(false);
  };

  const preview = useMemo(() => rows.slice(0, 8), [rows]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bulk import contacts</DialogTitle>
          <DialogDescription className="text-xs">
            Upload a CSV. Columns are auto-matched by header — adjust the mapping below if anything is off.
            Name and email are required. Optionally tag everyone by event, portfolio company, and/or source.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">CSV file</Label>
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
              {/* Column mapping */}
              <div>
                <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                  Map columns
                </Label>
                <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                  {FIELDS.map((field) => {
                    const unsetRequired = field.required && mapping[field.key] === NO_COLUMN;
                    return (
                      <div key={field.key} className="flex items-center gap-2">
                        <span
                          className={`text-[11px] w-20 shrink-0 ${unsetRequired ? "text-destructive font-medium" : "text-muted-foreground"}`}
                        >
                          {field.label}{field.required ? " *" : ""}
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
                    );
                  })}
                </div>
                {missingRequired && (
                  <p className="text-[11px] text-destructive mt-1.5">
                    Map both Name and Email to enable import.
                  </p>
                )}
              </div>

              {rows.length > 0 ? (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                        Tag as attendees of event
                      </Label>
                      <EventPicker value={eventName} onChange={setEventName} placeholder="Pick an Asana event…" />
                    </div>
                    <div>
                      <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                        Tag with portfolio companies
                      </Label>
                      <MultiSelect
                        options={portcoOptions}
                        value={portcoNames}
                        onChange={setPortcoNames}
                        placeholder="Portfolio companies…"
                        className="h-9"
                      />
                      {portcoNames.length > 0 && (
                        <Select
                          value={portcoSource}
                          onValueChange={(v) => setPortcoSource(v as EngagementSource)}
                        >
                          <SelectTrigger className="h-8 text-xs mt-1.5">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ENGAGEMENT_SOURCES.map((s) => (
                              <SelectItem key={s} value={s} className="text-xs capitalize">
                                {s}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                    <div>
                      <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                        Tag with source
                      </Label>
                      <Input
                        value={source}
                        onChange={(e) => setSource(e.target.value)}
                        placeholder='e.g. "RSA 2026", "Apollo"'
                        className="h-9 text-xs"
                      />
                    </div>
                  </div>

                  <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer">
                    <Checkbox
                      checked={enrichOnImport}
                      onCheckedChange={(v) => setEnrichOnImport(v === true)}
                      className="mt-0.5"
                    />
                    <span>
                      Auto-enrich missing fields with Apollo (title, company, phone, location).
                      <span className="text-muted-foreground/70"> On by default — uncheck to skip for large/quota-sensitive imports.</span>
                    </span>
                  </label>

                  {/* Pre-flight validation report */}
                  <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px]">
                    <div className="font-semibold text-foreground mb-1">Validation report</div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground">
                      <span>Data rows in file</span><span className="text-right tabular-nums">{report.dataRows}</span>
                      <span className="text-emerald-600 font-medium">Ready to import</span><span className="text-right tabular-nums text-emerald-600 font-medium">{rows.length}</span>
                      {skipped > 0 && (<><span>Duplicates skipped</span><span className="text-right tabular-nums">{skipped}</span></>)}
                      {report.invalid > 0 && (<><span className="text-amber-600">Invalid emails skipped</span><span className="text-right tabular-nums text-amber-600">{report.invalid}</span></>)}
                      {report.missingRequired > 0 && (<><span className="text-amber-600">Missing name/email</span><span className="text-right tabular-nums text-amber-600">{report.missingRequired}</span></>)}
                    </div>
                  </div>

                  <div>
                    <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Preview · first {Math.min(rows.length, 8)} of {rows.length}
                    </Label>
                    <ScrollArea className="h-48 border border-border rounded">
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
                              <td className="px-2 py-1">{r.name}</td>
                              <td className="px-2 py-1 text-muted-foreground">{r.email}</td>
                              <td className="px-2 py-1">{r.company}</td>
                              <td className="px-2 py-1 text-muted-foreground">{r.title}</td>
                            </tr>
                          ))}
                          {rows.length > preview.length && (
                            <tr><td colSpan={4} className="px-2 py-1 text-muted-foreground italic">…and {rows.length - preview.length} more</td></tr>
                          )}
                        </tbody>
                      </table>
                    </ScrollArea>
                  </div>
                </>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  {missingRequired
                    ? "Map Name and Email above to continue."
                    : skipped > 0
                      ? `All ${skipped} row${skipped !== 1 ? "s" : ""} are already in your contacts.`
                      : "No importable rows — check your column mapping."}
                </p>
              )}
            </>
          )}

          {/* Import History */}
          {history.length > 0 && (
            <div className="border-t border-border pt-2">
              <button
                type="button"
                onClick={() => setShowHistory((v) => !v)}
                className="text-[11px] font-semibold text-muted-foreground hover:text-foreground"
              >
                {showHistory ? "▾" : "▸"} Import history ({history.length})
              </button>
              {showHistory && (
                <div className="mt-2 max-h-40 overflow-auto space-y-1">
                  {history.map((h) => (
                    <div
                      key={h.importId}
                      className="flex items-center justify-between gap-2 text-[11px] border border-border rounded px-2 py-1"
                    >
                      <div className="min-w-0">
                        <div className="font-medium truncate">{h.filename}</div>
                        <div className="text-muted-foreground">
                          {h.timestamp.slice(0, 10)} · {h.source}
                        </div>
                      </div>
                      <div className="text-right text-muted-foreground tabular-nums shrink-0">
                        <span className="text-emerald-600 font-medium">{h.imported} added</span>
                        {h.duplicates > 0 && <> · {h.duplicates} dup</>}
                        {h.invalid > 0 && <> · {h.invalid} invalid</>}
                        {h.failed > 0 && <> · {h.failed} failed</>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={rows.length === 0 || busy} onClick={submit}>
            {busy
              ? enrichOnImport ? "Enriching & importing…" : "Importing…"
              : `Import ${rows.length || ""} contact${rows.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
