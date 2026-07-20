import { useState } from "react";
import { Users, Target, Search, Filter, Mail, Pencil, X, Telescope, Loader2, ScrollText } from "lucide-react";
import {
  HomeIcon,
  NetworkIcon,
  TargetingIcon,
  EventsIcon,
  PortCoIcon,
  SignalsIcon,
  CompaniesIcon,
  QueryIcon,
  DashboardIcon,
} from "@/components/home/WorkspaceIcons";
import dtcLogo from "@/assets/dtc-logo.jpg";
import { Link, useLocation } from "@tanstack/react-router";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { MultiSelect } from "@/components/ui/multi-select";
import { DateTextField } from "@/components/ui/date-text-field";
import type {
  ContactFilters,
  Contact,
  Interaction,
  TargetingFilters,
  PortfolioFilters,
  Temperature,
  BulkEditField,
} from "@/lib/types";
import { CONTACT_TYPES, RECORD_SOURCES } from "@/lib/types";
import { SENIORITY_LEVELS, DEPARTMENTS } from "@/lib/people-classify";
import { bulkUpdateContacts, addEvent as addEventToSheet, addPortcoIntro, addNote } from "@/utils/sheets.functions";
import { toast } from "sonner";
import { useFilterOptions } from "@/lib/filter-options-context";
import type { DashboardFilters } from "@/lib/dashboard-filter-context";
import { useSelection } from "@/lib/selection-context";
import { useTargetSelection } from "@/lib/target-selection-context";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { EventPicker } from "@/components/events/EventPicker";
import { NetworkSearchPanel } from "@/components/crm/NetworkSearchPanel";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar";
import { ApiHealthWidget } from "@/components/ApiHealthWidget";

const navItems = [
  { title: "Home", url: "/", icon: HomeIcon },
  { title: "Network", url: "/crm", icon: NetworkIcon },
  { title: "Targeting", url: "/targeting", icon: TargetingIcon },
  { title: "Events", url: "/events", icon: EventsIcon },
  { title: "PortCo", url: "/portfolio", icon: PortCoIcon },
  { title: "Signals", url: "/signals", icon: SignalsIcon },
  { title: "Companies", url: "/companies", icon: CompaniesIcon },
  { title: "Platform", url: "/platform", icon: Telescope },
  { title: "Query", url: "/query", icon: QueryIcon },
  { title: "Dashboard", url: "/dashboard", icon: DashboardIcon },
  { title: "Activity", url: "/activity", icon: ScrollText },
];

interface AppSidebarProps {
  filters?: ContactFilters;
  onFiltersChange?: (filters: ContactFilters) => void;
  dashboardFilters?: DashboardFilters;
  onDashboardFiltersChange?: (filters: DashboardFilters) => void;
  targetingFilters?: TargetingFilters;
  onTargetingFiltersChange?: (filters: TargetingFilters) => void;
  portfolioFilters?: PortfolioFilters;
  onPortfolioFiltersChange?: (filters: PortfolioFilters) => void;
}

export function AppSidebar({
  filters,
  onFiltersChange,
  dashboardFilters,
  onDashboardFiltersChange,
  targetingFilters,
  onTargetingFiltersChange,
  portfolioFilters,
  onPortfolioFiltersChange,
}: AppSidebarProps) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const location = useLocation();
  const currentPath = location.pathname;
  const { selectedContacts, selectedIds, clearSelection, onBulkUpdate } = useSelection();
  const {
    selectedTargets,
    selectedIds: targetSelectedIds,
    clearSelection: clearTargetSelection,
    onBulkUpdate: onTargetBulkUpdate,
    onBulkResearch: onTargetBulkResearch,
    researching: targetResearching,
  } = useTargetSelection();
  const { options: filterOpts } = useFilterOptions();
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkEditType, setBulkEditType] = useState<"portco" | "event" | "note" | "profile">("note");
  const [bulkPortCo, setBulkPortCo] = useState("");
  const [bulkEventName, setBulkEventName] = useState("");
  const [bulkEventType, setBulkEventType] = useState<"attended" | "invited">("attended");
  const [bulkNote, setBulkNote] = useState("");
  const [bulkField, setBulkField] = useState<BulkEditField>("status");
  const [bulkValue, setBulkValue] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [targetBulkEditOpen, setTargetBulkEditOpen] = useState(false);
  const [targetBulkNote, setTargetBulkNote] = useState("");

  const sectors = filterOpts.sectors;
  const primes = filterOpts.primes;
  const allAreas = filterOpts.areasOfInterest;
  const allCities = filterOpts.allCities;
  const portfolioCompanies = filterOpts.portfolioCompanies;
  const portfolioDomains = filterOpts.portfolioDomains;
  const portfolioCities = filterOpts.portfolioCities;
  const portfolioDtcPriorities = filterOpts.portfolioDtcPriorities;
  const targetSectors = filterOpts.targetSectors;
  const targetCities = filterOpts.targetCities;
  const targetOrigins = filterOpts.targetOrigins;

  const update = (partial: Partial<ContactFilters>) => {
    if (filters && onFiltersChange) onFiltersChange({ ...filters, ...partial });
  };
  // Quick-range presets: set the From bound to N days ago, clear To.
  const daysAgoIso = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().split("T")[0];
  };
  const setQuickRange = (days: number) => {
    update({ dateFrom: daysAgoIso(days), dateTo: "" });
  };
  // A preset is "active" when From matches N-days-ago and there's no upper bound.
  const isQuickActive = (days: number) =>
    !!filters && !filters.dateTo && filters.dateFrom === daysAgoIso(days);
  const QUICK_RANGES = [
    { label: "7d", days: 7 },
    { label: "30d", days: 30 },
    { label: "90d", days: 90 },
  ];
  const updateDash = (partial: Partial<DashboardFilters>) => {
    if (dashboardFilters && onDashboardFiltersChange)
      onDashboardFiltersChange({ ...dashboardFilters, ...partial });
  };
  const updateTarget = (partial: Partial<TargetingFilters>) => {
    if (targetingFilters && onTargetingFiltersChange)
      onTargetingFiltersChange({ ...targetingFilters, ...partial });
  };
  const updatePortfolio = (partial: Partial<PortfolioFilters>) => {
    if (portfolioFilters && onPortfolioFiltersChange)
      onPortfolioFiltersChange({ ...portfolioFilters, ...partial });
  };

  const showNetworkSearch = currentPath === "/crm" && !collapsed;
  const showCrmFilters = currentPath === "/crm" && filters && onFiltersChange && !collapsed;
  const showDashboardFilters =
    currentPath === "/dashboard" && dashboardFilters && onDashboardFiltersChange && !collapsed;
  const showTargetingFilters =
    currentPath === "/targeting" && targetingFilters && onTargetingFiltersChange && !collapsed;
  const showPortfolioFilters =
    currentPath === "/portfolio" && portfolioFilters && onPortfolioFiltersChange && !collapsed;
  const showBulkActions = currentPath === "/crm" && selectedIds.size > 0 && !collapsed;
  const showTargetBulkActions =
    currentPath === "/targeting" && targetSelectedIds.size > 0 && !collapsed;

  const handleBulkEmail = () => {
    if (selectedContacts.length === 0) return;
    // Use each contact's PRIMARY email (first of a ";"-separated cell) so a
    // multi-email contact doesn't inject a malformed recipient into the mailto.
    const emails = selectedContacts
      .map((c) => c.email?.split(";")[0]?.trim() || c.email)
      .filter(Boolean)
      .join(",");
    window.open(`mailto:${emails}`, "_self");

    // Log email interaction for each selected contact
    if (onBulkUpdate) {
      const now = new Date().toISOString().split("T")[0];
      const updated = selectedContacts.map((c) => ({
        ...c,
        interactions: [
          {
            id: `i-bulk-${Date.now()}-${c.id}`,
            date: now,
            type: "email" as const,
            summary: `Bulk email sent to ${selectedContacts.length} contacts`,
          },
          ...c.interactions,
        ],
        lastContact: now,
      }));
      onBulkUpdate(updated);
    }
  };

  const BULK_FIELD_LABELS: Record<BulkEditField, string> = {
    status: "Status",
    location: "Location",
    sector: "Sector",
    prime: "Contact Prime",
    title: "Title",
    company: "Company",
    contactType: "Contact Type",
    areasOfInterest: "Area of Interest",
    source: "Source",
  };

  // Bulk profile-field edit — persisted to the Contacts sheet, then reflected
  // locally. Status edits also lock the rating from the auto-scorecard.
  const handleBulkProfileSubmit = async () => {
    if (selectedContacts.length === 0) return;
    const value = bulkValue.trim();
    if (!value) return;
    setBulkBusy(true);
    try {
      const emails = selectedContacts.map((c) => c.email).filter(Boolean);
      const res = await bulkUpdateContacts({ data: { emails, field: bulkField, value } });
      if (onBulkUpdate) {
        const updated = selectedContacts.map((c) => {
          const u = { ...c };
          if (bulkField === "status") {
            u.temperature = value as Temperature;
            u.ratingLocked = true;
          } else if (bulkField === "location") u.location = value;
          else if (bulkField === "sector") u.sector = value;
          else if (bulkField === "prime") u.prime = value;
          else if (bulkField === "title") u.title = value;
          else if (bulkField === "company") u.company = value;
          else if (bulkField === "contactType") u.contactType = value;
          else if (bulkField === "source") u.source = value as Contact["source"];
          else if (bulkField === "areasOfInterest")
            u.areasOfInterest = value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
          return u;
        });
        onBulkUpdate(updated);
      }
      toast.success(
        `Updated ${res.updated} contact${res.updated !== 1 ? "s" : ""} · ${BULK_FIELD_LABELS[bulkField]} → ${value}`,
      );
      setBulkEditOpen(false);
      setBulkValue("");
    } catch (e) {
      console.error("bulkUpdateContacts failed", e);
      toast.error("Bulk update failed — see console.");
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkEditSubmit = () => {
    if (bulkEditType === "profile") {
      void handleBulkProfileSubmit();
      return;
    }
    if (!onBulkUpdate || selectedContacts.length === 0) return;
    const now = new Date().toISOString().split("T")[0];

    const updated = selectedContacts.map((c) => {
      const contact = { ...c };

      if (bulkEditType === "portco" && bulkPortCo && !contact.portCoIntros.includes(bulkPortCo)) {
        contact.portCoIntros = [...contact.portCoIntros, bulkPortCo];
        contact.interactions = [
          {
            id: `i-bulk-${Date.now()}-${c.id}`,
            date: now,
            type: "intro" as const,
            summary: `Bulk: Added portfolio company introduction — ${bulkPortCo}`,
          },
          ...contact.interactions,
        ];
        contact.lastContact = now;
      }

      if (bulkEditType === "event" && bulkEventName.trim()) {
        if (
          bulkEventType === "attended" &&
          !contact.eventsAttended.includes(bulkEventName.trim())
        ) {
          contact.eventsAttended = [...contact.eventsAttended, bulkEventName.trim()];
        } else if (
          bulkEventType === "invited" &&
          !contact.eventsInvited.includes(bulkEventName.trim())
        ) {
          contact.eventsInvited = [...contact.eventsInvited, bulkEventName.trim()];
        }
        contact.interactions = [
          {
            id: `i-bulk-${Date.now()}-${c.id}`,
            date: now,
            type: "event" as const,
            summary: `Bulk: ${bulkEventType === "attended" ? "Attended" : "Invited to"} — ${bulkEventName.trim()}`,
          },
          ...contact.interactions,
        ];
        contact.lastContact = now;
      }

      if (bulkEditType === "note" && bulkNote.trim()) {
        contact.interactions = [
          {
            id: `i-bulk-${Date.now()}-${c.id}`,
            date: now,
            type: "note" as const,
            summary: bulkNote.trim(),
          },
          ...contact.interactions,
        ];
        contact.lastContact = now;
      }

      return contact;
    });

    onBulkUpdate(updated);

    // Capture values before clearing dialog state — async persist runs after.
    const persistType = bulkEditType;
    const persistEventName = bulkEventName.trim();
    const persistEventType = bulkEventType;
    const persistPortCo = bulkPortCo;
    const persistNote = bulkNote.trim();
    const persistContacts = [...selectedContacts];

    setBulkEditOpen(false);
    setBulkPortCo("");
    setBulkEventName("");
    setBulkNote("");

    // Persist event / portco / note bulk edits to the sheet (profile uses its own path).
    void (async () => {
      try {
        if (persistType === "event" && persistEventName) {
          await Promise.all(
            persistContacts.map((c) =>
              addEventToSheet({
                data: {
                  contactEmail: (c.email || "").split(/[;,]/)[0]?.trim() || c.email,
                  eventName: persistEventName,
                  type: persistEventType,
                  urid: c.urid,
                },
              }),
            ),
          );
          toast.success(
            `Tagged ${persistContacts.length} contact${persistContacts.length !== 1 ? "s" : ""} on ${persistEventName}.`,
          );
        } else if (persistType === "portco" && persistPortCo) {
          await Promise.all(
            persistContacts.map((c) =>
              addPortcoIntro({
                data: {
                  contactEmail: (c.email || "").split(/[;,]/)[0]?.trim() || c.email,
                  portcoName: persistPortCo,
                },
              }),
            ),
          );
          toast.success(`Added PortCo intro for ${persistContacts.length} contact(s).`);
        } else if (persistType === "note" && persistNote) {
          await Promise.all(
            persistContacts.map((c) =>
              addNote({
                data: {
                  contactEmail: (c.email || "").split(/[;,]/)[0]?.trim() || c.email,
                  noteContent: persistNote,
                  type: "note",
                  requiresFollowUp: false,
                },
              }),
            ),
          );
          toast.success(`Logged note for ${persistContacts.length} contact(s).`);
        }
      } catch (e) {
        console.error("bulk sheet persist failed", e);
        toast.error("Updated locally, but saving to the sheet failed — see console.");
      }
    })();
  };

  const handleTargetBulkEmail = () => {
    if (selectedTargets.length === 0) return;
    const emails = selectedTargets
      .map((t) => t.email)
      .filter(Boolean)
      .join(",");
    if (emails) window.open(`mailto:${emails}`, "_self");

    if (onTargetBulkUpdate) {
      const now = new Date().toISOString().split("T")[0];
      const updated = selectedTargets.map((t) => ({
        ...t,
        outreach: [
          {
            id: `o-bulk-${Date.now()}-${t.id}`,
            date: now,
            method: "Email",
            summary: `Bulk email sent to ${selectedTargets.length} targets`,
          },
          ...t.outreach,
        ],
      }));
      onTargetBulkUpdate(updated);
    }
  };

  const handleTargetBulkEditSubmit = () => {
    if (!onTargetBulkUpdate || selectedTargets.length === 0 || !targetBulkNote.trim()) return;
    const now = new Date().toISOString().split("T")[0];
    const updated = selectedTargets.map((t) => ({
      ...t,
      outreach: [
        {
          id: `o-bulk-${Date.now()}-${t.id}`,
          date: now,
          method: "Note",
          summary: targetBulkNote.trim(),
        },
        ...t.outreach,
      ],
    }));
    onTargetBulkUpdate(updated);
    setTargetBulkEditOpen(false);
    setTargetBulkNote("");
  };

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader className="border-b border-sidebar-border px-4 py-4">
          <div className="flex items-center gap-2">
            <img src={dtcLogo} alt="Dell Technologies Capital" className="h-6 w-6 rounded" />
            {!collapsed && (
              <div>
                <h1 className="text-sm font-bold tracking-tight text-foreground">VenturePulse</h1>
                <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                  DTC Network Intelligence
                </p>
              </div>
            )}
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => {
                  const isActive = currentPath === item.url;
                  return (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton asChild isActive={isActive}>
                        <Link to={item.url} className="group">
                          <item.icon className="h-4 w-4" />
                          {!collapsed && <span>{item.title}</span>}
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {showNetworkSearch && (
            <>
              <SidebarSeparator />
              <SidebarGroup>
                <SidebarGroupLabel className="flex items-center gap-1.5">
                  <Search className="h-3 w-3" />
                  Network Search
                </SidebarGroupLabel>
                <SidebarGroupContent className="px-2">
                  <NetworkSearchPanel />
                </SidebarGroupContent>
              </SidebarGroup>
            </>
          )}

          {showCrmFilters && (
            <>
              <SidebarSeparator />
              <SidebarGroup>
                <SidebarGroupLabel className="flex items-center gap-1.5">
                  <Filter className="h-3 w-3" />
                  Filters
                </SidebarGroupLabel>
                <SidebarGroupContent className="px-2 space-y-3">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1.5 block">
                      Book
                    </label>
                    <div className="grid grid-cols-2 gap-1 rounded-md border border-border p-0.5">
                      <button
                        type="button"
                        onClick={() => update({ ownershipScope: "mine" })}
                        className={`h-7 rounded text-[11px] font-medium transition-colors ${
                          filters.ownershipScope !== "everyone"
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-accent"
                        }`}
                      >
                        My contacts
                      </button>
                      <button
                        type="button"
                        onClick={() => update({ ownershipScope: "everyone" })}
                        className={`h-7 rounded text-[11px] font-medium transition-colors ${
                          filters.ownershipScope === "everyone"
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-accent"
                        }`}
                      >
                        Everyone
                      </button>
                    </div>
                  </div>

                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      placeholder="Search..."
                      value={filters.search}
                      onChange={(e) => update({ search: e.target.value })}
                      className="pl-8 h-8 text-xs"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Sector
                    </label>
                    <MultiSelect
                      options={sectors}
                      value={filters.sector}
                      onChange={(v) => update({ sector: v })}
                      placeholder="All Sectors"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Temperature
                    </label>
                    <MultiSelect
                      options={["Hot", "Warm", "Cold"]}
                      value={filters.temperature}
                      onChange={(v) => update({ temperature: v })}
                      placeholder="All"
                      searchable={false}
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Contact Prime
                    </label>
                    <MultiSelect
                      options={primes}
                      value={filters.prime}
                      onChange={(v) => update({ prime: v })}
                      placeholder="All Primes"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Area of Interest
                    </label>
                    <MultiSelect
                      options={allAreas}
                      value={filters.areaOfInterest}
                      onChange={(v) => update({ areaOfInterest: v })}
                      placeholder="All Areas"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Source
                    </label>
                    <MultiSelect
                      options={[...RECORD_SOURCES]}
                      value={filters.source}
                      onChange={(v) => update({ source: v })}
                      placeholder="All Sources"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Title
                    </label>
                    <Input
                      placeholder="Title contains..."
                      value={filters.title}
                      onChange={(e) => update({ title: e.target.value })}
                      className="h-8 text-xs"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Seniority
                    </label>
                    <MultiSelect
                      options={[...SENIORITY_LEVELS]}
                      value={filters.seniority}
                      onChange={(v) => update({ seniority: v })}
                      placeholder="All Levels"
                      searchable={false}
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Department
                    </label>
                    <MultiSelect
                      options={[...DEPARTMENTS]}
                      value={filters.department}
                      onChange={(v) => update({ department: v })}
                      placeholder="All Departments"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Geography
                    </label>
                    <MultiSelect
                      options={allCities}
                      value={filters.location}
                      onChange={(v) => update({ location: v })}
                      placeholder="All Locations"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block">
                        Date
                      </label>
                      {(filters.dateFrom || filters.dateTo) && (
                        <button
                          type="button"
                          onClick={() => update({ dateFrom: "", dateTo: "" })}
                          className="text-[10px] text-muted-foreground hover:text-foreground"
                        >
                          Clear
                        </button>
                      )}
                    </div>

                    {/* Field toggle: Added vs Last activity */}
                    <div className="grid grid-cols-2 gap-1 mb-2 rounded-md border border-border p-0.5">
                      {(
                        [
                          { key: "added", label: "Added" },
                          { key: "activity", label: "Last activity" },
                        ] as const
                      ).map((opt) => (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => update({ dateField: opt.key })}
                          className={`text-[11px] rounded px-1.5 py-1 transition-colors ${
                            filters.dateField === opt.key
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:bg-accent"
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>

                    {/* Quick ranges */}
                    <div className="flex gap-1 mb-2">
                      {QUICK_RANGES.map((r) => {
                        const active = isQuickActive(r.days);
                        return (
                          <button
                            key={r.label}
                            type="button"
                            onClick={() => setQuickRange(r.days)}
                            className={`flex-1 text-[11px] rounded border px-1 py-1 transition-colors ${
                              active
                                ? "bg-primary text-primary-foreground border-primary"
                                : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                            }`}
                          >
                            {r.label}
                          </button>
                        );
                      })}
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <span className="text-[10px] text-muted-foreground mb-0.5 block">From</span>
                        <Input
                          type="date"
                          value={filters.dateFrom}
                          max={filters.dateTo || undefined}
                          onChange={(e) => update({ dateFrom: e.target.value })}
                          className="h-8 text-xs"
                        />
                      </div>
                      <div>
                        <span className="text-[10px] text-muted-foreground mb-0.5 block">To</span>
                        <Input
                          type="date"
                          value={filters.dateTo}
                          min={filters.dateFrom || undefined}
                          onChange={(e) => update({ dateTo: e.target.value })}
                          className="h-8 text-xs"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <Checkbox
                      id="followup-sidebar"
                      checked={filters.followUpOnly}
                      onCheckedChange={(checked) => update({ followUpOnly: checked === true })}
                    />
                    <label
                      htmlFor="followup-sidebar"
                      className="text-xs font-medium text-muted-foreground cursor-pointer"
                    >
                      Follow-ups only
                    </label>
                  </div>
                </SidebarGroupContent>
              </SidebarGroup>
            </>
          )}

          {showDashboardFilters && (
            <>
              <SidebarSeparator />
              <SidebarGroup>
                <SidebarGroupLabel className="flex items-center gap-1.5">
                  <Filter className="h-3 w-3" />
                  Filters
                </SidebarGroupLabel>
                <SidebarGroupContent className="px-2 space-y-3">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Sector
                    </label>
                    <Select
                      value={dashboardFilters.sector}
                      onValueChange={(v) => updateDash({ sector: v })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="All Sectors" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Sectors</SelectItem>
                        {sectors.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Contact Prime
                    </label>
                    <Select
                      value={dashboardFilters.prime}
                      onValueChange={(v) => updateDash({ prime: v })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="All Primes" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Primes</SelectItem>
                        {primes.map((p) => (
                          <SelectItem key={p} value={p}>
                            {p}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Temperature
                    </label>
                    <Select
                      value={dashboardFilters.temperature}
                      onValueChange={(v) => updateDash({ temperature: v })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="All" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All</SelectItem>
                        <SelectItem value="Hot">Hot</SelectItem>
                        <SelectItem value="Warm">Warm</SelectItem>
                        <SelectItem value="Cold">Cold</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      City
                    </label>
                    <Select
                      value={dashboardFilters.city}
                      onValueChange={(v) => updateDash({ city: v })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="All Cities" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Cities</SelectItem>
                        {allCities.map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Portfolio Company
                    </label>
                    <Select
                      value={dashboardFilters.portfolioCompany}
                      onValueChange={(v) => updateDash({ portfolioCompany: v })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="All Companies" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Companies</SelectItem>
                        {portfolioCompanies.map((co) => (
                          <SelectItem key={co} value={co}>
                            {co}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </SidebarGroupContent>
              </SidebarGroup>
            </>
          )}

          {showTargetingFilters && (
            <>
              <SidebarSeparator />
              <SidebarGroup>
                <SidebarGroupLabel className="flex items-center gap-1.5">
                  <Filter className="h-3 w-3" />
                  Filters
                </SidebarGroupLabel>
                <SidebarGroupContent className="px-2 space-y-3">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      placeholder="Search targets..."
                      value={targetingFilters.search}
                      onChange={(e) => updateTarget({ search: e.target.value })}
                      className="pl-8 h-8 text-xs"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Pipeline Stage
                    </label>
                    <Select
                      value={targetingFilters.stage}
                      onValueChange={(v) => updateTarget({ stage: v })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="All Stages" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Stages</SelectItem>
                        <SelectItem value="Prospecting">1. Prospecting</SelectItem>
                        <SelectItem value="Researching">2. Researching</SelectItem>
                        <SelectItem value="Outreach Sent">3. Outreach Sent</SelectItem>
                        <SelectItem value="Ready to Promote">4. Ready to Promote</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Sector Focus
                    </label>
                    <Select
                      value={targetingFilters.sector}
                      onValueChange={(v) => updateTarget({ sector: v })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="All Sectors" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Sectors</SelectItem>
                        {targetSectors.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      City / Location
                    </label>
                    <Select
                      value={targetingFilters.city}
                      onValueChange={(v) => updateTarget({ city: v })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="All Cities" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Cities</SelectItem>
                        {targetCities.map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Origin Source
                    </label>
                    <Select
                      value={targetingFilters.origin}
                      onValueChange={(v) => updateTarget({ origin: v })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="All Sources" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Sources</SelectItem>
                        {targetOrigins.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Title
                    </label>
                    <Input
                      placeholder="Title contains..."
                      value={targetingFilters.title}
                      onChange={(e) => updateTarget({ title: e.target.value })}
                      className="h-8 text-xs"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Seniority
                    </label>
                    <MultiSelect
                      options={[...SENIORITY_LEVELS]}
                      value={targetingFilters.seniority}
                      onChange={(v) => updateTarget({ seniority: v })}
                      placeholder="All Levels"
                      searchable={false}
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Department
                    </label>
                    <MultiSelect
                      options={[...DEPARTMENTS]}
                      value={targetingFilters.department}
                      onChange={(v) => updateTarget({ department: v })}
                      placeholder="All Departments"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block">
                        Date Added
                      </label>
                      {(targetingFilters.dateFrom || targetingFilters.dateTo) && (
                        <button
                          type="button"
                          onClick={() => updateTarget({ dateFrom: "", dateTo: "" })}
                          className="text-[10px] text-muted-foreground hover:text-foreground"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <span className="text-[10px] text-muted-foreground mb-0.5 block">From</span>
                        <DateTextField
                          value={targetingFilters.dateFrom}
                          onChange={(iso) => updateTarget({ dateFrom: iso })}
                        />
                      </div>
                      <div>
                        <span className="text-[10px] text-muted-foreground mb-0.5 block">To</span>
                        <DateTextField
                          value={targetingFilters.dateTo}
                          onChange={(iso) => updateTarget({ dateTo: iso })}
                        />
                      </div>
                    </div>
                  </div>
                </SidebarGroupContent>
              </SidebarGroup>
            </>
          )}

          {showPortfolioFilters && (
            <>
              <SidebarSeparator />
              <SidebarGroup>
                <SidebarGroupLabel className="flex items-center gap-1.5">
                  <Filter className="h-3 w-3" />
                  Filters
                </SidebarGroupLabel>
                <SidebarGroupContent className="px-2 space-y-3">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      placeholder="Search companies..."
                      value={portfolioFilters.search}
                      onChange={(e) => updatePortfolio({ search: e.target.value })}
                      className="pl-8 h-8 text-xs"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      Domain
                    </label>
                    <Select
                      value={portfolioFilters.domain}
                      onValueChange={(v) => updatePortfolio({ domain: v })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="All Domains" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Domains</SelectItem>
                        {portfolioDomains.map((d) => (
                          <SelectItem key={d} value={d}>
                            {d}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      City
                    </label>
                    <Select
                      value={portfolioFilters.city}
                      onValueChange={(v) => updatePortfolio({ city: v })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="All Cities" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Cities</SelectItem>
                        {portfolioCities.map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                      DTC Priority
                    </label>
                    <Select
                      value={portfolioFilters.dtcPriority}
                      onValueChange={(v) => updatePortfolio({ dtcPriority: v })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="All Priorities" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Priorities</SelectItem>
                        {portfolioDtcPriorities.map((p) => (
                          <SelectItem key={p} value={p}>
                            {p}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </SidebarGroupContent>
              </SidebarGroup>
            </>
          )}

          {showBulkActions && (
            <>
              <SidebarSeparator />
              <SidebarGroup>
                <SidebarGroupLabel className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <Users className="h-3 w-3" />
                    Bulk Actions
                  </span>
                  <button
                    onClick={clearSelection}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </SidebarGroupLabel>
                <SidebarGroupContent className="px-2 space-y-2">
                  <p className="text-[10px] text-muted-foreground">
                    <span className="font-semibold text-foreground">{selectedIds.size}</span>{" "}
                    contact{selectedIds.size !== 1 ? "s" : ""} selected
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full h-8 text-xs justify-start"
                    onClick={handleBulkEmail}
                  >
                    <Mail className="h-3.5 w-3.5 mr-2" />
                    Bulk Email
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full h-8 text-xs justify-start"
                    onClick={() => setBulkEditOpen(true)}
                  >
                    <Pencil className="h-3.5 w-3.5 mr-2" />
                    Bulk Edit
                  </Button>
                </SidebarGroupContent>
              </SidebarGroup>
            </>
          )}

          {showTargetBulkActions && (
            <>
              <SidebarSeparator />
              <SidebarGroup>
                <SidebarGroupLabel className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <Target className="h-3 w-3" />
                    Bulk Actions
                  </span>
                  <button
                    onClick={clearTargetSelection}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </SidebarGroupLabel>
                <SidebarGroupContent className="px-2 space-y-2">
                  <p className="text-[10px] text-muted-foreground">
                    <span className="font-semibold text-foreground">{targetSelectedIds.size}</span>{" "}
                    target{targetSelectedIds.size !== 1 ? "s" : ""} selected
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full h-8 text-xs justify-start"
                    onClick={handleTargetBulkEmail}
                  >
                    <Mail className="h-3.5 w-3.5 mr-2" />
                    Bulk Email
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full h-8 text-xs justify-start"
                    onClick={() => setTargetBulkEditOpen(true)}
                  >
                    <Pencil className="h-3.5 w-3.5 mr-2" />
                    Bulk Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full h-8 text-xs justify-start"
                    onClick={() => void onTargetBulkResearch?.()}
                    disabled={targetResearching || !onTargetBulkResearch}
                  >
                    {targetResearching ? (
                      <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                    ) : (
                      <Telescope className="h-3.5 w-3.5 mr-2" />
                    )}
                    {targetResearching ? "Researching…" : "Update with Apollo"}
                  </Button>
                </SidebarGroupContent>
              </SidebarGroup>
            </>
          )}
        </SidebarContent>
        <SidebarFooter className="border-t border-sidebar-border p-0">
          <ApiHealthWidget collapsed={collapsed} />
        </SidebarFooter>
      </Sidebar>

      {/* Bulk Edit Dialog */}
      <Dialog open={bulkEditOpen} onOpenChange={setBulkEditOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Bulk Edit — {selectedIds.size} Contact{selectedIds.size !== 1 ? "s" : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Action Type
              </label>
              <Select
                value={bulkEditType}
                onValueChange={(v) => setBulkEditType(v as "portco" | "event" | "note" | "profile")}
              >
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="profile">Edit profile field</SelectItem>
                  <SelectItem value="portco">Add Portfolio Company Introduction</SelectItem>
                  <SelectItem value="event">Add Event</SelectItem>
                  <SelectItem value="note">Add Note</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {bulkEditType === "profile" && (
              <>
                <div>
                  <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                    Field
                  </label>
                  <Select
                    value={bulkField}
                    onValueChange={(v) => {
                      setBulkField(v as BulkEditField);
                      setBulkValue("");
                    }}
                  >
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="status">Status (Hot/Warm/Cold)</SelectItem>
                      <SelectItem value="contactType">Contact Type (Dell/Customer/VC)</SelectItem>
                      <SelectItem value="location">Location</SelectItem>
                      <SelectItem value="sector">Sector</SelectItem>
                      <SelectItem value="areasOfInterest">Area of Interest</SelectItem>
                      <SelectItem value="prime">Contact Prime</SelectItem>
                      <SelectItem value="title">Title</SelectItem>
                      <SelectItem value="company">Company</SelectItem>
                      <SelectItem value="source">Source</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                    New value
                  </label>
                  {bulkField === "status" ? (
                    <Select value={bulkValue} onValueChange={setBulkValue}>
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue placeholder="Select status..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Hot">Hot</SelectItem>
                        <SelectItem value="Warm">Warm</SelectItem>
                        <SelectItem value="Cold">Cold</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : bulkField === "contactType" ? (
                    <Select value={bulkValue} onValueChange={setBulkValue}>
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue placeholder="Select type..." />
                      </SelectTrigger>
                      <SelectContent>
                        {CONTACT_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : bulkField === "source" ? (
                    <Select value={bulkValue} onValueChange={setBulkValue}>
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue placeholder="Select source..." />
                      </SelectTrigger>
                      <SelectContent>
                        {RECORD_SOURCES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <>
                      <Input
                        list="bulk-value-options"
                        value={bulkValue}
                        onChange={(e) => setBulkValue(e.target.value)}
                        placeholder={`Set ${BULK_FIELD_LABELS[bulkField].toLowerCase()} for all selected...`}
                        className="h-9 text-sm"
                      />
                      <datalist id="bulk-value-options">
                        {(bulkField === "sector"
                          ? filterOpts.sectors
                          : bulkField === "prime"
                            ? filterOpts.primes
                            : bulkField === "location"
                              ? filterOpts.allCities
                              : bulkField === "areasOfInterest"
                                ? filterOpts.areasOfInterest
                                : []
                        ).map((o) => (
                          <option key={o} value={o} />
                        ))}
                      </datalist>
                    </>
                  )}
                </div>
                {bulkField === "areasOfInterest" && (
                  <p className="text-[10px] text-muted-foreground">
                    Replaces existing areas. Separate multiple with commas.
                  </p>
                )}
                {bulkField === "status" && (
                  <p className="text-[10px] text-muted-foreground">
                    Manually setting status locks these contacts from the automatic scorecard.
                  </p>
                )}
              </>
            )}

            {bulkEditType === "portco" && (
              <div>
                <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                  Portfolio Company
                </label>
                <Select value={bulkPortCo} onValueChange={setBulkPortCo}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder="Select company..." />
                  </SelectTrigger>
                  <SelectContent>
                    {portfolioCompanies.map((co) => (
                      <SelectItem key={co} value={co}>
                        {co}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {bulkEditType === "event" && (
              <>
                <div>
                  <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                    Event Name
                  </label>
                  <EventPicker value={bulkEventName} onChange={setBulkEventName} />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                    Type
                  </label>
                  <Select
                    value={bulkEventType}
                    onValueChange={(v) => setBulkEventType(v as "attended" | "invited")}
                  >
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="attended">Attended</SelectItem>
                      <SelectItem value="invited">Invited</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}

            {bulkEditType === "note" && (
              <div>
                <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                  Note
                </label>
                <Textarea
                  placeholder="Add a note for all selected contacts..."
                  value={bulkNote}
                  onChange={(e) => setBulkNote(e.target.value)}
                  className="text-sm min-h-[100px]"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkEditOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleBulkEditSubmit}
              disabled={
                bulkBusy ||
                (bulkEditType === "profile" && !bulkValue.trim()) ||
                (bulkEditType === "portco" && !bulkPortCo) ||
                (bulkEditType === "event" && !bulkEventName.trim()) ||
                (bulkEditType === "note" && !bulkNote.trim())
              }
            >
              {bulkBusy
                ? "Applying…"
                : `Apply to ${selectedIds.size} Contact${selectedIds.size !== 1 ? "s" : ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Target Bulk Edit Dialog */}
      <Dialog open={targetBulkEditOpen} onOpenChange={setTargetBulkEditOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Bulk Edit — {targetSelectedIds.size} Target{targetSelectedIds.size !== 1 ? "s" : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">
                Note / Activity
              </label>
              <Textarea
                placeholder="Add a note or activity for all selected targets..."
                value={targetBulkNote}
                onChange={(e) => setTargetBulkNote(e.target.value)}
                className="text-sm min-h-[100px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTargetBulkEditOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleTargetBulkEditSubmit} disabled={!targetBulkNote.trim()}>
              Apply to {targetSelectedIds.size} Target{targetSelectedIds.size !== 1 ? "s" : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
