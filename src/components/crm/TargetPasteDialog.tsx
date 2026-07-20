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
import { importTargets } from "@/utils/sheets.functions";
import { enrichContact } from "@/utils/apollo.functions";
import { targetKeyOf } from "@/lib/types";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** targetKeyOf() for existing targets — used to preview duplicate skips. */
  existingKeys?: string[];
  onImported?: () => void | Promise<void>;
}

interface PastedTarget {
  name: string;
  email: string;
  linkedinUrl: string;
  company: string;
  title: string;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const LINKEDIN_RE = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/[^\s,|]+/i;
const TITLE_RE =
  /\b(ceo|cto|ciso|cfo|coo|cmo|cio|cso|vp|svp|evp|director|manager|head|chief|officer|president|founder|co-?founder|partner|engineer|lead|principal|analyst|consultant|architect|owner)\b/i;

const HEADER_WORDS = new Set([
  "name", "full name", "first name", "last name", "email", "email address",
  "company", "organization", "title", "role", "phone", "phone number",
  "location", "city", "linkedin", "sector", "industry",
]);

function isHeaderLine(line: string): boolean {
  if (EMAIL_RE.test(line) || LINKEDIN_RE.test(line)) return false;
  const tokens = line.split(/\t|,/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) return false;
  const known = tokens.filter((t) => HEADER_WORDS.has(t)).length;
  return known >= Math.max(1, Math.ceil(tokens.length / 2));
}

// Normalize a LinkedIn URL so it never lands in another field and is stored
// consistently (https, no trailing slash).
function normalizeLinkedin(url: string): string {
  const u = (url || "").trim();
  if (!u) return "";
  const withScheme = /^https?:\/\//i.test(u) ? u : `https://${u}`;
  return withScheme.replace(/\/+$/, "");
}

function parseLine(line: string): PastedTarget | null {
  const raw = line.trim();
  if (!raw || isHeaderLine(raw)) return null;

  const email = raw.match(EMAIL_RE)?.[0] ?? "";
  const linkedinUrl = normalizeLinkedin(raw.match(LINKEDIN_RE)?.[0] ?? "");

  let rest = raw;
  if (email) rest = rest.replace(email, "");
  if (linkedinUrl) rest = rest.replace(LINKEDIN_RE, "");
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

function sourceBadge(t: PastedTarget) {
  if (t.email) return { icon: Mail, label: "email" };
  if (t.linkedinUrl) return { icon: Linkedin, label: "linkedin" };
  return { icon: User, label: "name" };
}

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") };
}

// Paste anything (names / emails / LinkedIn URLs / "Name, Company" / spreadsheet
// rows) → Prospecting targets. Mirrors the Network SmartPaste flow.
export function TargetPasteDialog({ open, onOpenChange, existingKeys = [], onImported }: Props) {
  const [text, setText] = useState("");
  const [enrich, setEnrich] = useState(true);
  const [busy, setBusy] = useState(false);

  const { rows, skipped, headerSkipped, unparseable } = useMemo(() => {
    const parsed: PastedTarget[] = [];
    let headers = 0;
    let badLines = 0;
    for (const line of text.split(/\r?\n/)) {
      const raw = line.trim();
      if (!raw) continue;
      if (isHeaderLine(raw)) {
        headers++;
        continue;
      }
      const p = parseLine(raw);
      if (!p) {
        badLines++;
        continue;
      }
      parsed.push(p);
    }

    const existing = new Set(existingKeys.map((k) => k.trim().toLowerCase()).filter(Boolean));
    const seen = new Set<string>();
    const unique: PastedTarget[] = [];
    let dupes = 0;
    for (const p of parsed) {
      const key = targetKeyOf({ email: p.email, name: p.name, company: p.company });
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
  }, [text, existingKeys]);

  const reset = () => {
    setText("");
    setEnrich(true);
    setBusy(false);
  };

  const submit = async () => {
    if (rows.length === 0) return;
    setBusy(true);

    let enriched = 0;
    const built = [];
    for (const p of rows) {
      let name = p.name;
      let title = p.title;
      let company = p.company;
      let email = p.email;
      let phone = "";
      let location = "";
      let sector = "";
      let linkedin = p.linkedinUrl;

      if (enrich) {
        try {
          const parts = splitName(p.name);
          const r = await enrichContact({
            data: {
              email: p.email || undefined,
              firstName: parts.firstName || undefined,
              lastName: parts.lastName || undefined,
              company: p.company || undefined,
              linkedinUrl: p.linkedinUrl || undefined,
            },
          });
          if (r.found) {
            name = name || r.name || [r.firstName, r.lastName].filter(Boolean).join(" ");
            title = title || r.title || "";
            company = company || r.company || "";
            phone = r.phone || "";
            location = [r.city, r.state].filter(Boolean).join(", ");
            sector = r.industry || "";
            email = email || r.email || "";
            linkedin = linkedin || normalizeLinkedin(r.linkedinUrl || "");
            enriched++;
          }
        } catch (e) {
          console.error("target paste enrich failed", e);
        }
      }

      const finalName = name || email || linkedin;
      if (!finalName) continue;
      const { firstName, lastName } = splitName(name || email);
      built.push({
        firstName: firstName || finalName,
        lastName,
        company,
        role: title,
        linkedin,
        email,
        phone,
        location,
        sector,
        stage: "Prospecting",
        source: "Manual Entry",
        researchPurpose: "",
        reasonSurfaced: "",
      });
    }

    try {
      const res = await importTargets({ data: { targets: built } });
      const parts = [`Added ${res.added} prospecting target${res.added !== 1 ? "s" : ""}`];
      if (enrich) parts.push(`${enriched} enriched`);
      if (res.duplicates) parts.push(`${res.duplicates} duplicate${res.duplicates !== 1 ? "s" : ""} skipped`);
      toast.success(parts.join(" · "));
      if (res.added > 0) await onImported?.();
      reset();
      onOpenChange(false);
    } catch (e) {
      console.error("importTargets (paste) failed", e);
      toast.error("Import failed — see console.");
    } finally {
      setBusy(false);
    }
  };

  const preview = rows.slice(0, 8);

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
          <DialogTitle>Paste targets</DialogTitle>
          <DialogDescription className="text-xs">
            Paste anything — one per line: names, emails, LinkedIn URLs, "Name, Company", or rows
            copied from a spreadsheet. New people enter as{" "}
            <span className="font-medium">Prospecting</span>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              "Jane Doe, Acme Corp, jane@acme.com\nhttps://linkedin.com/in/johnsmith\nGrace Hopper\tCISO\tNavyTech"
            }
            className="h-40 text-xs font-mono"
          />

          <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer">
            <Checkbox
              checked={enrich}
              onCheckedChange={(v) => setEnrich(v === true)}
              className="mt-0.5"
            />
            <span>
              Enrich with Apollo on add.
              <span className="text-muted-foreground/70">
                {" "}
                Recommended — resolves email-only and LinkedIn-only lines into full targets.
              </span>
            </span>
          </label>

          {(unparseable > 0 || headerSkipped > 0) && (
            <div className="rounded border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-500">
              {unparseable > 0 && (
                <span>
                  {unparseable} line{unparseable !== 1 ? "s" : ""} couldn't be read — skipped.
                </span>
              )}
              {unparseable > 0 && headerSkipped > 0 && " "}
              {headerSkipped > 0 && (
                <span>
                  {headerSkipped} header row{headerSkipped !== 1 ? "s" : ""} ignored.
                </span>
              )}
            </div>
          )}

          {rows.length > 0 && (
            <div>
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Preview · {rows.length} target{rows.length !== 1 ? "s" : ""}
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
                          <td className="px-2 py-1">
                            {c.name || (
                              <span className="text-muted-foreground italic">resolved on add</span>
                            )}
                          </td>
                          <td className="px-2 py-1 text-muted-foreground">{c.email}</td>
                          <td className="px-2 py-1">{c.company}</td>
                          <td className="px-2 py-1">
                            <Badge variant="outline" className="text-[9px] gap-0.5 px-1 py-0">
                              <Icon className="h-2.5 w-2.5" />
                              {badge.label}
                            </Badge>
                          </td>
                        </tr>
                      );
                    })}
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
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={rows.length === 0 || busy} onClick={submit}>
            {busy
              ? enrich
                ? "Enriching & adding…"
                : "Adding…"
              : `Add ${rows.length || ""} target${rows.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
