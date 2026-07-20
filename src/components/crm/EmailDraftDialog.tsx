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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Mail, Copy, Loader2, ChevronsUpDown, X } from "lucide-react";
import { draftEmail } from "@/utils/gemini.functions";
import { fetchPortfolioCompanies, recordEmailSent } from "@/utils/sheets.functions";
import type { Contact } from "@/lib/types";
import { useFilterOptions } from "@/lib/filter-options-context";
import { EventPicker } from "@/components/events/EventPicker";
import { toast } from "sonner";

export interface EmailSentInfo {
  subject: string;
  emailType: string;
  linkedPortcos?: string[];
  linkedEvent?: string;
}

interface EmailDraftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact: Contact | null;
  /** Called when the user opens the draft in their mail client, so the caller can log the interaction. */
  onSent?: (info: EmailSentInfo) => void;
  /** Pre-fill the "what should this accomplish" field (e.g. from a detected signal). */
  initialPurpose?: string;
  /** Pre-fill the details field. */
  initialNotes?: string;
}

const TONES = ["Warm", "Professional", "Brief", "Formal"];
const EMAIL_TYPES = ["General", "PortCo", "Event"] as const;

// Sender name/org persist locally so they don't have to be retyped each time.
const SENDER_NAME_KEY = "dtc.email.senderName";
const SENDER_ORG_KEY = "dtc.email.senderOrg";

export function EmailDraftDialog({ open, onOpenChange, contact, onSent, initialPurpose, initialNotes }: EmailDraftDialogProps) {
  const { options: filterOptions } = useFilterOptions();
  // The filter-options context is only populated on the CRM page; on other routes
  // (e.g. Signals) it's empty, so fall back to fetching the portfolio list.
  const ctxCompanies = filterOptions.portfolioCompanies;
  const [fetchedCompanies, setFetchedCompanies] = useState<string[]>([]);
  const portfolioCompanies = ctxCompanies.length ? ctxCompanies : fetchedCompanies;
  const [purpose, setPurpose] = useState("");
  const [tone, setTone] = useState("Warm");
  const [emailType, setEmailType] = useState<string>("General");
  const [linkedPortcos, setLinkedPortcos] = useState<string[]>([]);
  const [linkedEvent, setLinkedEvent] = useState("");

  const togglePortco = (co: string) =>
    setLinkedPortcos((prev) => (prev.includes(co) ? prev.filter((c) => c !== co) : [...prev, co]));
  const [notes, setNotes] = useState("");
  const [senderName, setSenderName] = useState("");
  const [senderOrg, setSenderOrg] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (typeof window !== "undefined") {
      setSenderName(window.localStorage.getItem(SENDER_NAME_KEY) || "");
      setSenderOrg(window.localStorage.getItem(SENDER_ORG_KEY) || "");
    }
    if (initialPurpose !== undefined) setPurpose(initialPurpose);
    if (initialNotes !== undefined) setNotes(initialNotes);
  }, [open, initialPurpose, initialNotes]);

  // Fetch portfolio companies for the PortCo dropdown when the context is empty
  // (e.g. opened from the Signals page).
  useEffect(() => {
    if (!open || ctxCompanies.length > 0 || fetchedCompanies.length > 0) return;
    let cancelled = false;
    fetchPortfolioCompanies()
      .then((cos) => {
        if (!cancelled) setFetchedCompanies([...new Set(cos.map((c) => c.name).filter(Boolean))].sort());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, ctxCompanies.length, fetchedCompanies.length]);

  const reset = () => {
    setPurpose("");
    setTone("Warm");
    setEmailType("General");
    setLinkedPortcos([]);
    setLinkedEvent("");
    setNotes("");
    setSubject("");
    setBody("");
    setBusy(false);
    setHasDraft(false);
  };

  const primaryEmail = contact?.email?.split(";")[0]?.trim() || contact?.email || "";

  const generate = async () => {
    if (!contact || !purpose.trim()) {
      toast.error("Add what the email should accomplish first.");
      return;
    }
    setBusy(true);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SENDER_NAME_KEY, senderName.trim());
      window.localStorage.setItem(SENDER_ORG_KEY, senderOrg.trim());
    }
    try {
      const history = (contact.interactions || [])
        .slice(0, 6)
        .map((i) => `${i.date} · ${i.type}: ${i.summary}`);
      const res = await draftEmail({
        data: {
          contactName: contact.name,
          contactTitle: contact.title,
          contactCompany: contact.company,
          contactSector: contact.sector,
          purpose: purpose.trim(),
          tone,
          notes: notes.trim() || undefined,
          history,
          senderName: senderName.trim() || undefined,
          senderOrg: senderOrg.trim() || undefined,
          emailType,
          linkedPortcos: emailType === "PortCo" && linkedPortcos.length ? linkedPortcos : undefined,
          linkedEvent: emailType === "Event" ? linkedEvent || undefined : undefined,
        },
      });
      if (!res.found) {
        toast.error(res.error || "Gemini could not draft this email.");
        return;
      }
      setSubject(res.subject || "");
      setBody(res.body || "");
      setHasDraft(true);
    } catch (e) {
      console.error("draftEmail failed", e);
      toast.error("Drafting failed — see console.");
    } finally {
      setBusy(false);
    }
  };

  const openInMail = async () => {
    if (!primaryEmail) {
      toast.error("This contact has no email address.");
      return;
    }
    // Open Outlook on the web compose (reliable for browser users — a mailto: link
    // only works if a desktop mail app is registered as the default handler).
    const url = `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(
      primaryEmail,
    )}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener,noreferrer");

    const sentInfo: EmailSentInfo = {
      subject,
      emailType,
      linkedPortcos: emailType === "PortCo" && linkedPortcos.length ? linkedPortcos : undefined,
      linkedEvent: emailType === "Event" ? linkedEvent || undefined : undefined,
    };

    // Close the loop: Notes + Email Activity + Ops Log (every entry point).
    try {
      const res = await recordEmailSent({
        data: {
          contactEmail: primaryEmail,
          contactName: contact?.name,
          subject,
          emailType,
          linkedPortcos: sentInfo.linkedPortcos,
          linkedEvent: sentInfo.linkedEvent,
          urid: contact?.urid,
        },
      });
      if (!res.ok) {
        toast.warning(res.error || "Opened Outlook, but logging failed.");
      } else {
        toast.success("Opened Outlook · logged to Notes + Ops");
      }
    } catch (e) {
      console.error("recordEmailSent failed", e);
      toast.warning("Opened Outlook, but CRM logging failed — see console.");
    }

    onSent?.(sentInfo);
    reset();
    onOpenChange(false);
  };

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Could not copy.");
    }
  };

  if (!contact) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Draft email with Gemini
          </DialogTitle>
          <DialogDescription className="text-xs">
            To {contact.name}
            {contact.title ? ` · ${contact.title}` : ""}
            {contact.company ? ` at ${contact.company}` : ""}
            {primaryEmail ? ` · ${primaryEmail}` : " · no email on file"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1">
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                What should this email accomplish?
              </Label>
              <Input
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="Invite to our June portfolio dinner"
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">Tone</Label>
              <Select value={tone} onValueChange={setTone}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TONES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">Type</Label>
              <Select
                value={emailType}
                onValueChange={(v) => {
                  setEmailType(v);
                  setLinkedPortcos([]);
                  setLinkedEvent("");
                }}
              >
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {EMAIL_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t === "General" ? "General (follow-up)" : t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              {emailType === "PortCo" && (
                <>
                  <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                    Portfolio companies
                  </Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        className="h-8 w-full justify-between text-sm font-normal"
                      >
                        <span className="truncate">
                          {linkedPortcos.length === 0
                            ? "Select companies…"
                            : linkedPortcos.length === 1
                              ? linkedPortcos[0]
                              : `${linkedPortcos.length} companies selected`}
                        </span>
                        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-(--radix-popover-trigger-width) p-1" align="start">
                      {portfolioCompanies.length === 0 ? (
                        <p className="px-2 py-1.5 text-xs text-muted-foreground">No portfolio companies found.</p>
                      ) : (
                        <div className="max-h-56 overflow-auto">
                          {portfolioCompanies.map((co: string) => (
                            <button
                              key={co}
                              type="button"
                              onClick={() => togglePortco(co)}
                              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                            >
                              <Checkbox checked={linkedPortcos.includes(co)} className="pointer-events-none" />
                              <span className="truncate">{co}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </PopoverContent>
                  </Popover>
                  {linkedPortcos.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {linkedPortcos.map((co) => (
                        <Badge key={co} variant="secondary" className="gap-1 text-[10px] font-normal">
                          {co}
                          <button type="button" onClick={() => togglePortco(co)} aria-label={`Remove ${co}`}>
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </>
              )}
              {emailType === "Event" && (
                <>
                  <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                    Event
                  </Label>
                  <EventPicker value={linkedEvent} onChange={setLinkedEvent} />
                </>
              )}
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
              Details to include <span className="font-normal normal-case">(optional — dates, links, specifics)</span>
            </Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Thursday June 19, 6pm at our SF office. RSVP link: …"
              className="h-16 text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">Your name (sign-off)</Label>
              <Input value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="Jordan" className="h-8 text-sm" />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">Your firm (optional)</Label>
              <Input value={senderOrg} onChange={(e) => setSenderOrg(e.target.value)} placeholder="DTC" className="h-8 text-sm" />
            </div>
          </div>

          <Button onClick={generate} disabled={busy || !purpose.trim()} className="w-full" variant={hasDraft ? "outline" : "default"}>
            {busy ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Drafting…</>
            ) : (
              <><Sparkles className="h-4 w-4" /> {hasDraft ? "Regenerate" : "Draft with Gemini"}</>
            )}
          </Button>

          {hasDraft && (
            <div className="space-y-3 border-t border-border pt-3">
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">Subject</Label>
                <Input value={subject} onChange={(e) => setSubject(e.target.value)} className="h-8 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">Body</Label>
                <Textarea value={body} onChange={(e) => setBody(e.target.value)} className="h-56 text-sm font-mono" />
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          {hasDraft && (
            <Button variant="outline" onClick={copyAll}><Copy className="h-4 w-4" /> Copy</Button>
          )}
          <Button onClick={() => void openInMail()} disabled={!hasDraft || !primaryEmail}>
            <Mail className="h-4 w-4" /> Open in Outlook
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
