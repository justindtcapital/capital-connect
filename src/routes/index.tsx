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
import { PulseRing } from "@/components/pulse/PulseRing";
import { useAuth } from "@/lib/auth-context";
import { teamProfile } from "@/lib/user-ownership";
import {
  buildAttentionQueue,
  hasOpenFollowUp,
  networkContacts,
  type AttentionItem,
  type AttentionReason,
} from "@/lib/attention-queue";
import { fetchMyAttention } from "@/utils/sheets.functions";
import {
  ArrowRight,
  ArrowUpRight,
  ArrowDownRight,
  AlertTriangle,
  ExternalLink,
  Loader2,
  Radar,
  Telescope,
} from "lucide-react";

// ── Derivations (run server-side in the loader) ───────────────────
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
    const [contactsAll, targets, companies, briefing] = await Promise.all([
      fetchContacts().catch((): Contact[] => []),
      fetchTargets().catch((): TargetLead[] => []),
      fetchPortfolioCompanies().catch((): PortfolioCompany[] => []),
      getBriefing().catch((): BriefingData | null => null),
    ]);
    const contacts = networkContacts(contactsAll);
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
    const digest = buildHomeDigest(portcoNames);

    const hotRatio = metrics.contacts ? metrics.hotLeads / metrics.contacts : 0;
    const followPressure = metrics.contacts
      ? Math.min(1, metrics.openFollowUps / Math.max(1, metrics.contacts * 0.08))
      : 0;
    const networkHealth = Math.round(
      Math.max(12, Math.min(96, hotRatio * 55 + (1 - followPressure) * 35 + 10)),
    );

    return {
      metrics,
      snapshot,
      added,
      attention: queue.slice(0, 4),
      attentionTotal: queue.length,
      digest,
      briefing,
      networkHealth,
    };
  },
  component: HomePage,
});

type Module = {
  title: string;
  url: string;
  Icon: (p: { className?: string }) => React.ReactNode;
  description: string;
  accent: string;
};

const MODULES: Module[] = [
  {
    title: "Network",
    url: "/crm",
    Icon: NetworkIcon,
    description: "Relationships, temperature, and introductions.",
    accent: "text-foreground",
  },
  {
    title: "Targeting",
    url: "/targeting",
    Icon: TargetingIcon,
    description: "Prospects entering the network's gravity.",
    accent: "text-[var(--copper-foreground)]",
  },
  {
    title: "Events",
    url: "/events",
    Icon: EventsIcon,
    description: "Where the network meets in time.",
    accent: "text-muted-foreground",
  },
  {
    title: "PortCo",
    url: "/portfolio",
    Icon: PortCoIcon,
    description: "Companies under stewardship.",
    accent: "text-foreground",
  },
  {
    title: "Signals",
    url: "/signals",
    Icon: SignalsIcon,
    description: "Live intelligence mapped to your book.",
    accent: "text-primary",
  },
  {
    title: "Companies",
    url: "/companies",
    Icon: CompaniesIcon,
    description: "One brief per company.",
    accent: "text-muted-foreground",
  },
  {
    title: "Query",
    url: "/query",
    Icon: QueryIcon,
    description: "Ask the network anything.",
    accent: "text-primary",
  },
  {
    title: "Dashboard",
    url: "/dashboard",
    Icon: DashboardIcon,
    description: "Firm network intelligence.",
    accent: "text-muted-foreground",
  },
  {
    title: "Platform",
    url: "/platform",
    Icon: Telescope,
    description: "Research, sourcing, and diligence tools.",
    accent: "text-primary",
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
  overdue: {
    label: "overdue",
    cls: "text-[var(--copper-foreground)] border-[var(--copper)]/40 bg-[var(--copper)]/10",
  },
  stale: { label: "going stale", cls: "text-decay-foreground border-decay/40 bg-decay/15" },
  cooling: { label: "cooling", cls: "text-cold-foreground border-cold/50 bg-cold/40" },
};
const BADGE_STYLE: Record<DigestBadge, { label: string; cls: string }> = {
  portco: { label: "portco", cls: "text-foreground border-border bg-muted" },
  prospect: { label: "prospect", cls: "text-primary border-primary/25 bg-primary/5" },
  chatter: { label: "chatter", cls: "text-muted-foreground border-border bg-muted/50" },
};

function DeltaLine({ delta, label }: { delta: number | null; label: string }) {
  if (delta === null)
    return <span className="text-[11px] text-muted-foreground">building baseline…</span>;
  if (delta === 0)
    return <span className="text-[11px] text-muted-foreground">steady {label}</span>;
  const up = delta > 0;
  return (
    <span
      className={`text-[11px] inline-flex items-center gap-0.5 ${up ? "text-foreground" : "text-muted-foreground"}`}
    >
      {up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {Math.abs(delta)} {label}
    </span>
  );
}

function HomePage() {
  const {
    metrics,
    snapshot,
    added,
    attention: teamAttention,
    attentionTotal: teamAttentionTotal,
    digest,
    briefing,
    networkHealth,
  } = Route.useLoaderData();
  const { email, ready: authReady } = useAuth();
  const navigate = useNavigate();
  const router = useRouter();
  const { setFilters } = useFilters();
  const [briefingBusy, setBriefingBusy] = useState(false);
  const [myBusy, setMyBusy] = useState(false);
  const [myView, setMyView] = useState<{
    firstName: string;
    openFollowUps: number;
    attention: AttentionItem[];
    attentionTotal: number;
  } | null>(null);

  useEffect(() => {
    if (!authReady || !email) {
      setMyView(null);
      return;
    }
    let cancelled = false;
    setMyBusy(true);
    fetchMyAttention({ data: { email } })
      .then((res) => {
        if (cancelled) return;
        setMyView({
          firstName: res.firstName,
          openFollowUps: res.openFollowUps,
          attention: res.attention,
          attentionTotal: res.attentionTotal,
        });
      })
      .catch((e) => {
        console.error("fetchMyAttention failed", e);
        if (!cancelled) setMyView(null);
      })
      .finally(() => {
        if (!cancelled) setMyBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authReady, email]);

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

  const goWithFilter = (patch: Partial<ContactFilters>) => {
    setFilters({ ...defaultFilters, ownershipScope: "mine", ...patch });
    navigate({ to: "/crm" });
  };

  const now = new Date();
  const profile = teamProfile(email);
  const name = myView?.firstName || profile?.firstName || firstNameFrom(email);
  const attention = myView?.attention ?? teamAttention;
  const attentionTotal = myView?.attentionTotal ?? teamAttentionTotal;
  const openFollowUps = myView?.openFollowUps ?? metrics.openFollowUps;
  const personalized = !!myView;
  const longDate = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const base = snapshot.baseline;
  const delta = (key: keyof DailyMetrics, fallback: number | null) =>
    base ? metrics[key] - base[key] : fallback;

  const waking = metrics.hotLeads + (added.contacts || 0);
  const pulseValue = networkHealth;

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-10">
      {/* Hero — Relationship Pulse */}
      <section className="flex flex-col lg:flex-row lg:items-center gap-8 lg:gap-12">
        <div className="flex-1 min-w-0 space-y-3">
          <h1 className="font-display text-3xl sm:text-[2rem] font-semibold text-foreground tracking-tight">
            {greetingFor(now.getHours())}, {name}
          </h1>
          <p className="text-sm text-muted-foreground max-w-md">
            {longDate}
            {personalized ? " · your book" : ""}
          </p>
          <p className="text-sm text-foreground/80 max-w-lg leading-relaxed">
            {openFollowUps > 0
              ? `${openFollowUps} relationship${openFollowUps !== 1 ? "s" : ""} need judgment today. The network is already sorted.`
              : "Your network is steady. Nothing pressing — stay ahead of the quiet ones."}
          </p>
        </div>

        <div className="flex items-center gap-8 shrink-0">
          <PulseRing
            value={pulseValue}
            size="hero"
            breathe
            label={`${pulseValue}`}
            sublabel="network health"
            strokeColor="var(--primary)"
          />
          <div className="flex flex-col gap-5 min-w-[7.5rem]">
            <button
              type="button"
              onClick={() => goWithFilter({ followUpOnly: true, ownershipScope: "mine" })}
              className="text-left group"
            >
              <p className="text-[11px] font-medium text-[var(--copper-foreground)] tracking-wide">
                Needs you
              </p>
              <p className="text-2xl font-semibold tabular-nums text-foreground leading-none mt-1 group-hover:text-primary transition-colors">
                {attentionTotal}
              </p>
            </button>
            <button
              type="button"
              onClick={() => goWithFilter({ temperature: ["Hot"] })}
              className="text-left group"
            >
              <p className="text-[11px] font-medium text-muted-foreground tracking-wide">Waking</p>
              <p className="text-2xl font-semibold tabular-nums text-foreground leading-none mt-1 group-hover:text-primary transition-colors">
                {waking}
              </p>
            </button>
            <div>
              <p className="text-[11px] font-medium text-muted-foreground tracking-wide">Steady</p>
              <p className="text-2xl font-semibold tabular-nums text-foreground leading-none mt-1">
                {Math.max(0, metrics.contacts - metrics.hotLeads - openFollowUps)}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Quiet secondary metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border rounded-lg overflow-hidden border border-border">
        {(
          [
            {
              label: "Network",
              value: metrics.contacts,
              sub: <DeltaLine delta={delta("contacts", added.contacts)} label="this week" />,
              onActivate: () => navigate({ to: "/crm" }),
            },
            {
              label: "Hot",
              value: metrics.hotLeads,
              sub: <DeltaLine delta={delta("hotLeads", null)} label="this week" />,
              onActivate: () => goWithFilter({ temperature: ["Hot"] }),
            },
            {
              label: "Targets",
              value: metrics.targets,
              sub: <DeltaLine delta={delta("targets", added.targets)} label="this week" />,
              onActivate: () => navigate({ to: "/targeting" }),
            },
            {
              label: "Portfolio",
              value: metrics.portfolio,
              sub: <DeltaLine delta={delta("portfolio", null)} label="this week" />,
              onActivate: () => navigate({ to: "/portfolio" }),
            },
          ] as const
        ).map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={s.onActivate}
            className="bg-card px-4 py-3.5 text-left hover:bg-accent/60 transition-colors"
          >
            <p className="text-[11px] text-muted-foreground font-medium">{s.label}</p>
            <p className="text-lg font-semibold tabular-nums text-foreground mt-0.5">
              {s.value.toLocaleString()}
            </p>
            <div className="mt-1">{s.sub}</div>
          </button>
        ))}
      </div>

      {/* Attention + signals */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="border-border">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 text-[var(--copper)]" />
                Needs your attention
              </h2>
              <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
                {myBusy && <Loader2 className="h-3 w-3 animate-spin" />}
                {attentionTotal} items
                {personalized ? " · yours" : ""}
              </span>
            </div>
            {attention.length === 0 ? (
              <p className="text-xs text-muted-foreground py-6 text-center">
                {personalized
                  ? "Nothing in your book needs chasing right now."
                  : "Nothing needs chasing right now."}
              </p>
            ) : (
              <div className="divide-y divide-border">
                {attention.map((a: AttentionItem, idx: number) => {
                  const r = REASON_STYLE[a.reason];
                  return (
                    <Link
                      key={a.id}
                      to="/crm"
                      search={a.email ? { contact: a.email } : undefined}
                      className={`flex items-center gap-3 py-2.5 -mx-1 px-1 rounded-md hover:bg-accent transition-colors ${
                        idx === 0 ? "bg-[var(--copper)]/[0.04]" : ""
                      }`}
                    >
                      <ContactAvatar
                        contact={{ name: a.name, email: a.email, company: a.company }}
                        size="sm"
                      />
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
                        className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded border ${r.cls}`}
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
                onClick={() =>
                  setFilters({ ...defaultFilters, ownershipScope: "mine", followUpOnly: false })
                }
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-3"
              >
                View all {attentionTotal} <ArrowRight className="h-3 w-3" />
              </Link>
            )}
          </CardContent>
        </Card>

        <Card className="border-border">
          <CardContent className="p-5">
            <Suspense fallback={<DigestSkeleton />}>
              <Await promise={digest}>{(d) => <DigestBody digest={d as HomeDigest} />}</Await>
            </Suspense>
          </CardContent>
        </Card>
      </div>

      <DailyBriefing briefing={briefing} busy={briefingBusy} onGenerate={runBriefing} />

      <WorkspaceGrid />
    </div>
  );
}

/** Quiet workspace list — no pastel tiles, no idle icon loops. */
function WorkspaceGrid() {
  return (
    <div>
      <h2 className="text-sm font-semibold text-foreground mb-3">Workspaces</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        {MODULES.map((m) => (
          <Link key={m.url} to={m.url} className="group block">
            <div className="h-full rounded-lg border border-border bg-card px-3.5 py-3 surface-hover flex items-start gap-3">
              <div className={`mt-0.5 ${m.accent}`}>
                <m.Icon className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-medium text-foreground">{m.title}</h3>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                  {m.description}
                </p>
              </div>
            </div>
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
          <Radar className="h-3.5 w-3.5 text-primary" />
          Today's signals
        </h2>
        <span className="text-[11px] text-muted-foreground">
          {digest.newCount > 0 ? `${digest.newCount} new` : "triaged"}
        </span>
      </div>
      {digest.items.length === 0 ? (
        <p className="text-xs text-muted-foreground py-6 text-center">
          No stored signals yet — run a scan from Signals.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {digest.items.map((it, i) => {
            const b = BADGE_STYLE[it.badge];
            return (
              <Link
                key={i}
                to="/signals"
                search={{ q: it.headline }}
                className="flex items-center gap-2 py-2.5 -mx-1 px-1 rounded-md hover:bg-accent transition-colors"
              >
                {i === 0 && digest.newCount > 0 && (
                  <PulseRing value={72} size="xs" strokeColor="var(--primary)" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">{it.headline}</p>
                  <p className="text-[11px] text-muted-foreground truncate">{it.sub}</p>
                </div>
                <span
                  className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded border ${b.cls}`}
                >
                  {b.label}
                </span>
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
          <Radar className="h-3.5 w-3.5 text-primary" />
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
            <div className="h-4 w-14 rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
