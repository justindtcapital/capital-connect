import { useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { fetchAsanaEvents } from "@/utils/asana.functions";
import {
  fetchContacts,
  addEvent as addEventToSheet,
  fetchAppEvents,
  addAppEvent,
  fetchEmailActivity,
  fetchEventSynopses,
  saveEventSynopsis,
} from "@/utils/sheets.functions";
import { eventSynopsisDraft } from "@/utils/insights.functions";
import type { AsanaEvent, Contact, EmailActivityRecord } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Calendar as CalendarIcon,
  List,
  Users,
  MapPin,
  Building2,
  ChevronLeft,
  ChevronRight,
  Plus,
  Check,
  Video,
  MapPinned,
  Upload,
  BarChart3,
  Sparkles,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { colorForLead, colorForSector } from "@/lib/event-colors";
import { useChartDrill, matchesFilters, parseCfParam, type Dimension } from "@/lib/use-chart-drill";
import { DrillSheet, DrillChips } from "@/components/charts/DrillSheet";
import { ChartBuilder } from "@/components/charts/ChartBuilder";
import type { Metric } from "@/lib/chart-spec";
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  ResponsiveContainer,
} from "recharts";

export const Route = createFileRoute("/events")({
  head: () => ({
    meta: [
      { title: "Events — VenturePulse" },
      { name: "description", content: "Track Asana-sourced events and Network attendance" },
    ],
  }),
  validateSearch: (search: Record<string, unknown>) => ({ cf: parseCfParam(search.cf) }),
  loader: async () => {
    const [asanaEvents, appEvents, contacts, emailActivity, synopses] = await Promise.all([
      fetchAsanaEvents().catch((): AsanaEvent[] => []),
      fetchAppEvents().catch((): AsanaEvent[] => []),
      fetchContacts().catch((): Contact[] => []),
      fetchEmailActivity().catch((): EmailActivityRecord[] => []),
      fetchEventSynopses().catch((): Record<string, string> => ({})),
    ]);
    // App-added events first so newest local additions are easy to spot.
    const events = [...(appEvents as AsanaEvent[]), ...(asanaEvents as AsanaEvent[])];
    return { events, contacts: contacts as Contact[], emailActivity, synopses };
  },
  component: EventsPage,
});

// App-added events get an "app-" gid prefix so we can mark them in the UI.
function isAppEvent(e: AsanaEvent): boolean {
  return e.gid.startsWith("app-");
}

const EVENT_TYPES = ["conference", "dinner", "webinar", "meeting"] as const;
const EVENT_FORMATS = ["in-person", "virtual", "hybrid"] as const;
const EVENT_ROLES = ["hosted", "sponsored"] as const;

function findAttendees(contacts: Contact[], eventName: string) {
  const target = eventName.trim().toLowerCase();
  const attended: Contact[] = [];
  const invited: Contact[] = [];
  for (const c of contacts) {
    if ((c.eventsAttended || []).some((e) => e.trim().toLowerCase() === target)) attended.push(c);
    else if ((c.eventsInvited || []).some((e) => e.trim().toLowerCase() === target))
      invited.push(c);
  }
  return { attended, invited };
}

interface Filters {
  lead: string; // "" = all
  format: string;
  sector: string;
}

function EventsPage() {
  const { events, contacts, emailActivity, synopses } = Route.useLoaderData() as {
    events: AsanaEvent[];
    contacts: Contact[];
    emailActivity: EmailActivityRecord[];
    synopses: Record<string, string>;
  };
  const router = useRouter();
  const [view, setView] = useState<"list" | "calendar" | "analytics">("list");
  const [selected, setSelected] = useState<AsanaEvent | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [filters, setFilters] = useState<Filters>({ lead: "", format: "", sector: "" });
  const appEventCount = useMemo(() => events.filter(isAppEvent).length, [events]);

  const leads = useMemo(
    () => Array.from(new Set(events.map((e) => e.lead).filter((v): v is string => !!v))).sort(),
    [events],
  );
  const formats = useMemo(
    () =>
      Array.from(
        new Set(
          events.map((e) => e.format).filter((v): v is NonNullable<AsanaEvent["format"]> => !!v),
        ),
      ).sort(),
    [events],
  );
  const sectors = useMemo(
    () => Array.from(new Set(events.flatMap((e) => e.sectors || []).filter(Boolean))).sort(),
    [events],
  );

  const filtered = useMemo(
    () =>
      events.filter(
        (e) =>
          (!filters.lead || e.lead === filters.lead) &&
          (!filters.format || e.format === filters.format) &&
          (!filters.sector || (e.sectors || []).includes(filters.sector)),
      ),
    [events, filters],
  );

  const today = new Date().toISOString().split("T")[0];
  const upcoming = useMemo(
    () => filtered.filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date)),
    [filtered, today],
  );
  const past = useMemo(
    () => filtered.filter((e) => e.date < today).sort((a, b) => b.date.localeCompare(a.date)),
    [filtered, today],
  );

  return (
    <div className="p-6 max-w-[1500px] mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-bold text-foreground">Events</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Asana + app-added · {filtered.length} of {events.length} event
            {events.length !== 1 ? "s" : ""}
            {appEventCount > 0 && <span> · {appEventCount} added here</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
            <Button
              variant={view === "list" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-xs"
              onClick={() => setView("list")}
            >
              <List className="h-3.5 w-3.5 mr-1.5" /> List
            </Button>
            <Button
              variant={view === "calendar" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-xs"
              onClick={() => setView("calendar")}
            >
              <CalendarIcon className="h-3.5 w-3.5 mr-1.5" /> Calendar
            </Button>
            <Button
              variant={view === "analytics" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-xs"
              onClick={() => setView("analytics")}
            >
              <BarChart3 className="h-3.5 w-3.5 mr-1.5" /> Analytics
            </Button>
          </div>
          <Button size="sm" className="h-8 text-xs" onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Add event
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-[200px_1fr] gap-6">
        <FiltersPanel
          filters={filters}
          setFilters={setFilters}
          leads={leads}
          formats={formats}
          sectors={sectors}
        />
        <div className="min-w-0">
          {events.length === 0 ? (
            <div className="text-center py-16 border border-dashed border-border rounded-lg">
              <CalendarIcon className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">
                No events found in the Asana Events project.
              </p>
              <Button size="sm" className="h-8 text-xs mt-3" onClick={() => setAddOpen(true)}>
                <Plus className="h-3.5 w-3.5 mr-1.5" /> Add an event
              </Button>
            </div>
          ) : view === "list" ? (
            <ListView
              upcoming={upcoming}
              past={past}
              all={filtered}
              contacts={contacts}
              onSelect={setSelected}
            />
          ) : view === "calendar" ? (
            <CalendarView
              events={filtered}
              leads={leads}
              sectors={sectors}
              onSelect={setSelected}
            />
          ) : (
            <AnalyticsView events={filtered} contacts={contacts} onSelectEvent={setSelected} />
          )}
        </div>
      </div>

      <EventDetailSheet
        event={selected}
        contacts={contacts}
        emails={
          selected
            ? emailActivity.filter(
                (e) => e.linkedEvent.trim().toLowerCase() === selected.name.trim().toLowerCase(),
              )
            : []
        }
        onClose={() => setSelected(null)}
        onChanged={() => router.invalidate()}
        synopsis={selected ? synopses[selected.name.trim().toLowerCase()] || "" : ""}
      />

      <AddEventDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        leadOptions={leads}
        portcoOptions={Array.from(new Set(events.flatMap((e) => e.portcos))).sort()}
        sectorOptions={sectors}
        onAdded={() => router.invalidate()}
      />
    </div>
  );
}

// ─── Filters sidebar ────────────────────────────────────────
function FiltersPanel({
  filters,
  setFilters,
  leads,
  formats,
  sectors,
}: {
  filters: Filters;
  setFilters: (f: Filters) => void;
  leads: string[];
  formats: string[];
  sectors: string[];
}) {
  const reset = () => setFilters({ lead: "", format: "", sector: "" });
  const active = !!(filters.lead || filters.format || filters.sector);
  return (
    <aside className="space-y-5 text-xs">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">
          Filters
        </div>
        {active && (
          <button onClick={reset} className="text-[10px] text-primary hover:underline">
            Clear
          </button>
        )}
      </div>

      <FilterGroup
        label="Event Lead"
        options={leads}
        value={filters.lead}
        onChange={(v) => setFilters({ ...filters, lead: v })}
        renderSwatch={(v) => <Swatch color={colorForLead(v).solid} />}
      />

      <FilterGroup
        label="Format"
        options={formats}
        value={filters.format}
        onChange={(v) => setFilters({ ...filters, format: v })}
        renderSwatch={(v) =>
          v === "virtual" ? (
            <Video className="h-3 w-3 text-muted-foreground" />
          ) : (
            <MapPinned className="h-3 w-3 text-muted-foreground" />
          )
        }
      />

      <FilterGroup
        label="Sector"
        options={sectors}
        value={filters.sector}
        onChange={(v) => setFilters({ ...filters, sector: v })}
        renderSwatch={(v) => {
          const c = colorForSector(v);
          return c ? <Swatch color={c.solid} /> : null;
        }}
      />
    </aside>
  );
}

function FilterGroup({
  label,
  options,
  value,
  onChange,
  renderSwatch,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
  renderSwatch?: (v: string) => React.ReactNode;
}) {
  if (options.length === 0) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1.5">
        {label}
      </div>
      <div className="space-y-0.5">
        <button
          onClick={() => onChange("")}
          className={`flex items-center w-full text-left px-2 py-1 rounded ${
            !value ? "bg-accent font-medium" : "hover:bg-accent/50"
          }`}
        >
          All
        </button>
        {options.map((o) => (
          <button
            key={o}
            onClick={() => onChange(o)}
            className={`flex items-center gap-2 w-full text-left px-2 py-1 rounded capitalize ${
              value === o ? "bg-accent font-medium" : "hover:bg-accent/50"
            }`}
          >
            {renderSwatch && renderSwatch(o)}
            <span className="truncate">{o}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
      style={{ backgroundColor: color }}
    />
  );
}

// ─── List view ──────────────────────────────────────────────
function ListView({
  upcoming,
  past,
  all,
  contacts,
  onSelect,
}: {
  upcoming: AsanaEvent[];
  past: AsanaEvent[];
  all: AsanaEvent[];
  contacts: Contact[];
  onSelect: (e: AsanaEvent) => void;
}) {
  return (
    <Tabs defaultValue="upcoming">
      <TabsList>
        <TabsTrigger value="upcoming" className="text-xs">
          Upcoming ({upcoming.length})
        </TabsTrigger>
        <TabsTrigger value="past" className="text-xs">
          Past ({past.length})
        </TabsTrigger>
        <TabsTrigger value="all" className="text-xs">
          All ({all.length})
        </TabsTrigger>
      </TabsList>
      <TabsContent value="upcoming">
        <EventTable events={upcoming} contacts={contacts} onSelect={onSelect} />
      </TabsContent>
      <TabsContent value="past">
        <EventTable events={past} contacts={contacts} onSelect={onSelect} />
      </TabsContent>
      <TabsContent value="all">
        <EventTable events={all} contacts={contacts} onSelect={onSelect} />
      </TabsContent>
    </Tabs>
  );
}

function EventTable({
  events,
  contacts,
  onSelect,
}: {
  events: AsanaEvent[];
  contacts: Contact[];
  onSelect: (e: AsanaEvent) => void;
}) {
  if (events.length === 0) {
    return <p className="text-xs text-muted-foreground py-8 text-center">No events.</p>;
  }
  return (
    <div className="border border-border rounded-md mt-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-[11px]">Date</TableHead>
            <TableHead className="text-[11px]">Name</TableHead>
            <TableHead className="text-[11px]">Lead</TableHead>
            <TableHead className="text-[11px]">Format</TableHead>
            <TableHead className="text-[11px]">Sector</TableHead>
            <TableHead className="text-[11px]">Role</TableHead>
            <TableHead className="text-[11px]">Portfolio Companies</TableHead>
            <TableHead className="text-[11px] text-right">Network attendees</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((e) => {
            const { attended, invited } = findAttendees(contacts, e.name);
            const leadC = colorForLead(e.lead);
            return (
              <TableRow key={e.gid} className="cursor-pointer" onClick={() => onSelect(e)}>
                <TableCell className="text-xs whitespace-nowrap">{e.date}</TableCell>
                <TableCell className="text-xs font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    {e.name}
                    {isAppEvent(e) && (
                      <Badge
                        variant="outline"
                        className="text-[9px] px-1 py-0 border-primary/40 text-primary"
                      >
                        App
                      </Badge>
                    )}
                  </span>
                </TableCell>
                <TableCell className="text-xs">
                  {e.lead ? (
                    <span
                      className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium"
                      style={{ backgroundColor: leadC.bg, color: leadC.fg }}
                    >
                      {e.lead}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-xs capitalize text-muted-foreground">
                  {e.format ? (
                    <span className="inline-flex items-center gap-1">
                      {e.format === "virtual" ? (
                        <Video className="h-3 w-3" />
                      ) : (
                        <MapPinned className="h-3 w-3" />
                      )}
                      {e.format}
                    </span>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  {e.sectors && e.sectors.length > 0 ? (
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      {e.sectors.map((s) => {
                        const c = colorForSector(s);
                        return (
                          <span key={s} className="inline-flex items-center gap-1">
                            {c && <Swatch color={c.solid} />}
                            <span className="capitalize">{s}</span>
                          </span>
                        );
                      })}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  {e.role ? (
                    <Badge variant="outline" className="text-[10px] capitalize">
                      {e.role}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground max-w-[180px] truncate">
                  {e.portcos.length > 0 ? e.portcos.join(", ") : "—"}
                </TableCell>
                <TableCell className="text-xs text-right">
                  {e.attendeeCount != null ? (
                    <span className="font-semibold">{e.attendeeCount.toLocaleString()}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                  {attended.length > 0 && (
                    <span className="text-muted-foreground"> · {attended.length} in network</span>
                  )}
                  {invited.length > 0 && (
                    <span className="text-muted-foreground"> · {invited.length} inv</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// ─── Calendar view ──────────────────────────────────────────
function CalendarView({
  events,
  leads,
  sectors,
  onSelect,
}: {
  events: AsanaEvent[];
  leads: string[];
  sectors: string[];
  onSelect: (e: AsanaEvent) => void;
}) {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const monthLabel = new Date(cursor.year, cursor.month, 1).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });
  const firstDay = new Date(cursor.year, cursor.month, 1);
  const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate();
  const startWeekday = firstDay.getDay();

  const eventsByDay = useMemo(() => {
    const map = new Map<string, AsanaEvent[]>();
    for (const e of events) {
      const list = map.get(e.date) || [];
      list.push(e);
      map.set(e.date, list);
    }
    return map;
  }, [events]);

  const cells: { date: string | null; key: string }[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push({ date: null, key: `pad-${i}` });
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${cursor.year}-${String(cursor.month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    cells.push({ date: ds, key: ds });
  }

  const today = new Date().toISOString().split("T")[0];
  const prev = () =>
    setCursor((c) =>
      c.month === 0 ? { year: c.year - 1, month: 11 } : { year: c.year, month: c.month - 1 },
    );
  const next = () =>
    setCursor((c) =>
      c.month === 11 ? { year: c.year + 1, month: 0 } : { year: c.year, month: c.month + 1 },
    );

  return (
    <div className="border border-border rounded-md p-3">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold">{monthLabel}</div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={prev}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              const d = new Date();
              setCursor({ year: d.getFullYear(), month: d.getMonth() });
            }}
          >
            Today
          </Button>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={next}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div
            key={d}
            className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground text-center pb-1"
          >
            {d}
          </div>
        ))}
        {cells.map((cell) => {
          if (!cell.date) return <div key={cell.key} className="min-h-[88px]" />;
          const dayNum = Number(cell.date.split("-")[2]);
          const dayEvents = eventsByDay.get(cell.date) || [];
          const isToday = cell.date === today;
          return (
            <div
              key={cell.key}
              className={`min-h-[88px] border border-border rounded p-1 ${
                isToday ? "bg-primary/5 border-primary/30" : "bg-background"
              }`}
            >
              <div
                className={`text-[10px] font-medium mb-1 ${
                  isToday ? "text-primary" : "text-muted-foreground"
                }`}
              >
                {dayNum}
              </div>
              <div className="space-y-0.5">
                {dayEvents.slice(0, 3).map((e, idx) => {
                  const lead = colorForLead(e.lead);
                  // First sector with a known color drives the indicator dot.
                  const dot = (e.sectors || [])
                    .map((s) => colorForSector(s))
                    .find((c): c is NonNullable<typeof c> => !!c);
                  const sectorLabel = (e.sectors || []).join(", ");
                  return (
                    <button
                      key={`${e.gid}-${idx}`}
                      onClick={() => onSelect(e)}
                      className="relative block w-full text-left text-[10px] truncate pl-3 pr-1 py-0.5 rounded hover:opacity-80"
                      style={{ backgroundColor: lead.bg, color: lead.fg }}
                      title={`${e.name}${e.lead ? ` · ${e.lead}` : ""}${sectorLabel ? ` · ${sectorLabel}` : ""}`}
                    >
                      {dot && (
                        <span
                          className="absolute left-1 top-1/2 -translate-y-1/2 h-1.5 w-1.5 rounded-full"
                          style={{ backgroundColor: dot.solid }}
                        />
                      )}
                      {e.name}
                    </button>
                  );
                })}
                {dayEvents.length > 3 && (
                  <div className="text-[9px] text-muted-foreground px-1">
                    +{dayEvents.length - 3} more
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <Legend leads={leads} sectors={sectors} />
    </div>
  );
}

function Legend({ leads, sectors }: { leads: string[]; sectors: string[] }) {
  // Only show sector swatches we actually colorize (AI/Data/Security).
  const coloredSectors = sectors.filter((s) => !!colorForSector(s));
  if (leads.length === 0 && coloredSectors.length === 0) return null;
  return (
    <div className="mt-4 pt-3 border-t border-border grid grid-cols-2 gap-4 text-[10px]">
      {leads.length > 0 && (
        <div>
          <div className="uppercase tracking-wider font-semibold text-muted-foreground mb-1.5">
            Lead (background)
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {leads.map((l) => {
              const c = colorForLead(l);
              return (
                <span key={l} className="inline-flex items-center gap-1.5">
                  <span
                    className="h-2.5 w-4 rounded-sm"
                    style={{ backgroundColor: c.bg, border: `1px solid ${c.border}` }}
                  />
                  <span className="capitalize">{l}</span>
                </span>
              );
            })}
          </div>
        </div>
      )}
      {coloredSectors.length > 0 && (
        <div>
          <div className="uppercase tracking-wider font-semibold text-muted-foreground mb-1.5">
            Sector (dot)
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {coloredSectors.map((s) => {
              const c = colorForSector(s);
              if (!c) return null;
              return (
                <span key={s} className="inline-flex items-center gap-1.5">
                  <Swatch color={c.solid} />
                  <span className="capitalize">{s}</span>
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Analytics view (#4) ────────────────────────────────────
const CHART_COLORS = [
  "oklch(0.546 0.162 241)",
  "oklch(0.637 0.135 163)",
  "oklch(0.735 0.145 85)",
  "oklch(0.598 0.2 295)",
  "oklch(0.645 0.246 16)",
  "oklch(0.6 0.18 200)",
];

function quarterLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(date || "");
  if (!m) return "";
  return `${m[1]} Q${Math.ceil(parseInt(m[2], 10) / 3)}`;
}

// Registry of reportable event dimensions: the single source of truth for what's
// filterable. Each accessor returns the value(s) an event has for the dimension;
// cross-filtering (matchesFilters) and chart clicks both key off the `dim`. Add a
// new filterable field here — nothing else needs to change.
const EVENT_DIMS: Dimension<AsanaEvent>[] = [
  { dim: "format", label: "Format", get: (e) => e.format || "unspecified" },
  { dim: "role", label: "Role", get: (e) => e.role || "unspecified" },
  { dim: "type", label: "Type", get: (e) => e.type || "unspecified" },
  { dim: "quarter", label: "Quarter", get: (e) => quarterLabel(e.date) },
  { dim: "portco", label: "PortCo", get: (e) => e.portcos },
];

function DrillEventRow({ e, onClick }: { e: AsanaEvent; onClick: () => void }) {
  const meta = [e.type, e.format, e.role].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left rounded-md border border-border bg-card px-2.5 py-2 hover:bg-accent transition-colors"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium truncate">{e.name}</span>
        <span className="text-[11px] text-muted-foreground shrink-0">{e.date}</span>
      </div>
      <div className="text-[11px] text-muted-foreground truncate">
        {meta}
        {e.portcos.length ? `${meta ? " · " : ""}${e.portcos.join(", ")}` : ""}
      </div>
    </button>
  );
}

function AnalyticsView({
  events,
  contacts,
  onSelectEvent,
}: {
  events: AsanaEvent[];
  contacts: Contact[];
  onSelectEvent: (e: AsanaEvent) => void;
}) {
  const { crossFilters, focus, clear, clearAll, drill, drillOpen, setDrillOpen } =
    useChartDrill(EVENT_DIMS);

  // Click-driven cross-filter narrows EVERYTHING below (KPIs + every chart).
  const fEvents = useMemo(
    () => events.filter((e) => matchesFilters(e, crossFilters, EVENT_DIMS)),
    [events, crossFilters],
  );

  // Builder measures. Network attendees needs the contact roster, so precompute
  // a gid→count map once and have the accessor read from it.
  const eventMetrics = useMemo<Metric<AsanaEvent>[]>(() => {
    const netMap = new Map<string, number>();
    for (const e of events) netMap.set(e.gid, findAttendees(contacts, e.name).attended.length);
    return [
      { key: "headcount", label: "Total headcount", get: (e) => e.attendeeCount || 0 },
      { key: "network", label: "Network attendees", get: (e) => netMap.get(e.gid) || 0 },
    ];
  }, [events, contacts]);

  const stats = useMemo(() => {
    const countBy = (keyFn: (e: AsanaEvent) => string) => {
      const m = new Map<string, number>();
      for (const e of fEvents) {
        const k = keyFn(e) || "unspecified";
        m.set(k, (m.get(k) || 0) + 1);
      }
      return [...m.entries()]
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value);
    };

    const formatData = countBy((e) => e.format || "");
    const roleData = countBy((e) => e.role || "");
    const typeData = countBy((e) => e.type || "");

    const portcoMap = new Map<string, number>();
    for (const e of fEvents)
      for (const p of e.portcos) portcoMap.set(p, (portcoMap.get(p) || 0) + 1);
    const portcoData = [...portcoMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    const qMap = new Map<string, number>();
    const attQMap = new Map<string, number>();
    let totalAtt = 0;
    let withAtt = 0;
    let headcountSum = 0;
    let headcountEvents = 0;
    const headcountFormatMap = new Map<string, number>();
    for (const e of fEvents) {
      const q = quarterLabel(e.date);
      if (q) qMap.set(q, (qMap.get(q) || 0) + 1);
      const n = findAttendees(contacts, e.name).attended.length;
      totalAtt += n;
      if (n > 0) withAtt++;
      if (q) attQMap.set(q, (attQMap.get(q) || 0) + n);
      if (e.attendeeCount != null) {
        headcountSum += e.attendeeCount;
        headcountEvents++;
        const fk = e.format || "unspecified";
        headcountFormatMap.set(fk, (headcountFormatMap.get(fk) || 0) + e.attendeeCount);
      }
    }
    const quarterData = [...qMap.entries()].sort().map(([quarter, count]) => ({ quarter, count }));
    const attendeesQuarterData = [...attQMap.entries()]
      .sort()
      .map(([quarter, count]) => ({ quarter, count }));
    const headcountFormatData = [...headcountFormatMap.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
    const avgAtt = headcountEvents ? headcountSum / headcountEvents : 0;

    return {
      formatData,
      roleData,
      typeData,
      portcoData,
      quarterData,
      attendeesQuarterData,
      headcountFormatData,
      totalAtt,
      avgAtt,
      withAtt,
      headcountEvents,
      distinctPortcos: portcoMap.size,
    };
  }, [fEvents, contacts]);

  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-10 text-center">
        No events to analyze in the current filter.
      </p>
    );
  }

  const Kpi = ({ label, value }: { label: string; value: string | number }) => (
    <div className="rounded-lg border border-border p-3">
      <div className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">
        {label}
      </div>
      <div className="text-xl font-bold text-foreground mt-0.5">{value}</div>
    </div>
  );

  const ChartCard = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="rounded-lg border border-border p-3">
      <div className="text-xs font-semibold mb-2">{title}</div>
      {children}
    </div>
  );

  return (
    <div className="space-y-4">
      <DrillChips filters={crossFilters} onClear={clear} onClearAll={clearAll} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Events" value={fEvents.length} />
        <Kpi
          label="Avg headcount / event"
          value={stats.headcountEvents ? stats.avgAtt.toFixed(0) : "—"}
        />
        <Kpi label="Total network attendees" value={stats.totalAtt} />
        <Kpi label="Portfolio companies" value={stats.distinctPortcos} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Format — in-person vs virtual">
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={stats.formatData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={70}
                label={(d: { name: string }) => d.name}
                className="cursor-pointer"
                onClick={(d: { name?: string; value?: number }) => focus("format", d?.name)}
              >
                {stats.formatData.map((_, i) => (
                  <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Pie>
              <RTooltip contentStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Role — DTC-led vs partnered">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart
              data={stats.roleData}
              onClick={(s: { activeLabel?: string | number }) => focus("role", s?.activeLabel)}
              className="cursor-pointer"
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <RTooltip
                contentStyle={{ fontSize: 12 }}
                cursor={{ fill: "var(--color-accent)", opacity: 0.4 }}
              />
              <Bar dataKey="value" fill={CHART_COLORS[1]} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Event type">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart
              data={stats.typeData}
              onClick={(s: { activeLabel?: string | number }) => focus("type", s?.activeLabel)}
              className="cursor-pointer"
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <RTooltip
                contentStyle={{ fontSize: 12 }}
                cursor={{ fill: "var(--color-accent)", opacity: 0.4 }}
              />
              <Bar dataKey="value" fill={CHART_COLORS[3]} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Events by quarter (EOY review)">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart
              data={stats.quarterData}
              onClick={(s: { activeLabel?: string | number }) => focus("quarter", s?.activeLabel)}
              className="cursor-pointer"
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="quarter" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <RTooltip
                contentStyle={{ fontSize: 12 }}
                cursor={{ fill: "var(--color-accent)", opacity: 0.4 }}
              />
              <Bar dataKey="count" fill={CHART_COLORS[0]} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Network attendees by quarter">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart
              data={stats.attendeesQuarterData}
              onClick={(s: { activeLabel?: string | number }) => focus("quarter", s?.activeLabel)}
              className="cursor-pointer"
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="quarter" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <RTooltip
                contentStyle={{ fontSize: 12 }}
                cursor={{ fill: "var(--color-accent)", opacity: 0.4 }}
              />
              <Bar dataKey="count" name="Attendees" fill={CHART_COLORS[4]} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {stats.headcountFormatData.length > 0 && (
          <ChartCard title="Total headcount by format (Asana)">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart
                data={stats.headcountFormatData}
                onClick={(s: { activeLabel?: string | number }) => focus("format", s?.activeLabel)}
                className="cursor-pointer"
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <RTooltip
                  contentStyle={{ fontSize: 12 }}
                  cursor={{ fill: "var(--color-accent)", opacity: 0.4 }}
                />
                <Bar
                  dataKey="value"
                  name="Headcount"
                  fill={CHART_COLORS[5]}
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {stats.portcoData.length > 0 && (
          <ChartCard title="Events per portfolio company (top 10)">
            <ResponsiveContainer width="100%" height={Math.max(200, stats.portcoData.length * 28)}>
              <BarChart
                data={stats.portcoData}
                layout="vertical"
                onClick={(s: { activeLabel?: string | number }) => focus("portco", s?.activeLabel)}
                className="cursor-pointer"
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                <YAxis dataKey="name" type="category" width={120} tick={{ fontSize: 10 }} />
                <RTooltip
                  contentStyle={{ fontSize: 12 }}
                  cursor={{ fill: "var(--color-accent)", opacity: 0.4 }}
                />
                <Bar dataKey="count" fill={CHART_COLORS[2]} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}
      </div>

      <ChartBuilder
        storageKey="venturepulse:events-charts"
        dims={EVENT_DIMS}
        metrics={eventMetrics}
        items={fEvents}
        focus={focus}
      />

      <DrillSheet open={drillOpen} onOpenChange={setDrillOpen} drill={drill} count={fEvents.length}>
        {fEvents.map((e) => (
          <DrillEventRow
            key={e.gid}
            e={e}
            onClick={() => {
              setDrillOpen(false);
              onSelectEvent(e);
            }}
          />
        ))}
      </DrillSheet>
    </div>
  );
}

// ─── Detail side sheet ──────────────────────────────────────
function EventDetailSheet({
  event,
  contacts,
  emails = [],
  onClose,
  onChanged,
  synopsis = "",
}: {
  event: AsanaEvent | null;
  contacts: Contact[];
  emails?: EmailActivityRecord[];
  onClose: () => void;
  onChanged?: () => void;
  synopsis?: string;
}) {
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkType, setBulkType] = useState<"attended" | "invited">("attended");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [synopsisText, setSynopsisText] = useState(synopsis);
  const [synopsisBusy, setSynopsisBusy] = useState(false);
  const [synopsisGen, setSynopsisGen] = useState(false);

  // Re-seed the editor when switching events (or when loader data refreshes).
  const synKey = (event?.name || "") + "::" + synopsis;
  const [synSeed, setSynSeed] = useState(synKey);
  if (synSeed !== synKey) {
    setSynSeed(synKey);
    setSynopsisText(synopsis);
  }

  if (!event) return null;
  const { attended, invited } = findAttendees(contacts, event.name);

  const saveSynopsis = async () => {
    setSynopsisBusy(true);
    try {
      await saveEventSynopsis({ data: { eventName: event.name, synopsis: synopsisText.trim() } });
      toast.success("Synopsis saved.");
      onChanged?.();
    } catch (e) {
      console.error("saveEventSynopsis failed", e);
      toast.error("Couldn't save synopsis — see console.");
    } finally {
      setSynopsisBusy(false);
    }
  };

  const generateSynopsis = async () => {
    setSynopsisGen(true);
    try {
      const res = await eventSynopsisDraft({
        data: {
          eventName: event.name,
          date: event.date,
          attendees: attended.map((c) => ({ name: c.name, title: c.title, company: c.company })),
        },
      });
      if (res.ok && res.summary) {
        setSynopsisText(res.summary);
        toast.success("Draft synopsis generated — review and save.");
      } else {
        toast.error(res.error || "Couldn't generate a synopsis.");
      }
    } catch (e) {
      console.error("eventSynopsisDraft failed", e);
      toast.error("Synopsis generation failed — see console.");
    } finally {
      setSynopsisGen(false);
    }
  };
  const leadC = colorForLead(event.lead);

  return (
    <Sheet
      open={!!event}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full sm:max-w-xl overflow-hidden flex flex-col">
        <SheetHeader className="pb-4 border-b border-border shrink-0">
          <SheetTitle className="text-base">{event.name}</SheetTitle>
          {/* Use a div (not the default <p> SheetDescription renders) so we can
              nest Badge components without a <p>-inside-<div> hydration error. */}
          <SheetDescription asChild>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <CalendarIcon className="h-3 w-3" />
                {event.date}
              </span>
              <Badge variant="outline" className="text-[10px] capitalize">
                {event.status}
              </Badge>
              {event.attendeeCount != null && (
                <Badge variant="outline" className="text-[10px] font-semibold">
                  {event.attendeeCount.toLocaleString()} attendees
                </Badge>
              )}
              {event.role && (
                <Badge variant="outline" className="text-[10px] capitalize">
                  {event.role}
                </Badge>
              )}
              <Badge variant="outline" className="text-[10px] capitalize">
                {event.type}
              </Badge>
              {event.format && (
                <span className="inline-flex items-center gap-1 text-[10px] capitalize">
                  {event.format === "virtual" ? (
                    <Video className="h-3 w-3" />
                  ) : (
                    <MapPinned className="h-3 w-3" />
                  )}
                  {event.format}
                </span>
              )}
              {event.lead && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
                  style={{ backgroundColor: leadC.bg, color: leadC.fg }}
                >
                  Lead: {event.lead}
                </span>
              )}
              {event.sectors &&
                event.sectors.length > 0 &&
                event.sectors.map((s) => {
                  const c = colorForSector(s);
                  return (
                    <span key={s} className="inline-flex items-center gap-1 text-[10px] capitalize">
                      {c && <Swatch color={c.solid} />}
                      {s}
                    </span>
                  );
                })}
            </div>
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1 -mx-6 px-6">
          <div className="py-5 space-y-6">
            {/* #3 — Synopsis (manual + on-demand LLM draft from the attendee roster) */}
            <section>
              <div className="flex items-center justify-between mb-2 gap-2">
                <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">
                  Synopsis
                </h3>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[11px]"
                    onClick={generateSynopsis}
                    disabled={synopsisGen || attended.length === 0}
                    title={
                      attended.length === 0
                        ? "Tag attendees first"
                        : "Draft from the attendee roster"
                    }
                  >
                    <Sparkles className="h-3 w-3 mr-1" />
                    {synopsisGen ? "Drafting…" : "Generate"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    onClick={saveSynopsis}
                    disabled={synopsisBusy}
                  >
                    {synopsisBusy ? "Saving…" : "Save"}
                  </Button>
                </div>
              </div>
              <textarea
                value={synopsisText}
                onChange={(e) => setSynopsisText(e.target.value)}
                rows={3}
                placeholder="Short synopsis of this event and who attended… or click Generate to draft from the roster."
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
              />
            </section>

            {event.portcos.length > 0 && (
              <section>
                <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground mb-2">
                  Portfolio Companies
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {event.portcos.map((p) => (
                    <Badge key={p} variant="secondary" className="text-[11px]">
                      <Building2 className="h-3 w-3 mr-1" />
                      {p}
                    </Badge>
                  ))}
                </div>
              </section>
            )}

            <section>
              <div className="flex items-center justify-between mb-2 gap-2">
                <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">
                  Network attendees ({attended.length}
                  {event.attendeeCount != null ? ` of ${event.attendeeCount.toLocaleString()}` : ""}
                  )
                </h3>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    onClick={() => {
                      setBulkType("attended");
                      setBulkOpen(true);
                    }}
                  >
                    <Plus className="h-3 w-3 mr-1" /> Attended
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    onClick={() => setUploadOpen(true)}
                  >
                    <Upload className="h-3 w-3 mr-1" /> Upload list
                  </Button>
                </div>
              </div>
              {attended.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No Network contacts logged as attendees yet.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {attended.map((c) => (
                    <AttendeeRow key={c.id} contact={c} />
                  ))}
                </div>
              )}
            </section>

            <section>
              <div className="flex items-center justify-between mb-2 gap-2">
                <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">
                  Invited ({invited.length})
                </h3>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px]"
                  onClick={() => {
                    setBulkType("invited");
                    setBulkOpen(true);
                  }}
                >
                  <Plus className="h-3 w-3 mr-1" /> Invite
                </Button>
              </div>
              {invited.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No one tagged as invited yet. Invite contacts pre-event; uploading the attended
                  list later moves them to Attended automatically.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {invited.map((c) => (
                    <AttendeeRow key={c.id} contact={c} />
                  ))}
                </div>
              )}
            </section>

            <section>
              <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground mb-2">
                Outreach ({emails.length})
              </h3>
              {emails.length > 0 ? (
                <div className="space-y-1.5">
                  {emails.map((e, i) => (
                    <div
                      key={`${e.contactEmail}-${i}`}
                      className="border border-border rounded px-2 py-1.5"
                    >
                      <div className="text-xs font-medium truncate">
                        {e.subject || "(no subject)"}
                      </div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        {e.contactEmail}
                        {e.timestamp ? ` · ${e.timestamp.slice(0, 10)}` : ""}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No outreach emails logged for this event yet.
                </p>
              )}
            </section>
          </div>
        </ScrollArea>

        <BulkAddAttendeesDialog
          open={bulkOpen}
          onOpenChange={setBulkOpen}
          eventName={event.name}
          contacts={contacts}
          type={bulkType}
          alreadyTagged={new Set((bulkType === "attended" ? attended : invited).map((c) => c.id))}
          onChanged={onChanged}
        />
        <UploadAttendedDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          eventName={event.name}
          contacts={contacts}
          onChanged={onChanged}
        />
      </SheetContent>
    </Sheet>
  );
}

function AttendeeRow({ contact }: { contact: Contact }) {
  return (
    <div className="flex items-center justify-between border border-border rounded px-2 py-1.5">
      <div className="min-w-0">
        <div className="text-xs font-medium truncate">{contact.name}</div>
        <div className="text-[10px] text-muted-foreground truncate">
          {contact.title}
          {contact.company ? ` · ${contact.company}` : ""}
        </div>
      </div>
      {contact.location && (
        <div className="text-[10px] text-muted-foreground flex items-center gap-1 shrink-0">
          <MapPin className="h-2.5 w-2.5" />
          {contact.location}
        </div>
      )}
    </div>
  );
}

// ─── Add event dialog (saves to the Sheet, never to Asana) ──────
function parseTags(v: string): string[] {
  return v
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function AddEventDialog({
  open,
  onOpenChange,
  leadOptions,
  portcoOptions,
  sectorOptions,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  leadOptions: string[];
  portcoOptions: string[];
  sectorOptions: string[];
  onAdded: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [type, setType] = useState<string>("meeting");
  const [format, setFormat] = useState<string>("none");
  const [role, setRole] = useState<string>("none");
  const [lead, setLead] = useState("");
  const [sectorsText, setSectorsText] = useState("");
  const [portcosText, setPortcosText] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setName("");
    setDate("");
    setType("meeting");
    setFormat("none");
    setRole("none");
    setLead("");
    setSectorsText("");
    setPortcosText("");
    setBusy(false);
  };

  const sectorChips = parseTags(sectorsText);
  const portcoChips = parseTags(portcosText);

  const submit = async () => {
    if (!name.trim() || !date) {
      toast.error("Event name and date are required.");
      return;
    }
    setBusy(true);
    try {
      await addAppEvent({
        data: {
          name: name.trim(),
          date,
          type,
          format: format === "none" ? "" : format,
          role: role === "none" ? "" : role,
          lead: lead.trim(),
          sectors: sectorChips,
          portcos: portcoChips,
        },
      });
      toast.success(`Added "${name.trim()}" to your events`);
      await onAdded();
      reset();
      onOpenChange(false);
    } catch (e) {
      console.error("addAppEvent failed", e);
      toast.error("Could not add the event — see console.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarIcon className="h-4 w-4 text-primary" /> Add event
          </DialogTitle>
          <DialogDescription className="text-xs">
            Saved to your VenturePulse sheet. This does not write to Asana.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
              Event name
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="DTC Security Summit"
              className="h-8 text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                Date
              </Label>
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                Type
              </Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger className="h-8 text-sm capitalize">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EVENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t} className="capitalize">
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                Format
              </Label>
              <Select value={format} onValueChange={setFormat}>
                <SelectTrigger className="h-8 text-sm capitalize">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">—</SelectItem>
                  {EVENT_FORMATS.map((f) => (
                    <SelectItem key={f} value={f} className="capitalize">
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                DTC role
              </Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger className="h-8 text-sm capitalize">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">—</SelectItem>
                  {EVENT_ROLES.map((r) => (
                    <SelectItem key={r} value={r} className="capitalize">
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
              Event lead
            </Label>
            <Input
              list="event-lead-options"
              value={lead}
              onChange={(e) => setLead(e.target.value)}
              placeholder="DTC, PortCo, Partner…"
              className="h-8 text-sm"
            />
            <datalist id="event-lead-options">
              {leadOptions.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </div>

          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
              Sectors <span className="font-normal normal-case">(comma-separated)</span>
            </Label>
            <Input
              list="event-sector-options"
              value={sectorsText}
              onChange={(e) => setSectorsText(e.target.value)}
              placeholder="AI, Security"
              className="h-8 text-sm"
            />
            <datalist id="event-sector-options">
              {sectorOptions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            {sectorChips.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {sectorChips.map((s) => (
                  <Badge key={s} variant="secondary" className="text-[10px] capitalize">
                    {s}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
              Portfolio companies <span className="font-normal normal-case">(comma-separated)</span>
            </Label>
            <Input
              list="event-portco-options"
              value={portcosText}
              onChange={(e) => setPortcosText(e.target.value)}
              placeholder="Illumio, Netskope"
              className="h-8 text-sm"
            />
            <datalist id="event-portco-options">
              {portcoOptions.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            {portcoChips.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {portcoChips.map((p) => (
                  <Badge key={p} variant="secondary" className="text-[10px]">
                    <Building2 className="h-2.5 w-2.5 mr-1" />
                    {p}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim() || !date}>
            {busy ? "Adding…" : "Add event"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Upload an attended list — paste emails (one per line or comma/CSV). Matches by
// email to Network contacts and tags them attended; anyone previously "invited"
// auto-reconciles to "attended" because findAttendees() prefers attended.
function UploadAttendedDialog({
  open,
  onOpenChange,
  eventName,
  contacts,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  eventName: string;
  contacts: Contact[];
  onChanged?: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

  const { matched, unmatched } = useMemo(() => {
    const emails = [...new Set((text.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))];
    const byEmail = new Map(
      contacts.filter((c) => c.email).map((c) => [c.email.trim().toLowerCase(), c]),
    );
    const matched: Contact[] = [];
    const unmatched: string[] = [];
    for (const e of emails) {
      const c = byEmail.get(e);
      if (c) matched.push(c);
      else unmatched.push(e);
    }
    return { matched, unmatched };
  }, [text, contacts]);

  const submit = async () => {
    if (matched.length === 0) return;
    setBusy(true);
    let ok = 0;
    for (const c of matched) {
      try {
        await addEventToSheet({ data: { contactEmail: c.email, eventName, type: "attended" } });
        ok++;
      } catch (e) {
        console.error("Failed to tag attended for", c.email, e);
      }
    }
    setBusy(false);
    toast.success(
      `Marked ${ok} attended for "${eventName}"${unmatched.length ? ` · ${unmatched.length} email${unmatched.length !== 1 ? "s" : ""} not in network` : ""}`,
    );
    setText("");
    onOpenChange(false);
    onChanged?.();
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md flex flex-col">
        <SheetHeader>
          <SheetTitle className="text-sm">Upload attended list</SheetTitle>
          <SheetDescription className="text-xs">
            Paste the attended emails (one per line, or a CSV column) for{" "}
            <span className="font-medium">{eventName}</span>. Matched contacts are marked attended;
            anyone already invited moves to attended automatically.
          </SheetDescription>
        </SheetHeader>
        <div className="py-3 space-y-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            placeholder={"jane@acme.com\njohn@globex.com\n…"}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs font-mono shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
          />
          {text.trim() && (
            <p className="text-[11px] text-muted-foreground">
              <span className="font-semibold text-emerald-600">{matched.length}</span> matched ·{" "}
              <span className="font-semibold text-amber-600">{unmatched.length}</span> not in
              network
            </p>
          )}
        </div>
        <div className="border-t border-border pt-3 flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs"
            disabled={matched.length === 0 || busy}
            onClick={submit}
          >
            <Check className="h-3 w-3 mr-1" />
            {busy ? "Marking…" : `Mark ${matched.length} attended`}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function BulkAddAttendeesDialog({
  open,
  onOpenChange,
  eventName,
  contacts,
  type = "attended",
  alreadyTagged,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  eventName: string;
  contacts: Contact[];
  type?: "attended" | "invited";
  alreadyTagged: Set<string>;
  onChanged?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const verb = type === "invited" ? "invitees" : "attendees";

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return contacts
      .filter((c) => !alreadyTagged.has(c.id))
      .filter(
        (c) =>
          !q ||
          c.name.toLowerCase().includes(q) ||
          c.company.toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q),
      )
      .slice(0, 200);
  }, [contacts, query, alreadyTagged]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const submit = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    const targets = contacts.filter((c) => selected.has(c.id) && c.email);
    let ok = 0;
    for (const c of targets) {
      try {
        await addEventToSheet({ data: { contactEmail: c.email, eventName, type } });
        ok++;
      } catch (e) {
        console.error("Failed to add event for", c.email, e);
      }
    }
    setBusy(false);
    toast.success(`Tagged ${ok} contact${ok !== 1 ? "s" : ""} as ${verb} of "${eventName}"`);
    setSelected(new Set());
    onOpenChange(false);
    onChanged?.();
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md flex flex-col">
        <SheetHeader>
          <SheetTitle className="text-sm capitalize">Add {verb}</SheetTitle>
          <SheetDescription className="text-xs">
            Tag Network contacts as {verb} of <span className="font-medium">{eventName}</span>.
          </SheetDescription>
        </SheetHeader>
        <div className="py-3">
          <Input
            placeholder="Search contacts…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 text-xs"
          />
        </div>
        <ScrollArea className="flex-1 -mx-6 px-6">
          <div className="space-y-1">
            {candidates.map((c) => {
              const isSelected = selected.has(c.id);
              return (
                <label
                  key={c.id}
                  className="flex items-center gap-2 border border-border rounded px-2 py-1.5 cursor-pointer hover:bg-accent"
                >
                  <Checkbox checked={isSelected} onCheckedChange={() => toggle(c.id)} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{c.name}</div>
                    <div className="text-[10px] text-muted-foreground truncate">
                      {c.title}
                      {c.company ? ` · ${c.company}` : ""}
                    </div>
                  </div>
                  <Users className="h-3 w-3 text-muted-foreground shrink-0" />
                </label>
              );
            })}
            {candidates.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-6">
                No matching contacts.
              </p>
            )}
          </div>
        </ScrollArea>
        <div className="border-t border-border pt-3 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{selected.size} selected</span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={selected.size === 0 || busy}
              onClick={submit}
            >
              <Check className="h-3 w-3 mr-1" />
              {busy ? "Adding…" : `Add ${selected.size}`}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
