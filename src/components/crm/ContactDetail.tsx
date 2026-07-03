import { useState } from "react";
import { addNote, addEvent as addEventToSheet, addPortcoIntro, resolveFollowUp, mergeContactFields, storeApolloRaw, setContactRating, clearContactRatingOverride, logEmailActivity } from "@/utils/sheets.functions";
import { enrichContact } from "@/utils/apollo.functions";
import type { ApolloEnrichmentResult } from "@/utils/apollo.server";
import { toast } from "sonner";
import type { Contact, Interaction, InteractionType, Temperature, EngagementSource } from "@/lib/types";
import { ENGAGEMENT_SOURCES, CONTACT_TYPES, RECORD_SOURCES, isAsanaSourced, asanaTaskUrl } from "@/lib/types";
import { inferInterestAreas } from "@/lib/interest-domains";
import { suggestAreasOfInterest } from "@/utils/gemini.functions";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TemperatureBadge } from "./TemperatureBadge";
import { EngagementBreakdown } from "./EngagementScore";
import { ContactAvatar } from "./ContactAvatar";
import {
  Building2,
  Mail,
  User,
  MapPin,
  Calendar,
  Link2,
  MessageSquare,
  Phone,
  Briefcase,
  Pencil,
  Save,
  X,
  Plus,
  CheckCircle2,
  AlertCircle,
  PhoneCall,
  Telescope,
  ExternalLink,
  Tag,
  Search,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Lock, Unlock, Clock } from "lucide-react";
import { daysSinceLastContact } from "@/lib/activity-score";
import { Checkbox } from "@/components/ui/checkbox";
import { useFilterOptions } from "@/lib/filter-options-context";
import { EventPicker } from "@/components/events/EventPicker";
import { EmailDraftDialog } from "./EmailDraftDialog";
import { TechStackSection } from "./TechStackSection";
import { ActivitySection } from "./ActivitySection";
import { useAsanaActivities } from "@/lib/use-activities";
import { matchActivitiesToContact } from "@/lib/activity-match";
import { Sparkles, Loader2 } from "lucide-react";

interface ContactDetailProps {
  contact: Contact | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onContactUpdate?: (contact: Contact) => void;
}

const TIERS: Temperature[] = ["Council", "Hot", "Warm", "Cold"];

// Rating control in the detail header. Shows the current tier + activity score,
// lets you manually set the rating (which locks it from auto-scoring), and lets
// you hand control back to the automatic scorecard.
function RatingControl({
  contact,
  onContactUpdate,
}: {
  contact: Contact;
  onContactUpdate?: (contact: Contact) => void;
}) {
  const [busy, setBusy] = useState(false);

  const setTier = async (tier: Temperature) => {
    if (!contact.email) {
      toast.error("This contact has no email, so the rating can't be saved.");
      return;
    }
    setBusy(true);
    try {
      const res = await setContactRating({ data: { email: contact.email, tier, urid: contact.urid } });
      if (res.success) {
        onContactUpdate?.({ ...contact, temperature: tier, ratingLocked: true });
        toast.success(`Rating set to ${tier} and locked.`);
      } else {
        toast.warning("Couldn't find this contact's row to save the rating.");
      }
    } catch (e) {
      console.error("setContactRating failed", e);
      toast.error("Failed to save the rating — see console.");
    } finally {
      setBusy(false);
    }
  };

  const useAuto = async () => {
    if (!contact.email) return;
    setBusy(true);
    try {
      await clearContactRatingOverride({ data: { email: contact.email, urid: contact.urid } });
      onContactUpdate?.({ ...contact, ratingLocked: false });
      toast.success("Switched to automatic — applies on the next recalculation.");
    } catch (e) {
      console.error("clearContactRatingOverride failed", e);
      toast.error("Failed to switch to automatic — see console.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-1.5 py-1 hover:bg-accent transition-colors disabled:opacity-50"
          title="Click to set the rating manually"
        >
          <TemperatureBadge temperature={contact.temperature} />
          {(() => {
            const days = daysSinceLastContact(contact);
            if (days === null) return null;
            return (
              <span
                className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground"
                title={`${days} day${days !== 1 ? "s" : ""} since last contact`}
              >
                <Clock className="h-3 w-3" />
                {days}d
              </span>
            );
          })()}
          {contact.ratingLocked ? (
            <Lock className="h-3 w-3 text-muted-foreground" />
          ) : (
            <span className="text-[9px] uppercase tracking-wide text-muted-foreground">auto</span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-[10px]">Set rating (locks it)</DropdownMenuLabel>
        {TIERS.map((t) => (
          <DropdownMenuItem key={t} onClick={() => setTier(t)}>
            <TemperatureBadge temperature={t} className="mr-2" />
            {t}
          </DropdownMenuItem>
        ))}
        {contact.ratingLocked && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={useAuto}>
              <Unlock className="h-3.5 w-3.5 mr-2" />
              Use automatic
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Tiny per-field source indicator: telescope = Apollo-sourced, pencil = human.
function FieldSource({ source }: { source?: "user" | "apollo" }) {
  if (!source) return null;
  const isApollo = source === "apollo";
  return (
    <span
      title={isApollo ? "From Apollo enrichment" : "Edited by hand"}
      className="inline-flex shrink-0"
    >
      {isApollo ? (
        <Telescope className="h-3 w-3 text-sky-500/70" />
      ) : (
        <Pencil className="h-3 w-3 text-amber-500/70" />
      )}
    </span>
  );
}

const interactionColors: Record<InteractionType, string> = {
  intro: "bg-purple-100 text-purple-700 border-purple-200",
  meeting: "bg-blue-100 text-blue-700 border-blue-200",
  event: "bg-emerald-100 text-emerald-700 border-emerald-200",
  "follow-up": "bg-amber-100 text-amber-700 border-amber-200",
  call: "bg-sky-100 text-sky-700 border-sky-200",
  email: "bg-slate-100 text-slate-600 border-slate-200",
  note: "bg-gray-100 text-gray-600 border-gray-200",
};

const interactionIcons: Record<InteractionType, typeof MessageSquare> = {
  call: PhoneCall,
  email: Mail,
  meeting: Calendar,
  intro: Link2,
  event: Calendar,
  note: MessageSquare,
  "follow-up": AlertCircle,
};

// Consistent small outline button style for all action buttons
const actionBtnClass = "h-7 text-[11px] font-medium";

export function ContactDetail({ contact, open, onOpenChange, onContactUpdate }: ContactDetailProps) {
  const { options: filterOpts } = useFilterOptions();
  const portfolioCompanies = filterOpts.portfolioCompanies;
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState<Partial<Contact>>({});
  const [addInteractionOpen, setAddInteractionOpen] = useState(false);
  const [editingInteractionId, setEditingInteractionId] = useState<string | null>(null);
  const [editInteractionData, setEditInteractionData] = useState({ type: "" as InteractionType, summary: "" });
  const [addPortCoOpen, setAddPortCoOpen] = useState(false);
  const [newPortCo, setNewPortCo] = useState("");
  const [newPortCoSource, setNewPortCoSource] = useState<EngagementSource>("direct introduction");
  const [addEventOpen, setAddEventOpen] = useState(false);
  const [newEvent, setNewEvent] = useState({ name: "", type: "attended" as "attended" | "invited" });
  const [addAreaOpen, setAddAreaOpen] = useState(false);
  const [newArea, setNewArea] = useState("");
  const [suggestingAreas, setSuggestingAreas] = useState(false);
  const [newInteraction, setNewInteraction] = useState({
    type: "note" as InteractionType,
    summary: "",
    isFollowUp: false,
    portCoIntro: "",
  });
  const [enriching, setEnriching] = useState(false);
  const [apolloResult, setApolloResult] = useState<ApolloEnrichmentResult | null>(null);
  const [apolloReviewOpen, setApolloReviewOpen] = useState(false);
  const [apolloMessage, setApolloMessage] = useState<{ title: string; description: string } | null>(null);
  const [selectedFields, setSelectedFields] = useState<Record<string, boolean>>({});
  const [emailDraftOpen, setEmailDraftOpen] = useState(false);
  const { activities, loading: activitiesLoading } = useAsanaActivities();

  if (!contact) return null;

  const contactActivities = matchActivitiesToContact(activities, contact);

  const primaryEmail = contact.email?.split(";")[0]?.trim() || contact.email;

  const getEnrichmentFields = (result: ApolloEnrichmentResult) => {
    const location = [result.city, result.state, result.country].filter(Boolean).join(", ");

    return [
      result.title
        ? {
            key: "title",
            label: "Title",
            apolloValue: result.title,
            currentValue: contact.title || "",
            contactField: "title" as keyof Contact,
            canApply: true,
          }
        : null,
      result.company
        ? {
            key: "company",
            label: "Company",
            apolloValue: result.company,
            currentValue: contact.company || "",
            contactField: "company" as keyof Contact,
            canApply: true,
          }
        : null,
      result.email
        ? {
            key: "email",
            label: "Email",
            apolloValue: result.email,
            currentValue: contact.email || "",
            contactField: "email" as keyof Contact,
            canApply: true,
          }
        : null,
      result.phone
        ? {
            key: "phone",
            label: result.phoneSource === "mobile" ? "Phone (Mobile)"
              : result.phoneSource === "personal" ? "Phone (Personal)"
              : result.phoneSource === "work" ? "Phone (Work Direct)"
              : result.phoneSource === "company" ? "Phone (Company main)"
              : "Phone",
            apolloValue: result.phone,
            currentValue: contact.phone || "",
            contactField: "phone" as keyof Contact,
            canApply: true,
          }
        : null,
      location
        ? {
            key: "location",
            label: "Location",
            apolloValue: location,
            // Contact Information shows `address`, so we apply Apollo's
            // location into that field (and ContactDetail keeps `location`
            // synced via the apply step below).
            currentValue: contact.address || contact.location || "",
            contactField: "address" as keyof Contact,
            canApply: true,
          }
        : null,
      result.linkedinUrl
        ? {
            key: "linkedinUrl",
            label: "LinkedIn",
            apolloValue: result.linkedinUrl,
            currentValue: contact.linkedinUrl || "",
            contactField: "linkedinUrl" as keyof Contact,
            canApply: true,
          }
        : null,
      result.industry
        ? {
            key: "sector",
            label: "Sector / Industry",
            apolloValue: result.industry,
            currentValue: contact.sector || "",
            contactField: "sector" as keyof Contact,
            canApply: true,
          }
        : null,
      result.headline
        ? {
            key: "headline",
            label: "Headline",
            apolloValue: result.headline,
            currentValue: "",
            canApply: true,
          }
        : null,
    ].filter(Boolean) as Array<{
      key: string;
      label: string;
      apolloValue: string;
      currentValue: string;
      contactField?: keyof Contact;
      canApply: boolean;
    }>;
  };

  const openApolloDialog = (options: {
    result?: ApolloEnrichmentResult | null;
    title: string;
    description: string;
    defaultSelections?: Record<string, boolean>;
  }) => {
    setApolloResult(options.result ?? null);
    setApolloMessage({ title: options.title, description: options.description });
    setSelectedFields(options.defaultSelections ?? {});
    setApolloReviewOpen(true);
  };

  const handleEnrichWithApollo = async () => {
    setEnriching(true);
    try {
      const nameParts = contact.name.split(" ");
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";
      const result = await enrichContact({
        data: {
          email: primaryEmail,
          firstName,
          lastName,
          company: contact.company,
          linkedinUrl: contact.linkedinUrl || undefined,
        },
      });

      if (result.accessDenied) {
        openApolloDialog({
          title: "Apollo access issue",
          description: result.error || "Apollo enrichment is not available for this API key.",
        });
        return;
      }

      if (!result.found) {
        openApolloDialog({
          title: "No Apollo match found",
          description: "Apollo didn’t return a matching person for the current contact inputs.",
        });
        return;
      }

      const fields = getEnrichmentFields(result);
      const defaults: Record<string, boolean> = {};
      fields.forEach((field) => {
        if (field.canApply) {
          defaults[field.key] = field.apolloValue !== field.currentValue;
        }
      });

      openApolloDialog({
        result,
        title: "Apollo enrichment results",
        description: `Review the data Apollo found for ${contact.name} and choose what to apply.`,
        defaultSelections: defaults,
      });
    } catch (e) {
      console.error("Apollo enrichment failed:", e);
      openApolloDialog({
        title: "Apollo request failed",
        description: "The enrichment request failed before any data could be reviewed.",
      });
    } finally {
      setEnriching(false);
    }
  };

  const applySelectedApolloFields = async () => {
    if (!apolloResult || !contact) return;
    const fields = getEnrichmentFields(apolloResult);
    const updates: Partial<Contact> = {};
    fields.forEach((field) => {
      if (field.canApply && field.contactField && selectedFields[field.key]) {
        (updates as Record<string, string>)[field.contactField] = field.apolloValue;
      }
    });
    // Mirror Apollo address into the secondary `location` field so views
    // that show MapPin (events page, attendee rows) pick it up too.
    if (typeof updates.address === "string") {
      updates.location = updates.address;
    }
    updates.apolloEnriched = true;
    updates.apolloEnrichedDate = new Date().toISOString().split("T")[0];
    if (onContactUpdate) onContactUpdate({ ...contact, ...updates });
    const count = Object.values(selectedFields).filter(Boolean).length;
    setApolloReviewOpen(false);
    setApolloResult(null);
    setApolloMessage(null);

    // Archive the full Apollo payload first so nothing is ever lost.
    if (apolloResult) {
      storeApolloRaw({ data: { email: primaryEmail, payload: apolloResult } }).catch((e) =>
        console.error("Failed to archive Apollo payload:", e)
      );
    }

    // Persist enriched fields through the non-destructive merge: Apollo never
    // overwrites a field you've edited by hand. Fields with a Contacts column:
    // title, company, phone, location. LinkedIn has no column (UI-only).
    const sheetUpdates: Record<string, string | undefined> = {};
    if (typeof updates.title === "string") sheetUpdates.title = updates.title;
    if (typeof updates.company === "string") sheetUpdates.company = updates.company;
    if (typeof updates.phone === "string") sheetUpdates.phone = updates.phone;
    if (typeof updates.location === "string") sheetUpdates.location = updates.location;
    // Sector: when applied, also send company so the merge can apply the
    // portfolio-company override ("Portfolio") server-side.
    if (typeof updates.sector === "string") {
      sheetUpdates.sector = updates.sector;
      sheetUpdates.company = sheetUpdates.company ?? contact.company;
    }
    // Headline (selectable) + employment history (additive) — columns the merge
    // creates on demand.
    if (selectedFields.headline && apolloResult.headline) {
      sheetUpdates.headline = apolloResult.headline;
    }
    const history = (apolloResult.employmentHistory || [])
      .map((j) => {
        const base = [j.title, j.company].filter(Boolean).join(" @ ");
        return j.current ? `${base} (current)` : base;
      })
      .filter(Boolean)
      .join("; ");
    if (history) sheetUpdates.employmentHistory = history;

    if (Object.keys(sheetUpdates).length === 0) {
      toast.success(`Applied ${count} field${count !== 1 ? "s" : ""} from Apollo`);
      return;
    }
    try {
      // "Apply Selected" is an explicit, human-reviewed choice, so it must write
      // every field the user picked — even over an existing value. We persist as
      // "user" intent; the non-destructive "apollo" mode is only for unattended
      // background enrichment, which would otherwise skip already-populated cells.
      const res = await mergeContactFields({
        data: { email: primaryEmail, fields: sheetUpdates, source: "user", urid: contact.urid },
      });
      if (res.success) {
        const wrote = res.written.length;
        toast.success(
          `Saved ${wrote} field${wrote !== 1 ? "s" : ""} from Apollo to the sheet.`,
        );
      } else {
        toast.warning("Couldn't find this contact's row to save — showing locally only.");
      }
    } catch (e) {
      console.error("Failed to save Apollo fields to Contacts sheet:", e);
      toast.warning(`Applied ${count} field${count !== 1 ? "s" : ""} from Apollo locally — saving failed (see console)`);
    }
  };

  const startEditing = () => {
    setEditData({
      name: contact.name,
      title: contact.title,
      company: contact.company,
      email: contact.email,
      phone: contact.phone,
      // The real geo value lives in `location`; `address` is a legacy alias.
      address: contact.address || contact.location || "",
      prime: contact.prime,
      sector: contact.sector,
      contactType: contact.contactType || "",
      linkedinUrl: contact.linkedinUrl || "",
      source: contact.source || "Manual Entry",
      sourceContext: contact.sourceContext || "",
    });
    setEditing(true);
  };

  const saveEdits = async () => {
    if (onContactUpdate) {
      // Mirror an address edit into location (no separate address column).
      const merged = { ...contact, ...editData };
      if (typeof editData.address === "string") merged.location = editData.address;
      onContactUpdate(merged);
    }
    setEditing(false);

    // Persist only the fields the user actually changed, stamped as human-owned
    // so the Apollo enrichment pass won't overwrite them. Sending unchanged
    // fields could clobber good data with blanks. Email is the match key.
    const fields: Record<string, string | undefined> = {};
    if (editData.name !== undefined && editData.name !== contact.name) fields.name = editData.name;
    if (editData.title !== undefined && editData.title !== contact.title) fields.title = editData.title;
    if (editData.company !== undefined && editData.company !== contact.company) fields.company = editData.company;
    if (editData.phone !== undefined && editData.phone !== contact.phone) fields.phone = editData.phone;
    if (editData.prime !== undefined && editData.prime !== contact.prime) fields.prime = editData.prime;
    if (editData.sector !== undefined && editData.sector !== contact.sector) fields.sector = editData.sector;
    if (editData.contactType !== undefined && editData.contactType !== (contact.contactType || "")) fields.contactType = editData.contactType;
    if (editData.source !== undefined && editData.source !== (contact.source || "Manual Entry")) fields.source = editData.source;
    if (editData.sourceContext !== undefined && editData.sourceContext !== (contact.sourceContext || "")) fields.sourceContext = editData.sourceContext;
    const curLocation = contact.location || contact.address || "";
    if (editData.address !== undefined && editData.address !== curLocation) fields.location = editData.address;

    if (Object.keys(fields).length === 0) return;
    try {
      const res = await mergeContactFields({
        data: { email: primaryEmail, fields, source: "user", urid: contact.urid },
      });
      if (res.success) toast.success("Saved to sheet.");
      else toast.warning("Couldn't find this contact's row — changes shown locally only.");
    } catch (e) {
      console.error("Failed to save contact edits:", e);
      toast.error("Saving to the sheet failed — see console.");
    }
  };

  const cancelEditing = () => {
    setEditing(false);
    setEditData({});
  };

  const addInteraction = async () => {
    if (!newInteraction.summary.trim()) return;
    const interaction: Interaction = {
      id: `i-${Date.now()}`,
      date: new Date().toISOString().split("T")[0],
      type: newInteraction.type,
      summary: newInteraction.summary,
      isFollowUp: newInteraction.isFollowUp,
      followUpComplete: false,
    };
    const updatedPortCoIntros = newInteraction.portCoIntro && !contact.portCoIntros.includes(newInteraction.portCoIntro)
      ? [...contact.portCoIntros, newInteraction.portCoIntro]
      : contact.portCoIntros;
    const updated = {
      ...contact,
      interactions: [interaction, ...contact.interactions],
      lastContact: interaction.date,
      followUpPending: newInteraction.isFollowUp ? true : contact.followUpPending,
      portCoIntros: updatedPortCoIntros,
    };
    if (onContactUpdate) onContactUpdate(updated);
    setNewInteraction({ type: "note", summary: "", isFollowUp: false, portCoIntro: "" });
    setAddInteractionOpen(false);

    // Write to Google Sheets
    try {
      await addNote({ data: { contactEmail: contact.email, noteContent: interaction.summary, requiresFollowUp: newInteraction.isFollowUp, type: newInteraction.type } });
      if (newInteraction.portCoIntro) {
        await addPortcoIntro({ data: { contactEmail: contact.email, portcoName: newInteraction.portCoIntro } });
      }
    } catch (e) {
      console.error("Failed to write interaction to sheet:", e);
    }
  };

  const startEditingInteraction = (interaction: Interaction) => {
    setEditingInteractionId(interaction.id);
    setEditInteractionData({ type: interaction.type, summary: interaction.summary });
  };

  const saveInteractionEdit = () => {
    if (!editingInteractionId) return;
    const updated = {
      ...contact,
      interactions: contact.interactions.map((i) =>
        i.id === editingInteractionId
          ? { ...i, type: editInteractionData.type, summary: editInteractionData.summary }
          : i
      ),
    };
    if (onContactUpdate) onContactUpdate(updated);
    setEditingInteractionId(null);
  };

  const toggleFollowUpComplete = async (interactionId: string) => {
    const interaction = contact.interactions.find((i) => i.id === interactionId);
    if (!interaction) return;
    const newResolved = !interaction.followUpComplete;
    const updated = {
      ...contact,
      interactions: contact.interactions.map((i) =>
        i.id === interactionId ? { ...i, followUpComplete: newResolved } : i
      ),
    };
    updated.followUpPending = updated.interactions.some(
      (i) => i.isFollowUp && !i.followUpComplete
    );
    if (onContactUpdate) onContactUpdate(updated);

    try {
      await resolveFollowUp({ data: { contactEmail: contact.email, noteContent: interaction.summary, resolved: newResolved } });
    } catch (e) {
      console.error("Failed to update follow-up resolved in sheet:", e);
    }
  };

  const addPortCoIntro = async () => {
    if (!newPortCo.trim() || contact.portCoIntros.includes(newPortCo)) return;
    const today = new Date().toISOString().split("T")[0];
    const updated = {
      ...contact,
      portCoIntros: [...contact.portCoIntros, newPortCo],
      portCoEngagements: [
        ...(contact.portCoEngagements || []),
        { portco: newPortCo, date: today, source: newPortCoSource },
      ],
    };
    if (onContactUpdate) onContactUpdate(updated);
    setNewPortCo("");
    setNewPortCoSource("direct introduction");
    setAddPortCoOpen(false);

    try {
      await addPortcoIntro({
        data: { contactEmail: contact.email, portcoName: newPortCo, source: newPortCoSource },
      });
    } catch (e) {
      console.error("Failed to write portco intro to sheet:", e);
    }
  };

  const addEventHandler = async () => {
    if (!newEvent.name.trim()) return;
    const updated = {
      ...contact,
      eventsAttended: newEvent.type === "attended"
        ? [...contact.eventsAttended, newEvent.name]
        : contact.eventsAttended,
      eventsInvited: newEvent.type === "invited"
        ? [...contact.eventsInvited, newEvent.name]
        : contact.eventsInvited,
    };
    if (onContactUpdate) onContactUpdate(updated);
    const eventName = newEvent.name;
    const eventType = newEvent.type;
    setNewEvent({ name: "", type: "attended" });
    setAddEventOpen(false);

    try {
      await addEventToSheet({ data: { contactEmail: contact.email, eventName, type: eventType } });
    } catch (e) {
      console.error("Failed to write event to sheet:", e);
    }
  };

  // Persist the full areas-of-interest list to the sheet as a manual override
  // (a non-empty value stops the rule-based auto-inference from overriding it).
  const persistAreas = async (areas: string[]) => {
    if (!primaryEmail) return;
    try {
      const res = await mergeContactFields({
        data: {
          email: primaryEmail,
          fields: { areasOfInterest: areas.join(", ") },
          source: "user",
          urid: contact.urid,
        },
      });
      if (!res.success) toast.warning("Couldn't find this contact's row — change shown locally only.");
    } catch (e) {
      console.error("Failed to save areas of interest:", e);
      toast.error("Saving areas of interest failed — see console.");
    }
  };

  const addAreaOfInterest = () => {
    if (!newArea.trim() || contact.areasOfInterest.includes(newArea.trim())) return;
    const areas = [...contact.areasOfInterest, newArea.trim()];
    if (onContactUpdate) onContactUpdate({ ...contact, areasOfInterest: areas });
    void persistAreas(areas);
    setNewArea("");
    setAddAreaOpen(false);
  };

  const removeAreaOfInterest = (area: string) => {
    const areas = contact.areasOfInterest.filter((a) => a !== area);
    if (onContactUpdate) onContactUpdate({ ...contact, areasOfInterest: areas });
    void persistAreas(areas);
  };

  // Suggest interest domains from title/company/sector via Gemini (falling back
  // to the rule-based inference server-side), then merge them in and persist.
  const suggestAreas = async () => {
    if (suggestingAreas) return;
    setSuggestingAreas(true);
    try {
      let suggested: string[] = [];
      try {
        const res = await suggestAreasOfInterest({
          data: {
            title: contact.title,
            company: contact.company,
            sector: contact.sector,
            existing: contact.areasOfInterest,
          },
        });
        suggested = res.areas;
      } catch (e) {
        console.error("suggestAreasOfInterest failed, using local inference:", e);
        suggested = inferInterestAreas(contact.title, contact.company, contact.sector);
      }
      const merged = [...new Set([...contact.areasOfInterest, ...suggested])];
      if (merged.length === contact.areasOfInterest.length) {
        toast.info("No new domains to suggest from this title/company.");
        return;
      }
      if (onContactUpdate) onContactUpdate({ ...contact, areasOfInterest: merged });
      void persistAreas(merged);
      toast.success("Added suggested interest domains.");
    } finally {
      setSuggestingAreas(false);
    }
  };

  const removePortCoIntro = (co: string) => {
    const updated = { ...contact, portCoIntros: contact.portCoIntros.filter((p) => p !== co) };
    if (onContactUpdate) onContactUpdate(updated);
  };

  const removeEvent = (name: string, type: "attended" | "invited") => {
    const updated = {
      ...contact,
      eventsAttended: type === "attended" ? contact.eventsAttended.filter((e) => e !== name) : contact.eventsAttended,
      eventsInvited: type === "invited" ? contact.eventsInvited.filter((e) => e !== name) : contact.eventsInvited,
    };
    if (onContactUpdate) onContactUpdate(updated);
  };

  const sortedInteractions = [...contact.interactions].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full sm:max-w-2xl overflow-hidden flex flex-col">
          <SheetHeader className="pb-4 border-b border-border shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <ContactAvatar contact={contact} size="lg" />
                <div>
                  <SheetTitle className="text-base">{contact.name}</SheetTitle>
                  <SheetDescription className="flex items-center gap-1">
                    <Briefcase className="h-3 w-3" />
                    {contact.title} · {contact.company}
                  </SheetDescription>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <RatingControl contact={contact} onContactUpdate={onContactUpdate} />
              </div>
            </div>
          </SheetHeader>

          <ScrollArea className="flex-1 -mx-6 px-6">
            <div className="py-5 space-y-6">
              <section className="border-b border-border pb-6">
                <EngagementBreakdown contact={contact} />
              </section>

              {/* Metadata */}
              <section className="border-b border-border pb-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">
                    Contact Information
                  </h3>
                  <div className="flex items-center gap-1">
                    {editing ? (
                      <>
                        <Button variant="ghost" size="sm" className={actionBtnClass} onClick={cancelEditing}>
                          <X className="h-3 w-3 mr-1" />
                          Cancel
                        </Button>
                        <Button size="sm" className={actionBtnClass} onClick={saveEdits}>
                          <Save className="h-3 w-3 mr-1" />
                          Save
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button variant="outline" size="sm" className={actionBtnClass} onClick={startEditing}>
                          <Pencil className="h-3 w-3 mr-1" />
                          Edit
                        </Button>
                        <Button variant="outline" size="sm" className={actionBtnClass} onClick={handleEnrichWithApollo} disabled={enriching}>
                          <Telescope className="h-3 w-3 mr-1" />
                          {enriching ? "Enriching…" : contact.apolloEnriched ? "Re-sync Apollo" : "Update with Apollo"}
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {editing ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">Name</label>
                      <Input className="h-8 text-sm" value={editData.name || ""} onChange={(e) => setEditData({ ...editData, name: e.target.value })} />
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">Title</label>
                      <Input className="h-8 text-sm" value={editData.title || ""} onChange={(e) => setEditData({ ...editData, title: e.target.value })} />
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">Company</label>
                      <Input className="h-8 text-sm" value={editData.company || ""} onChange={(e) => setEditData({ ...editData, company: e.target.value })} />
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">Email</label>
                      <Input className="h-8 text-sm" value={editData.email || ""} onChange={(e) => setEditData({ ...editData, email: e.target.value })} />
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">Phone</label>
                      <Input className="h-8 text-sm" value={editData.phone || ""} onChange={(e) => setEditData({ ...editData, phone: e.target.value })} />
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">Address</label>
                      <Input className="h-8 text-sm" value={editData.address || ""} onChange={(e) => setEditData({ ...editData, address: e.target.value })} />
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">Contact Prime</label>
                      <Input className="h-8 text-sm" value={editData.prime || ""} onChange={(e) => setEditData({ ...editData, prime: e.target.value })} />
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">Sector</label>
                      <Input className="h-8 text-sm" value={editData.sector || ""} onChange={(e) => setEditData({ ...editData, sector: e.target.value })} />
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">Contact Type</label>
                      <Select
                        value={editData.contactType || "none"}
                        onValueChange={(v) => setEditData({ ...editData, contactType: v === "none" ? "" : v })}
                      >
                        <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="—" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">—</SelectItem>
                          {CONTACT_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>{t}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-2">
                      <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">LinkedIn URL</label>
                      <Input className="h-8 text-sm" value={editData.linkedinUrl || ""} onChange={(e) => setEditData({ ...editData, linkedinUrl: e.target.value })} placeholder="https://linkedin.com/in/..." />
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">Source</label>
                      <Select value={editData.source || "Manual Entry"} onValueChange={(v) => setEditData({ ...editData, source: v as Contact["source"] })}>
                        <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {RECORD_SOURCES.map((s) => (
                            <SelectItem key={s} value={s}>{s}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-2">
                      <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">Source Context</label>
                      <Textarea
                        className="text-sm min-h-[56px]"
                        value={editData.sourceContext || ""}
                        onChange={(e) => setEditData({ ...editData, sourceContext: e.target.value })}
                        placeholder="Why surfaced — e.g. Uses Salesforce · Hiring security engineers"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Briefcase className="h-3.5 w-3.5 shrink-0" />
                      <span className="font-medium text-foreground">{contact.title}</span>
                      <FieldSource source={contact.fieldProvenance?.title} />
                      <span>at</span>
                      <span className="font-medium text-foreground">{contact.company}</span>
                      <FieldSource source={contact.fieldProvenance?.company} />
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Mail className="h-3.5 w-3.5 shrink-0" />
                      <a
                        href={`mailto:${primaryEmail}`}
                        className="text-primary hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          const interaction = {
                            id: `i-${Date.now()}`,
                            date: new Date().toISOString().split("T")[0],
                            type: "email" as InteractionType,
                            summary: `Email sent to ${primaryEmail}`,
                            isFollowUp: false,
                            followUpComplete: false,
                          };
                          if (onContactUpdate) {
                            onContactUpdate({
                              ...contact,
                              interactions: [interaction, ...contact.interactions],
                              lastContact: interaction.date,
                            });
                          }
                          toast.success("Email interaction logged");
                        }}
                      >
                        {primaryEmail}
                      </a>
                      {primaryEmail && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 ml-1 text-[11px] gap-1 px-2"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEmailDraftOpen(true);
                          }}
                        >
                          <Sparkles className="h-3 w-3" /> Draft
                        </Button>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Phone className="h-3.5 w-3.5 shrink-0" />
                      <span>{contact.phone}</span>
                      <FieldSource source={contact.fieldProvenance?.phone} />
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <MapPin className="h-3.5 w-3.5 shrink-0" />
                      <span>{contact.address || contact.location}</span>
                      <FieldSource source={contact.fieldProvenance?.location} />
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <User className="h-3.5 w-3.5 shrink-0" />
                      <span>
                        <span className="font-medium text-foreground">{contact.prime}</span> (Contact Prime)
                      </span>
                      <FieldSource source={contact.fieldProvenance?.prime} />
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Building2 className="h-3.5 w-3.5 shrink-0" />
                      <span>{contact.sector}</span>
                      <FieldSource source={contact.fieldProvenance?.sector} />
                    </div>
                    {contact.contactType && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Tag className="h-3.5 w-3.5 shrink-0" />
                        <Badge variant="secondary" className="text-[10px]">{contact.contactType}</Badge>
                      </div>
                    )}
                    {contact.dateAdded && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Calendar className="h-3.5 w-3.5 shrink-0" />
                        <span>Added {contact.dateAdded}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Link2 className="h-3.5 w-3.5 shrink-0" />
                      {contact.linkedinUrl ? (
                        <a href={contact.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
                          LinkedIn Profile <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>
                    {contact.apolloEnriched && (
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="secondary" className="text-[10px] h-5 gap-1">
                          <Telescope className="h-3 w-3" />
                          Apollo synced {contact.apolloEnrichedDate || ""}
                        </Badge>
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Search className="h-3.5 w-3.5 shrink-0" />
                      <span>Source: <span className="font-medium text-foreground">{contact.source || "Manual Entry"}</span></span>
                    </div>
                    {/* V2: supporting reasoning behind why this contact was surfaced. */}
                    {contact.sourceContext && (
                      <div className="mt-2 rounded-md border border-primary/20 bg-primary/5 p-2">
                        <div className="text-[10px] uppercase tracking-wider font-semibold text-primary mb-0.5">Why surfaced</div>
                        <div className="text-xs text-foreground">{contact.sourceContext}</div>
                      </div>
                    )}
                  </div>
                )}
              </section>

              {/* Areas of Interest */}
              <section className="border-b border-border pb-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">
                    Areas of Interest
                  </h3>
                  <div className="flex items-center gap-1.5">
                    <Button variant="ghost" size="sm" className={actionBtnClass} onClick={() => void suggestAreas()} disabled={suggestingAreas} title="Infer domains from title + company">
                      {suggestingAreas
                        ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        : <Sparkles className="h-3 w-3 mr-1" />}
                      {suggestingAreas ? "Suggesting…" : "Suggest"}
                    </Button>
                    <Button variant="outline" size="sm" className={actionBtnClass} onClick={() => setAddAreaOpen(true)}>
                      <Plus className="h-3 w-3 mr-1" />
                      Add
                    </Button>
                  </div>
                </div>
                {contact.areasOfInterest.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {contact.areasOfInterest.map((area) => (
                      <Badge key={area} variant="secondary" className="text-xs font-medium bg-accent border border-border text-foreground gap-1 pr-1">
                        {area}
                        <button
                          type="button"
                          onClick={() => removeAreaOfInterest(area)}
                          className="ml-0.5 rounded-sm hover:bg-foreground/10 p-0.5"
                          title="Remove"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No areas of interest yet</p>
                )}
              </section>

              {/* Tech Stack (contact's company, via Sumble) */}
              <section className="border-b border-border pb-6">
                {contact.techStack ? (
                  <div className="mb-4">
                    <p className="text-xs font-medium text-muted-foreground mb-2">Tech Stack (loaded)</p>
                    <div className="flex flex-wrap gap-1.5">
                      {contact.techStack.split(",").map((t) => t.trim()).filter(Boolean).map((t) => (
                        <span key={t} className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
                <TechStackSection company={contact.company} email={primaryEmail} compact />
              </section>

              {/* BD / GTM activity from Asana, matched to this contact */}
              {(activitiesLoading || contactActivities.length > 0) && (
                <section className="border-b border-border pb-6">
                  <ActivitySection activities={contactActivities} loading={activitiesLoading} compact enableSourcing defaultCompany={contact.company} />
                </section>
              )}

              {/* Portfolio Engagement */}
              <section className="border-b border-border pb-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">
                    Portfolio Engagement
                  </h3>
                  <Button variant="outline" size="sm" className={actionBtnClass} onClick={() => setAddPortCoOpen(true)}>
                    <Plus className="h-3 w-3 mr-1" />
                    Add
                  </Button>
                </div>
                {contact.portCoIntros.length > 0 ? (
                  <div className="space-y-1.5">
                    {contact.portCoIntros.map((co) => {
                      const src = (contact.portCoEngagements || []).find((e) => e.portco === co)?.source;
                      return (
                        <div
                          key={co}
                          className="flex items-center justify-between gap-2 rounded border border-primary/20 bg-primary/5 px-2 py-1"
                        >
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-primary truncate">{co}</div>
                            {src && (
                              <div className="text-[10px] text-muted-foreground capitalize">{src}</div>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => removePortCoIntro(co)}
                            className="rounded-sm hover:bg-primary/20 p-0.5 shrink-0"
                            title="Remove"
                          >
                            <X className="h-3 w-3 text-primary" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No portfolio engagement yet</p>
                )}
              </section>

              {/* Events */}
              <section className="border-b border-border pb-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">
                    Events
                  </h3>
                  <Button variant="outline" size="sm" className={actionBtnClass} onClick={() => setAddEventOpen(true)}>
                    <Plus className="h-3 w-3 mr-1" />
                    Add Events
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground mb-2">Attended</p>
                    {contact.eventsAttended.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {contact.eventsAttended.map((ev) => (
                          <Badge key={ev} variant="outline" className="text-xs font-medium border-emerald-200 bg-emerald-50 text-emerald-700 gap-1 pr-1">
                            {ev}
                            <button
                              type="button"
                              onClick={() => removeEvent(ev, "attended")}
                              className="ml-0.5 rounded-sm hover:bg-emerald-100 p-0.5"
                              title="Remove"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">None</p>
                    )}
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground mb-2">Invited</p>
                    {contact.eventsInvited.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {contact.eventsInvited.map((ev) => (
                          <Badge key={`inv-${ev}`} variant="outline" className="text-xs font-medium gap-1 pr-1">
                            {ev}
                            <button
                              type="button"
                              onClick={() => removeEvent(ev, "invited")}
                              className="ml-0.5 rounded-sm hover:bg-foreground/10 p-0.5"
                              title="Remove"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">None</p>
                    )}
                  </div>
                </div>
              </section>

              {/* Interaction Trail */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">
                    Interaction Trail · {contact.interactions.length} entries
                  </h3>
                  <Button
                    variant="outline"
                    size="sm"
                    className={actionBtnClass}
                    onClick={() => setAddInteractionOpen(true)}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Log Activity
                  </Button>
                </div>

                <div className="relative">
                  <div className="absolute left-3.5 top-0 bottom-0 w-px bg-border" />

                  <div className="space-y-3">
                    {sortedInteractions.map((interaction) => {
                      const Icon = interactionIcons[interaction.type] || MessageSquare;
                      const colorClass = interactionColors[interaction.type] || interactionColors.note;
                      const readOnly = isAsanaSourced(interaction);
                      const isEditingThis = editingInteractionId === interaction.id && !readOnly;

                      return (
                        <div key={interaction.id} className="flex gap-3 relative group">
                          <div
                            className={`h-7 w-7 rounded-full flex items-center justify-center shrink-0 z-10 border ${colorClass}`}
                          >
                            <Icon className="h-3.5 w-3.5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            {isEditingThis ? (
                              <div className="space-y-2">
                                <Select value={editInteractionData.type} onValueChange={(v) => setEditInteractionData({ ...editInteractionData, type: v as InteractionType })}>
                                  <SelectTrigger className="h-7 text-xs w-32">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="call">Call</SelectItem>
                                    <SelectItem value="email">Email</SelectItem>
                                    <SelectItem value="meeting">Meeting</SelectItem>
                                    <SelectItem value="intro">Portfolio Intro</SelectItem>
                                    <SelectItem value="event">Event</SelectItem>
                                    <SelectItem value="note">Note</SelectItem>
                                    <SelectItem value="follow-up">Follow-up</SelectItem>
                                  </SelectContent>
                                </Select>
                                <Input
                                  className="h-7 text-xs"
                                  value={editInteractionData.summary}
                                  onChange={(e) => setEditInteractionData({ ...editInteractionData, summary: e.target.value })}
                                />
                                <div className="flex gap-1">
                                  <Button size="sm" className="h-6 text-[10px] px-2" onClick={saveInteractionEdit}>Save</Button>
                                  <Button variant="ghost" size="sm" className="h-6 text-[10px] px-2" onClick={() => setEditingInteractionId(null)}>Cancel</Button>
                                </div>
                              </div>
                            ) : (
                              <>
                                <div className="flex items-center gap-2">
                                  <span className={`text-xs font-medium capitalize px-1.5 py-0.5 rounded ${colorClass}`}>
                                    {interaction.type}
                                  </span>
                                  <span className="text-[10px] text-muted-foreground">
                                    {interaction.date}
                                  </span>
                                  {interaction.isFollowUp && (
                                    <button
                                      onClick={() => toggleFollowUpComplete(interaction.id)}
                                      className="flex items-center gap-1"
                                      title={interaction.followUpComplete ? "Mark incomplete" : "Mark complete"}
                                    >
                                      {interaction.followUpComplete ? (
                                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                                      ) : (
                                        <AlertCircle className="h-4 w-4 text-red-500" />
                                      )}
                                    </button>
                                  )}
                                  {readOnly ? (
                                    <a
                                      href={asanaTaskUrl(interaction.sourceRef)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="ml-auto inline-flex items-center gap-1 text-[9px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded-full border border-border text-muted-foreground hover:text-foreground"
                                      title="Synced from Asana (read-only) — open the task"
                                    >
                                      Asana <ExternalLink className="h-2.5 w-2.5" />
                                    </a>
                                  ) : (
                                    <button
                                      onClick={() => startEditingInteraction(interaction)}
                                      className="ml-auto opacity-50 hover:opacity-100 transition-opacity"
                                      title="Edit interaction"
                                    >
                                      <Pencil className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                                    </button>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  {interaction.summary}
                                </p>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </section>
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>

      {/* Add Interaction Dialog */}
      <Dialog open={addInteractionOpen} onOpenChange={setAddInteractionOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Log Activity</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Type
              </label>
              <Select
                value={newInteraction.type}
                onValueChange={(v) => setNewInteraction({ ...newInteraction, type: v as InteractionType })}
              >
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="call">Call</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="meeting">Meeting</SelectItem>
                  <SelectItem value="intro">Portfolio Intro</SelectItem>
                  <SelectItem value="event">Event</SelectItem>
                  <SelectItem value="note">Note</SelectItem>
                  <SelectItem value="follow-up">Follow-up</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {newInteraction.type === "intro" && (
              <div>
                <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                  Portfolio Company
                </label>
                <Select
                  value={newInteraction.portCoIntro}
                  onValueChange={(v) => setNewInteraction({ ...newInteraction, portCoIntro: v })}
                >
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder="Select company..." />
                  </SelectTrigger>
                  <SelectContent>
                    {portfolioCompanies.map((co) => (
                      <SelectItem key={co} value={co}>{co}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Notes
              </label>
              <Textarea
                placeholder="Add details about this interaction..."
                value={newInteraction.summary}
                onChange={(e) => setNewInteraction({ ...newInteraction, summary: e.target.value })}
                className="text-sm min-h-[100px]"
              />
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="is-followup"
                checked={newInteraction.isFollowUp}
                onCheckedChange={(checked) =>
                  setNewInteraction({ ...newInteraction, isFollowUp: checked === true })
                }
              />
              <label htmlFor="is-followup" className="text-sm font-medium text-foreground cursor-pointer">
                Schedule as follow-up
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddInteractionOpen(false)}>
              Cancel
            </Button>
            <Button onClick={addInteraction} disabled={!newInteraction.summary.trim()}>
              Add Entry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Portfolio Company Dialog */}
      <Dialog open={addPortCoOpen} onOpenChange={setAddPortCoOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Portfolio Engagement</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Portfolio Company
              </label>
              <Select value={newPortCo} onValueChange={setNewPortCo}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder="Select company..." />
                </SelectTrigger>
                <SelectContent>
                  {portfolioCompanies
                    .filter((co) => !contact.portCoIntros.includes(co))
                    .map((co) => (
                      <SelectItem key={co} value={co}>{co}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Engagement Source
              </label>
              <Select
                value={newPortCoSource}
                onValueChange={(v) => setNewPortCoSource(v as EngagementSource)}
              >
                <SelectTrigger className="h-9 text-sm capitalize">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENGAGEMENT_SOURCES.map((s) => (
                    <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddPortCoOpen(false)}>Cancel</Button>
            <Button onClick={addPortCoIntro} disabled={!newPortCo}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Event Dialog */}
      <Dialog open={addEventOpen} onOpenChange={setAddEventOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Event</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">Event Name</label>
              <EventPicker value={newEvent.name} onChange={(name) => setNewEvent({ ...newEvent, name })} />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">Type</label>
              <Select value={newEvent.type} onValueChange={(v) => setNewEvent({ ...newEvent, type: v as "attended" | "invited" })}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="attended">Attended</SelectItem>
                  <SelectItem value="invited">Invited</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddEventOpen(false)}>Cancel</Button>
            <Button onClick={addEventHandler} disabled={!newEvent.name.trim()}>Add Event</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Area of Interest Dialog */}
      <Dialog open={addAreaOpen} onOpenChange={setAddAreaOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Area of Interest</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Input
              className="h-9 text-sm"
              value={newArea}
              onChange={(e) => setNewArea(e.target.value)}
              placeholder="e.g. Security, Innovation, Distribution..."
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddAreaOpen(false)}>Cancel</Button>
            <Button onClick={addAreaOfInterest} disabled={!newArea.trim()}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Apollo Enrichment Review Dialog */}
      <Dialog open={apolloReviewOpen} onOpenChange={setApolloReviewOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Telescope className="h-4 w-4" />
              Apollo Enrichment Results
            </DialogTitle>
          </DialogHeader>
          {(apolloMessage || apolloResult) && (
            <div className="space-y-3 max-h-[60vh] overflow-y-auto">
              {apolloMessage && (
                <div className="rounded-md border border-border bg-muted/40 p-3 space-y-1">
                  <div className="text-sm font-medium text-foreground">{apolloMessage.title}</div>
                  <p className="text-sm text-muted-foreground">{apolloMessage.description}</p>
                </div>
              )}

              {apolloResult && (
                <>
                  <p className="text-sm text-muted-foreground">
                    Select the fields you want to apply to <span className="font-medium text-foreground">{contact.name}</span>:
                  </p>
                  {getEnrichmentFields(apolloResult).map((field) => {
                    const changed = field.apolloValue !== field.currentValue;
                    return (
                      <div
                        key={field.key}
                        className={`rounded-md border p-3 space-y-1 ${selectedFields[field.key] ? "border-primary/50 bg-primary/5" : "border-border"}`}
                      >
                        <div className="flex items-center gap-2">
                          {field.canApply ? (
                            <Checkbox
                              id={`apollo-${field.key}`}
                              checked={selectedFields[field.key] || false}
                              onCheckedChange={(checked) =>
                                setSelectedFields((prev) => ({ ...prev, [field.key]: !!checked }))
                              }
                            />
                          ) : (
                            <div className="h-4 w-4 rounded-sm border border-border bg-muted" />
                          )}
                          <label htmlFor={`apollo-${field.key}`} className="text-xs font-semibold uppercase tracking-wider text-muted-foreground cursor-pointer">
                            {field.label}
                          </label>
                          {changed && (
                            <Badge variant="secondary" className="text-[10px] h-4 px-1.5">New</Badge>
                          )}
                          {!field.canApply && (
                            <Badge variant="outline" className="text-[10px] h-4 px-1.5">Preview only</Badge>
                          )}
                        </div>
                        <div className="ml-6 space-y-0.5">
                          <div className="text-sm font-medium text-foreground break-all">{field.apolloValue}</div>
                          {field.currentValue && field.currentValue !== field.apolloValue && (
                            <div className="text-xs text-muted-foreground line-through break-all">{field.currentValue}</div>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {apolloResult.employmentHistory && apolloResult.employmentHistory.length > 0 && (
                    <div className="rounded-md border border-border p-3 space-y-2">
                      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Employment History</div>
                      {apolloResult.employmentHistory.map((job, i) => (
                        <div key={i} className="ml-2 text-sm">
                          <span className="font-medium">{job.title}</span> at {job.company}
                          {job.current && <Badge variant="secondary" className="text-[10px] h-4 px-1.5 ml-2">Current</Badge>}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setApolloReviewOpen(false);
                setApolloResult(null);
                setApolloMessage(null);
              }}
            >
              Close
            </Button>
            <Button onClick={applySelectedApolloFields} disabled={!apolloResult || !Object.values(selectedFields).some(Boolean)}>
              Apply Selected
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <EmailDraftDialog
        open={emailDraftOpen}
        onOpenChange={setEmailDraftOpen}
        contact={contact}
        onSent={(info) => {
          const date = new Date().toISOString().split("T")[0];
          const tag = info.linkedPortcos && info.linkedPortcos.length
            ? ` [PortCo: ${info.linkedPortcos.join(", ")}]`
            : info.linkedEvent
              ? ` [Event: ${info.linkedEvent}]`
              : info.emailType && info.emailType !== "General"
                ? ` [${info.emailType}]`
                : "";
          const summary =
            (info.subject ? `Email sent: ${info.subject}` : `Email sent to ${primaryEmail}`) + tag;
          const interaction: Interaction = {
            id: `i-${Date.now()}`,
            date,
            type: "email",
            summary,
            isFollowUp: false,
            followUpComplete: false,
          };
          onContactUpdate?.({
            ...contact,
            interactions: [interaction, ...contact.interactions],
            lastContact: date,
          });
          // Persist: a note (shows in history, survives reload) + a structured
          // Email Activity row for action tracking.
          if (primaryEmail) {
            addNote({
              data: { contactEmail: primaryEmail, noteContent: summary, requiresFollowUp: false, type: "email" },
            }).catch((e) => console.error("Failed to log email note:", e));
            logEmailActivity({
              data: {
                contactEmail: primaryEmail,
                subject: info.subject || "",
                emailType: info.emailType,
                linkedPortco: info.linkedPortcos?.join("; "),
                linkedEvent: info.linkedEvent,
              },
            }).catch((e) => console.error("Failed to log email activity:", e));
          }
        }}
      />
    </>
  );
}
