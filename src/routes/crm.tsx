import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  fetchContacts,
  fetchPortfolioCompanies,
  recalculateRatings,
} from "@/utils/sheets.functions";
import type { Contact, PortfolioCompany } from "@/lib/types";
import { ContactList } from "@/components/crm/ContactList";
import { syncAsanaActivities, syncActivityTracks } from "@/utils/activity-sync.functions";
import { syncEventExposure } from "@/utils/event-exposure.functions";
import { Button } from "@/components/ui/button";
import { Plus, Upload, Download, ClipboardPaste, ChevronDown, Gauge, Loader2, Activity } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useFilters } from "@/lib/filter-context";
import { useFilterOptions } from "@/lib/filter-options-context";
import { useSelection } from "@/lib/selection-context";
import { BulkUploadDialog } from "@/components/crm/BulkUploadDialog";
import { SmartPasteDialog } from "@/components/crm/SmartPasteDialog";
import { canonicalLocations } from "@/lib/location-utils";
import { contactsToCsv, downloadCsv } from "@/lib/csv-export";
import { contactsToXlsx, downloadXlsx } from "@/lib/xlsx-export";
import { FileSpreadsheet, FileText } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/crm")({
  // `?contact=<email>` deep-links to a single contact (e.g. from the home page's
  // "Needs your attention" list) and opens its detail panel.
  validateSearch: (search: Record<string, unknown>): { contact?: string } => ({
    contact: typeof search.contact === "string" ? search.contact : undefined,
  }),
  head: () => ({
    meta: [
      { title: "CRM — VenturePulse" },
      { name: "description", content: "Manage your DTC network contacts" },
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
  const { updateOptions } = useFilterOptions();
  const { allFilteredContacts, selectedContacts, setOnBulkDelete } = useSelection();
  const router = useRouter();
  const [bulkUploadOpen, setBulkUploadOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [recalcBusy, setRecalcBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);

  // Pull BD/GTM activities from Asana and log each onto the contacts it matches
  // (deduped, read-only). Safe to re-run — only new/newly-matched activities land.
  const handleSyncActivity = async () => {
    setSyncBusy(true);
    try {
      const [res, exp, tracks] = await Promise.all([
        syncAsanaActivities(),
        syncEventExposure(),
        syncActivityTracks(),
      ]);
      if (!res.ok) {
        toast.error(res.error || "Activity sync failed.");
        return;
      }
      if (res.activities === 0) {
        toast.info("No BD/GTM activities found in Asana (check the project GIDs / access).");
      } else if (res.logged === 0) {
        toast.success(
          `Up to date — ${res.matched} matched activit${res.matched !== 1 ? "ies" : "y"}, nothing new to log.`,
        );
      } else {
        toast.success(
          `Logged ${res.logged} activit${res.logged !== 1 ? "ies" : "y"} across ${res.contactsTouched} contact${res.contactsTouched !== 1 ? "s" : ""}` +
            (res.skipped > 0 ? ` · ${res.skipped} already synced.` : "."),
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
      // Mirror raw BD/GTM activities into their own sheet tabs.
      if (!tracks.ok) {
        toast.error(tracks.error || "BD/GTM tab sync failed.");
      } else if (tracks.bdLogged > 0 || tracks.gtmLogged > 0) {
        toast.success(
          `BD/GTM tabs: added ${tracks.bdLogged} BD · ${tracks.gtmLogged} GTM row${tracks.gtmLogged !== 1 ? "s" : ""}.`,
        );
      }
      await router.invalidate();
    } catch (e) {
      console.error("syncAsanaActivities failed", e);
      toast.error("Activity sync failed — see console.");
    } finally {
      setSyncBusy(false);
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
    if (format === "xlsx") {
      downloadXlsx(`contacts-${date}.xlsx`, contactsToXlsx(toExport));
    } else {
      downloadCsv(`contacts-${date}.csv`, contactsToCsv(toExport));
    }
    const label = format === "xlsx" ? "Excel" : "CSV";
    toast.success(
      `Exported ${toExport.length} contact${toExport.length !== 1 ? "s" : ""} to ${label}.`,
    );
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
            onClick={handleSyncActivity}
            disabled={syncBusy}
            title="Pull BD/GTM activities from Asana and log each onto the contacts it matches (read-only, deduped). Safe to re-run."
          >
            {syncBusy ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Activity className="h-3.5 w-3.5 mr-1.5" />
            )}
            {syncBusy ? "Syncing…" : "Sync activity"}
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
            className="text-xs bg-(image:--gradient-primary) shadow-(--shadow-elegant) hover:shadow-(--shadow-elegant) hover:brightness-110"
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add Contact
          </Button>
        </div>
      </div>

      <ContactList contacts={contacts} filters={filters} focusEmail={focusEmail} />

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
