import { createFileRoute, Link, Await, useNavigate, useRouter } from "@tanstack/react-router";
import { Suspense, useEffect, useState } from "react";
import {
  NetworkIcon,
  TargetingIcon,
  EventsIcon,
  PortCoIcon,
  SignalsIcon,
  CompaniesIcon,
  QueryIcon,
  DashboardIcon,
} from "@/components/home/WorkspaceIcons";
import { useFilters, defaultFilters } from "@/lib/filter-context";
import type { ContactFilters } from "@/lib/types";
import {
  fetchContacts,
  fetchTargets,
  fetchPortfolioCompanies,
  recordHomeSnapshot,
} from "@/utils/sheets.functions";
import { fetchSignals } from "@/utils/gemini.functions";
import { getBriefing, generateBriefing } from "@/utils/briefing.functions";
import type { BriefingData } from "@/lib/briefing";
import { toast } from "sonner";
import { relativeTime } from "@/lib/signal-feed";
import type { Contact, TargetLead, PortfolioCompany } from "@/lib/types";
import type { DailyMetrics, SnapshotResult } from "@/utils/sheets.server";
import { Card, CardContent } from "@/components/ui/card";
import { ContactAvatar } from "@/components/crm/ContactAvatar";
import { DailyBriefing } from "@/components/home/DailyBriefing";
import { useAuth } from "@/lib/auth-context";
import {
  Users,
  Flame,
  Bell,
  Target,
  Briefcase,
  Building2,
  Calendar,
  Radar,
  BarChart3,
  ArrowRight,
  ArrowUpRight,
  ArrowDownRight,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";

// ── Derivations (run server-side in the loader) ───────────────────
function isPortfolioContact(c: Contact): boolean {
  return (c.sector || "").trim().toLowerCase() === "portfolio";
}
function hasOpenFollowUp(c: Contact): boolean {
  return c.interactions.some((i) => i.isFollowUp && !i.followUpComplete) || !!c.followUpPending;
}

type AttentionReason = "overdue" | "stale" | "cooling";
interface AttentionItem {
  id: string;
  name: string;
  title: string;
  company: string;
  email: string;
  reason: AttentionReason;
  detail: string;
  score: number;
}

// Score contacts by importance × days-since-touch and surface the ones that need
// action: open follow-ups (overdue), important contacts going stale, and warm/hot
// relationships cooling off. This is what makes Home worth opening on purpose.
function buildAttentionQueue(contacts: Contact[]): AttentionItem[] {
  const now = Date.now();
  const DAY = 86_400_000;
  const tempW = (t: string) => (t === "Hot" ? 3 : t === "Warm" ? 2 : 1);
  const lastTouch = (c: Contact): number => {
    let ts = Date.parse(c.lastContact || "") || 0;
    for (const it of c.interactions) {
      const t = Date.parse(it.date || "");
      if (!Number.isNaN(t) && t > ts) ts = t;
    }
    return ts || Date.parse(c.dateAdded || "") || 0;
  };

  const out: AttentionItem[] = [];
  for (const c of contacts) {
    const ts = lastTouch(c);
    const days = ts ? Math.floor((now - ts) / DAY) : 999;
    const importance =
      tempW(c.temperature) + Math.min(c.portCoIntros.length, 5) * 0.6 + (c.activityScore || 0) / 40;
    const open = hasOpenFollowUp(c);

    let reason: AttentionReason | null = null;
    let detail = "";
    if (open) {
      reason = "overdue";
      detail = `Follow-up open · last touch ${days}d ago`;
    } else if (days >= 30 && importance >= 2.5) {
      reason = "stale";
      detail = `Last touch ${days} days ago`;
    } else if ((c.temperature === "Hot" || c.temperature === "Warm") && days >= 10 && days < 30) {
      reason = "cooling";
      detail = `Quiet ${days} days`;
    }
    if (!reason) continue;

    const boost = reason === "overdue" ? 100_000 : 0;
    out.push({
      id: c.id,
      name: c.name,
      title: c.title,
      company: c.company,
      email: c.email,
      reason,
      detail,
      score: boost + importance * days,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ── Signal digest (deferred — streams behind a skeleton) ──────────
type DigestBadge = "portco" | "prospect" | "chatter";
interface DigestItem {
  company: string;
  headline: string;
  sub: string;
  badge: DigestBadge;
  sourceUrl?: string;
}
interface HomeDigest {
  items: DigestItem[];
  total: number;
  newCount: number;
}

function badgeFor(
  company: string,
  type: "recommendation" | "awareness",
  relevance: number,
  portco: Set<string>,
): DigestBadge {
  if (company && portco.has(company.trim().toLowerCase())) return "portco";
  if (type === "recommendation" && relevance >= 6) return "prospect";
  return "chatter";
}

async function buildHomeDigest(portco: Set<string>): Promise<HomeDigest> {
  try {
    const res = await fetchSignals();
    const rows: (DigestItem & { ts: number; rel: number })[] = [];
    for (const r of res.recommendations || []) {
      const ts = Date.parse(r.dateFound || "") || 0;
      rows.push({
        company: r.company || r.person || "Signal",
        headline: r.signal || r.category || "New signal",
        sub: [r.company || r.category, relativeTime(ts)].filter(Boolean).join(" · "),
        badge: badgeFor(r.company || "", "recommendation", r.relevance || 0, portco),
        sourceUrl: r.sourceUrl,
        ts,
        rel: r.relevance || 0,
      });
    }
    for (const a of res.otherSignals || []) {
      const ts = Date.parse(a.dateFound || "") || 0;
      rows.push({
        company: a.company || "Industry",
        headline: a.summary || a.category || "Industry update",
        sub: [a.company || a.category, relativeTime(ts)].filter(Boolean).join(" · "),
        badge: badgeFor(a.company || "", "awareness", 0, portco),
        sourceUrl: a.sourceUrl,
        ts,
        rel: 0,
      });
    }
    rows.sort((x, y) => y.ts - x.ts || y.rel - x.rel);
    const items = rows.slice(0, 4).map((i) => ({
      company: i.company,
      headline: i.headline,
      sub: i.sub,
      badge: i.badge,
      sourceUrl: i.sourceUrl,
    }));
    return { items, total: rows.length, newCount: res.newCount || 0 };
  } catch {
    return { items: [], total: 0, newCount: 0 };
  }
}

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Home — VenturePulse" },
      { name: "description", content: "Your DTC network at a glance" },
    ],
  }),
  loader: async () => {
    // Fast (cached) — drives the greeting, stat cards, and attention queue.
    const [contactsAll, targets, companies, briefing] = await Promise.all([
      fetchContacts().catch((): Contact[] => []),
      fetchTargets().catch((): TargetLead[] => []),
      fetchPortfolioCompanies().catch((): PortfolioCompany[] => []),
      getBriefing().catch((): BriefingData | null => null),
    ]);
    const contacts = contactsAll.filter((c) => !isPortfolioContact(c));
    const metrics: DailyMetrics = {
      contacts: contacts.length,
      hotLeads: contacts.filter((c) => c.temperature === "Hot").length,
      openFollowUps: contacts.filter(hasOpenFollowUp).length,
      targets: targets.length,
      portfolio: companies.length,
    };
    const snapshot = await recordHomeSnapshot({ data: metrics }).catch(
      (): SnapshotResult => ({ today: metrics, baseline: null, baselineDate: null }),
    );

    // Timestamp fallback for added-deltas before a week of snapshots exists.
    const within7 = (d?: string) => {
      const t = Date.parse(d || "");
      return !Number.isNaN(t) && t >= Date.now() - 7 * 86_400_000;
    };
    const added = {
      contacts: contacts.filter((c) => within7(c.dateAdded)).length,
      targets: targets.filter((t) => within7(t.dateAdded)).length,
    };

    const queue = buildAttentionQueue(contacts);
    const portcoNames = new Set(companies.map((c) => c.name.trim().toLowerCase()));

    // Deferred — NOT awaited; streams in behind a skeleton.
    const digest = buildHomeDigest(portcoNames);

    return {
      metrics,
      snapshot,
      added,
      attention: queue.slice(0, 4),
      attentionTotal: queue.length,
      digest,
      briefing,
    };
  },
  component: HomePage,
});

type Module = {
  title: string;
  url: string;
  Icon: (p: { className?: string }) => React.ReactNode;
  description: string;
  /** Soft gradient behind the glyph (resting + hover-strengthened). */
  tile: string;
  /** Glyph color + ring tint that fades in on hover. */
  glyph: string;
};

const MODULES: Module[] = [
  {
    title: "Network",
    url: "/crm",
    Icon: NetworkIcon,
    description: "Manage and track your DTC network contacts.",
    tile: "from-blue-500/15 to-blue-400/5 group-hover:from-blue-500/25 group-hover:to-blue-400/10",
    glyph: "text-blue-600 group-hover:ring-blue-500/30",
  },
  {
    title: "Targeting",
    url: "/targeting",
    Icon: TargetingIcon,
    description: "Work your prospecting pipeline of new leads.",
    tile: "from-rose-500/15 to-pink-400/5 group-hover:from-rose-500/25 group-hover:to-pink-400/10",
    glyph: "text-rose-600 group-hover:ring-rose-500/30",
  },
  {
    title: "Events",
    url: "/events",
    Icon: EventsIcon,
    description: "Track events and network attendance.",
    tile: "from-orange-500/15 to-amber-400/5 group-hover:from-orange-500/25 group-hover:to-amber-400/10",
    glyph: "text-orange-600 group-hover:ring-orange-500/30",
  },
  {
    title: "PortCo",
    url: "/portfolio",
    Icon: PortCoIcon,
    description: "Explore portfolio companies and their signals.",
    tile: "from-violet-500/15 to-purple-400/5 group-hover:from-violet-500/25 group-hover:to-purple-400/10",
    glyph: "text-violet-600 group-hover:ring-violet-500/30",
  },
  {
    title: "Signals",
    url: "/signals",
    Icon: SignalsIcon,
    description: "Scan the web for portfolio-relevant news.",
    tile: "from-cyan-500/15 to-sky-400/5 group-hover:from-cyan-500/25 group-hover:to-sky-400/10",
    glyph: "text-cyan-600 group-hover:ring-cyan-500/30",
  },
  {
    title: "Companies",
    url: "/companies",
    Icon: CompaniesIcon,
    description: "One intelligence brief per company.",
    tile: "from-indigo-500/15 to-blue-400/5 group-hover:from-indigo-500/25 group-hover:to-blue-400/10",
    glyph: "text-indigo-600 group-hover:ring-indigo-500/30",
  },
  {
    title: "Query",
    url: "/query",
    Icon: QueryIcon,
    description: "Ask the AI agent across all of your data.",
    tile: "from-fuchsia-500/15 to-pink-400/5 group-hover:from-fuchsia-500/25 group-hover:to-pink-400/10",
    glyph: "text-fuchsia-600 group-hover:ring-fuchsia-500/30",
  },
  {
    title: "Dashboard",
    url: "/dashboard",
    Icon: DashboardIcon,
    description: "Network analytics and progression insights.",
    tile: "from-emerald-500/15 to-green-400/5 group-hover:from-emerald-500/25 group-hover:to-green-400/10",
    glyph: "text-emerald-600 group-hover:ring-emerald-500/30",
  },
];

function firstNameFrom(email: string | null): string {
  if (!email) return "there";
  const local = email.split("@")[0] || "";
  const first = local.split(/[._-]/)[0] || local;
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : "there";
}
function greetingFor(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

const REASON_STYLE: Record<AttentionReason, { label: string; cls: string }> = {
  overdue: { label: "overdue", cls: "bg-red-50 text-red-700 border-red-200" },
  stale: { label: "going stale", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  cooling: { label: "cooling", cls: "bg-yellow-50 text-yellow-700 border-yellow-200" },
};
const BADGE_STYLE: Record<DigestBadge, { label: string; cls: string }> = {
  portco: { label: "portco", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  prospect: { label: "new prospect", cls: "bg-primary/10 text-primary border-primary/20" },
  chatter: { label: "chatter", cls: "bg-amber-50 text-amber-700 border-amber-200" },
};

function DeltaLine({ delta, label }: { delta: number | null; label: string }) {
  if (delta === null)
    return <span className="text-[11px] text-muted-foreground">building baseline…</span>;
  if (delta === 0)
    return <span className="text-[11px] text-muted-foreground">no change {label}</span>;
  const up = delta > 0;
  return (
    <span
      className={`text-[11px] inline-flex items-center gap-0.5 ${up ? "text-emerald-600" : "text-muted-foreground"}`}
    >
      {up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {Math.abs(delta)} {label}
    </span>
  );
}

function HomePage() {
  const { metrics, snapshot, added, attention, attentionTotal, digest, briefing } =
    Route.useLoaderData();
  const { email } = useAuth();
  const navigate = useNavigate();
  const router = useRouter();
  const { setFilters } = useFilters();
  const [briefingBusy, setBriefingBusy] = useState(false);

  // Build (or rebuild) today's briefing, then reload so the stored copy renders.
  const runBriefing = async () => {
    setBriefingBusy(true);
    try {
      await generateBriefing();
      await router.invalidate();
    } catch (e) {
      console.error("generateBriefing failed", e);
      toast.error("Couldn't generate the briefing — see console.");
    } finally {
      setBriefingBusy(false);
    }
  };

  // Apply a clean Network filter, then jump to /crm — the FilterProvider sits
  // above both pages, so the filter is already set when CRM mounts.
  const goWithFilter = (patch: Partial<ContactFilters>) => {
    setFilters({ ...defaultFilters, ...patch });
    navigate({ to: "/crm" });
  };

  const now = new Date();
  const name = firstNameFrom(email);
  const longDate = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const base = snapshot.baseline;
  const delta = (key: keyof DailyMetrics, fallback: number | null) =>
    base ? metrics[key] - base[key] : fallback;

  const stats: {
    label: string;
    value: number;
    icon: typeof Users;
    to: string;
    onActivate?: () => void;
    sub: React.ReactNode;
  }[] = [
    {
      label: "Network",
      value: metrics.contacts,
      icon: Users,
      to: "/crm",
      sub: <DeltaLine delta={delta("contacts", added.contacts)} label="this week" />,
    },
    {
      label: "Hot Leads",
      value: metrics.hotLeads,
      icon: Flame,
      to: "/crm",
      onActivate: () => goWithFilter({ temperature: ["Hot"] }),
      sub: <DeltaLine delta={delta("hotLeads", null)} label="this week" />,
    },
    {
      label: "Follow-ups",
      value: metrics.openFollowUps,
      icon: Bell,
      to: "/crm",
      onActivate: () => goWithFilter({ followUpOnly: true }),
      sub: (
        <span
          className={`text-[11px] ${metrics.openFollowUps > 0 ? "text-red-600" : "text-muted-foreground"}`}
        >
          {metrics.openFollowUps > 0 ? "need action" : "all clear"}
        </span>
      ),
    },
    {
      label: "Targets",
      value: metrics.targets,
      icon: Target,
      to: "/targeting",
      sub: <DeltaLine delta={delta("targets", added.targets)} label="this week" />,
    },
    {
      label: "Portfolio",
      value: metrics.portfolio,
      icon: Briefcase,
      to: "/portfolio",
      sub: <DeltaLine delta={delta("portfolio", null)} label="this week" />,
    },
  ];

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-8">
      {/* Greeting */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">
          {greetingFor(now.getHours())}, {name}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {longDate}
          {metrics.openFollowUps > 0 ? (
            <>
              {" · "}
              <span className="font-medium text-foreground">{metrics.openFollowUps}</span> follow-up
              {metrics.openFollowUps !== 1 ? "s" : ""} need attention
            </>
          ) : (
            " · you're all caught up"
          )}
        </p>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {stats.map((s) => {
          const card = (
            <Card className="h-full transition-all duration-200 hover:-translate-y-0.5 hover:shadow-(--shadow-elegant)">
              <CardContent className="p-5">
                <div className="flex items-center gap-2 mb-2">
                  <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <s.icon className="h-3.5 w-3.5 text-primary" />
                  </div>
                  <p className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground truncate">
                    {s.label}
                  </p>
                </div>
                <p className="text-2xl font-bold text-foreground leading-none">
                  {s.value.toLocaleString()}
                </p>
                <div className="mt-2">{s.sub}</div>
              </CardContent>
            </Card>
          );
          return s.onActivate ? (
            <button
              key={s.label}
              type="button"
              onClick={s.onActivate}
              className="block w-full text-left"
            >
              {card}
            </button>
          ) : (
            <Link key={s.label} to={s.to} className="block">
              {card}
            </Link>
          );
        })}
      </div>

      {/* Attention queue + signal digest */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Needs your attention */}
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Needs your attention
              </h2>
              <span className="text-[11px] text-muted-foreground">{attentionTotal} items</span>
            </div>
            {attention.length === 0 ? (
              <p className="text-xs text-muted-foreground py-6 text-center">
                Nothing needs chasing right now — nicely done.
              </p>
            ) : (
              <div className="divide-y divide-border">
                {attention.map((a: AttentionItem) => {
                  const r = REASON_STYLE[a.reason];
                  return (
                    <Link
                      key={a.id}
                      to="/crm"
                      search={a.email ? { contact: a.email } : undefined}
                      className="flex items-center gap-3 py-2.5 -mx-1 px-1 rounded-md hover:bg-accent transition-colors"
                    >
                      <ContactAvatar contact={{ name: a.name, email: a.email }} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground truncate">
                            {a.name}
                          </span>
                          {a.company && (
                            <span className="text-xs text-muted-foreground truncate">
                              · {a.company}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground truncate">{a.detail}</p>
                      </div>
                      <span
                        className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${r.cls}`}
                      >
                        {r.label}
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
            {attentionTotal > attention.length && (
              <Link
                to="/crm"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-3"
              >
                View all {attentionTotal} <ArrowRight className="h-3 w-3" />
              </Link>
            )}
          </CardContent>
        </Card>

        {/* Today's signals (deferred) */}
        <Card>
          <CardContent className="p-5">
            <Suspense fallback={<DigestSkeleton />}>
              <Await promise={digest}>{(d) => <DigestBody digest={d as HomeDigest} />}</Await>
            </Suspense>
          </CardContent>
        </Card>
      </div>

      {/* Daily briefing */}
      <DailyBriefing briefing={briefing} busy={briefingBusy} onGenerate={runBriefing} />

      {/* Module navigation */}
      <WorkspaceGrid />
    </div>
  );
}

/**
 * The "Jump into a workspace" grid. Each card lifts on hover and its custom
 * icon animates on hover. A gentle idle choreography also fires one icon at a
 * time (every ~6s) so the page feels alive without constant motion.
 */
function WorkspaceGrid() {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  useEffect(() => {
    // Respect reduced-motion: skip the idle loop entirely.
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    let i = -1;
    let clearTimer: ReturnType<typeof setTimeout>;
    const tick = () => {
      i = (i + 1) % MODULES.length;
      setActiveIdx(i);
      // Hold the animation ~2.6s, then rest until the next tick.
      clearTimer = setTimeout(() => setActiveIdx(null), 2600);
    };
    const interval = setInterval(tick, 6000);
    return () => {
      clearInterval(interval);
      clearTimeout(clearTimer);
    };
  }, []);

  return (
    <div>
      <h2 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-3">
        Jump into a workspace
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {MODULES.map((m, idx) => (
          <Link key={m.url} to={m.url} className="group block">
            <Card className="h-full transition-all duration-200 ease-out group-hover:-translate-y-1.5 group-hover:shadow-(--shadow-elegant) group-hover:border-primary/40">
              <CardContent className="p-5 flex items-start gap-3.5">
                <div
                  className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-linear-to-br ring-1 ring-transparent transition-all duration-200 ease-out group-hover:scale-[1.08] ${m.tile} ${m.glyph} ${
                    activeIdx === idx ? "wsi--active" : ""
                  }`}
                >
                  <m.Icon className="h-6 w-6" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-foreground">{m.title}</h3>
                    <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 -translate-x-1 transition-all group-hover:opacity-100 group-hover:translate-x-0" />
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{m.description}</p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

function DigestBody({ digest }: { digest: HomeDigest }) {
  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <Radar className="h-4 w-4 text-primary" />
          Today's signals
        </h2>
        <span className="text-[11px] text-muted-foreground">
          {digest.newCount > 0 ? `${digest.newCount} new` : "triaged"}
        </span>
      </div>
      {digest.items.length === 0 ? (
        <p className="text-xs text-muted-foreground py-6 text-center">
          No stored signals yet — run a scan from the Signals tab.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {digest.items.map((it, i) => {
            const b = BADGE_STYLE[it.badge];
            const inner = (
              <>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">{it.headline}</p>
                  <p className="text-[11px] text-muted-foreground truncate">{it.sub}</p>
                </div>
                <span
                  className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${b.cls}`}
                >
                  {b.label}
                </span>
              </>
            );
            return (
              <Link
                key={i}
                to="/signals"
                search={{ q: it.headline }}
                className="flex items-center gap-2 py-2.5 -mx-1 px-1 rounded-md hover:bg-accent transition-colors"
              >
                {inner}
              </Link>
            );
          })}
        </div>
      )}
      <Link
        to="/signals"
        className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-3"
      >
        Open Signals <ExternalLink className="h-3 w-3" />
      </Link>
    </>
  );
}

function DigestSkeleton() {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <Radar className="h-4 w-4 text-primary" />
          Today's signals
        </h2>
      </div>
      <div className="space-y-3 animate-pulse">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-2 py-1">
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="h-3 w-3/4 rounded bg-muted" />
              <div className="h-2.5 w-1/2 rounded bg-muted" />
            </div>
            <div className="h-4 w-14 rounded-full bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
