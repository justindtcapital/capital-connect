import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  fetchContacts,
  fetchPortfolioCompanies,
  fetchOwnershipIndex,
  recalculateRatings,
  logOpsEvent,
  addContact,
  addEvent as addEventToSheet,
  addPortcoIntro,
  addNote,
} from "@/utils/sheets.functions";
import { EventPicker } from "@/components/events/EventPicker";
import { MultiSelect } from "@/components/ui/multi-select";
import { Textarea } from "@/components/ui/textarea";
import { ENGAGEMENT_SOURCES, type EngagementSource } from "@/lib/types";
import { formatEngagementSources, mergeEngagementSources } from "@/lib/engagement-source";
import type { Contact, PortfolioCompany } from "@/lib/types";

import { ContactList } from "@/components/crm/ContactList";
import { syncAsanaActivities, syncActivityTracks } from "@/utils/activity-sync.functions";
import { syncGmailCrmTouches } from "@/utils/gmail-crm-sync.functions";
import { syncEventExposure } from "@/utils/event-exposure.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Upload, Download, ClipboardPaste, ChevronDown, Gauge, Loader2, Activity, Mail } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useFilters } from "@/lib/filter-context";
import { useFilterOptions } from "@/lib/filter-options-context";
import { useSelection } from "@/lib/selection-context";
import { useAuth } from "@/lib/auth-context";
import { teamProfile } from "@/lib/user-ownership";
import { BulkUploadDialog } from "@/components/crm/BulkUploadDialog";
import { SmartPasteDialog } from "@/components/crm/SmartPasteDialog";
import { canonicalLocations } from "@/lib/location-utils";
import { Checkbox } from "@/components/ui/checkbox";
import { enrichContact } from "@/utils/apollo.functions";
import { contactsToCsv, downloadCsv } from "@/lib/csv-export";
import { contactsToXlsx, downloadXlsx } from "@/lib/xlsx-export";
import { FileSpreadsheet, FileText } from "lucide-react";
import { toast } from "sonner";
import { useEffect, useMemo, useState } from "react";

export const Route = createFileRoute("/crm")({
  // `?contact=<email>` deep-links to a single contact (e.g. from the home page's
  // "Needs your attention" list) and opens its detail panel.
  validateSearch: (search: Record<string, unknown>): { contact?: string } => ({
    contact: typeof search.contact === "string" ? search.contact : undefined,
  }),
  head: () => ({
    meta: [
      { title: "CRM — VenturePulse" },
      {
        name: "description",
        content:
          "Manage DTC network contacts: relationship temperature, engagement history, follow-ups and Asana-synced activity in one CRM view.",
      },
      { property: "og:title", content: "CRM — VenturePulse" },
      {
        property: "og:description",
        content:
          "Manage DTC network contacts: relationship temperature, engagement history, follow-ups and Asana-synced activity in one CRM view.",
      },
    ],
  }),

  loader: async () => {
    const [contacts, companies] = await Promise.all([
      fetchContacts(),
      fetchPortfolioCompanies().catch((): PortfolioCompany[] => []),
    ]);
    return { contacts, companies };
  },
  component: CrmPage,
});

function isPortfolioContact(c: Contact) {
  return (c.sector || "").trim().toLowerCase() === "portfolio";
}

function CrmPage() {
  const { contacts: allContacts, companies } = Route.useLoaderData() as {
    contacts: Contact[];
    companies: PortfolioCompany[];
  };
  const { contact: focusEmail } = Route.useSearch();
  // Portfolio-tagged contacts belong to portfolio companies — surface them on the Portfolio page instead.
  const contacts = useMemo(() => allContacts.filter((c) => !isPortfolioContact(c)), [allContacts]);
  const { filters } = useFilters();
  const { email, ready: authReady } = useAuth();
  const profile = useMemo(() => teamProfile(email), [email]);
  const ownershipQuery = useQuery({
    queryKey: ["ownership-index", email],
    queryFn: () => fetchOwnershipIndex({ data: { email: email! } }),
    enabled: Boolean(authReady && email),
    staleTime: 60_000,
  });
  const ownedGids = useMemo(
    () => new Set(ownershipQuery.data?.ownedGids || []),
    [ownershipQuery.data?.ownedGids],
  );
  const { updateOptions } = useFilterOptions();
  const { allFilteredContacts, selectedContacts, setOnBulkDelete } = useSelection();
  const router = useRouter();
  const navigate = useNavigate({ from: "/crm" });
  const [bulkUploadOpen, setBulkUploadOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addForm, setAddForm] = useState({
    name: "",
    email: "",
    company: "",
    title: "",
    linkedinUrl: "",
  });
  const [addEnrich, setAddEnrich] = useState(true);
  // Optional tagging applied right after the contact row lands (same shape as
  // the bulk importer: event, portco engagement, interaction note, follow-up).
  const [addEventName, setAddEventName] = useState("");
  const [addPortcos, setAddPortcos] = useState<string[]>([]);
  const [addPortcoSources, setAddPortcoSources] = useState<EngagementSource[]>([
    "direct introduction",
  ]);
  const [addNoteText, setAddNoteText] = useState("");
  const [addFollowUp, setAddFollowUp] = useState(false);

  const [recalcBusy, setRecalcBusy] = useState(false);
  const [asanaSyncBusy, setAsanaSyncBusy] = useState(false);
  const [gmailSyncBusy, setGmailSyncBusy] = useState(false);
  const syncBusy = asanaSyncBusy || gmailSyncBusy;

  const handleAddContact = async () => {
    const name = addForm.name.trim();
    const emailAddr = addForm.email.trim().toLowerCase();
    if (!name) {
      toast.error("Name is required.");
      return;
    }
    if (!emailAddr || !emailAddr.includes("@")) {
      toast.error("A valid email is required so we can find and update this contact later.");
      return;
    }
    if (addBusy) return;
    setAddBusy(true);
    try {
      // Stamp the signed-in teammate as Relationship Prime so the contact shows
      // under the default "Mine" ownership filter (not just Everyone).
      const prime = profile?.displayName || email || "";

      let role = addForm.title.trim();
      let company = addForm.company.trim();
      let linkedinUrl = addForm.linkedinUrl.trim();
      let phone = "";
      let location = "";
      let sector = "";
      let enriched = false;

      if (addEnrich) {
        try {
          const parts = name.split(/\s+/).filter(Boolean);
          const r = await enrichContact({
            data: {
              email: emailAddr,
              firstName: parts[0] || undefined,
              lastName: parts.slice(1).join(" ") || undefined,
              company: company || undefined,
              linkedinUrl: linkedinUrl || undefined,
            },
          });
          if (r.found) {
            role = role || r.title || "";
            company = company || r.company || "";
            linkedinUrl = linkedinUrl || (r.linkedinUrl || "").replace(/\/+$/, "");
            phone = r.phone || "";
            location = [r.city, r.state].filter(Boolean).join(", ");
            sector = r.industry || "";
            enriched = true;
          }
        } catch (err) {
          console.error("add contact enrich failed", err);
        }
      }

      const evt = addEventName.trim();
      const portcos = addPortcos.map((p) => p.trim()).filter(Boolean);
      const noteText = addNoteText.trim();
      // Event-tagged people always get a follow-up flag, like the bulk importer.
      const followUp = addFollowUp || Boolean(evt);

      await addContact({
        data: {
          name,
          role,
          company,
          email: emailAddr,
          phone,
          location,
          linkedinUrl,
          prime,
          sector,
          temperature: "Warm",
          source: "Manual Entry",
          skipPortfolioSector: true,
          followUp,
        },
      });

      // Each tag is best-effort and independent — a failure doesn't lose the contact.
      const tagged: string[] = [];
      if (evt) {
        try {
          await addEventToSheet({
            data: { contactEmail: emailAddr, eventName: evt, type: "attended", flagFollowUp: true },
          });
          tagged.push(`event "${evt}"`);
        } catch (err) {
          console.error("event tag failed", err);
        }
      }
      for (const portco of portcos) {
        try {
          await addPortcoIntro({
            data: {
              contactEmail: emailAddr,
              portcoName: portco,
              sources: mergeEngagementSources([], addPortcoSources),
            },
          });
        } catch (err) {
          console.error("portco tag failed", portco, err);
        }
      }
      if (portcos.length > 0) tagged.push(`${portcos.length} portco${portcos.length > 1 ? "s" : ""}`);
      if (noteText) {
        try {
          await addNote({
            data: { contactEmail: emailAddr, noteContent: noteText, requiresFollowUp: followUp },
          });
          tagged.push("interaction note");
        } catch (err) {
          console.error("note failed", err);
        }
      }

      toast.success(
        `Added ${name} to your network.${addEnrich ? (enriched ? " Enriched with Apollo." : " No Apollo match found.") : ""}${tagged.length ? ` Tagged: ${tagged.join(", ")}.` : ""}${followUp ? " Flagged for follow-up." : ""}`,
      );
      setAddContactOpen(false);
      setAddForm({ name: "", email: "", company: "", title: "", linkedinUrl: "" });
      setAddEventName("");
      setAddPortcos([]);
      setAddPortcoSources(["direct introduction"]);
      setAddNoteText("");
      setAddFollowUp(false);

      await router.invalidate();
      await navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, contact: emailAddr }) });
    } catch (e) {
      console.error("addContact failed", e);
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(
        /ENOTFOUND|fetch failed|network/i.test(msg)
          ? "Couldn't reach Google Sheets — check your network connection."
          : "Couldn't save contact to the sheet — see console.",
      );
    } finally {
      setAddBusy(false);
    }
  };

  // Pull BD/GTM activities from Asana (or Gmail aliases) and log onto matched
  // contacts (deduped, read-only). Safe to re-run — only new rows land.
  const handleSyncAsana = async () => {
    setAsanaSyncBusy(true);
    try {
      const [res, exp, tracks] = await Promise.all([
        syncAsanaActivities({ data: { source: "asana" } }),
        syncEventExposure(),
        syncActivityTracks({ data: { source: "asana" } }),
      ]);
      if (!res.ok) {
        toast.error(
          /fetch failed|timed out|UND_ERR|ENOTFOUND|network/i.test(res.error || "")
            ? "Couldn't reach Asana — connection timed out. BD/GTM still displays from the sheet tabs."
            : res.error || "Asana sync failed.",
        );
        return;
      }
      if (res.activities === 0 && res.portcosLogged === 0 && res.portcosBackfilled === 0) {
        toast.info("No BD/GTM Asana activities found (check ASANA_* project GIDs).");
      } else if (res.logged === 0 && res.portcosLogged === 0 && res.portcosBackfilled === 0 && res.contactsCreated === 0) {
        toast.success(
          `Asana up to date — ${res.matched} matched activit${res.matched !== 1 ? "ies" : "y"}, nothing new to log.`,
        );
      } else {
        const parts: string[] = [];
        if (res.contactsCreated > 0) {
          parts.push(
            `+${res.contactsCreated} new contact${res.contactsCreated !== 1 ? "s" : ""}`,
          );
        }
        if (res.logged > 0) {
          parts.push(
            `Logged ${res.logged} Asana activit${res.logged !== 1 ? "ies" : "y"} across ${res.contactsTouched} contact${res.contactsTouched !== 1 ? "s" : ""}`,
          );
        }
        if (res.portcosLogged > 0) {
          parts.push(
            `${res.portcosLogged} PortCo tag${res.portcosLogged !== 1 ? "s" : ""}`,
          );
        }
        if (res.portcosBackfilled > 0) {
          parts.push(
            `${res.portcosBackfilled} PortCo backfill${res.portcosBackfilled !== 1 ? "s" : ""}`,
          );
        }
        toast.success(
          parts.join(" · ") +
            (res.skipped > 0 && res.logged > 0 ? ` · ${res.skipped} already synced.` : "."),
        );
      }
      if (!exp.ok) {
        toast.error(exp.error || "Event-exposure sync failed.");
      } else if (exp.exposuresLogged > 0 || exp.engagementsLogged > 0) {
        toast.success(
          `Event exposure: tagged ${exp.exposuresLogged} compan${exp.exposuresLogged !== 1 ? "ies" : "y"}` +
            (exp.engagementsLogged > 0
              ? ` · ${exp.engagementsLogged} attendee engagement${exp.engagementsLogged !== 1 ? "s" : ""}.`
              : "."),
        );
      }
      if (!tracks.ok) {
        toast.error(tracks.error || "BD/GTM tab sync failed.");
      } else if (tracks.bdLogged > 0 || tracks.gtmLogged > 0) {
        toast.success(
          `BD/GTM tabs: added ${tracks.bdLogged} BD · ${tracks.gtmLogged} GTM row${tracks.gtmLogged !== 1 ? "s" : ""}.`,
        );
      }
      if (res.logged > 0 || (exp.ok && exp.engagementsLogged > 0)) {
        try {
          const scores = await recalculateRatings();
          if (scores.updated > 0) {
            toast.success(
              `Updated ${scores.updated} rating${scores.updated !== 1 ? "s" : ""} from new activity.`,
            );
          }
        } catch (e) {
          console.error("post-sync recalculateRatings failed", e);
        }
      }
      await router.invalidate();
      await ownershipQuery.refetch();
    } catch (e) {
      console.error("sync with Asana failed", e);
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(
        /fetch failed|timed out|UND_ERR|ENOTFOUND|network/i.test(msg)
          ? "Couldn't reach Asana — connection timed out. BD/GTM still displays from the sheet tabs."
          : "Asana sync failed — see console.",
      );
    } finally {
      setAsanaSyncBusy(false);
    }
  };

  // Pull BD/GTM alias email (and subject-classified threads) into Notes + BD/GTM tabs.
  const handleSyncGmail = async () => {
    setGmailSyncBusy(true);
    try {
      const [res, tracks, gmailCrm] = await Promise.all([
        syncAsanaActivities({ data: { source: "gmail" } }),
        syncActivityTracks({ data: { source: "gmail" } }),
        syncGmailCrmTouches(),
      ]);
      if (!res.ok) {
        toast.error(res.error || "Gmail sync failed.");
        return;
      }
      if (res.activities === 0 && res.portcosLogged === 0 && res.portcosBackfilled === 0) {
        toast.info("No BD/GTM Gmail activities found (check GMAIL_BD_ALIAS / GMAIL_GTM_ALIAS).");
      } else if (res.logged === 0 && res.portcosLogged === 0 && res.portcosBackfilled === 0 && res.contactsCreated === 0) {
        toast.success(
          `Gmail up to date — ${res.matched} matched activit${res.matched !== 1 ? "ies" : "y"}, nothing new to log.`,
        );
      } else {
        const parts: string[] = [];
        if (res.contactsCreated > 0) {
          parts.push(
            `+${res.contactsCreated} new contact${res.contactsCreated !== 1 ? "s" : ""}`,
          );
        }
        if (res.logged > 0) {
          parts.push(
            `Logged ${res.logged} Gmail activit${res.logged !== 1 ? "ies" : "y"} across ${res.contactsTouched} contact${res.contactsTouched !== 1 ? "s" : ""}`,
          );
        }
        if (res.portcosLogged > 0) {
          parts.push(
            `${res.portcosLogged} PortCo tag${res.portcosLogged !== 1 ? "s" : ""}`,
          );
        }
        if (res.portcosBackfilled > 0) {
          parts.push(
            `${res.portcosBackfilled} PortCo backfill${res.portcosBackfilled !== 1 ? "s" : ""}`,
          );
        }
        toast.success(
          parts.join(" · ") +
            (res.skipped > 0 && res.logged > 0 ? ` · ${res.skipped} already synced.` : "."),
        );
      }
      if (!tracks.ok) {
        toast.error(tracks.error || "BD/GTM tab sync failed.");
      } else if (tracks.bdLogged > 0 || tracks.gtmLogged > 0) {
        toast.success(
          `BD/GTM tabs: added ${tracks.bdLogged} BD · ${tracks.gtmLogged} GTM row${tracks.gtmLogged !== 1 ? "s" : ""}.`,
        );
      }
      if (!gmailCrm.ok) {
        toast.error(gmailCrm.error || "Gmail CRM deepen failed.");
      } else if (!gmailCrm.skipped && (gmailCrm.logged > 0 || gmailCrm.eventsLogged > 0)) {
        const parts: string[] = [];
        if (gmailCrm.logged > 0) {
          parts.push(
            `${gmailCrm.logged} touch${gmailCrm.logged !== 1 ? "es" : ""} across ${gmailCrm.matchedContacts} contact${gmailCrm.matchedContacts !== 1 ? "s" : ""}`,
          );
        }
        if (gmailCrm.eventsLogged > 0) {
          parts.push(
            `${gmailCrm.eventsLogged} event link${gmailCrm.eventsLogged !== 1 ? "s" : ""}`,
          );
        }
        toast.success(`Gmail CRM: ${parts.join(" · ")}.`);
      }
      if (
        res.logged > 0 ||
        (!gmailCrm.skipped && (gmailCrm.logged > 0 || gmailCrm.eventsLogged > 0))
      ) {
        try {
          const scores = await recalculateRatings();
          if (scores.updated > 0) {
            toast.success(
              `Updated ${scores.updated} rating${scores.updated !== 1 ? "s" : ""} from new activity.`,
            );
          }
        } catch (e) {
          console.error("post-sync recalculateRatings failed", e);
        }
      }
      await router.invalidate();
      await ownershipQuery.refetch();
    } catch (e) {
      console.error("sync with Gmail failed", e);
      toast.error("Gmail sync failed — see console.");
    } finally {
      setGmailSyncBusy(false);
    }
  };

  // Recompute every unlocked contact's rating from activity and persist changes.
  const handleRecalc = async () => {
    setRecalcBusy(true);
    try {
      const res = await recalculateRatings();
      if (res.updated === 0) {
        toast.success(`Ratings up to date — no changes across ${res.scanned} contacts.`);
      } else {
        toast.success(
          `Updated ${res.updated} rating${res.updated !== 1 ? "s" : ""}` +
            (res.skippedLocked > 0 ? ` · ${res.skippedLocked} locked, left as-is.` : "."),
        );
      }
      await router.invalidate();
    } catch (e) {
      console.error("recalculateRatings failed", e);
      toast.error("Could not recalculate ratings — see console.");
    } finally {
      setRecalcBusy(false);
    }
  };

  // Export the checkbox-selected contacts if any are selected, otherwise
  // everything currently in view (respecting active filters).
  const handleExport = (format: "csv" | "xlsx") => {
    const toExport = selectedContacts.length > 0 ? selectedContacts : allFilteredContacts;
    if (toExport.length === 0) {
      toast.error("No contacts to export.");
      return;
    }
    const date = new Date().toISOString().split("T")[0];
    const filename = format === "xlsx" ? `contacts-${date}.xlsx` : `contacts-${date}.csv`;
    if (format === "xlsx") {
      downloadXlsx(filename, contactsToXlsx(toExport));
    } else {
      downloadCsv(filename, contactsToCsv(toExport));
    }
    const label = format === "xlsx" ? "Excel" : "CSV";
    toast.success(
      `Exported ${toExport.length} contact${toExport.length !== 1 ? "s" : ""} to ${label}.`,
    );
    void logOpsEvent({
      data: {
        action: "export",
        source: format === "xlsx" ? "contacts_xlsx" : "contacts_csv",
        status: "ok",
        summary: `Exported ${toExport.length} contacts to ${filename}`,
        records: toExport.length,
        details: {
          format,
          filename,
          selection: selectedContacts.length > 0 ? "selected" : "filtered_view",
        },
        items: toExport.slice(0, 80).map((c) => {
          const email = (c.email || "").split(";")[0]?.trim() || "";
          return `${c.name || "(no name)"}${email ? ` <${email}>` : ""}${c.company ? ` · ${c.company}` : ""}`;
        }),
      },
    }).catch((e) => console.error("logOpsEvent export failed", e));
  };

  // Portfolio-company names — from the Portfolio sheet plus any already recorded
  // as intros — offered as suggestions when tagging a bulk import by portco.
  const portcoOptions = useMemo(
    () =>
      [
        ...new Set(
          [
            ...companies.map((c) => c.name),
            ...contacts.flatMap((c) => c.portCoIntros || []),
          ].filter(Boolean),
        ),
      ].sort(),
    [companies, contacts],
  );

  // After a bulk delete, re-run the loader so the removed contacts drop out of view.
  useEffect(() => {
    setOnBulkDelete(() => void router.invalidate());
    return () => setOnBulkDelete(undefined);
  }, [setOnBulkDelete, router]);

  useEffect(() => {
    const sectors = [...new Set(contacts.map((x) => x.sector).filter(Boolean))].sort();
    const primes = [...new Set(contacts.map((x) => x.prime).filter(Boolean))].sort();
    const areasOfInterest = [
      ...new Set(contacts.flatMap((x) => x.areasOfInterest).filter(Boolean)),
    ].sort();
    // Condense near-duplicate location strings (e.g. "San Francisco, CA" vs
    // "San Francisco, California") into one canonical entry per place.
    const cities = canonicalLocations(contacts.map((x) => x.location));
    // Portfolio company names — sourced from the Portfolio sheet plus any
    // intros already recorded against contacts (so the dropdown is never empty
    // even before /portfolio has been visited).
    const portcoFromIntros = contacts.flatMap((c) => c.portCoIntros || []);
    const portfolioCompanies = [
      ...new Set([...companies.map((c) => c.name), ...portcoFromIntros].filter(Boolean)),
    ].sort();
    updateOptions({ sectors, primes, areasOfInterest, allCities: cities, portfolioCompanies });
  }, [contacts, companies, updateOptions]);

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-bold text-foreground">Network CRM</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Manage and track your DTC network relationships
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            onClick={handleSyncAsana}
            disabled={syncBusy}
            title="Pull BD/GTM activities from Asana and log each onto matched contacts (read-only, deduped). Safe to re-run."
          >
            {asanaSyncBusy ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Activity className="h-3.5 w-3.5 mr-1.5" />
            )}
            {asanaSyncBusy ? "Syncing Asana…" : "Sync with Asana"}
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            onClick={handleSyncGmail}
            disabled={syncBusy}
            title="Pull BD/GTM tracking-alias email into Notes and the BD/GTM tabs (read-only, deduped). Safe to re-run."
          >
            {gmailSyncBusy ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Mail className="h-3.5 w-3.5 mr-1.5" />
            )}
            {gmailSyncBusy ? "Syncing Gmail…" : "Sync with Gmail"}
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            onClick={handleRecalc}
            disabled={recalcBusy}
            title="Recompute Council/Hot/Warm/Cold from activity. Manually-set ratings are left untouched."
          >
            {recalcBusy ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Gauge className="h-3.5 w-3.5 mr-1.5" />
            )}
            {recalcBusy ? "Scoring…" : "Recalculate ratings"}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="text-xs">
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Export
                <ChevronDown className="h-3.5 w-3.5 ml-1.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => handleExport("csv")}>
                <FileText className="h-3.5 w-3.5 mr-2" />
                Export as CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport("xlsx")}>
                <FileSpreadsheet className="h-3.5 w-3.5 mr-2" />
                Export as Excel
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="text-xs">
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                Import
                <ChevronDown className="h-3.5 w-3.5 ml-1.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => setPasteOpen(true)}>
                <ClipboardPaste className="h-3.5 w-3.5 mr-2" />
                Paste Contacts
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setBulkUploadOpen(true)}>
                <Upload className="h-3.5 w-3.5 mr-2" />
                Upload CSV
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            size="sm"
            className="text-xs"
            onClick={() => setAddContactOpen(true)}
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add Contact
          </Button>
        </div>
      </div>

      <ContactList
        contacts={contacts}
        filters={filters}
        focusEmail={focusEmail}
        teamProfile={profile}
        ownedGids={ownedGids}
        ownershipLoading={ownershipQuery.isFetching}
      />

      <Dialog open={addContactOpen} onOpenChange={setAddContactOpen}>
        <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Contact</DialogTitle>
            <DialogDescription>
              Add one person to your network. They’ll be assigned to you as Relationship Prime.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3 py-2"
            onSubmit={(e) => {
              e.preventDefault();
              void handleAddContact();
            }}
          >
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Name <span className="text-destructive">*</span>
              </label>
              <Input
                value={addForm.name}
                onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Full name"
                className="h-9 text-sm"
                autoFocus
                required
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Email <span className="text-destructive">*</span>
              </label>
              <Input
                type="email"
                value={addForm.email}
                onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="name@company.com"
                className="h-9 text-sm"
                required
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Company
              </label>
              <Input
                value={addForm.company}
                onChange={(e) => setAddForm((f) => ({ ...f, company: e.target.value }))}
                placeholder="Company"
                className="h-9 text-sm"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Title
              </label>
              <Input
                value={addForm.title}
                onChange={(e) => setAddForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="Role / title"
                className="h-9 text-sm"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                LinkedIn
              </label>
              <Input
                value={addForm.linkedinUrl}
                onChange={(e) => setAddForm((f) => ({ ...f, linkedinUrl: e.target.value }))}
                placeholder="https://linkedin.com/in/..."
                className="h-9 text-sm"
              />
            </div>

            <div className="pt-1 border-t border-border" />

            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Tie to event
              </label>
              <EventPicker
                value={addEventName}
                onChange={setAddEventName}
                placeholder="Pick an Asana event…"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Portfolio interactions
              </label>
              <MultiSelect
                options={portcoOptions}
                value={addPortcos}
                onChange={setAddPortcos}
                placeholder="Portfolio companies…"
                className="h-9"
              />
              {addPortcos.length > 0 && (
                <MultiSelect
                  options={[...ENGAGEMENT_SOURCES]}
                  value={addPortcoSources}
                  onChange={(v) =>
                    setAddPortcoSources(
                      mergeEngagementSources([], (v as EngagementSource[]) || []),
                    )
                  }
                  searchable={false}
                  placeholder="Engagement sources…"
                  formatLabel={(v) => formatEngagementSources(v as EngagementSource[])}
                  className="h-8 text-xs mt-1.5 capitalize"
                />
              )}
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Interaction trail
              </label>
              <Textarea
                value={addNoteText}
                onChange={(e) => setAddNoteText(e.target.value)}
                placeholder="What happened? e.g. “Met at RSA booth, wants intro to PortCo X”"
                className="text-sm min-h-[64px]"
              />
            </div>
            <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer">
              <Checkbox
                checked={addFollowUp || Boolean(addEventName.trim())}
                onCheckedChange={(v) => setAddFollowUp(v === true)}
                disabled={Boolean(addEventName.trim())}
                className="mt-0.5"
              />
              <span>
                Flag for follow-up.
                <span className="text-muted-foreground/70">
                  {" "}
                  Writes TRUE to “Follow Up Flag” on the Contacts sheet
                  {addEventName.trim() ? " — always on for event-tagged people." : "."}
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer">
              <Checkbox
                checked={addEnrich}
                onCheckedChange={(v) => setAddEnrich(v === true)}
                className="mt-0.5"
              />
              <span>
                Enrich with Apollo on add.
                <span className="text-muted-foreground/70">
                  {" "}
                  Fills in title, company, phone, location and sector when found.
                </span>
              </span>
            </label>
            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setAddContactOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  addBusy || !addForm.name.trim() || !addForm.email.trim().includes("@")
                }
              >
                {addBusy ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />{" "}
                    {addEnrich ? "Enriching & saving…" : "Saving…"}
                  </>
                ) : (
                  "Add contact"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <BulkUploadDialog
        open={bulkUploadOpen}
        onOpenChange={setBulkUploadOpen}
        portcoOptions={portcoOptions}
        existingEmails={allContacts.map((c) => c.email)}
        onImported={() => router.invalidate()}
      />

      <SmartPasteDialog
        open={pasteOpen}
        onOpenChange={setPasteOpen}
        existingEmails={allContacts.map((c) => c.email)}
        onImported={() => router.invalidate()}
      />
    </div>
  );
}
