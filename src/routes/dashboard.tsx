import { createFileRoute } from "@tanstack/react-router";
import type { Contact } from "@/lib/types";
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fetchContacts, fetchRatingTransitions } from "@/utils/sheets.functions";
import { networkProgressionInsights, type InsightNarrative } from "@/utils/insights.functions";
import { Users, Flame, Bell, Link2, Sparkles, Loader2, TrendingUp } from "lucide-react";
import { toast } from "sonner";

type Transition = { from: string; to: string; ts: string };
import { useDashboardFilters } from "@/lib/dashboard-filter-context";
import { normalizeLocation } from "@/lib/location-utils";
import { useChartDrill, matchesFilters, parseCfParam, type Dimension } from "@/lib/use-chart-drill";
import { DrillSheet, DrillChips } from "@/components/charts/DrillSheet";
import { ChartBuilder } from "@/components/charts/ChartBuilder";
import type { Metric } from "@/lib/chart-spec";
import { ContactDetail } from "@/components/crm/ContactDetail";
import { TemperatureBadge } from "@/components/crm/TemperatureBadge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — VenturePulse" },
      { name: "description", content: "DTC network analytics and insights" },
    ],
  }),
  validateSearch: (search: Record<string, unknown>) => ({ cf: parseCfParam(search.cf) }),
  loader: async () => ({
    contacts: await fetchContacts(),
    transitions: await fetchRatingTransitions(),
  }),
  component: DashboardPage,
});

const CHART_COLORS = [
  "oklch(0.546 0.162 241)",
  "oklch(0.637 0.135 163)",
  "oklch(0.735 0.145 85)",
  "oklch(0.598 0.2 295)",
  "oklch(0.645 0.246 16)",
  "oklch(0.6 0.18 200)",
  "oklch(0.7 0.15 130)",
  "oklch(0.55 0.19 310)",
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthKeyOf(date?: string): string {
  const ms = Date.parse(date || "");
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function monthTick(key: string): string {
  const [, mo] = key.split("-");
  return MONTHS[Number(mo) - 1] ?? key;
}

// Registry of reportable contact dimensions: the single source of truth for
// what's filterable. Each accessor returns the value(s) a contact has for the
// dimension; cross-filtering (matchesFilters) and chart clicks both key off the
// `dim`. Add a new filterable field here — nothing else needs to change.
const CONTACT_DIMS: Dimension<Contact>[] = [
  { dim: "prime", label: "Prime", get: (c) => c.prime },
  { dim: "sector", label: "Sector", get: (c) => c.sector },
  { dim: "temperature", label: "Status", get: (c) => c.temperature },
  { dim: "event", label: "Event", get: (c) => c.eventsAttended },
  { dim: "portco", label: "PortCo", get: (c) => c.portCoIntros },
  {
    dim: "month",
    label: "Month",
    get: (c) => (c.portCoEngagements || []).map((e) => monthKeyOf(e.date)),
  },
];

// Numeric measures available to the chart builder (record count is implicit).
const CONTACT_METRICS: Metric<Contact>[] = [
  { key: "intros", label: "PortCo intros", get: (c) => c.portCoIntros.length },
  { key: "events", label: "Events attended", get: (c) => c.eventsAttended.length },
  { key: "engagements", label: "Engagements", get: (c) => (c.portCoEngagements || []).length },
];

// How the drill-down list can be organized. "Engagement" buckets each contact by
// how they connect to the network (portfolio intro / event / direct).
type DrillGroupBy =
  | "engagement"
  | "temperature"
  | "company"
  | "sector"
  | "contactType"
  | "prime"
  | "none";

const DRILL_GROUP_OPTIONS: { value: DrillGroupBy; label: string }[] = [
  { value: "engagement", label: "Engagement" },
  { value: "temperature", label: "Temperature" },
  { value: "company", label: "Company" },
  { value: "sector", label: "Sector" },
  { value: "contactType", label: "Contact type" },
  { value: "prime", label: "Prime" },
  { value: "none", label: "No grouping" },
];

// Stable section order for the dimensions that have a natural ordering.
const DRILL_GROUP_ORDER: Partial<Record<DrillGroupBy, string[]>> = {
  engagement: ["Portfolio intro", "Event — attended", "Event — invited", "Direct / other"],
  temperature: ["Hot", "Warm", "Cold"],
};

function drillGroupKey(c: Contact, by: DrillGroupBy): string {
  switch (by) {
    case "temperature":
      return c.temperature || "—";
    case "company":
      return c.company?.trim() || "—";
    case "sector":
      return c.sector?.trim() || "—";
    case "contactType":
      return c.contactType?.trim() || "Unspecified";
    case "prime":
      return c.prime?.trim() || "—";
    case "engagement":
      if ((c.portCoIntros?.length ?? 0) > 0) return "Portfolio intro";
      if ((c.eventsAttended?.length ?? 0) > 0) return "Event — attended";
      if ((c.eventsInvited?.length ?? 0) > 0) return "Event — invited";
      return "Direct / other";
    default:
      return "";
  }
}

function groupDrillContacts(
  contacts: Contact[],
  by: DrillGroupBy,
): { key: string; items: Contact[] }[] {
  const map = new Map<string, Contact[]>();
  for (const c of contacts) {
    const k = drillGroupKey(c, by);
    const arr = map.get(k);
    if (arr) arr.push(c);
    else map.set(k, [c]);
  }
  const order = DRILL_GROUP_ORDER[by];
  return [...map.entries()]
    .map(([key, items]) => ({
      key,
      items: [...items].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => {
      if (order) {
        const ai = order.indexOf(a.key);
        const bi = order.indexOf(b.key);
        if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      }
      return b.items.length - a.items.length || a.key.localeCompare(b.key);
    });
}

function DrillContactRow({ c, onClick }: { c: Contact; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left rounded-md border border-border bg-card px-2.5 py-2 hover:bg-accent transition-colors"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium truncate">{c.name}</span>
        <TemperatureBadge temperature={c.temperature} />
      </div>
      <div className="text-[11px] text-muted-foreground truncate">
        {[c.title, c.company].filter(Boolean).join(" · ") || "—"}
      </div>
    </button>
  );
}

function DashboardPage() {
  const { contacts, transitions } = Route.useLoaderData() as {
    contacts: Contact[];
    transitions: Transition[];
  };
  const { filters } = useDashboardFilters();
  const { crossFilters, focus, clear, clearAll, drill, drillOpen, setDrillOpen } =
    useChartDrill(CONTACT_DIMS);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [drillGroupBy, setDrillGroupBy] = useState<DrillGroupBy>("engagement");

  // Sidebar filters first, then the click-driven cross-filters from the charts.
  const filtered = useMemo(() => {
    return contacts.filter((c) => {
      if (filters.sector !== "all" && c.sector !== filters.sector) return false;
      if (filters.prime !== "all" && c.prime !== filters.prime) return false;
      if (filters.temperature !== "all" && c.temperature !== filters.temperature) return false;
      if (filters.city !== "all" && normalizeLocation(c.location) !== filters.city) return false;
      if (filters.portfolioCompany !== "all" && !c.portCoIntros.includes(filters.portfolioCompany))
        return false;
      return matchesFilters(c, crossFilters, CONTACT_DIMS);
    });
  }, [contacts, filters, crossFilters]);

  const hotCount = filtered.filter((c) => c.temperature === "Hot").length;
  const followUpCount = filtered.filter((c) => c.followUpPending).length;
  const totalIntros = filtered.reduce((sum, c) => sum + c.portCoIntros.length, 0);

  const introsByPrime = useMemo(() => {
    const map: Record<string, number> = {};
    filtered.forEach((c) => {
      map[c.prime] = (map[c.prime] || 0) + c.portCoIntros.length;
    });
    return Object.entries(map).map(([name, intros]) => ({ name: name || "—", intros }));
  }, [filtered]);

  // Real intro velocity: portfolio engagements bucketed by month, last 12 months.
  const velocityData = useMemo(() => {
    const now = new Date();
    const keys: string[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    const counts = new Map(keys.map((k) => [k, 0]));
    for (const c of filtered) {
      for (const e of c.portCoEngagements || []) {
        const k = monthKeyOf(e.date);
        if (counts.has(k)) counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    return keys.map((k) => ({ month: k, intros: counts.get(k) || 0 }));
  }, [filtered]);

  const eventsDistribution = useMemo(() => {
    const map: Record<string, number> = {};
    filtered.forEach((c) =>
      c.eventsAttended.forEach((ev) => {
        map[ev] = (map[ev] || 0) + 1;
      }),
    );
    return Object.entries(map)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [filtered]);

  const sectorExposure = useMemo(() => {
    const map: Record<string, number> = {};
    filtered.forEach((c) => {
      if (c.sector) map[c.sector] = (map[c.sector] || 0) + 1;
    });
    return Object.entries(map)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [filtered]);

  // Temperature mix (Hot / Warm / Cold).
  const temperatureMix = useMemo(() => {
    const order = ["Hot", "Warm", "Cold"];
    const m: Record<string, number> = {};
    filtered.forEach((c) => {
      m[c.temperature] = (m[c.temperature] || 0) + 1;
    });
    return order.filter((t) => m[t]).map((t) => ({ name: t, value: m[t] }));
  }, [filtered]);

  const portCoExposure = useMemo(() => {
    const introMap: Record<string, number> = {};
    filtered.forEach((c) =>
      c.portCoIntros.forEach((co) => {
        introMap[co] = (introMap[co] || 0) + 1;
      }),
    );
    return Object.entries(introMap)
      .map(([name, intros]) => ({ name, intros }))
      .sort((a, b) => b.intros - a.intros)
      .slice(0, 12);
  }, [filtered]);

  const TEMP_COLORS: Record<string, string> = {
    Hot: "oklch(0.645 0.246 16)",
    Warm: "oklch(0.735 0.145 85)",
    Cold: "oklch(0.6 0.18 200)",
  };

  const openContact = (c: Contact) => {
    setSelectedContact(c);
    setDetailOpen(true);
  };

  // Group the drilled records for the side panel (e.g. by engagement / company).
  const drillGroups = useMemo(
    () => (drillGroupBy === "none" ? [] : groupDrillContacts(filtered, drillGroupBy)),
    [filtered, drillGroupBy],
  );

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-6">
      <div>
        <h1 className="text-lg font-bold text-foreground">Network Analytics</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Insights across your DTC network · click any chart to drill in
        </p>
      </div>

      <DrillChips filters={crossFilters} onClear={clear} onClearAll={clearAll} />

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard icon={Users} label="Network Count" value={filtered.length} />
        <KpiCard icon={Flame} label="Hot Leads" value={hotCount} />
        <KpiCard icon={Bell} label="Follow-ups" value={followUpCount} />
        <KpiCard icon={Link2} label="Total Intros" value={totalIntros} />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">PortCo Intros by Prime</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart
                data={introsByPrime}
                onClick={(s: { activeLabel?: string | number }) => focus("prime", s?.activeLabel)}
                className="cursor-pointer"
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ fontSize: 12 }}
                  cursor={{ fill: "var(--color-accent)", opacity: 0.4 }}
                />
                <Bar dataKey="intros" fill={CHART_COLORS[0]} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">
              Intro Activity Velocity{" "}
              <span className="font-normal text-muted-foreground">· last 12 mo</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart
                data={velocityData}
                onClick={(s: { activeLabel?: string | number }) => focus("month", s?.activeLabel)}
                className="cursor-pointer"
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} tickFormatter={monthTick} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12 }} labelFormatter={monthTick} />
                <Line
                  type="monotone"
                  dataKey="intros"
                  stroke={CHART_COLORS[0]}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Network Temperature Mix</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie
                  data={temperatureMix}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={80}
                  label={(d: { name?: string; value?: number }) => `${d.name} (${d.value})`}
                  className="cursor-pointer"
                  onClick={(d: { name?: string; value?: number }) => focus("temperature", d?.name)}
                >
                  {temperatureMix.map((t) => (
                    <Cell key={t.name} fill={TEMP_COLORS[t.name] ?? CHART_COLORS[0]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Network Sector Exposure</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart
                data={sectorExposure}
                layout="vertical"
                onClick={(s: { activeLabel?: string | number }) => focus("sector", s?.activeLabel)}
                className="cursor-pointer"
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                <YAxis dataKey="name" type="category" width={120} tick={{ fontSize: 10 }} />
                <Tooltip
                  contentStyle={{ fontSize: 12 }}
                  cursor={{ fill: "var(--color-accent)", opacity: 0.4 }}
                />
                <Bar dataKey="count" fill={CHART_COLORS[1]} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Events Activity Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie
                  data={eventsDistribution}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={80}
                  labelLine={false}
                  className="cursor-pointer"
                  onClick={(d: { name?: string; value?: number }) => focus("event", d?.name)}
                >
                  {eventsDistribution.map((_, idx) => (
                    <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">
              Portfolio Company Exposure{" "}
              <span className="font-normal text-muted-foreground">· top 12</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart
                data={portCoExposure}
                onClick={(s: { activeLabel?: string | number }) => focus("portco", s?.activeLabel)}
                className="cursor-pointer"
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 10 }}
                  angle={-20}
                  textAnchor="end"
                  height={50}
                />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ fontSize: 12 }}
                  cursor={{ fill: "var(--color-accent)", opacity: 0.4 }}
                />
                <Bar
                  dataKey="intros"
                  name="Introductions"
                  fill={CHART_COLORS[0]}
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <ChartBuilder
        storageKey="venturepulse:dashboard-charts"
        dims={CONTACT_DIMS}
        metrics={CONTACT_METRICS}
        items={filtered}
        focus={focus}
      />

      <NetworkInsights contacts={filtered} transitions={transitions} />

      <DrillSheet
        open={drillOpen}
        onOpenChange={setDrillOpen}
        drill={drill}
        count={filtered.length}
        controls={
          filtered.length > 0 ? (
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                Group by
              </span>
              <Select
                value={drillGroupBy}
                onValueChange={(v) => setDrillGroupBy(v as DrillGroupBy)}
              >
                <SelectTrigger className="h-7 w-36 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DRILL_GROUP_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value} className="text-xs">
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null
        }
      >
        {drillGroupBy === "none"
          ? filtered.map((c) => (
              <DrillContactRow key={c.id} c={c} onClick={() => openContact(c)} />
            ))
          : drillGroups.map((g) => (
              <div key={g.key} className="space-y-1.5">
                <div className="flex items-center gap-1.5 px-0.5 pt-1">
                  <span className="text-[10px] uppercase tracking-wider font-semibold text-foreground">
                    {g.key}
                  </span>
                  <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
                    {g.items.length}
                  </span>
                </div>
                {g.items.map((c) => (
                  <DrillContactRow key={c.id} c={c} onClick={() => openContact(c)} />
                ))}
              </div>
            ))}
      </DrillSheet>

      <ContactDetail
        contact={selectedContact}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onContactUpdate={(u) => setSelectedContact(u)}
      />
    </div>
  );
}

// #9 — Network progression insights: deterministic transition + recent-add stats
// always shown; a Claude narrative on demand. All data is Sheets-native.
function NetworkInsights({
  contacts,
  transitions,
}: {
  contacts: Contact[];
  transitions: Transition[];
}) {
  const [insight, setInsight] = useState<InsightNarrative | null>(null);
  const [loading, setLoading] = useState(false);

  const WINDOW_DAYS = 90;
  const windowLabel = `last ${WINDOW_DAYS} days`;

  const RANK: Record<string, number> = { Cold: 1, Warm: 2, Hot: 3 };

  const { transitionRows, recentAdds, recentCount } = useMemo(() => {
    const cutoff = Date.now() - WINDOW_DAYS * 86_400_000;

    // Aggregate rating transitions within the window.
    const tMap = new Map<string, number>();
    for (const t of transitions) {
      const ms = Date.parse(t.ts);
      if (!Number.isNaN(ms) && ms < cutoff) continue; // keep within window (or undated)
      const key = `${t.from}→${t.to}`;
      tMap.set(key, (tMap.get(key) || 0) + 1);
    }
    const transitionRows = [...tMap.entries()]
      .map(([k, count]) => {
        const [from, to] = k.split("→");
        return { from, to, count, down: (RANK[to] ?? 0) < (RANK[from] ?? 0) };
      })
      .sort((a, b) => b.count - a.count);

    // Recently-added breakdown by title / sector / location.
    const recent = contacts.filter((c) => {
      const ms = Date.parse(c.dateAdded || "");
      return !Number.isNaN(ms) && ms >= cutoff;
    });
    const top = (vals: string[], bucket: string) => {
      const m = new Map<string, number>();
      for (const v of vals.map((x) => (x || "").trim()).filter(Boolean))
        m.set(v, (m.get(v) || 0) + 1);
      return [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([label, count]) => ({ bucket, label, count }));
    };
    const recentAdds = [
      ...top(
        recent.map((c) => c.title),
        "title",
      ),
      ...top(
        recent.map((c) => c.sector),
        "sector",
      ),
      ...top(
        recent.map((c) => normalizeLocation(c.location)),
        "city",
      ),
    ];
    return { transitionRows, recentAdds, recentCount: recent.length };
  }, [contacts, transitions]);

  const generate = async () => {
    setLoading(true);
    setInsight(null);
    try {
      const res = await networkProgressionInsights({
        data: {
          transitions: transitionRows.map((t) => ({ from: t.from, to: t.to, count: t.count })),
          recentAdds,
          windowLabel,
        },
      });
      setInsight(res);
      if (!res.ok && res.error) toast.error(res.error);
    } catch (e) {
      console.error("networkProgressionInsights failed", e);
      toast.error("Insight generation failed — see console.");
    } finally {
      setLoading(false);
    }
  };

  const titleAdds = recentAdds.filter((r) => r.bucket === "title");
  const hasData = transitionRows.length > 0 || recentCount > 0;

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
          <TrendingUp className="h-4 w-4 text-primary" /> Network Progression{" "}
          <span className="font-normal text-muted-foreground">· {windowLabel}</span>
        </CardTitle>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[11px]"
          onClick={generate}
          disabled={loading || !hasData}
        >
          {loading ? (
            <>
              <Loader2 className="h-3 w-3 mr-1 animate-spin" /> Thinking…
            </>
          ) : (
            <>
              <Sparkles className="h-3 w-3 mr-1" /> Generate insights
            </>
          )}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {!hasData ? (
          <p className="text-xs text-muted-foreground">
            No rating changes or new contacts in the {windowLabel} yet. Run the scorecard and add
            contacts to populate this.
          </p>
        ) : (
          <>
            {/* Deterministic stats */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1">
                  Rating transitions
                </p>
                {transitionRows.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {transitionRows.map((t, i) => (
                      <span
                        key={i}
                        className={`text-[11px] rounded border px-1.5 py-0.5 ${t.down ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}
                      >
                        {t.from}→{t.to}: <span className="font-semibold">{t.count}</span>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">No transitions in window.</p>
                )}
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1">
                  Added in window ({recentCount})
                </p>
                {titleAdds.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {titleAdds.map((r, i) => (
                      <span
                        key={i}
                        className="text-[11px] rounded border border-border bg-muted/40 px-1.5 py-0.5"
                      >
                        {r.label}: <span className="font-semibold">{r.count}</span>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    No titles recorded on recent adds.
                  </p>
                )}
              </div>
            </div>

            {/* AI narrative */}
            {insight?.ok && (
              <div className="space-y-2 border-t border-border pt-2.5">
                {insight.summary && <p className="text-xs text-foreground">{insight.summary}</p>}
                {insight.commonalities && insight.commonalities.length > 0 && (
                  <div>
                    <span className="text-[9px] uppercase tracking-wider font-semibold text-muted-foreground">
                      Patterns
                    </span>
                    <ul className="list-disc pl-4 text-[11px] text-muted-foreground">
                      {insight.commonalities.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {insight.suggestions && insight.suggestions.length > 0 && (
                  <div>
                    <span className="text-[9px] uppercase tracking-wider font-semibold text-muted-foreground">
                      Gaps / where to add next
                    </span>
                    <ul className="list-disc pl-4 text-[11px] text-muted-foreground">
                      {insight.suggestions.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Users;
  label: string;
  value: number;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
            <Icon className="h-4 w-4 text-primary" />
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">
              {label}
            </p>
            <p className="text-2xl font-bold text-foreground">{value}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
