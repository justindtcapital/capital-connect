import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useFilterOptions } from "@/lib/filter-options-context";
import { enrichContact } from "@/utils/apollo.functions";
import type { ApolloEnrichmentResult } from "@/utils/apollo.server";
import { toast } from "sonner";
import {
  Search,
  Plus,
  Upload,
  ArrowUpRight,
  Pencil,
  ExternalLink,
  X,
  Save,
  Telescope,
  Briefcase,
  Mail,
  MapPin,
  Link2,
  Calendar,
  PhoneCall,
  MessageSquare,
  AlertCircle,
  FileUp,
  UserSearch,
  Building2,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  LayoutGrid,
  List,
  Sparkles,
  Loader2,
  Copy,
  CheckCircle2,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ContactAvatar } from "@/components/crm/ContactAvatar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  fetchTargets,
  fetchPortfolioCompanies,
  logTargetOutreach,
  saveTargetConnectionStrategy,
  updateTargetFields,
  bulkDeleteTargets,
} from "@/utils/sheets.functions";
import { NetworkBuilderDialog } from "@/components/crm/NetworkBuilderDialog";
import { NetworkFinderDialog } from "@/components/crm/NetworkFinderDialog";
import { TargetAccountsDialog } from "@/components/crm/TargetAccountsDialog";
import { EmailDraftDialog } from "@/components/crm/EmailDraftDialog";
import {
  type TargetLead,
  type PipelineStage,
  type OutreachAttempt,
  type PortfolioCompany,
  type Contact,
  type ConnectionPlan,
  targetKeyOf,
  RECORD_SOURCES,
} from "@/lib/types";
import { useTargetingFilters } from "@/lib/targeting-filter-context";
import { useTargetSelection } from "@/lib/target-selection-context";
import { connectionStrategy, type ConnectionStrategy } from "@/utils/insights.functions";

export const Route = createFileRoute("/targeting")({
  head: () => ({
    meta: [
      { title: "Targeting — VenturePulse" },
      { name: "description", content: "DTC network prospecting pipeline" },
    ],
  }),
  loader: async () => {
    const [targets, companies] = await Promise.all([
      fetchTargets(),
      fetchPortfolioCompanies().catch((): PortfolioCompany[] => []),
    ]);
    return { targets, companies };
  },
  component: TargetingPage,
});

const stages: PipelineStage[] = ["Prospecting", "Researching", "Outreach Sent", "Ready to Promote"];

const outreachMethodIcons: Record<string, typeof MessageSquare> = {
  Email: Mail,
  LinkedIn: Link2,
  Call: PhoneCall,
  Meeting: Calendar,
  "Event Invite": Calendar,
  Note: MessageSquare,
  Strategy: Sparkles,
};

const outreachMethodColors: Record<string, string> = {
  Email: "bg-slate-100 text-slate-600 border-slate-200",
  LinkedIn: "bg-blue-100 text-blue-700 border-blue-200",
  Call: "bg-sky-100 text-sky-700 border-sky-200",
  Meeting: "bg-purple-100 text-purple-700 border-purple-200",
  "Event Invite": "bg-emerald-100 text-emerald-700 border-emerald-200",
  Note: "bg-gray-100 text-gray-600 border-gray-200",
  Strategy: "bg-primary/10 text-primary border-primary/20",
};

function stageBadgeClass(stage: PipelineStage) {
  switch (stage) {
    case "Prospecting":
      return "bg-muted text-muted-foreground";
    case "Researching":
      return "bg-blue-50 text-blue-700 border-blue-200";
    case "Outreach Sent":
      return "bg-amber-50 text-amber-700 border-amber-200";
    case "Ready to Promote":
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
  }
}

const actionBtnClass = "h-7 text-[11px] font-medium";

// Adapt a target lead to the Contact shape the EmailDraftDialog expects. Only
// the fields the dialog reads are meaningful; the rest are safe defaults. Past
// outreach becomes interaction history so the draft has context.
function targetToContact(target: TargetLead): Contact {
  return {
    id: target.id,
    name: target.name,
    title: target.title,
    company: target.company,
    email: target.email,
    phone: target.phone,
    address: "",
    prime: "",
    sector: target.sector,
    areasOfInterest: [],
    temperature: "Cold",
    portCoIntros: [],
    eventsAttended: [],
    eventsInvited: [],
    interactions: target.outreach.map((o) => ({
      id: o.id,
      date: o.date,
      type: "email" as const,
      summary: `${o.method}: ${o.summary}`,
    })),
    location: target.location,
    linkedinUrl: target.linkedinUrl,
  };
}

// Sortable target columns (mirrors the Network table's sortable headers).
type TSortKey = "name" | "company" | "stage" | "location" | "intel";
const STAGE_RANK: Record<PipelineStage, number> = {
  Prospecting: 1,
  Researching: 2,
  "Outreach Sent": 3,
  "Ready to Promote": 4,
};
const TARGET_COLUMNS: { key: TSortKey; label: string }[] = [
  { key: "name", label: "Target Name" },
  { key: "company", label: "Company" },
  { key: "stage", label: "Stage" },
  { key: "location", label: "Location" },
  { key: "intel", label: "Intel" },
];
function targetSortValue(t: TargetLead, key: TSortKey): string | number {
  switch (key) {
    case "name":
      return t.name.toLowerCase();
    case "company":
      return t.company.toLowerCase();
    case "stage":
      return STAGE_RANK[t.stage] ?? 0;
    case "location":
      return (t.location || "").toLowerCase();
    case "intel":
      return t.outreach.length;
  }
}

// Target card — mirrors the Network ContactCard layout (avatar + identity, an
// email/location block, and a footer of stats) but with target-specific fields.
function TargetCard({ target, onClick }: { target: TargetLead; onClick: () => void }) {
  const primaryEmail = target.email?.split(";")[0]?.trim() || target.email;
  return (
    <Card
      className="cursor-pointer transition-all duration-200 hover:-translate-y-0.5 hover:shadow-(--shadow-elegant) hover:border-primary/40 border-border h-full flex flex-col"
      onClick={onClick}
    >
      <CardContent className="p-5 flex flex-col flex-1">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex items-center gap-3 min-w-0">
            <ContactAvatar contact={{ name: target.name, email: target.email }} size="md" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground truncate">{target.name}</h3>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Briefcase className="h-3 w-3 shrink-0" />
                <span className="truncate">{target.title || "—"}</span>
              </div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Building2 className="h-3 w-3 shrink-0" />
                <span className="truncate">{target.company || "—"}</span>
              </div>
            </div>
          </div>
          <Badge
            variant="outline"
            className={`text-[10px] font-semibold shrink-0 ${stageBadgeClass(target.stage)}`}
          >
            {target.stage}
          </Badge>
        </div>

        <div className="space-y-1.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Mail className="h-3 w-3 shrink-0" />
            {primaryEmail ? (
              <a
                href={`mailto:${primaryEmail}`}
                className="text-primary hover:underline truncate"
                onClick={(e) => e.stopPropagation()}
              >
                {primaryEmail}
              </a>
            ) : (
              <span>—</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <MapPin className="h-3 w-3 shrink-0" />
            <span className="truncate">{target.location || "—"}</span>
            {target.sector && (
              <>
                <span className="text-muted-foreground/60">·</span>
                <span className="truncate">{target.sector}</span>
              </>
            )}
          </div>
        </div>

        {target.reasonSurfaced && (
          <div className="mt-3 rounded-md border border-primary/20 bg-primary/5 px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider font-semibold text-primary mb-0.5">
              Why surfaced
            </div>
            <div className="text-[11px] text-foreground line-clamp-2">{target.reasonSurfaced}</div>
          </div>
        )}

        <div className="flex items-center gap-3 mt-auto pt-3 border-t border-border">
          <span className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground">
            {target.outreach.length} attempt{target.outreach.length !== 1 ? "s" : ""}
          </span>
          <span className="text-muted-foreground/30">·</span>
          <span
            className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground/80 truncate"
            title={`Source: ${target.originSource || "Manual Entry"}`}
          >
            {target.originSource || "Manual Entry"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function TargetingPage() {
  const { filters } = useTargetingFilters();
  const {
    selectedIds,
    selectedTargets,
    toggleId,
    toggleAll: contextToggleAll,
    clearSelection,
    setFilteredTargets,
    setOnBulkUpdate,
  } = useTargetSelection();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deletingTargets, setDeletingTargets] = useState(false);
  const { updateOptions } = useFilterOptions();
  const loaderData = Route.useLoaderData();
  const [targets, setTargets] = useState<TargetLead[]>(loaderData.targets);
  const companies = loaderData.companies;

  useEffect(() => {
    const targetSectors = [...new Set(targets.map((t) => t.sector).filter(Boolean))].sort();
    const targetCities = [...new Set(targets.map((t) => t.location).filter(Boolean))].sort();
    const targetOrigins = [...new Set(targets.map((t) => t.originSource).filter(Boolean))].sort();
    updateOptions({ targetSectors, targetCities, targetOrigins });
  }, [targets, updateOptions]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [activeTarget, setActiveTarget] = useState<TargetLead | null>(null);
  const [newTargetOpen, setNewTargetOpen] = useState(false);
  const [networkBuilderOpen, setNetworkBuilderOpen] = useState(false);
  const [finderOpen, setFinderOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [logAttemptOpen, setLogAttemptOpen] = useState(false);
  const [emailDraftOpen, setEmailDraftOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState<Partial<TargetLead>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  // New target form
  const [newName, setNewName] = useState("");
  const [newLinkedin, setNewLinkedin] = useState("");
  const [newLocation, setNewLocation] = useState("");
  // New targets are manual by default; source is a constrained enum.
  const [newOrigin, setNewOrigin] = useState<string>("Manual Entry");

  // Bulk import — defaults to the canonical "CSV Import" source.
  const [bulkText, setBulkText] = useState("");
  const [bulkSource, setBulkSource] = useState<string>("CSV Import");
  const effectiveSource = bulkSource;

  // Log attempt form
  const [attemptMethod, setAttemptMethod] = useState("Email");
  const [attemptSummary, setAttemptSummary] = useState("");
  const [enriching, setEnriching] = useState(false);
  const [apolloResult, setApolloResult] = useState<ApolloEnrichmentResult | null>(null);
  const [apolloReviewOpen, setApolloReviewOpen] = useState(false);
  const [apolloMessage, setApolloMessage] = useState<{ title: string; description: string } | null>(
    null,
  );
  const [selectedApolloFields, setSelectedApolloFields] = useState<Record<string, boolean>>({});
  // "How to Connect" recommendation for the open target.
  const [strategy, setStrategy] = useState<ConnectionStrategy | null>(null);
  const [strategyLoading, setStrategyLoading] = useState(false);
  const [strategySaving, setStrategySaving] = useState(false);
  // True when the shown strategy is freshly (re)generated and not yet persisted.
  const [strategyDirty, setStrategyDirty] = useState(false);

  const filtered = useMemo(() => {
    return targets.filter((t) => {
      if (
        filters.search &&
        !t.name.toLowerCase().includes(filters.search.toLowerCase()) &&
        !t.company.toLowerCase().includes(filters.search.toLowerCase())
      )
        return false;
      if (filters.stage !== "all" && t.stage !== filters.stage) return false;
      if (filters.sector !== "all" && t.sector !== filters.sector) return false;
      if (filters.city !== "all" && t.location !== filters.city) return false;
      if (filters.origin !== "all" && t.originSource !== filters.origin) return false;
      return true;
    });
  }, [targets, filters]);

  // Sync filtered targets and bulk update handler with context
  useEffect(() => {
    setFilteredTargets(filtered);
  }, [filtered, setFilteredTargets]);

  // Re-pull the pipeline after a discovery import (Find People / Target Accounts
  // add straight to the Targets sheet).
  const refreshTargets = useCallback(async () => {
    try {
      setTargets(await fetchTargets());
    } catch (e) {
      console.error("refresh targets failed", e);
    }
  }, []);

  const handleBulkTargetUpdate = useCallback((updatedTargets: TargetLead[]) => {
    setTargets((prev) => {
      const updatedMap = new Map(updatedTargets.map((t) => [t.id, t]));
      return prev.map((t) => updatedMap.get(t.id) || t);
    });
  }, []);

  useEffect(() => {
    setOnBulkUpdate(handleBulkTargetUpdate);
    return () => setOnBulkUpdate(undefined);
  }, [handleBulkTargetUpdate, setOnBulkUpdate]);

  const allSelected = filtered.length > 0 && filtered.every((t) => selectedIds.has(t.id));

  const [view, setView] = useState<"cards" | "table">("cards");
  const [sort, setSort] = useState<{ key: TSortKey; dir: "asc" | "desc" } | null>(null);
  const toggleSort = (key: TSortKey) =>
    setSort((prev) =>
      prev?.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    );
  const sortedTargets = useMemo(() => {
    if (!sort) return filtered;
    const arr = [...filtered];
    arr.sort((a, b) => {
      const av = targetSortValue(a, sort.key);
      const bv = targetSortValue(b, sort.key);
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sort]);

  const openDetail = (target: TargetLead) => {
    setActiveTarget(target);
    setDetailOpen(true);
    setEditing(false);
    // Show the saved plan (if any); otherwise start empty. Not dirty until regenerated.
    setStrategy(target.connectionPlan ? { ok: true, ...target.connectionPlan } : null);
    setStrategyDirty(false);
  };

  const handleSuggestStrategy = async () => {
    if (!activeTarget) return;
    setStrategyLoading(true);
    setStrategy(null);
    try {
      const res = await connectionStrategy({
        data: {
          name: activeTarget.name,
          title: activeTarget.title,
          company: activeTarget.company,
          location: activeTarget.location,
          sector: activeTarget.sector,
          originSource: activeTarget.originSource,
          reasonSurfaced: activeTarget.reasonSurfaced || "",
          stage: activeTarget.stage,
          outreach: activeTarget.outreach.map((o) => ({ method: o.method, summary: o.summary })),
        },
      });
      setStrategy(res);
      setStrategyDirty(res.ok); // a fresh, unsaved recommendation
      if (!res.ok && res.error) toast.error(res.error);
    } catch (e) {
      console.error("connectionStrategy failed", e);
      toast.error("Couldn't generate a strategy — see console.");
    } finally {
      setStrategyLoading(false);
    }
  };

  // Persist the shown plan AND log it to the target's (now persistent) outreach trail.
  const handleSaveStrategy = async () => {
    if (!activeTarget || !strategy?.ok) return;
    setStrategySaving(true);
    try {
      const plan: ConnectionPlan = {
        approach: strategy.approach,
        channel: strategy.channel,
        steps: strategy.steps,
        talkingPoints: strategy.talkingPoints,
        opener: strategy.opener,
      };
      const key = targetKeyOf(activeTarget);
      const date = new Date().toISOString().split("T")[0];
      const id = `o-${Date.now()}`;
      const summary =
        `Connection plan${plan.channel ? ` via ${plan.channel}` : ""}` +
        `${plan.approach ? `: ${plan.approach}` : ""}`.trim();
      const urid = activeTarget.urid;
      const [saveRes] = await Promise.all([
        saveTargetConnectionStrategy({ data: { targetKey: key, plan, urid } }),
        logTargetOutreach({ data: { targetKey: key, id, date, method: "Strategy", summary, urid } }),
      ]);
      const savedPlan: ConnectionPlan = { ...plan, savedAt: saveRes.savedAt || date };
      const attempt: OutreachAttempt = { id, date, method: "Strategy", summary };
      updateTarget({
        ...activeTarget,
        connectionPlan: savedPlan,
        outreach: [attempt, ...activeTarget.outreach],
      });
      setStrategy({ ok: true, ...savedPlan });
      setStrategyDirty(false);
      toast.success("Connection plan saved & logged to the outreach trail.");
    } catch (e) {
      console.error("saveTargetConnectionStrategy failed", e);
      toast.error("Couldn't save the plan — see console.");
    } finally {
      setStrategySaving(false);
    }
  };

  const updateTarget = (updated: TargetLead) => {
    setTargets((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    setActiveTarget(updated);
  };

  const handleNewTarget = () => {
    if (!newName.trim()) return;
    const lead: TargetLead = {
      id: `t-${Date.now()}`,
      name: newName.trim(),
      title: "",
      company: "",
      linkedinUrl: newLinkedin.trim(),
      email: "",
      phone: "",
      location: newLocation.trim(),
      sector: "",
      stage: "Prospecting",
      originSource: newOrigin || "Manual Entry",
      dateAdded: new Date().toISOString().split("T")[0],
      outreach: [],
      notes: "",
    };
    setTargets((prev) => [lead, ...prev]);
    setNewTargetOpen(false);
    setNewName("");
    setNewLinkedin("");
    setNewLocation("");
    setNewOrigin("Manual Entry");
  };

  const handleBulkImport = () => {
    const lines = bulkText.trim().split("\n").filter(Boolean);
    const newLeads: TargetLead[] = lines.map((line, i) => {
      const parts = line.split(",").map((s) => s.trim());
      return {
        id: `t-import-${Date.now()}-${i}`,
        name: parts[0] || "",
        title: "",
        company: parts[1] || "",
        linkedinUrl: parts[2] || "",
        email: "",
        phone: "",
        location: "",
        sector: "",
        stage: "Prospecting",
        originSource: effectiveSource || "Bulk Import",
        dateAdded: new Date().toISOString().split("T")[0],
        outreach: [],
        notes: "",
      };
    });
    setTargets((prev) => [...newLeads, ...prev]);
    setBulkImportOpen(false);
    setBulkText("");
    setBulkSource("CSV Import");
  };

  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (text) {
        const lines = text.trim().split("\n").filter(Boolean);
        // Skip header row if it looks like one
        const start = lines[0]?.toLowerCase().includes("name") ? 1 : 0;
        const newLeads: TargetLead[] = lines.slice(start).map((line, i) => {
          const parts = line.split(",").map((s) => s.trim().replace(/^"/, "").replace(/"$/, ""));
          return {
            id: `t-csv-${Date.now()}-${i}`,
            name: parts[0] || "",
            title: "",
            company: parts[1] || "",
            linkedinUrl: parts[2] || "",
            email: parts[3] || "",
            phone: "",
            location: parts[4] || "",
            sector: "",
            stage: "Prospecting",
            originSource: effectiveSource || "CSV Import",
            outreach: [],
            notes: "",
          };
        });
        setTargets((prev) => [...newLeads, ...prev]);
        setBulkImportOpen(false);
        setBulkSource("CSV Import");
      }
    };
    reader.readAsText(file);
    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleLogAttempt = () => {
    if (!activeTarget || !attemptSummary.trim()) return;
    const attempt: OutreachAttempt = {
      id: `o-${Date.now()}`,
      date: new Date().toISOString().split("T")[0],
      method: attemptMethod,
      summary: attemptSummary.trim(),
    };
    const updated = { ...activeTarget, outreach: [attempt, ...activeTarget.outreach] };
    updateTarget(updated);
    // Persist so the outreach trail survives a refresh (Target Outreach tab).
    void logTargetOutreach({
      data: {
        targetKey: targetKeyOf(activeTarget),
        id: attempt.id,
        date: attempt.date,
        method: attempt.method,
        summary: attempt.summary,
        urid: activeTarget.urid,
      },
    }).catch((e) => console.error("logTargetOutreach failed", e));
    setLogAttemptOpen(false);
    setAttemptSummary("");
  };

  // --- Apollo enrichment for targeting ---
  const getTargetEnrichmentFields = (result: ApolloEnrichmentResult) => {
    if (!activeTarget) return [];
    const location = [result.city, result.state, result.country].filter(Boolean).join(", ");
    return [
      result.title
        ? {
            key: "title",
            label: "Title",
            apolloValue: result.title,
            currentValue: activeTarget.title || "",
            targetField: "title",
            canApply: true,
          }
        : null,
      result.company
        ? {
            key: "company",
            label: "Company",
            apolloValue: result.company,
            currentValue: activeTarget.company || "",
            targetField: "company",
            canApply: true,
          }
        : null,
      result.email
        ? {
            key: "email",
            label: "Email",
            apolloValue: result.email,
            currentValue: activeTarget.email || "",
            targetField: "email",
            canApply: true,
          }
        : null,
      result.phone
        ? {
            key: "phone",
            label: "Phone",
            apolloValue: result.phone,
            currentValue: activeTarget.phone || "",
            targetField: "phone",
            canApply: true,
          }
        : null,
      location
        ? {
            key: "location",
            label: "Location",
            apolloValue: location,
            currentValue: activeTarget.location || "",
            targetField: "location",
            canApply: true,
          }
        : null,
      result.linkedinUrl
        ? {
            key: "linkedinUrl",
            label: "LinkedIn",
            apolloValue: result.linkedinUrl,
            currentValue: activeTarget.linkedinUrl || "",
            targetField: "linkedinUrl",
            canApply: true,
          }
        : null,
      result.headline
        ? {
            key: "headline",
            label: "Headline",
            apolloValue: result.headline,
            currentValue: "",
            canApply: false,
          }
        : null,
    ].filter(Boolean) as Array<{
      key: string;
      label: string;
      apolloValue: string;
      currentValue: string;
      targetField?: string;
      canApply: boolean;
    }>;
  };

  const handleTargetEnrich = async () => {
    if (!activeTarget) return;
    setEnriching(true);
    try {
      const nameParts = activeTarget.name.split(" ");
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";
      const result = await enrichContact({
        data: {
          email: activeTarget.email || undefined,
          firstName,
          lastName,
          company: activeTarget.company || undefined,
          linkedinUrl: activeTarget.linkedinUrl || undefined,
        },
      });

      if (result.accessDenied) {
        setApolloMessage({
          title: "Apollo access issue",
          description: result.error || "Apollo enrichment is not available.",
        });
        setApolloResult(null);
        setSelectedApolloFields({});
        setApolloReviewOpen(true);
        return;
      }
      if (!result.found) {
        setApolloMessage({
          title: "No Apollo match found",
          description: result.error || "No matching person found in Apollo.",
        });
        setApolloResult(null);
        setSelectedApolloFields({});
        setApolloReviewOpen(true);
        return;
      }

      setApolloResult(result);
      const fields = getTargetEnrichmentFields(result);
      const defaults: Record<string, boolean> = {};
      fields.forEach((f) => {
        if (f.canApply) defaults[f.key] = f.apolloValue !== f.currentValue;
      });
      setSelectedApolloFields(defaults);
      setApolloMessage({
        title: "Apollo enrichment results",
        description: `Review the data Apollo found for ${activeTarget.name}.`,
      });
      setApolloReviewOpen(true);
    } catch (e) {
      console.error("Apollo enrichment failed:", e);
      setApolloMessage({
        title: "Apollo request failed",
        description: "The enrichment request failed.",
      });
      setApolloResult(null);
      setSelectedApolloFields({});
      setApolloReviewOpen(true);
    } finally {
      setEnriching(false);
    }
  };

  const applyTargetApolloFields = () => {
    if (!apolloResult || !activeTarget) return;
    const fields = getTargetEnrichmentFields(apolloResult);
    const updates: Partial<TargetLead> = {};
    fields.forEach((f) => {
      if (f.canApply && f.targetField && selectedApolloFields[f.key]) {
        (updates as Record<string, string>)[f.targetField] = f.apolloValue;
      }
    });
    // Persist using the target's CURRENT key (computed before any email change).
    const key = targetKeyOf(activeTarget);
    const urid = activeTarget.urid;
    updateTarget({ ...activeTarget, ...updates });
    const count = Object.keys(updates).length;
    if (count > 0) {
      void updateTargetFields({ data: { targetKey: key, fields: updates as Record<string, string>, urid } })
        .then((res) => {
          if (!res.success) toast.warning("Applied locally, but couldn't find the row to save to the sheet.");
        })
        .catch((e) => {
          console.error("updateTargetFields failed", e);
          toast.error("Applied locally, but saving to the sheet failed — see console.");
        });
    }
    toast.success(`Applied ${count} field${count !== 1 ? "s" : ""} from Apollo`);
    setApolloReviewOpen(false);
    setApolloResult(null);
    setApolloMessage(null);
  };

  const updateStage = (id: string, stage: PipelineStage) => {
    setTargets((prev) => prev.map((t) => (t.id === id ? { ...t, stage } : t)));
    if (activeTarget?.id === id) setActiveTarget((prev) => (prev ? { ...prev, stage } : prev));
  };

  const promoteSelected = () => {
    setTargets((prev) =>
      prev.map((t) => (selectedIds.has(t.id) ? { ...t, stage: "Ready to Promote" } : t)),
    );
  };

  // Hard-delete the selected targets from the Targets sheet (confirmed first),
  // matched by stable URID with a target-key fallback, then drop them locally.
  const deleteSelected = async () => {
    const doomed = selectedTargets;
    if (doomed.length === 0) return;
    setDeletingTargets(true);
    try {
      const entries = doomed.map((t) => ({ urid: t.urid, key: targetKeyOf(t) }));
      const res = await bulkDeleteTargets({ data: { entries } });
      const goneIds = new Set(doomed.map((t) => t.id));
      setTargets((prev) => prev.filter((t) => !goneIds.has(t.id)));
      if (activeTarget && goneIds.has(activeTarget.id)) {
        setDetailOpen(false);
        setActiveTarget(null);
      }
      clearSelection();
      toast.success(`Deleted ${res.deleted} target${res.deleted !== 1 ? "s" : ""}.`);
    } catch (e) {
      console.error("bulkDeleteTargets failed", e);
      toast.error("Delete failed — see console.");
    } finally {
      setDeletingTargets(false);
      setConfirmDeleteOpen(false);
    }
  };

  const startEditing = () => {
    if (!activeTarget) return;
    setEditData({
      name: activeTarget.name,
      title: activeTarget.title,
      company: activeTarget.company,
      email: activeTarget.email,
      phone: activeTarget.phone,
      location: activeTarget.location,
      linkedinUrl: activeTarget.linkedinUrl,
      sector: activeTarget.sector,
      originSource: activeTarget.originSource,
      notes: activeTarget.notes,
    });
    setEditing(true);
  };

  const saveEdits = () => {
    if (!activeTarget) return;
    // Persist using the current key (computed before any email/name change).
    const key = targetKeyOf(activeTarget);
    const urid = activeTarget.urid;
    updateTarget({ ...activeTarget, ...editData });
    setEditing(false);
    if (Object.keys(editData).length > 0) {
      void updateTargetFields({ data: { targetKey: key, fields: editData as Record<string, string>, urid } })
        .then((res) => {
          if (!res.success) toast.warning("Saved locally, but couldn't find the row to save to the sheet.");
        })
        .catch((e) => {
          console.error("updateTargetFields failed", e);
          toast.error("Saved locally, but saving to the sheet failed — see console.");
        });
    }
  };

  const sortedOutreach = activeTarget
    ? [...activeTarget.outreach].sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
      )
    : [];

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-foreground">Prospecting Pipeline</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Build and work your DTC prospecting pipeline
            </p>
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="text-xs">
                  <Telescope className="h-3.5 w-3.5 mr-1.5" />
                  Discover
                  <ChevronDown className="h-3.5 w-3.5 ml-1.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={() => setNetworkBuilderOpen(true)}>
                  <Telescope className="h-3.5 w-3.5 mr-2" />
                  Find Contacts
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setFinderOpen(true)}>
                  <UserSearch className="h-3.5 w-3.5 mr-2" />
                  Find People
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setAccountsOpen(true)}>
                  <Building2 className="h-3.5 w-3.5 mr-2" />
                  Target Accounts
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => setBulkImportOpen(true)}
            >
              <Upload className="h-3.5 w-3.5 mr-1.5" />
              Import
            </Button>

            <Button
              size="sm"
              className="text-xs bg-(image:--gradient-primary) shadow-(--shadow-elegant) hover:shadow-(--shadow-elegant) hover:brightness-110"
              onClick={() => setNewTargetOpen(true)}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New Target
            </Button>
          </div>
        </div>
      </div>

      {/* Count, selection actions, and view toggle */}
      <div className="flex items-center justify-between gap-2 mb-3">
        <p className="text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">{filtered.length}</span> target
          {filtered.length !== 1 ? "s" : ""}
        </p>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <>
              <span className="text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">{selectedIds.size}</span> selected
              </span>
              <Button variant="outline" size="sm" className={actionBtnClass}>
                <Search className="h-3 w-3 mr-1" />
                Research (Apollo)
              </Button>
              <Button size="sm" className={actionBtnClass} onClick={promoteSelected}>
                <ArrowUpRight className="h-3 w-3 mr-1" />
                Promote All
              </Button>
              <Button
                variant="outline"
                size="sm"
                className={`${actionBtnClass} text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive`}
                onClick={() => setConfirmDeleteOpen(true)}
                disabled={deletingTargets}
              >
                <Trash2 className="h-3 w-3 mr-1" />
                Delete
              </Button>
            </>
          )}
          <div className="flex items-center gap-1">
            <Button
              variant={view === "cards" ? "default" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={() => setView("cards")}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={view === "table" ? "default" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={() => setView("table")}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {view === "cards" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {sortedTargets.map((t) => (
            <TargetCard key={t.id} target={t} onClick={() => openDetail(t)} />
          ))}
          {filtered.length === 0 && (
            <p className="col-span-full text-center py-12 text-sm text-muted-foreground">
              No targets match your filters.
            </p>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10">
                  <Checkbox checked={allSelected} onCheckedChange={contextToggleAll} />
                </TableHead>
                {TARGET_COLUMNS.map((col) => {
                  const active = sort?.key === col.key;
                  return (
                    <TableHead
                      key={col.key}
                      className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground whitespace-nowrap"
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(col.key)}
                        className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                      >
                        {col.label}
                        {active ? (
                          sort!.dir === "asc" ? (
                            <ChevronUp className="h-3 w-3" />
                          ) : (
                            <ChevronDown className="h-3 w-3" />
                          )
                        ) : (
                          <ChevronsUpDown className="h-3 w-3 opacity-30" />
                        )}
                      </button>
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedTargets.map((t) => (
                <TableRow
                  key={t.id}
                  className={`cursor-pointer ${activeTarget?.id === t.id && detailOpen ? "bg-accent/50" : ""}`}
                  onClick={() => openDetail(t)}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.has(t.id)}
                      onCheckedChange={() => toggleId(t.id)}
                    />
                  </TableCell>
                  <TableCell className="font-medium text-sm">
                    <div className="flex items-center gap-2.5">
                      <ContactAvatar contact={{ name: t.name, email: t.email }} size="sm" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span>{t.name}</span>
                          {t.originSource && (
                            <Badge
                              variant="outline"
                              className="text-[9px] font-normal text-muted-foreground"
                            >
                              {t.originSource}
                            </Badge>
                          )}
                        </div>
                        {t.reasonSurfaced && (
                          <div
                            className="text-[11px] font-normal text-muted-foreground truncate max-w-[240px]"
                            title={t.reasonSurfaced}
                          >
                            {t.reasonSurfaced}
                          </div>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <div className="max-w-[160px] truncate" title={t.company}>{t.company || "—"}</div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={`text-[10px] font-semibold whitespace-nowrap ${stageBadgeClass(t.stage)}`}
                    >
                      {t.stage}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <div className="max-w-[150px] truncate" title={t.location}>{t.location || "—"}</div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <span className="text-xs text-muted-foreground">
                      {t.outreach.length} attempt{t.outreach.length !== 1 ? "s" : ""}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center py-12 text-muted-foreground text-sm"
                  >
                    No targets match your filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Detail Sheet (slides in from right, matching CRM) */}
      <Sheet open={detailOpen} onOpenChange={setDetailOpen}>
        <SheetContent className="w-full sm:max-w-2xl overflow-hidden flex flex-col">
          {activeTarget && (
            <>
              <SheetHeader className="pb-4 border-b border-border shrink-0">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-12 w-12 rounded-full bg-accent flex items-center justify-center">
                      <span className="text-lg font-bold text-foreground">
                        {activeTarget.name
                          .split(" ")
                          .map((n) => n[0])
                          .join("")}
                      </span>
                    </div>
                    <div>
                      <SheetTitle className="text-base">{activeTarget.name}</SheetTitle>
                      <SheetDescription className="flex items-center gap-1">
                        <Briefcase className="h-3 w-3" />
                        {activeTarget.title || "No title"} · {activeTarget.company || "No company"}{" "}
                        · {activeTarget.location || "No location"}
                      </SheetDescription>
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className={`text-[10px] font-semibold ${stageBadgeClass(activeTarget.stage)}`}
                  >
                    {activeTarget.stage}
                  </Badge>
                </div>
              </SheetHeader>

              <ScrollArea className="flex-1 -mx-6 px-6">
                <div className="py-5 space-y-0">
                  {/* Profile Data */}
                  <section className="border-b border-border pb-6">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">
                        Profile Data
                      </h3>
                      <div className="flex items-center gap-1">
                        {editing ? (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              className={actionBtnClass}
                              onClick={() => setEditing(false)}
                            >
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
                            <Button
                              variant="outline"
                              size="sm"
                              className={actionBtnClass}
                              onClick={startEditing}
                            >
                              <Pencil className="h-3 w-3 mr-1" />
                              Edit
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className={actionBtnClass}
                              onClick={handleTargetEnrich}
                              disabled={enriching}
                            >
                              <Telescope className="h-3 w-3 mr-1" />
                              {enriching ? "Enriching…" : "Update with Apollo"}
                            </Button>
                          </>
                        )}
                      </div>
                    </div>

                    {editing ? (
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                            Name
                          </label>
                          <Input
                            className="h-8 text-sm"
                            value={editData.name || ""}
                            onChange={(e) => setEditData({ ...editData, name: e.target.value })}
                          />
                        </div>
                        <div>
                          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                            Title
                          </label>
                          <Input
                            className="h-8 text-sm"
                            value={editData.title || ""}
                            onChange={(e) => setEditData({ ...editData, title: e.target.value })}
                          />
                        </div>
                        <div>
                          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                            Company
                          </label>
                          <Input
                            className="h-8 text-sm"
                            value={editData.company || ""}
                            onChange={(e) => setEditData({ ...editData, company: e.target.value })}
                          />
                        </div>
                        <div>
                          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                            Email
                          </label>
                          <Input
                            className="h-8 text-sm"
                            value={editData.email || ""}
                            onChange={(e) => setEditData({ ...editData, email: e.target.value })}
                          />
                        </div>
                        <div>
                          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                            Phone
                          </label>
                          <Input
                            className="h-8 text-sm"
                            value={editData.phone || ""}
                            onChange={(e) => setEditData({ ...editData, phone: e.target.value })}
                          />
                        </div>
                        <div>
                          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                            Location
                          </label>
                          <Input
                            className="h-8 text-sm"
                            value={editData.location || ""}
                            onChange={(e) => setEditData({ ...editData, location: e.target.value })}
                          />
                        </div>
                        <div className="col-span-2">
                          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                            LinkedIn URL
                          </label>
                          <Input
                            className="h-8 text-sm"
                            value={editData.linkedinUrl || ""}
                            onChange={(e) =>
                              setEditData({ ...editData, linkedinUrl: e.target.value })
                            }
                          />
                        </div>
                        <div>
                          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                            Sector
                          </label>
                          <Input
                            className="h-8 text-sm"
                            value={editData.sector || ""}
                            onChange={(e) => setEditData({ ...editData, sector: e.target.value })}
                          />
                        </div>
                        <div>
                          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                            Source
                          </label>
                          <Select
                            value={editData.originSource || "Manual Entry"}
                            onValueChange={(v) => setEditData({ ...editData, originSource: v })}
                          >
                            <SelectTrigger className="h-8 text-sm">
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
                        <div className="col-span-2">
                          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                            Reason Surfaced
                          </label>
                          <Input
                            className="h-8 text-sm"
                            value={editData.reasonSurfaced || ""}
                            onChange={(e) =>
                              setEditData({ ...editData, reasonSurfaced: e.target.value })
                            }
                            placeholder="Uses Salesforce · Hiring security engineers"
                          />
                        </div>
                        <div className="col-span-2">
                          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                            Notes
                          </label>
                          <Textarea
                            className="text-sm min-h-[60px]"
                            value={editData.notes || ""}
                            onChange={(e) => setEditData({ ...editData, notes: e.target.value })}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2 text-sm">
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Briefcase className="h-3.5 w-3.5 shrink-0" />
                          <span className="font-medium text-foreground">
                            {activeTarget.title || "—"}
                          </span>
                          <span className="text-muted-foreground/60">·</span>
                          <span>{activeTarget.company || "—"}</span>
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Mail className="h-3.5 w-3.5 shrink-0" />
                          {activeTarget.email ? (
                            <a
                              href={`mailto:${activeTarget.email}`}
                              className="text-primary hover:underline"
                            >
                              {activeTarget.email}
                            </a>
                          ) : (
                            <span>—</span>
                          )}
                          {activeTarget.email && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 ml-auto text-[11px] px-2"
                              onClick={() => setEmailDraftOpen(true)}
                            >
                              <Sparkles className="h-3 w-3 mr-1" /> Draft
                            </Button>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <PhoneCall className="h-3.5 w-3.5 shrink-0" />
                          <span>{activeTarget.phone || "—"}</span>
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <MapPin className="h-3.5 w-3.5 shrink-0" />
                          <span>{activeTarget.location || "—"}</span>
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Link2 className="h-3.5 w-3.5 shrink-0" />
                          {activeTarget.linkedinUrl ? (
                            <a
                              href={activeTarget.linkedinUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline inline-flex items-center gap-1"
                            >
                              LinkedIn Profile <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            <span>—</span>
                          )}
                        </div>
                        {activeTarget.originSource && (
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <Search className="h-3.5 w-3.5 shrink-0" />
                            <span>
                              Source:{" "}
                              <span className="font-medium text-foreground">
                                {activeTarget.originSource}
                              </span>
                            </span>
                          </div>
                        )}
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Calendar className="h-3.5 w-3.5 shrink-0" />
                          <span>
                            Date added:{" "}
                            <span className="font-medium text-foreground">
                              {activeTarget.dateAdded || "—"}
                            </span>
                          </span>
                        </div>
                        {activeTarget.reasonSurfaced && (
                          <div className="mt-2 rounded-md border border-primary/20 bg-primary/5 p-2">
                            <div className="text-[10px] uppercase tracking-wider font-semibold text-primary mb-0.5">
                              Why surfaced
                            </div>
                            <div className="text-xs text-foreground">
                              {activeTarget.reasonSurfaced}
                            </div>
                          </div>
                        )}
                        {activeTarget.notes && (
                          <div className="mt-2 p-2 rounded bg-accent/50 text-xs text-foreground">
                            {activeTarget.notes}
                          </div>
                        )}
                      </div>
                    )}
                  </section>

                  {/* How to Connect — AI-suggested connection strategy */}
                  <section className="border-b border-border py-6">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground flex items-center gap-1.5">
                        <Sparkles className="h-3 w-3 text-primary" />
                        How to Connect
                      </h3>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {strategy?.ok && strategyDirty && (
                          <Button
                            variant="outline"
                            size="sm"
                            className={actionBtnClass}
                            onClick={handleSaveStrategy}
                            disabled={strategySaving}
                          >
                            {strategySaving ? (
                              <>
                                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                Saving…
                              </>
                            ) : (
                              <>
                                <Save className="h-3 w-3 mr-1" />
                                Save &amp; log
                              </>
                            )}
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          className={actionBtnClass}
                          onClick={handleSuggestStrategy}
                          disabled={strategyLoading}
                        >
                          {strategyLoading ? (
                            <>
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                              Thinking…
                            </>
                          ) : (
                            <>
                              <Sparkles className="h-3 w-3 mr-1" />
                              {strategy?.ok ? "Regenerate" : "Suggest approach"}
                            </>
                          )}
                        </Button>
                      </div>
                    </div>

                    {!strategy && !strategyLoading && (
                      <p className="text-xs text-muted-foreground italic">
                        Get an AI-suggested way in — channel, angle, talking points, and an opener
                        tailored to {activeTarget.name.split(" ")[0]}.
                      </p>
                    )}

                    {strategy?.ok && !strategyDirty && activeTarget.connectionPlan?.savedAt && (
                      <p className="text-[10px] text-muted-foreground mb-2 flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                        Saved &amp; logged on{" "}
                        {new Date(activeTarget.connectionPlan.savedAt).toLocaleDateString()}
                      </p>
                    )}

                    {strategy?.ok && (
                      <div className="space-y-3">
                        {strategy.approach && (
                          <p className="text-xs text-foreground">{strategy.approach}</p>
                        )}
                        {strategy.channel && (
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground shrink-0">
                              Channel
                            </span>
                            <Badge variant="secondary" className="text-[11px] font-normal">
                              {strategy.channel}
                            </Badge>
                          </div>
                        )}
                        {strategy.steps && strategy.steps.length > 0 && (
                          <div>
                            <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1">
                              Suggested steps
                            </div>
                            <ol className="list-decimal pl-4 space-y-1 text-xs text-foreground">
                              {strategy.steps.map((s, i) => (
                                <li key={i}>{s}</li>
                              ))}
                            </ol>
                          </div>
                        )}
                        {strategy.talkingPoints && strategy.talkingPoints.length > 0 && (
                          <div>
                            <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1">
                              Talking points
                            </div>
                            <ul className="list-disc pl-4 space-y-1 text-xs text-muted-foreground">
                              {strategy.talkingPoints.map((s, i) => (
                                <li key={i}>{s}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {strategy.opener && (
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                                Suggested opener
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  navigator.clipboard?.writeText(strategy.opener || "");
                                  toast.success("Opener copied");
                                }}
                                className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                              >
                                <Copy className="h-3 w-3" />
                                Copy
                              </button>
                            </div>
                            <div className="rounded-md border border-primary/20 bg-primary/5 p-2 text-xs text-foreground whitespace-pre-wrap">
                              {strategy.opener}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </section>

                  {/* Outreach Trail */}
                  <section className="border-b border-border py-6">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">
                        Outreach Trail · {activeTarget.outreach.length} entries
                      </h3>
                      <Button
                        variant="outline"
                        size="sm"
                        className={actionBtnClass}
                        onClick={() => setLogAttemptOpen(true)}
                      >
                        <Plus className="h-3 w-3 mr-1" />
                        Log Activity
                      </Button>
                    </div>

                    {sortedOutreach.length === 0 ? (
                      <p className="text-xs text-muted-foreground italic">
                        No outreach recorded yet.
                      </p>
                    ) : (
                      <div className="relative">
                        <div className="absolute left-3.5 top-0 bottom-0 w-px bg-border" />
                        <div className="space-y-3">
                          {sortedOutreach.map((o) => {
                            const Icon = outreachMethodIcons[o.method] || MessageSquare;
                            const colorClass =
                              outreachMethodColors[o.method] || outreachMethodColors.Note;
                            return (
                              <div key={o.id} className="flex gap-3 relative">
                                <div
                                  className={`h-7 w-7 rounded-full flex items-center justify-center shrink-0 z-10 border ${colorClass}`}
                                >
                                  <Icon className="h-3.5 w-3.5" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-[10px] font-bold uppercase tracking-wider">
                                      {o.method}
                                    </span>
                                    <span className="text-[10px] text-muted-foreground">
                                      {o.date}
                                    </span>
                                  </div>
                                  <p className="text-xs text-foreground mt-0.5">{o.summary}</p>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </section>

                  {/* Pipeline Strategy */}
                  <section className="pt-6">
                    <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground mb-3">
                      Pipeline Strategy
                    </h3>
                    <div className="mb-4">
                      <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
                        Current Stage
                      </span>
                      <Select
                        value={activeTarget.stage}
                        onValueChange={(v) => updateStage(activeTarget.id, v as PipelineStage)}
                      >
                        <SelectTrigger className="h-9 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {stages.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      className={`w-full ${actionBtnClass}`}
                      variant="outline"
                      onClick={() => updateStage(activeTarget.id, "Ready to Promote")}
                      disabled={activeTarget.stage === "Ready to Promote"}
                    >
                      <ArrowUpRight className="h-3 w-3 mr-1" />
                      Promote to CRM
                    </Button>
                  </section>
                </div>
              </ScrollArea>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Network builder — Apollo discovery search */}
      <NetworkBuilderDialog
        open={networkBuilderOpen}
        onOpenChange={setNetworkBuilderOpen}
        onAdded={(t) => setTargets((prev) => [t, ...prev])}
      />

      {/* Find People — Customer Discovery search (company / industry / technology) */}
      <NetworkFinderDialog
        open={finderOpen}
        onOpenChange={setFinderOpen}
        onImported={refreshTargets}
        companies={companies}
      />

      {/* Target Accounts — find people at specific accounts */}
      <TargetAccountsDialog
        open={accountsOpen}
        onOpenChange={setAccountsOpen}
        onImported={refreshTargets}
      />

      {/* Draft an email to the active target; logs to the outreach trail on send */}
      <EmailDraftDialog
        open={emailDraftOpen}
        onOpenChange={setEmailDraftOpen}
        contact={activeTarget ? targetToContact(activeTarget) : null}
        onSent={(info) => {
          if (!activeTarget) return;
          const tag = info.linkedPortcos?.length
            ? ` [PortCo: ${info.linkedPortcos.join(", ")}]`
            : info.linkedEvent
              ? ` [Event: ${info.linkedEvent}]`
              : info.emailType && info.emailType !== "General"
                ? ` [${info.emailType}]`
                : "";
          const summary =
            (info.subject ? `Email sent: ${info.subject}` : `Email sent to ${activeTarget.email}`) +
            tag;
          const attempt: OutreachAttempt = {
            id: `o-${Date.now()}`,
            date: new Date().toISOString().split("T")[0],
            method: "Email",
            summary,
          };
          updateTarget({ ...activeTarget, outreach: [attempt, ...activeTarget.outreach] });
          // Persist so the outreach trail survives a refresh (Target Outreach tab).
          void logTargetOutreach({
            data: {
              targetKey: targetKeyOf(activeTarget),
              id: attempt.id,
              date: attempt.date,
              method: attempt.method,
              summary: attempt.summary,
              urid: activeTarget.urid,
            },
          }).catch((e) => console.error("logTargetOutreach failed", e));
        }}
      />

      {/* Confirm bulk delete */}
      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedIds.size} target{selectedIds.size !== 1 ? "s" : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes {selectedIds.size === 1 ? "this target" : "these targets"}{" "}
              from the Targets sheet. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingTargets}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void deleteSelected();
              }}
              disabled={deletingTargets}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingTargets ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Deleting…
                </>
              ) : (
                <>Delete {selectedIds.size}</>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* New Target Dialog */}
      <Dialog open={newTargetOpen} onOpenChange={setNewTargetOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Track New Lead</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Target Name
              </label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Full name"
                className="h-9 text-sm"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                LinkedIn URL
              </label>
              <Input
                value={newLinkedin}
                onChange={(e) => setNewLinkedin(e.target.value)}
                placeholder="https://linkedin.com/in/..."
                className="h-9 text-sm"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Location
              </label>
              <Input
                value={newLocation}
                onChange={(e) => setNewLocation(e.target.value)}
                placeholder="City, State"
                className="h-9 text-sm"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Source
              </label>
              <Select value={newOrigin} onValueChange={setNewOrigin}>
                <SelectTrigger className="h-9 text-sm">
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewTargetOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleNewTarget} disabled={!newName.trim()}>
              Begin Research
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Import Dialog */}
      <Dialog open={bulkImportOpen} onOpenChange={setBulkImportOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Bulk Import</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Source
              </label>
              <Select value={bulkSource} onValueChange={setBulkSource}>
                <SelectTrigger className="h-9 text-sm">
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

            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-2 block">
                Upload CSV File
              </label>
              <p className="text-xs text-muted-foreground mb-2">
                Columns: Name, Company, LinkedIn URL, Email, Location
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={handleCsvUpload}
                className="hidden"
              />
              <Button
                variant="outline"
                className="w-full h-9 text-sm"
                onClick={() => fileInputRef.current?.click()}
              >
                <FileUp className="h-4 w-4 mr-2" />
                Choose CSV File
              </Button>
            </div>

            <div className="relative flex items-center gap-3">
              <div className="flex-1 border-t border-border" />
              <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                or paste
              </span>
              <div className="flex-1 border-t border-border" />
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-2">
                Format: Name, Company, LinkedIn URL
              </p>
              <Textarea
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                placeholder={
                  "John Doe, Acme Inc, https://linkedin.com/in/johndoe\nJane Smith, Beta Corp, https://linkedin.com/in/janesmith"
                }
                className="min-h-[100px] text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkImportOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleBulkImport} disabled={!bulkText.trim()}>
              Start Import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Log Attempt Dialog */}
      <Dialog open={logAttemptOpen} onOpenChange={setLogAttemptOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Log Outreach Activity</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Method
              </label>
              <Select value={attemptMethod} onValueChange={setAttemptMethod}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Email">Email</SelectItem>
                  <SelectItem value="LinkedIn">LinkedIn</SelectItem>
                  <SelectItem value="Call">Call</SelectItem>
                  <SelectItem value="Meeting">Meeting</SelectItem>
                  <SelectItem value="Event Invite">Event Invite</SelectItem>
                  <SelectItem value="Note">Note</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Summary
              </label>
              <Textarea
                value={attemptSummary}
                onChange={(e) => setAttemptSummary(e.target.value)}
                placeholder="What happened?"
                className="min-h-[80px] text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLogAttemptOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleLogAttempt} disabled={!attemptSummary.trim()}>
              Log Activity
            </Button>
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
                  {getTargetEnrichmentFields(apolloResult).map((field) => {
                    const changed = field.apolloValue !== field.currentValue;
                    return (
                      <div
                        key={field.key}
                        className={`rounded-md border p-3 space-y-1 ${selectedApolloFields[field.key] ? "border-primary/50 bg-primary/5" : "border-border"}`}
                      >
                        <div className="flex items-center gap-2">
                          {field.canApply ? (
                            <Checkbox
                              id={`target-apollo-${field.key}`}
                              checked={selectedApolloFields[field.key] || false}
                              onCheckedChange={(checked) =>
                                setSelectedApolloFields((prev) => ({
                                  ...prev,
                                  [field.key]: !!checked,
                                }))
                              }
                            />
                          ) : (
                            <div className="h-4 w-4 rounded-sm border border-border bg-muted" />
                          )}
                          <label
                            htmlFor={`target-apollo-${field.key}`}
                            className="text-xs font-semibold uppercase tracking-wider text-muted-foreground cursor-pointer"
                          >
                            {field.label}
                          </label>
                          {changed && (
                            <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                              New
                            </Badge>
                          )}
                          {!field.canApply && (
                            <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                              Preview only
                            </Badge>
                          )}
                        </div>
                        <div className="ml-6 space-y-0.5">
                          <div className="text-sm font-medium text-foreground break-all">
                            {field.apolloValue}
                          </div>
                          {field.currentValue && field.currentValue !== field.apolloValue && (
                            <div className="text-xs text-muted-foreground line-through break-all">
                              {field.currentValue}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {apolloResult.employmentHistory && apolloResult.employmentHistory.length > 0 && (
                    <div className="rounded-md border border-border p-3 space-y-2">
                      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Employment History
                      </div>
                      {apolloResult.employmentHistory.map((job, i) => (
                        <div key={i} className="ml-2 text-sm">
                          <span className="font-medium">{job.title}</span> at {job.company}
                          {job.current && (
                            <Badge variant="secondary" className="text-[10px] h-4 px-1.5 ml-2">
                              Current
                            </Badge>
                          )}
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
            <Button
              onClick={applyTargetApolloFields}
              disabled={!apolloResult || !Object.values(selectedApolloFields).some(Boolean)}
            >
              Apply Selected
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
