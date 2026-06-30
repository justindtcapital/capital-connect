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
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Mail, Linkedin, User } from "lucide-react";
import { addContact, fetchContactEmails, logImportResult } from "@/utils/sheets.functions";
import { enrichContact } from "@/utils/apollo.functions";
import { toast } from "sonner";

interface SmartPasteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Emails of contacts that already exist — used to auto-skip duplicates. */
  existingEmails?: string[];
  /** Called after a successful add so the caller can refresh its data. */
  onImported?: () => void | Promise<void>;
}

interface PastedContact {
  name: string;
  email: string;
  linkedinUrl: string;
  company: string;
  title: string;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const LINKEDIN_RE = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/[^\s,|]+/i;
const TITLE_RE = /\b(ceo|cto|ciso|cfo|coo|cmo|cio|cso|vp|svp|evp|svp|director|manager|head|chief|officer|president|founder|co-?founder|partner|engineer|lead|principal|analyst|consultant|architect|owner)\b/i;

const HEADER_WORDS = new Set([
  "name", "full name", "first name", "last name", "email", "email address",
  "company", "organization", "title", "role", "phone", "phone number",
  "location", "city", "linkedin", "sector", "industry", "prime",
]);

// A pasted line that's clearly a spreadsheet header row (no contact data on it).
function isHeaderLine(line: string): boolean {
  if (EMAIL_RE.test(line) || LINKEDIN_RE.test(line)) return false;
  const tokens = line.split(/\t|,/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) return false;
  const known = tokens.filter((t) => HEADER_WORDS.has(t)).length;
  return known >= Math.max(1, Math.ceil(tokens.length / 2));
}

// Parse one pasted line into a partial contact. Handles loose text, "Name, Company",
// emails, LinkedIn URLs, and tab-separated (copied-from-spreadsheet) rows.
function parseLine(line: string): PastedContact | null {
  const raw = line.trim();
  if (!raw || isHeaderLine(raw)) return null;

  const email = raw.match(EMAIL_RE)?.[0] ?? "";
  const linkedinUrl = raw.match(LINKEDIN_RE)?.[0] ?? "";

  let rest = raw;
  if (email) rest = rest.replace(email, "");
  if (linkedinUrl) rest = rest.replace(linkedinUrl, "");
  rest = rest.replace(/[<>|]/g, " ");

  const tokens = rest.split(/\t|,|;/).map((t) => t.trim()).filter(Boolean);
  const name = tokens[0] || "";
  let title = "";
  let company = "";
  for (const tok of tokens.slice(1)) {
    if (!title && TITLE_RE.test(tok)) title = tok;
    else if (!company) company = tok;
  }

  if (!name && !email && !linkedinUrl) return null;
  return { name, email, linkedinUrl, company, title };
}

function sourceBadge(c: PastedContact) {
  if (c.email) return { icon: Mail, label: "email" };
  if (c.linkedinUrl) return { icon: Linkedin, label: "linkedin" };
  return { icon: User, label: "name" };
}

export function SmartPasteDialog({ open, onOpenChange, existingEmails = [], onImported }: SmartPasteDialogProps) {
  const [text, setText] = useState("");
  const [enrich, setEnrich] = useState(true);
  const [busy, setBusy] = useState(false);

  const { rows, skipped, headerSkipped, unparseable } = useMemo(() => {
    // Categorize every non-blank line so nothing is dropped silently.
    const parsed: PastedContact[] = [];
    let headers = 0;
    let badLines = 0;
    for (const line of text.split(/\r?\n/)) {
      const raw = line.trim();
      if (!raw) continue; // blank line — not data loss, don't report
      if (isHeaderLine(raw)) { headers++; continue; }
      const p = parseLine(raw);
      if (!p) { badLines++; continue; } // couldn't extract a name/email/LinkedIn
      parsed.push(p);
    }

    const existing = new Set(existingEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
    const seen = new Set<string>();
    const unique: PastedContact[] = [];
    let dupes = 0;
    for (const p of parsed) {
      const key = p.email.trim().toLowerCase();
      // Only emails can be de-duplicated; entries without one always pass through.
      if (key) {
        if (existing.has(key) || seen.has(key)) {
          dupes++;
          continue;
        }
        seen.add(key);
      }
      unique.push(p);
    }
    return { rows: unique, skipped: dupes, headerSkipped: headers, unparseable: badLines };
  }, [text, existingEmails]);

  const reset = () => {
    setText("");
    setEnrich(true);
    setBusy(false);
  };

  const submit = async () => {
    if (rows.length === 0) return;
    setBusy(true);
    const importId =
      typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `imp-${Date.now()}`;

    // Idempotency: re-read existing emails server-side right before committing so
    // a re-click (or another tab's import) can't double-create the same contact.
    let toImport = rows;
    let commitDupes = 0;
    try {
      const fresh = new Set((await fetchContactEmails()).map((e) => e.toLowerCase()));
      const filtered = rows.filter((r) => !r.email || !fresh.has(r.email.trim().toLowerCase()));
      commitDupes = rows.length - filtered.length;
      toImport = filtered;
    } catch (e) {
      console.error("smart-paste commit-time dedup failed (proceeding with client dedup):", e);
    }

    let added = 0;
    let enriched = 0;
    for (const p of toImport) {
      const c = { name: p.name, title: p.title, company: p.company, email: p.email, phone: "", location: "" };
      if (enrich) {
        try {
          const parts = p.name.trim().split(/\s+/);
          const r = await enrichContact({
            data: {
              email: p.email || undefined,
              firstName: parts[0] || undefined,
              lastName: parts.slice(1).join(" ") || undefined,
              company: p.company || undefined,
              linkedinUrl: p.linkedinUrl || undefined,
            },
          });
          if (r.found) {
            c.name = c.name || r.name || [r.firstName, r.lastName].filter(Boolean).join(" ");
            c.title = c.title || r.title || "";
            c.company = c.company || r.company || "";
            c.phone = r.phone || "";
            c.location = [r.city, r.state].filter(Boolean).join(", ");
            c.email = c.email || r.email || "";
            enriched++;
          }
        } catch (e) {
          console.error("paste enrich failed", e);
        }
      }
      const finalName = c.name || c.email;
      if (!finalName) continue;
      try {
        await addContact({
          data: {
            name: finalName,
            role: c.title,
            company: c.company,
            email: c.email,
            phone: c.phone,
            location: c.location,
            prime: "",
            sector: "",
            temperature: "Warm",
            source: "Manual Entry",
          },
        });
        added++;
      } catch (e) {
        console.error("paste add failed", c.email || finalName, e);
      }
    }
    const failed = toImport.length - added;
    const totalDupes = skipped + commitDupes;

    // Log the import to the Import History tab (audit trail), best-effort.
    try {
      await logImportResult({
        data: {
          importId,
          filename: "smart paste",
          source: "smart_paste",
          totalRows: rows.length + skipped + headerSkipped + unparseable,
          imported: added,
          duplicates: totalDupes,
          invalid: headerSkipped + unparseable,
          enriched,
          failed,
        },
      });
    } catch (e) {
      console.error("smart-paste import-log failed:", e);
    }

    setBusy(false);

    const parts = [`Added ${added} contact${added !== 1 ? "s" : ""}`];
    if (enrich) parts.push(`${enriched} enriched`);
    if (totalDupes > 0) parts.push(`${totalDupes} duplicate${totalDupes !== 1 ? "s" : ""} skipped`);
    if (failed > 0) toast.warning(`${parts.join(" · ")} · ${failed} failed (see console)`);
    else toast.success(parts.join(" · "));

    if (added > 0) await onImported?.();
    reset();
    onOpenChange(false);
  };

  const preview = rows.slice(0, 8);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Paste contacts</DialogTitle>
          <DialogDescription className="text-xs">
            Paste anything — one per line: names, emails, LinkedIn URLs, "Name, Company", or rows
            copied straight from a spreadsheet. No file or formatting needed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Jane Doe, Acme Corp, jane@acme.com\nhttps://linkedin.com/in/johnsmith\nerica.antos@mrcy.com\nGrace Hopper\tCISO\tNavyTech`}
            className="h-40 text-xs font-mono"
          />

          <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer">
            <Checkbox checked={enrich} onCheckedChange={(v) => setEnrich(v === true)} className="mt-0.5" />
            <span>
              Enrich with Apollo on add.
              <span className="text-muted-foreground/70"> Recommended — resolves email-only and LinkedIn-only lines into full contacts.</span>
            </span>
          </label>

          {/* Skip report — shown whenever lines were dropped, even if 0 parsed,
              so nothing disappears silently. */}
          {(unparseable > 0 || headerSkipped > 0) && (
            <div className="rounded border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-500">
              {unparseable > 0 && (
                <span>
                  {unparseable} line{unparseable !== 1 ? "s" : ""} couldn't be read (no name, email, or LinkedIn found) — skipped.
                </span>
              )}
              {unparseable > 0 && headerSkipped > 0 && " "}
              {headerSkipped > 0 && (
                <span>{headerSkipped} header row{headerSkipped !== 1 ? "s" : ""} ignored.</span>
              )}
            </div>
          )}

          {rows.length > 0 && (
            <div>
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Preview · {rows.length} contact{rows.length !== 1 ? "s" : ""}
                {skipped > 0 && ` · ${skipped} duplicate${skipped !== 1 ? "s" : ""} skipped`}
              </Label>
              <ScrollArea className="h-44 border border-border rounded">
                <table className="w-full text-[11px]">
                  <thead className="bg-muted/40 sticky top-0">
                    <tr className="text-left">
                      <th className="px-2 py-1 font-semibold">Name</th>
                      <th className="px-2 py-1 font-semibold">Email</th>
                      <th className="px-2 py-1 font-semibold">Company</th>
                      <th className="px-2 py-1 font-semibold">From</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((c, i) => {
                      const badge = sourceBadge(c);
                      const Icon = badge.icon;
                      return (
                        <tr key={i} className="border-t border-border">
                          <td className="px-2 py-1">{c.name || <span className="text-muted-foreground italic">resolved on add</span>}</td>
                          <td className="px-2 py-1 text-muted-foreground">{c.email}</td>
                          <td className="px-2 py-1">{c.company}</td>
                          <td className="px-2 py-1">
                            <Badge variant="outline" className="text-[9px] gap-0.5 px-1 py-0"><Icon className="h-2.5 w-2.5" />{badge.label}</Badge>
                          </td>
                        </tr>
                      );
                    })}
                    {rows.length > preview.length && (
                      <tr><td colSpan={4} className="px-2 py-1 text-muted-foreground italic">…and {rows.length - preview.length} more</td></tr>
                    )}
                  </tbody>
                </table>
              </ScrollArea>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={rows.length === 0 || busy} onClick={submit}>
            {busy ? (enrich ? "Enriching & adding…" : "Adding…") : `Add ${rows.length || ""} contact${rows.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
