import { createFileRoute } from "@tanstack/react-router";
import type { Contact, PortfolioEvent } from "@/lib/types";
import { useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchContacts, fetchRatingTransitions, fetchPortfolioCompanies } from "@/utils/sheets.functions";
import { fetchAsanaPortcoData, type AsanaPortcoData } from "@/utils/asana.functions";
import { networkProgressionInsights, type InsightNarrative } from "@/utils/insights.functions";
import { Sparkles, Loader2, TrendingUp, Landmark, Calendar } from "lucide-react";
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
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  buildIntelligence,
  temperatureRiver,
  type PulseInsight,
  type Recommendation,
} from "@/lib/dashboard-intelligence";
import { PulseIsland } from "@/components/dashboard/PulseIsland";
import { NetworkConstellation } from "@/components/dashboard/NetworkConstellation";
import { InstrumentStrip } from "@/components/dashboard/InstrumentStrip";
import { RecommendationsBand } from "@/components/dashboard/RecommendationsBand";
import { ThesisIntelligenceMap } from "@/components/dashboard/ThesisIntelligenceMap";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — VenturePulse" },
      { name: "description", content: "DTC network analytics and insights" },
    ],
  }),
  validateSearch: (search: Record<string, unknown>) => ({ cf: parseCfParam(search.cf) }),
  loader: async () => {
    const [contacts, transitions, asana, portfolio] = await Promise.all([
      fetchContacts(),
      fetchRatingTransitions(),
      fetchAsanaPortcoData().catch(
        (): AsanaPortcoData => ({
          fieldsByCompanyName: {},
          namesByCompanyName: {},
          eventsByCompanyName: {},
        }),
      ),
      fetchPortfolioCompanies().catch(() => []),
    ]);

    // Derive lead investor per portco from the Asana "Lead Investor" custom field.
    // The field name can carry trailing whitespace, so match on a trim/lowercase
    // normalization (this was the fix for the Akka sourcing issue).
    const investorByPortco: Record<string, string> = {};
    for (const [key, fields] of Object.entries(asana.fieldsByCompanyName)) {
      for (const [fieldName, fieldValue] of Object.entries(fields)) {
        if (fieldName.trim().toLowerCase() === "lead investor" && fieldValue && fieldValue.trim()) {
          investorByPortco[key] = fieldValue.trim();
          break;
        }
      }
    }

    const portfolioPortcos = [
      ...new Set(
        (portfolio || [])
          .map((p: { name?: string }) => (p.name || "").trim())
          .filter(Boolean),
      ),
    ];

    return {
      contacts,
      transitions,
      investorByPortco,
      portcoNames: asana.namesByCompanyName,
      eventsByPortco: asana.eventsByCompanyName,
      portfolioPortcos,
    };
  },
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

const CONTACT_METRICS: Metric<Contact>[] = [
  { key: "intros", label: "PortCo intros", get: (c) => c.portCoIntros.length },
  { key: "events", label: "Events attended", get: (c) => c.eventsAttended.length },
  { key: "engagements", label: "Engagements", get: (c) => (c.portCoEngagements || []).length },
];

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

interface InvestorPortco {
  key: string;
  name: string;
  leads: number;
  events: PortfolioEvent[];
  eventsThisMonth: number;
}
interface InvestorRecord {
  investor: string;
  totalPortcos: number;
  totalLeads: number;
  totalEvents: number;
  portcos: InvestorPortco[];
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

function SectionLabel({
  eyebrow,
  title,
  hint,
}: {
  eyebrow: string;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {eyebrow}
        </p>
        <h2 className="text-sm font-semibold text-foreground mt-0.5">{title}</h2>
      </div>
      {hint && <p className="text-[11px] text-muted-foreground hidden sm:block">{hint}</p>}
    </div>
  );
}

function DashboardPage() {
  const { contacts, transitions, investorByPortco, portcoNames, eventsByPortco, portfolioPortcos } =
    Route.useLoaderData() as {
      contacts: Contact[];
      transitions: Transition[];
      investorByPortco: Record<string, string>;
      portcoNames: Record<string, string>;
      eventsByPortco: Record<string, PortfolioEvent[]>;
      portfolioPortcos: string[];
    };
  const { filters } = useDashboardFilters();
  const { crossFilters, focus, clear, clearAll, drill, drillOpen, setDrillOpen } =
    useChartDrill(CONTACT_DIMS);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [drillGroupBy, setDrillGroupBy] = useState<DrillGroupBy>("engagement");
  const [selectedInvestor, setSelectedInvestor] = useState<string | null>(null);
  const [focusContactId, setFocusContactId] = useState<string | null>(null);
  const constellationRef = useRef<HTMLDivElement>(null);

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

  const intelligence = useMemo(
    () => buildIntelligence(filtered, contacts, transitions, investorByPortco, portcoNames),
    [filtered, contacts, transitions, investorByPortco, portcoNames],
  );

  const introsByPrime = useMemo(() => {
    const map: Record<string, number> = {};
    filtered.forEach((c) => {
      map[c.prime] = (map[c.prime] || 0) + c.portCoIntros.length;
    });
    return Object.entries(map)
      .map(([name, intros]) => ({ name: name || "—", intros }))
      .sort((a, b) => b.intros - a.intros);
  }, [filtered]);

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

  const riverData = useMemo(() => temperatureRiver(filtered), [filtered]);

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

  const investorReport = useMemo(() => {
    const leadsByPortco = new Map<string, number>();
    for (const c of contacts) {
      for (const intro of c.portCoIntros || []) {
        const k = intro.trim().toLowerCase();
        if (k) leadsByPortco.set(k, (leadsByPortco.get(k) || 0) + 1);
      }
    }

    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const byInvestor = new Map<string, InvestorRecord>();
    for (const [key, investor] of Object.entries(investorByPortco)) {
      const events = eventsByPortco[key] || [];
      const eventsThisMonth = events.filter((e) => monthKeyOf(e.date) === thisMonth).length;
      const leads = leadsByPortco.get(key) || 0;
      const rec = byInvestor.get(investor) || {
        investor,
        totalPortcos: 0,
        totalLeads: 0,
        totalEvents: 0,
        portcos: [],
      };
      rec.totalPortcos += 1;
      rec.totalLeads += leads;
      rec.totalEvents += events.length;
      rec.portcos.push({ key, name: portcoNames[key] || key, leads, events, eventsThisMonth });
      byInvestor.set(investor, rec);
    }
    return [...byInvestor.values()].sort(
      (a, b) => b.totalPortcos - a.totalPortcos || b.totalLeads - a.totalLeads,
    );
  }, [contacts, investorByPortco, portcoNames, eventsByPortco]);

  const investorExposure = useMemo(
    () => investorReport.slice(0, 12).map((r) => ({ name: r.investor, portcos: r.totalPortcos })),
    [investorReport],
  );

  const selectedRecord = useMemo(
    () => investorReport.find((r) => r.investor === selectedInvestor) || null,
    [investorReport, selectedInvestor],
  );

  const openContact = (c: Contact) => {
    setSelectedContact(c);
    setDetailOpen(true);
    setFocusContactId(c.id);
  };

  const drillGroups = useMemo(
    () => (drillGroupBy === "none" ? [] : groupDrillContacts(filtered, drillGroupBy)),
    [filtered, drillGroupBy],
  );

  const handlePulseAct = (pulse: PulseInsight) => {
    if (pulse.contactId) {
      const c = contacts.find((x) => x.id === pulse.contactId);
      if (c) openContact(c);
      return;
    }
    if (pulse.focus) focus(pulse.focus.dim, pulse.focus.value);
    if (pulse.id === "steady") clearAll();
  };

  const handleRecAct = (rec: Recommendation) => {
    if (rec.contactId) {
      const c = contacts.find((x) => x.id === rec.contactId);
      if (c) openContact(c);
      return;
    }
    if (rec.focus) focus(rec.focus.dim, rec.focus.value);
  };

  const scrollToConstellation = () => {
    constellationRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-8">
      {/* 01 Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Firm intelligence
          </p>
          <h1 className="text-xl font-bold text-foreground tracking-tight">Network Intelligence</h1>
          <p className="text-xs text-muted-foreground mt-1">
            What is happening inside the firm network ·{" "}
            <span className="tabular-nums text-foreground/80">
              {intelligence.networkCount.toLocaleString()}
            </span>{" "}
            relationships in view
          </p>
        </div>
        <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
          <span>
            <span className="font-semibold text-foreground tabular-nums">{intelligence.hotCount}</span>{" "}
            Hot
          </span>
          <span className="text-border">·</span>
          <span>
            <span className="font-semibold text-foreground tabular-nums">
              {intelligence.followUpCount}
            </span>{" "}
            follow-ups
          </span>
          <span className="text-border">·</span>
          <span>
            <span className="font-semibold text-foreground tabular-nums">
              {intelligence.totalIntros}
            </span>{" "}
            intros
          </span>
        </div>
      </div>

      {/* 02 Pulse Island */}
      <PulseIsland
        pulse={intelligence.pulse}
        onAct={handlePulseAct}
        onFocusConstellation={scrollToConstellation}
      />

      {/* Intelligence summary */}
      <div className="rounded-xl border border-border/80 bg-muted/20 px-4 py-3.5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground mb-2">
          Situational brief
        </p>
        <ul className="space-y-1.5">
          {intelligence.summaryLines.map((line, i) => (
            <li key={i} className="text-sm text-foreground/90 leading-snug flex gap-2">
              <span className="text-primary mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
              {line}
            </li>
          ))}
        </ul>
      </div>

      <DrillChips filters={crossFilters} onClear={clear} onClearAll={clearAll} />

      {/* 03 Living Network */}
      <section ref={constellationRef} className="space-y-3">
        <SectionLabel
          eyebrow="03 · Living network"
          title="Constellation"
          hint="Time morph · Diff · Explore local / Ask AI · Pulse Trace · Orbit Focus"
        />
        <NetworkConstellation
          contacts={filtered}
          portfolioPortcos={portfolioPortcos}
          focusContactId={focusContactId}
          onSelectContact={openContact}
          onSelectPortco={(name) => focus("portco", name)}
        />
        <div className="rounded-xl border border-border/80 bg-muted/20 px-4 py-3.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground mb-2">
            How Constellation works
          </p>
          <div className="grid gap-3 sm:grid-cols-2 text-xs text-foreground/85 leading-relaxed">
            <ul className="space-y-1.5">
              <li className="flex gap-2">
                <span className="text-primary mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
                <span>
                  <span className="font-medium text-foreground">PortCos</span> come from the
                  Google Sheets Portfolio Companies tab (e.g.{" "}
                  <span className="font-medium text-foreground">ibex</span> maps to{" "}
                  <span className="font-medium text-foreground">IBEX</span>). People orbit the
                  company they are primarily introduced to. Halos show{" "}
                  <span className="font-medium text-foreground">Influence</span>.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-primary mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
                <span>
                  <span className="font-medium text-foreground">Click</span> a person to focus;{" "}
                  <span className="font-medium text-foreground">double-click</span> to open their
                  file. Click a PortCo to filter the dashboard; double-click for Orbit Focus.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-primary mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
                <span>
                  <span className="font-medium text-foreground">Pulse Trace (T)</span> — pick two
                  nodes to light the warmest intro path. Press{" "}
                  <span className="font-medium text-foreground">P</span> for alternate routes.
                </span>
              </li>
            </ul>
            <ul className="space-y-1.5">
              <li className="flex gap-2">
                <span className="text-primary mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
                <span>
                  <span className="font-medium text-foreground">Time</span> scrubber and{" "}
                  <span className="font-medium text-foreground">Diff (D)</span> show how influence
                  changed versus today. AI marks decay, opportunities, and under-connected
                  PortCos.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-primary mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
                <span>
                  Press <span className="font-medium text-foreground">/</span> to ask the network
                  (e.g. “bridges”, “cooling”, “connected to Acme”). Esc or F clears focus.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-primary mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
                <span>
                  <span className="font-medium text-foreground">Labels</span> default to{" "}
                  <span className="font-medium text-foreground">Active</span> (PortCos with
                  intros). Switch to All / None in the map chrome; hover always reveals a name.
                  Double-click a PortCo for Orbit Focus when the ring is dense.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-primary mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
                <span>
                  The map follows your dashboard filters — change sector, temperature, or PortCo
                  above and the constellation rebuilds live.
                </span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* 04 Executive instruments */}
      <section className="space-y-3">
        <SectionLabel
          eyebrow="04 · Instruments"
          title="Executive instruments"
          hint="Health · momentum · velocity · coverage · freshness · influence"
        />
        <InstrumentStrip instruments={intelligence.instruments} />
      </section>

      {/* 05 Relationship Analytics */}
      <section className="space-y-3">
        <SectionLabel
          eyebrow="05 · Relationship analytics"
          title="Primes, velocity & thesis exposure"
          hint="Click any series to drill"
        />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="border-border/80 shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">PortCo Intros by Prime</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart
                  data={introsByPrime}
                  layout="vertical"
                  margin={{ left: 4, right: 12 }}
                  onClick={(s: { activeLabel?: string | number }) => focus("prime", s?.activeLabel)}
                  className="cursor-pointer"
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                  <YAxis dataKey="name" type="category" width={100} tick={{ fontSize: 10 }} />
                  <Tooltip
                    contentStyle={{ fontSize: 12 }}
                    cursor={{ fill: "var(--color-accent)", opacity: 0.4 }}
                  />
                  <Bar dataKey="intros" fill={CHART_COLORS[0]} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="border-border/80 shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">
                Intro Activity Velocity{" "}
                <span className="font-normal text-muted-foreground">· last 12 mo</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart
                  data={velocityData}
                  onClick={(s: { activeLabel?: string | number }) => focus("month", s?.activeLabel)}
                  className="cursor-pointer"
                >
                  <defs>
                    <linearGradient id="velFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART_COLORS[0]} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={CHART_COLORS[0]} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} tickFormatter={monthTick} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip contentStyle={{ fontSize: 12 }} labelFormatter={monthTick} />
                  <Area
                    type="monotone"
                    dataKey="intros"
                    stroke={CHART_COLORS[0]}
                    strokeWidth={2}
                    fill="url(#velFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="border-border/80 shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">
                Temperature River{" "}
                <span className="font-normal text-muted-foreground">· activity-weighted</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={riverData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} tickFormatter={monthTick} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip contentStyle={{ fontSize: 12 }} labelFormatter={monthTick} />
                  <Area
                    type="monotone"
                    dataKey="Hot"
                    stackId="t"
                    stroke="oklch(0.645 0.246 16)"
                    fill="oklch(0.645 0.246 16)"
                    fillOpacity={0.75}
                    className="cursor-pointer"
                    onClick={() => focus("temperature", "Hot")}
                  />
                  <Area
                    type="monotone"
                    dataKey="Warm"
                    stackId="t"
                    stroke="oklch(0.735 0.145 85)"
                    fill="oklch(0.735 0.145 85)"
                    fillOpacity={0.7}
                    className="cursor-pointer"
                    onClick={() => focus("temperature", "Warm")}
                  />
                  <Area
                    type="monotone"
                    dataKey="Cold"
                    stackId="t"
                    stroke="oklch(0.6 0.18 200)"
                    fill="oklch(0.6 0.18 200)"
                    fillOpacity={0.55}
                    className="cursor-pointer"
                    onClick={() => focus("temperature", "Cold")}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="border-border/80 shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">
                Thesis Intelligence{" "}
                <span className="font-normal text-muted-foreground">
                  · relationship capital by thesis
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ThesisIntelligenceMap
                contacts={filtered}
                onSelectThesis={(name) => focus("sector", name)}
              />
            </CardContent>
          </Card>
        </div>
      </section>

      {/* 06 Investor Analytics */}
      <section className="space-y-3">
        <SectionLabel
          eyebrow="06 · Investor analytics"
          title="Lead investor leverage"
          hint="Asana Lead Investor · click a bar to drill"
        />
        <Card className="border-border/80 shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
              <Landmark className="h-4 w-4 text-primary" /> Reports by Lead Investor
            </CardTitle>
          </CardHeader>
          <CardContent>
            {investorExposure.length === 0 ? (
              <div className="text-xs text-muted-foreground py-10 text-center">
                No lead-investor data yet. Add a{" "}
                <span className="font-medium text-foreground">“Lead Investor”</span> custom field to
                your portfolio-company tasks in Asana to populate this chart.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(240, investorExposure.length * 34)}>
                <BarChart data={investorExposure} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--color-border)"
                    horizontal={false}
                  />
                  <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                  <YAxis dataKey="name" type="category" width={150} tick={{ fontSize: 10 }} />
                  <Tooltip
                    contentStyle={{ fontSize: 12 }}
                    cursor={{ fill: "var(--color-accent)", opacity: 0.4 }}
                    formatter={(v: number) => [v, "Portfolio companies"]}
                  />
                  <Bar
                    dataKey="portcos"
                    name="Portfolio companies"
                    fill={CHART_COLORS[3]}
                    radius={[0, 4, 4, 0]}
                    className="cursor-pointer"
                    onClick={(d: { name?: string | number }) =>
                      d?.name != null && setSelectedInvestor(String(d.name))
                    }
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </section>

      {/* 07 Portfolio Intelligence */}
      <section className="space-y-3">
        <SectionLabel
          eyebrow="07 · Portfolio intelligence"
          title="Portfolio company exposure"
          hint="Top 12 by introductions"
        />
        <Card className="border-border/80 shadow-none">
          <CardContent className="pt-5">
            <ResponsiveContainer width="100%" height={260}>
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
      </section>

      {/* 08 Recommendations */}
      <section className="space-y-3">
        <SectionLabel
          eyebrow="08 · Recommendations"
          title="Where to act next"
          hint="Decay · follow-ups · coverage gaps · concentration"
        />
        <RecommendationsBand items={intelligence.recommendations} onAct={handleRecAct} />
        <NetworkInsights contacts={filtered} transitions={transitions} />
      </section>

      {/* 09 Custom Analytics */}
      <section className="space-y-3">
        <SectionLabel
          eyebrow="09 · Custom analytics"
          title="Build your own cuts"
          hint="Power users · persisted locally"
        />
        <ChartBuilder
          storageKey="venturepulse:dashboard-charts"
          dims={CONTACT_DIMS}
          metrics={CONTACT_METRICS}
          items={filtered}
          focus={focus}
          aiRecommend
          blockedCharts={[
            // Curated charts already rendered above — never re-suggest these cuts.
            { groupBy: "prime", metric: "intros", label: "PortCo Intros by Prime" },
            { groupBy: "month", metric: "engagements", label: "Intro Activity Velocity" },
            { groupBy: "month", metric: "intros", label: "Intro Activity Velocity (alt)" },
            { groupBy: "temperature", metric: "count", label: "Temperature River / mix" },
            { groupBy: "sector", metric: "count", label: "Thesis Intelligence / Sector Exposure" },
            { groupBy: "portco", metric: "intros", label: "Portfolio Company Exposure" },
            { groupBy: "event", metric: "count", label: "Events Activity Distribution" },
            { groupBy: "event", metric: "events", label: "Events attended by event" },
          ]}
        />
      </section>

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
          ? filtered.map((c) => <DrillContactRow key={c.id} c={c} onClick={() => openContact(c)} />)
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

      <Dialog
        open={!!selectedRecord}
        onOpenChange={(o) => {
          if (!o) setSelectedInvestor(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          {selectedRecord && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Landmark className="h-4 w-4 text-primary" /> {selectedRecord.investor}
                </DialogTitle>
                <DialogDescription className="flex items-center gap-3 text-xs">
                  <span>
                    <b className="text-foreground">{selectedRecord.totalPortcos}</b> portfolio
                    compan
                    {selectedRecord.totalPortcos !== 1 ? "ies" : "y"}
                  </span>
                  <span>
                    <b className="text-foreground">{selectedRecord.totalLeads}</b> lead
                    {selectedRecord.totalLeads !== 1 ? "s" : ""}
                  </span>
                  <span>
                    <b className="text-foreground">{selectedRecord.totalEvents}</b> event
                    {selectedRecord.totalEvents !== 1 ? "s" : ""}
                  </span>
                </DialogDescription>
              </DialogHeader>

              <div className="max-h-[60vh] overflow-y-auto space-y-2 pr-1">
                {[...selectedRecord.portcos]
                  .sort((a, b) => b.leads - a.leads || a.name.localeCompare(b.name))
                  .map((p) => {
                    const recentEvents = [...p.events]
                      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
                      .slice(0, 4);
                    return (
                      <div key={p.key} className="rounded-lg border border-border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-foreground truncate">
                            {p.name}
                          </span>
                          <div className="flex items-center gap-2 text-[11px] text-muted-foreground shrink-0">
                            <span>
                              {p.leads} lead{p.leads !== 1 ? "s" : ""}
                            </span>
                            <span className="text-muted-foreground/40">·</span>
                            <span>
                              {p.events.length} event{p.events.length !== 1 ? "s" : ""}
                            </span>
                            {p.eventsThisMonth > 0 && (
                              <>
                                <span className="text-muted-foreground/40">·</span>
                                <span className="text-primary font-medium">
                                  {p.eventsThisMonth} this month
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                        {recentEvents.length > 0 && (
                          <div className="mt-2 space-y-1">
                            {recentEvents.map((e) => (
                              <div
                                key={e.id}
                                className="flex items-center gap-2 text-[11px] text-muted-foreground"
                              >
                                <Calendar className="h-3 w-3 shrink-0" />
                                <span className="truncate">{e.name}</span>
                                <span className="ml-auto shrink-0 text-muted-foreground/70">
                                  {e.date}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

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

    const tMap = new Map<string, number>();
    for (const t of transitions) {
      const ms = Date.parse(t.ts);
      if (!Number.isNaN(ms) && ms < cutoff) continue;
      const key = `${t.from}→${t.to}`;
      tMap.set(key, (tMap.get(key) || 0) + 1);
    }
    const transitionRows = [...tMap.entries()]
      .map(([k, count]) => {
        const [from, to] = k.split("→");
        return { from, to, count, down: (RANK[to!] ?? 0) < (RANK[from!] ?? 0) };
      })
      .sort((a, b) => b.count - a.count);

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
    <Card className="border-border/80 shadow-none">
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
              <Sparkles className="h-3 w-3 mr-1" /> Deepen brief
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
                        className={`text-[11px] rounded border px-1.5 py-0.5 ${t.down ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300" : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"}`}
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
