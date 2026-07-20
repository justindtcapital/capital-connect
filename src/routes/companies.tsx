import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  fetchContacts,
  fetchPortfolioCompanies,
  fetchTargets,
  fetchEmailActivity,
} from "@/utils/sheets.functions";
import { fetchAsanaPortcoData, type AsanaPortcoData } from "@/utils/asana.functions";
import { fetchSignals, scanSignals } from "@/utils/gemini.functions";
import type { Contact, PortfolioCompany, TargetLead, EmailActivityRecord } from "@/lib/types";
import type { FeedCard } from "@/lib/signal-feed";
import type { ScoredTarget } from "@/utils/broadcast.functions";
import { buildFeed, relativeTime } from "@/lib/signal-feed";
import { companyLogoSources, extractDomain } from "@/lib/domain-utils";
import { useFilters, defaultFilters } from "@/lib/filter-context";
import { EmailDraftDialog } from "@/components/crm/EmailDraftDialog";
import { BroadcastDialog } from "@/components/crm/BroadcastDialog";
import { PortfolioDetail } from "@/components/portfolio/PortfolioDetail";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

// PortCo-tab data the PortfolioDetail sheet needs, computed per portfolio company.
interface PortcoExtras {
  crmContacts: Contact[];
  crmIntros: Contact[];
  emails: EmailActivityRecord[];
}
import {
  buildCompanyDirectory,
  normCompany,
  RELATIONSHIP_LABEL,
  type CompanyIntel,
  type MomentumScore,
  type Relationship,
  type RelatedPerson,
} from "@/lib/company-intel";
import { ContactAvatar } from "@/components/crm/ContactAvatar";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Building2,
  Search,
  ArrowLeft,
  ArrowUpRight,
  ArrowDownRight,
  Flame,
  Users,
  Radar,
  Swords,
  ExternalLink,
  Sparkles,
  CalendarDays,
  Mail,
  Megaphone,
  Loader2,
  Briefcase,
} from "lucide-react";

// Build a minimal Contact from a person so we can reuse the CRM email dialog.
function personToContact(name: string, email: string, title: string, company: string): Contact {
  return {
    id: `co-${email || name}`,
    name,
    title,
    company,
    email,
    phone: "",
    address: "",
    prime: "",
    sector: "",
    areasOfInterest: [],
    temperature: "Warm",
    portCoIntros: [],
    eventsAttended: [],
    eventsInvited: [],
    interactions: [],
  };
}

export const Route = createFileRoute("/companies")({
  head: () => ({
    meta: [
      { title: "Company Intelligence — VenturePulse" },
      { name: "description", content: "Every signal, contact, and competitor — per company" },
    ],
  }),
  validateSearch: (search: Record<string, unknown>) => ({
    c: typeof search.c === "string" ? search.c : undefined,
  }),
  loader: async () => {
    const [contacts, portfolioRaw, targets, signals, emailActivity, asana] = await Promise.all([
      fetchContacts().catch((): Contact[] => []),
      fetchPortfolioCompanies().catch((): PortfolioCompany[] => []),
      fetchTargets().catch((): TargetLead[] => []),
      fetchSignals().catch(() => ({ recommendations: [], otherSignals: [], compliance: [] })),
      fetchEmailActivity().catch((): EmailActivityRecord[] => []),
      fetchAsanaPortcoData().catch(
        (): AsanaPortcoData => ({
          fieldsByCompanyName: {},
          namesByCompanyName: {},
          eventsByCompanyName: {},
        }),
      ),
    ]);

    // Enrich portfolio rows with Asana investment fields + events, exactly like
    // the PortCo tab does, so the reused profile sheet shows identical data.
    const portfolio = portfolioRaw.map((c) => {
      const key = c.name.trim().toLowerCase();
      const fields = asana.fieldsByCompanyName[key];
      const events = asana.eventsByCompanyName[key] || [];
      return {
        ...c,
        asanaFields: fields && Object.keys(fields).length > 0 ? fields : undefined,
        events: [...c.events, ...events],
      };
    });

    const feed = buildFeed({
      recommendations: signals.recommendations ?? [],
      otherSignals: signals.otherSignals ?? [],
      linkedinPosts: [],
      driveDocs: [],
      emails: [],
      portfolio,
      contacts,
    });
    const companies = buildCompanyDirectory({
      contacts,
      portfolio,
      targets,
      feed,
      now: Date.now(),
    });

    // Per-portco data the PortfolioDetail sheet expects: CRM contacts matched by
    // email domain, contacts who logged an intro, and outreach emails.
    const contactsByDomain = new Map<string, Contact[]>();
    for (const c of contacts) {
      const d = extractDomain(c.email);
      if (!d) continue;
      (contactsByDomain.get(d) ?? contactsByDomain.set(d, []).get(d)!).push(c);
    }
    const portcoExtras: Record<string, PortcoExtras> = {};
    for (const p of portfolio) {
      const key = p.name.trim().toLowerCase();
      const d = extractDomain(p.website);
      portcoExtras[key] = {
        crmContacts: d ? (contactsByDomain.get(d) ?? []) : [],
        crmIntros: contacts.filter((c) =>
          (c.portCoIntros || []).some((x) => x.trim().toLowerCase() === key),
        ),
        emails: emailActivity.filter((e) =>
          (e.linkedPortco || "")
            .split(/[;,]/)
            .map((s) => s.trim().toLowerCase())
            .includes(key),
        ),
      };
    }

    return { companies, portcoExtras };
  },
  component: CompaniesPage,
});

// ── Shared bits ──────────────────────────────────────────────────
function CompanyLogo({
  domain,
  initial,
  size = 10,
  confident = true,
}: {
  domain?: string;
  initial: string;
  size?: number;
  confident?: boolean;
}) {
  const [stage, setStage] = useState(0);
  const px = size * 4;
  const sources = useMemo(() => {
    if (!domain) return [] as string[];
    // Guessed domains: still try Logo.dev/DDG; avoid treating missing as success.
    return companyLogoSources(domain, confident ? "high" : "low");
  }, [domain, confident]);

  useEffect(() => {
    setStage(0);
  }, [sources.join("|")]);

  if (domain && stage < sources.length) {
    const src = sources[stage];
    return (
      <img
        key={src}
        src={src}
        alt=""
        style={{ width: px, height: px }}
        className="rounded-md border border-border object-contain bg-white shrink-0"
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setStage((s) => s + 1)}
      />
    );
  }
  return (
    <div
      style={{ width: px, height: px }}
      className="rounded-md bg-primary/10 text-primary flex items-center justify-center text-sm font-semibold shrink-0"
    >
      {initial}
    </div>
  );
}

function momentumClass(score: number): string {
  if (score >= 65) return "text-emerald-700";
  if (score >= 45) return "text-amber-700";
  return "text-muted-foreground";
}

function TrendTag({ trend }: { trend: number }) {
  if (trend === 0) return <span className="text-[11px] text-muted-foreground">flat</span>;
  const up = trend > 0;
  return (
    <span
      className={`text-[11px] inline-flex items-center gap-0.5 ${up ? "text-emerald-600" : "text-red-600"}`}
    >
      {up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {Math.abs(trend)}
    </span>
  );
}

function MomentumBlock({ m }: { m: MomentumScore }) {
  return (
    <div
      className="flex flex-col"
      title={`Activity + signal-sentiment momentum (not a financial health score). ${m.drivers.join(" · ")}`}
    >
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Momentum</span>
      <span className="flex items-baseline gap-1.5">
        <span className={`text-xl font-bold tabular-nums leading-none ${momentumClass(m.score)}`}>
          {m.score}
        </span>
        <TrendTag trend={m.trend} />
      </span>
    </div>
  );
}

const SEG_CLASS: Record<string, string> = {
  AI: "bg-violet-50 text-violet-700 border-violet-200",
  Data: "bg-blue-50 text-blue-700 border-blue-200",
  Security: "bg-red-50 text-red-700 border-red-200",
  Other: "bg-muted text-muted-foreground border-border",
};
const TEMP_DOT: Record<string, string> = {
  Hot: "bg-red-500",
  Warm: "bg-amber-500",
  Cold: "bg-sky-400",
};

const REL_BADGE: Record<Relationship, string> = {
  "works-here": "bg-emerald-50 text-emerald-700 border-emerald-200",
  intro: "bg-violet-50 text-violet-700 border-violet-200",
  target: "bg-amber-50 text-amber-700 border-amber-200",
  team: "bg-sky-50 text-sky-700 border-sky-200",
  signal: "bg-muted text-muted-foreground border-border",
};
// Order people are grouped in within the People card.
const REL_ORDER: Relationship[] = ["works-here", "intro", "target", "team", "signal"];

function PersonRow({
  p,
  companyName,
  companyDomain,
  onEmail,
}: {
  p: RelatedPerson;
  companyName?: string;
  companyDomain?: string;
  onEmail: (p: RelatedPerson) => void;
}) {
  const body = (
    <>
      <ContactAvatar
        contact={{
          name: p.name,
          email: p.email,
          company: companyName,
          domain: companyDomain,
        }}
        size="sm"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground truncate">{p.name}</p>
        {(p.title || p.detail) && (
          <p className="text-[11px] text-muted-foreground truncate">{p.title || p.detail}</p>
        )}
      </div>
    </>
  );
  const left = "flex items-center gap-2.5 min-w-0 flex-1";

  // Route the person to where they actually live. Network contacts (works-here /
  // intro) deep-link straight to their contact detail via ?contact=<email>;
  // targets go to the pipeline; team/signal-only people have no record to open.
  const renderIdentity = () => {
    if (p.relationship === "works-here" || p.relationship === "intro") {
      return (
        <Link to="/crm" search={p.email ? { contact: p.email } : undefined} className={left}>
          {body}
        </Link>
      );
    }
    if (p.relationship === "target") {
      return (
        <Link to="/targeting" className={left}>
          {body}
        </Link>
      );
    }
    return <div className={left}>{body}</div>;
  };

  return (
    <div className="group flex items-center gap-2 -mx-1 px-1 py-1 rounded-md hover:bg-accent transition-colors">
      {renderIdentity()}
      {p.temperature && (
        <span
          className={`h-2 w-2 rounded-full shrink-0 ${TEMP_DOT[p.temperature] || "bg-muted-foreground"}`}
          title={p.temperature}
        />
      )}
      {p.email && (
        <button
          type="button"
          onClick={() => onEmail(p)}
          title={`Draft email to ${p.name}`}
          className="shrink-0 text-muted-foreground hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Mail className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function PeopleCard({
  intel,
  onEmail,
}: {
  intel: CompanyIntel;
  onEmail: (p: RelatedPerson) => void;
}) {
  const groups = REL_ORDER.map((rel) => ({
    rel,
    items: intel.people.filter((p) => p.relationship === rel),
  })).filter((g) => g.items.length > 0);

  return (
    <Card>
      <CardContent className="p-4">
        <h2 className="text-sm font-semibold flex items-center gap-1.5 mb-3">
          <Users className="h-4 w-4 text-primary" /> People
          <span className="text-[11px] text-muted-foreground font-normal">
            ({intel.people.length})
          </span>
        </h2>
        {intel.people.length === 0 ? (
          <p className="text-xs text-muted-foreground py-3">
            No one connected to {intel.name} yet — no contacts, intros, targets, or signal mentions.
          </p>
        ) : (
          <div className="space-y-3">
            {groups.map((g) => (
              <div key={g.rel}>
                <div className="flex items-center gap-1.5 mb-1">
                  <span
                    className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border ${REL_BADGE[g.rel]}`}
                  >
                    {RELATIONSHIP_LABEL[g.rel]}
                  </span>
                  <span className="text-[10px] text-muted-foreground">{g.items.length}</span>
                </div>
                <div className="space-y-1">
                  {g.items.slice(0, 8).map((p) => (
                    <PersonRow
                      key={`${p.relationship}-${p.id}`}
                      p={p}
                      companyName={intel.name}
                      companyDomain={intel.logoDomain}
                      onEmail={onEmail}
                    />
                  ))}
                  {g.items.length > 8 && (
                    <p className="text-[11px] text-muted-foreground pl-1">
                      +{g.items.length - 8} more
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EngagementCard({ intel }: { intel: CompanyIntel }) {
  if (intel.events.length === 0 && intel.introductions.length === 0) return null;
  const events = [...intel.events].sort((a, b) => (b.date > a.date ? 1 : -1)).slice(0, 6);
  const intros = [...intel.introductions].sort((a, b) => (b.date > a.date ? 1 : -1)).slice(0, 6);
  return (
    <Card>
      <CardContent className="p-4">
        <h2 className="text-sm font-semibold flex items-center gap-1.5 mb-3">
          <CalendarDays className="h-4 w-4 text-primary" /> Engagement
        </h2>
        {events.length > 0 && (
          <div className="mb-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Events
            </div>
            <div className="space-y-1">
              {events.map((ev) => (
                <div key={ev.id} className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground tabular-nums shrink-0 w-16">
                    {shortMonth(ev.date)}
                  </span>
                  <span className="text-foreground truncate flex-1">{ev.name}</span>
                  <Badge variant="outline" className="text-[9px] capitalize">
                    {ev.type}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}
        {intros.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Introductions
            </div>
            <div className="space-y-1">
              {intros.map((intro) => (
                <div key={intro.id} className="text-xs">
                  <span className="text-foreground">{intro.targetName}</span>
                  {intro.targetCompany && (
                    <span className="text-muted-foreground"> · {intro.targetCompany}</span>
                  )}
                  {intro.outcome && (
                    <span className="text-muted-foreground"> — {intro.outcome}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function shortMonth(d?: string): string {
  const t = Date.parse(d || "");
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

// ── Page ─────────────────────────────────────────────────────────
function CompaniesPage() {
  const { companies, portcoExtras } = Route.useLoaderData();
  const { c } = Route.useSearch();

  const byKey = useMemo(() => {
    const m = new Map<string, CompanyIntel>();
    for (const e of companies) m.set(e.key, e);
    return m;
  }, [companies]);

  const selected = c ? byKey.get(normCompany(c)) : undefined;

  if (selected)
    return <CompanyBrief intel={selected} byKey={byKey} extras={portcoExtras[selected.key]} />;
  return <CompanyIndex companies={companies} />;
}

// ── Index ────────────────────────────────────────────────────────
// Left accent stripe per segment — gives the grid a scannable color rhythm.
const SEG_ACCENT: Record<string, string> = {
  AI: "bg-violet-400",
  Data: "bg-blue-400",
  Security: "bg-red-400",
  Other: "bg-slate-300",
};

// Opportunity score → tier color (number tint + meter fill).
function oppTier(n: number): { text: string; bar: string } {
  if (n >= 70) return { text: "text-emerald-700", bar: "bg-emerald-500" };
  if (n >= 50) return { text: "text-blue-700", bar: "bg-blue-500" };
  if (n >= 30) return { text: "text-amber-700", bar: "bg-amber-500" };
  return { text: "text-muted-foreground", bar: "bg-slate-300" };
}

// Recency of last activity → a small status dot.
function freshness(ts: number): { cls: string; label: string } | null {
  if (!ts) return null;
  const days = (Date.now() - ts) / 86_400_000;
  if (days <= 7) return { cls: "bg-emerald-500", label: "Active this week" };
  if (days <= 30) return { cls: "bg-amber-400", label: "Active this month" };
  return { cls: "bg-slate-300", label: "Quiet recently" };
}

type SortKey = "opp" | "momentum" | "signals" | "recent";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "opp", label: "Opportunity" },
  { key: "momentum", label: "Momentum" },
  { key: "signals", label: "Signals" },
  { key: "recent", label: "Recent" },
];
const SEGMENTS = ["AI", "Data", "Security", "Other"] as const;

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs px-2.5 h-7 rounded-full border transition-colors whitespace-nowrap ${
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-card text-muted-foreground border-border hover:border-primary/40 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  tint,
}: {
  icon: typeof Building2;
  label: string;
  value: number;
  tint: string;
}) {
  return (
    <Card>
      <CardContent className="p-3.5 flex items-center gap-3">
        <div className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${tint}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-lg font-bold tabular-nums leading-none text-foreground">
            {value.toLocaleString()}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5 truncate">
            {label}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CompanyIndex({ companies }: { companies: CompanyIntel[] }) {
  const [q, setQ] = useState("");
  const [seg, setSeg] = useState<string>("all");
  const [portcoOnly, setPortcoOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>("opp");

  // The eligible universe: companies with any substance (signal, portco, or people).
  const eligible = useMemo(
    () => companies.filter((e) => e.signalCount > 0 || e.isPortfolio || e.people.length > 0),
    [companies],
  );

  // Top-of-page overview + per-segment counts for the filter chips.
  const overview = useMemo(() => {
    const segCounts: Record<string, number> = { AI: 0, Data: 0, Security: 0, Other: 0 };
    let portcos = 0;
    let signals = 0;
    let hotOpps = 0;
    for (const e of eligible) {
      segCounts[e.segment] = (segCounts[e.segment] || 0) + 1;
      if (e.isPortfolio) portcos++;
      signals += e.signalCount;
      if (e.opportunity >= 70) hotOpps++;
    }
    return { segCounts, portcos, signals, hotOpps, total: eligible.length };
  }, [eligible]);

  const ranked = useMemo(() => {
    const query = q.trim().toLowerCase();
    const cmp: Record<SortKey, (a: CompanyIntel, b: CompanyIntel) => number> = {
      opp: (a, b) => b.opportunity - a.opportunity || b.momentum.score - a.momentum.score,
      momentum: (a, b) => b.momentum.score - a.momentum.score || b.opportunity - a.opportunity,
      signals: (a, b) => b.signalCount - a.signalCount || b.opportunity - a.opportunity,
      recent: (a, b) => b.lastActivityTs - a.lastActivityTs || b.opportunity - a.opportunity,
    };
    return eligible
      .filter((e) => seg === "all" || e.segment === seg)
      .filter((e) => !portcoOnly || e.isPortfolio)
      .filter((e) => !query || e.name.toLowerCase().includes(query))
      .sort(cmp[sort]);
  }, [eligible, q, seg, portcoOnly, sort]);

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-bold text-foreground flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" /> Company Intelligence
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            One brief per company — every signal, contact, and competitor in one place.
          </p>
        </div>
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search companies…"
            className="h-9 pl-8 text-sm"
          />
        </div>
      </div>

      {/* Overview */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile
          icon={Building2}
          label="Companies tracked"
          value={overview.total}
          tint="bg-primary/10 text-primary"
        />
        <StatTile
          icon={Building2}
          label="Portfolio companies"
          value={overview.portcos}
          tint="bg-emerald-100 text-emerald-700"
        />
        <StatTile
          icon={Radar}
          label="Signals captured"
          value={overview.signals}
          tint="bg-cyan-100 text-cyan-700"
        />
        <StatTile
          icon={Flame}
          label="Hot opportunities"
          value={overview.hotOpps}
          tint="bg-amber-100 text-amber-700"
        />
      </div>

      {/* Filters + sort */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          <Chip active={seg === "all"} onClick={() => setSeg("all")}>
            All
          </Chip>
          {SEGMENTS.map((s) => (
            <Chip key={s} active={seg === s} onClick={() => setSeg(seg === s ? "all" : s)}>
              {s} <span className="opacity-60">{overview.segCounts[s] || 0}</span>
            </Chip>
          ))}
          <span className="mx-1 h-4 w-px bg-border" />
          <Chip active={portcoOnly} onClick={() => setPortcoOnly((v) => !v)}>
            PortCo only
          </Chip>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground hidden sm:inline">Sort by</span>
          {SORTS.map((s) => (
            <Chip key={s.key} active={sort === s.key} onClick={() => setSort(s.key)}>
              {s.label}
            </Chip>
          ))}
        </div>
      </div>

      <div className="text-xs text-muted-foreground">
        {ranked.length} {ranked.length === 1 ? "company" : "companies"}
        {seg !== "all" ? ` · ${seg}` : ""}
        {portcoOnly ? " · portfolio only" : ""}
      </div>

      {ranked.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No companies match these filters.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {ranked.map((e) => {
            const tier = oppTier(e.opportunity);
            const fresh = freshness(e.lastActivityTs);
            return (
              <Link key={e.key} to="/companies" search={{ c: e.name }} className="group block">
                <Card className="relative h-full overflow-hidden surface-hover">
                  {/* segment accent */}
                  <span
                    className={`absolute left-0 top-0 h-full w-1 ${SEG_ACCENT[e.segment] || SEG_ACCENT.Other}`}
                  />
                  <CardContent className="p-4 pl-5">
                    <div className="flex items-start gap-3">
                      <CompanyLogo
                        domain={e.logoDomain}
                        confident={e.logoConfident}
                        initial={e.name.charAt(0).toUpperCase()}
                      />
                      <div className="min-w-0 flex-1">
                        <span
                          className="block text-sm font-semibold text-foreground leading-snug line-clamp-2"
                          title={e.name}
                        >
                          {e.name}
                        </span>
                        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                          {e.isPortfolio && (
                            <Badge
                              variant="outline"
                              className="text-[9px] bg-emerald-50 text-emerald-700 border-emerald-200"
                            >
                              PortCo
                            </Badge>
                          )}
                          <Badge
                            variant="outline"
                            className={`text-[9px] ${SEG_CLASS[e.segment] || SEG_CLASS.Other}`}
                          >
                            {e.segment}
                          </Badge>
                        </div>
                      </div>
                      {e.opportunity > 0 && (
                        <div className="shrink-0 text-right leading-none">
                          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
                            Opp
                          </div>
                          <div className={`mt-0.5 text-xl font-bold tabular-nums ${tier.text}`}>
                            {e.opportunity}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* opportunity meter */}
                    {e.opportunity > 0 && (
                      <div
                        className="mt-3 h-1 rounded-full bg-muted overflow-hidden"
                        title={`Opportunity score ${e.opportunity}/100`}
                      >
                        <div
                          className={`h-full rounded-full ${tier.bar}`}
                          style={{ width: `${Math.max(4, Math.min(100, e.opportunity))}%` }}
                        />
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-3 text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1 whitespace-nowrap" title={`${e.signalCount} signals`}>
                        <Radar className="h-3 w-3 shrink-0" /> {e.signalCount}
                      </span>
                      <span
                        className="inline-flex items-center gap-1 whitespace-nowrap"
                        title={`${e.people.length} related people · ${e.networkCount} known`}
                      >
                        <Users className="h-3 w-3 shrink-0" /> {e.people.length}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 whitespace-nowrap ${momentumClass(e.momentum.score)}`}
                        title={`Momentum ${e.momentum.score}/100`}
                      >
                        <Flame className="h-3 w-3 shrink-0" /> {e.momentum.score}
                        {e.momentum.trend !== 0 && <TrendTag trend={e.momentum.trend} />}
                      </span>
                      <span className="ml-auto inline-flex items-center gap-1.5 whitespace-nowrap">
                        {fresh && (
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${fresh.cls}`}
                            title={fresh.label}
                          />
                        )}
                        {e.lastActivityTs > 0 && <span>{relativeTime(e.lastActivityTs)}</span>}
                      </span>
                    </div>

                    {/* hover affordance */}
                    <div className="mt-2 h-0 overflow-hidden opacity-0 -translate-y-1 transition-all duration-200 group-hover:h-5 group-hover:opacity-100 group-hover:translate-y-0">
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-primary leading-5">
                        View brief <ArrowUpRight className="h-3 w-3 shrink-0" />
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Brief ────────────────────────────────────────────────────────
const CAT_CLASS: Record<string, string> = {
  "Funding/M&A": "bg-emerald-50 text-emerald-700 border-emerald-200",
  "Product/Milestone": "bg-blue-50 text-blue-700 border-blue-200",
  "Partnership/Customer Win": "bg-cyan-50 text-cyan-700 border-cyan-200",
  "Executive Movement": "bg-amber-50 text-amber-700 border-amber-200",
  "Crisis/Regulatory": "bg-red-50 text-red-700 border-red-200",
};

function CompanyBrief({
  intel,
  byKey,
  extras,
}: {
  intel: CompanyIntel;
  byKey: Map<string, CompanyIntel>;
  extras?: PortcoExtras;
}) {
  const topInsight = intel.signals.find((s) => s.insight)?.insight;
  const router = useRouter();
  const navigate = useNavigate();
  const { setFilters } = useFilters();

  const [scanning, setScanning] = useState(false);
  const [portfolioOpen, setPortfolioOpen] = useState(false);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftContact, setDraftContact] = useState<Contact | null>(null);
  const [draftSeed, setDraftSeed] = useState<{ purpose: string; notes: string }>({
    purpose: "",
    notes: "",
  });
  const [broadcastCard, setBroadcastCard] = useState<FeedCard | null>(null);

  const latestSignal = intel.signals[0];

  // Re-scan the web for THIS company only (reuses the scoped scanSignals the
  // PortCo panel uses). New rows persist + bust the sheet cache, so invalidate
  // reloads the brief with them.
  const runScan = async () => {
    setScanning(true);
    try {
      const res = await scanSignals({ data: { companyName: intel.name, windowDays: 14 } });
      if (!res.found && res.error) {
        toast.error(res.error);
      } else {
        const total = res.recommendations.length + res.otherSignals.length;
        toast.success(
          `Scan complete — ${total} signal${total !== 1 ? "s" : ""} for ${intel.name}.`,
        );
        await router.invalidate();
      }
    } catch (e) {
      console.error("scoped scanSignals failed", e);
      toast.error("Scan failed — see console.");
    } finally {
      setScanning(false);
    }
  };

  // Jump to Network with the list pre-filtered to this company.
  const openInNetwork = () => {
    setFilters({ ...defaultFilters, search: intel.name });
    navigate({ to: "/crm" });
  };

  const emailPerson = (p: RelatedPerson) => {
    if (!p.email) {
      toast.error("No email on file for this person.");
      return;
    }
    setDraftContact(personToContact(p.name, p.email, p.title, intel.name));
    setDraftSeed({
      purpose: latestSignal
        ? `${intel.name}: ${latestSignal.headline}`
        : `Outreach to ${intel.name}`,
      notes: latestSignal?.sourceUrl ? `Reference: ${latestSignal.sourceUrl}` : "",
    });
    setDraftOpen(true);
  };

  const emailSignalPerson = (card: FeedCard) => {
    if (!card.email) return;
    setDraftContact(personToContact(card.person || "", card.email, "", intel.name));
    setDraftSeed({
      purpose: `${card.category ? `${card.category}: ` : ""}${card.headline}`,
      notes: card.sourceUrl ? `Reference: ${card.sourceUrl}` : "",
    });
    setDraftOpen(true);
  };

  // Email a scored Broadcast target (same flow as the Signals tab).
  const emailTarget = (t: ScoredTarget) => {
    if (!t.email) {
      toast.error("No email on file for this contact.");
      return;
    }
    const card = broadcastCard;
    setDraftContact(personToContact(t.name, t.email, t.title, t.company));
    setDraftSeed({
      purpose: card ? `${card.company}: ${card.headline}` : `Outreach on ${intel.name}`,
      notes: card?.sourceUrl ? `Reference: ${card.sourceUrl}` : "",
    });
    setBroadcastCard(null);
    setDraftOpen(true);
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-5">
      <div className="flex items-center justify-between gap-3">
        <Link
          to="/companies"
          search={{ c: undefined }}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> All companies
        </Link>
        <div className="flex items-center gap-2">
          {intel.isPortfolio && intel.portfolioCompany && (
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => setPortfolioOpen(true)}
            >
              <Briefcase className="h-3.5 w-3.5 mr-1.5" /> PortCo profile
            </Button>
          )}
          <Button variant="outline" size="sm" className="text-xs" onClick={openInNetwork}>
            <Users className="h-3.5 w-3.5 mr-1.5" /> Open in Network
          </Button>
          <Button
            size="sm"
            className="text-xs"
            onClick={runScan}
            disabled={scanning}
          >
            {scanning ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Radar className="h-3.5 w-3.5 mr-1.5" />
            )}
            {scanning ? "Scanning…" : "Scan signals"}
          </Button>
        </div>
      </div>

      {/* Header */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-start gap-4 flex-wrap">
            <CompanyLogo
              domain={intel.logoDomain}
              confident={intel.logoConfident}
              initial={intel.name.charAt(0).toUpperCase()}
              size={14}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-bold text-foreground">{intel.name}</h1>
                {intel.isPortfolio && (
                  <Badge
                    variant="outline"
                    className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200"
                  >
                    Portfolio company
                  </Badge>
                )}
                <Badge
                  variant="outline"
                  className={`text-[10px] ${SEG_CLASS[intel.segment] || SEG_CLASS.Other}`}
                >
                  {intel.segment}
                </Badge>
                {intel.industry && (
                  <Badge variant="outline" className="text-[10px]">
                    {intel.industry}
                  </Badge>
                )}
              </div>
              {(intel.portfolioSector || intel.website) && (
                <p className="text-xs text-muted-foreground mt-1">
                  {intel.portfolioSector}
                  {intel.portfolioSector && intel.website ? " · " : ""}
                  {intel.website && (
                    <a
                      href={
                        intel.website.startsWith("http")
                          ? intel.website
                          : `https://${intel.website}`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline inline-flex items-center gap-0.5"
                    >
                      website <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </p>
              )}
            </div>
            {/* Quick stats */}
            <div className="flex items-center gap-6">
              <MomentumBlock m={intel.momentum} />
              {intel.opportunity > 0 && (
                <div className="flex flex-col">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Top opp
                  </span>
                  <span className="text-xl font-bold tabular-nums leading-none text-foreground">
                    {intel.opportunity}
                  </span>
                </div>
              )}
              <div className="flex flex-col">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Signals
                </span>
                <span className="text-xl font-bold tabular-nums leading-none text-foreground">
                  {intel.signalCount}
                </span>
              </div>
              <div
                className="flex flex-col"
                title={`${intel.networkCount} known of ${intel.people.length}`}
              >
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  People
                </span>
                <span className="text-xl font-bold tabular-nums leading-none text-foreground">
                  {intel.people.length}
                </span>
              </div>
            </div>
          </div>
          {intel.momentum.drivers.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap mt-3">
              {intel.momentum.drivers.map((d) => (
                <span
                  key={d}
                  className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground border border-border"
                >
                  {d}
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Signal timeline */}
        <div className="lg:col-span-2 space-y-4">
          {topInsight && (
            <Card>
              <CardContent className="p-4">
                <div className="text-[10px] uppercase tracking-wider font-semibold text-primary mb-1.5 flex items-center gap-1">
                  <Sparkles className="h-3.5 w-3.5" /> Why this company matters
                </div>
                <p className="text-sm text-foreground leading-snug">{topInsight.whyItMatters}</p>
                <p className="text-xs text-muted-foreground mt-1.5">{topInsight.whyNow}</p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="p-4">
              <h2 className="text-sm font-semibold flex items-center gap-1.5 mb-3">
                <Radar className="h-4 w-4 text-primary" /> Signal timeline
              </h2>
              {intel.signals.length === 0 ? (
                <p className="text-xs text-muted-foreground py-6 text-center">
                  No signals yet for {intel.name}.
                </p>
              ) : (
                <div className="relative pl-4 space-y-4 before:absolute before:left-1 before:top-1 before:bottom-1 before:w-px before:bg-border">
                  {intel.signals.map((s) => (
                    <div key={s.id} className="relative">
                      <span className="absolute -left-[13px] top-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-background" />
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[11px] text-muted-foreground">
                          {s.timeLabel || relativeTime(s.sortTs)}
                        </span>
                        {s.category && (
                          <Badge
                            variant="outline"
                            className={`text-[9px] ${CAT_CLASS[s.category] || ""}`}
                          >
                            {s.category}
                          </Badge>
                        )}
                        {s.insight && s.insight.scores.opportunity > 0 && (
                          <Badge variant="secondary" className="text-[9px]">
                            opp {s.insight.scores.opportunity}
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm font-medium text-foreground mt-0.5 leading-snug">
                        {s.headline}
                      </p>
                      {s.summary && (
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                          {s.summary}
                        </p>
                      )}
                      <div className="flex items-center gap-2 flex-wrap mt-1">
                        <button
                          type="button"
                          onClick={() => setBroadcastCard(s)}
                          className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                        >
                          <Megaphone className="h-3 w-3" /> Broadcast
                        </button>
                        {s.email && (
                          <button
                            type="button"
                            onClick={() => emailSignalPerson(s)}
                            className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                          >
                            <Mail className="h-3 w-3" /> Email {s.person || "contact"}
                          </button>
                        )}
                        {s.sourceUrl && (
                          <a
                            href={s.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5"
                          >
                            {s.sourceIsSearch ? "find source" : "source"}{" "}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Side: people + engagement + competitors */}
        <div className="space-y-4">
          <PeopleCard intel={intel} onEmail={emailPerson} />

          <EngagementCard intel={intel} />

          <Card>
            <CardContent className="p-4">
              <h2 className="text-sm font-semibold flex items-center gap-1.5 mb-3">
                <Swords className="h-4 w-4 text-primary" /> Competitor radar
              </h2>
              {intel.competitors.length === 0 ? (
                <p className="text-xs text-muted-foreground py-3">
                  No same-segment companies tracked yet.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {intel.competitors.map((name) => {
                    const peer = byKey.get(normCompany(name));
                    return (
                      <Link
                        key={name}
                        to="/companies"
                        search={{ c: name }}
                        className="flex items-center gap-2 -mx-1 px-1 py-1 rounded-md hover:bg-accent transition-colors"
                      >
                        <CompanyLogo
                          domain={peer?.logoDomain}
                          confident={peer?.logoConfident}
                          initial={name.charAt(0).toUpperCase()}
                          size={6}
                        />
                        <span className="text-sm text-foreground truncate flex-1">{name}</span>
                        {peer?.isPortfolio && (
                          <Badge
                            variant="outline"
                            className="text-[9px] bg-emerald-50 text-emerald-700 border-emerald-200"
                          >
                            PortCo
                          </Badge>
                        )}
                        {peer && peer.signalCount > 0 && (
                          <span className="text-[11px] text-muted-foreground tabular-nums">
                            {peer.signalCount}
                          </span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <BroadcastDialog
        open={!!broadcastCard}
        onOpenChange={(o) => {
          if (!o) setBroadcastCard(null);
        }}
        card={broadcastCard}
        onEmailTarget={emailTarget}
      />
      <EmailDraftDialog
        open={draftOpen}
        onOpenChange={setDraftOpen}
        contact={draftContact}
        initialPurpose={draftSeed.purpose}
        initialNotes={draftSeed.notes}
      />
      {intel.portfolioCompany && (
        <PortfolioDetail
          company={intel.portfolioCompany}
          open={portfolioOpen}
          onOpenChange={setPortfolioOpen}
          crmContacts={extras?.crmContacts ?? []}
          crmIntros={extras?.crmIntros ?? []}
          emails={extras?.emails ?? []}
        />
      )}
    </div>
  );
}
