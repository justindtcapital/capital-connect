import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { scanSignals, fetchSignals, fetchSignalBody } from "@/utils/gemini.functions";
import {
  logSignalFeedback,
  fetchSignalQualityMetrics,
} from "@/utils/signal-feedback.functions";
import { fetchLinkedInFeed } from "@/utils/linkedin.functions";
import { fetchDriveDocs } from "@/utils/drive.functions";
import { fetchGmailFeed } from "@/utils/gmail.functions";
import { fetchPortfolioCompanies, fetchContacts } from "@/utils/sheets.functions";
import {
  recordVerdict,
  fetchWatchUniverse,
  setWatchTier,
  type WatchEntity,
} from "@/utils/intel.functions";
import { fetchSignalTopics, pinSignalTopic } from "@/utils/signal-topics.functions";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth-context";
import type { Contact, PortfolioCompany } from "@/lib/types";
import {
  buildFeed,
  bucketOf,
  SOURCE_TYPES,
  SEGMENTS,
  INDUSTRIES,
  type FeedCard,
} from "@/lib/signal-feed";
import { companyLogoSources } from "@/lib/domain-utils";
import type { ScoredTarget } from "@/utils/broadcast.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmailDraftDialog } from "@/components/crm/EmailDraftDialog";
import { BroadcastDialog } from "@/components/crm/BroadcastDialog";
import { MarkdownMessage } from "@/components/query/MarkdownMessage";
import {
  Radar,
  Sparkles,
  ExternalLink,
  AlertTriangle,
  Loader2,
  Newspaper,
  Share2,
  Search,
  X,
  ChevronDown,
  ChevronRight,
  Building2,
  Mail,
  FileText,
  Zap,
  BadgeCheck,
  Layers,
  Pin,
  Globe,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/signals")({
  // `?q=<text>` seeds the search box so a deep-link (e.g. from the home page's
  // "Today's signals") lands filtered to that specific signal.
  validateSearch: (search: Record<string, unknown>): { q?: string } => ({
    q: typeof search.q === "string" ? search.q : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Signals — VenturePulse" },
      {
        name: "description",
        content: "Relationship radar: recent news + LinkedIn mapped to your network",
      },
    ],
  }),
  loader: async () => ({
    signals: await fetchSignals(),
    linkedin: await fetchLinkedInFeed(),
    drive: await fetchDriveDocs(),
    gmail: await fetchGmailFeed(),
    portfolio: await fetchPortfolioCompanies(),
    contacts: await fetchContacts().catch((): Contact[] => []),
  }),
  component: SignalsPage,
});

const sourceTypeClass: Record<string, string> = {
  "PortCo Blogs": "bg-emerald-50 text-emerald-700 border-emerald-200",
  "PortCo News": "bg-sky-50 text-sky-700 border-sky-200",
  "Industry Reports": "bg-amber-50 text-amber-700 border-amber-200",
  "Industry News": "bg-indigo-50 text-indigo-700 border-indigo-200",
  LinkedIn: "bg-[#0a66c2]/5 text-[#0a66c2] border-[#0a66c2]/20",
};

const segmentClass: Record<string, string> = {
  Security: "bg-red-50 text-red-700 border-red-200",
  AI: "bg-violet-50 text-violet-700 border-violet-200",
  Data: "bg-blue-50 text-blue-700 border-blue-200",
  "Supply Chain": "bg-teal-50 text-teal-700 border-teal-200",
  Cloud: "bg-cyan-50 text-cyan-700 border-cyan-200",
};

// Time filter windows (max age in days). "120+" has no upper bound → show all.
const DATE_RANGES: Record<string, number> = {
  "1": 1,
  "7": 7,
  "30": 30,
  "60": 60,
  "90": 90,
};

// WS5 feed budget — presentation-layer only (downstream consumers read all
// rows). Mirrors DEFAULT_SIGNAL_CONFIG.feed; the sheet-config override applies
// server-side scores, these only shape the morning view.
const FEED_BUDGET_N = 8;
const FEED_MIN_RANK = 20;

// ── Grounded score chips ─────────────────────────────────────────
function oppClass(score: number): string {
  if (score >= 70) return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (score >= 45) return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-muted text-muted-foreground border-border";
}
const LEVEL_CLASS: Record<string, string> = {
  Strong: "text-emerald-700",
  Some: "text-sky-700",
  High: "text-emerald-700",
  Medium: "text-amber-700",
  Low: "text-muted-foreground",
  None: "text-muted-foreground",
};
const RISK_CLASS: Record<string, string> = {
  High: "text-red-600",
  Medium: "text-amber-700",
  Low: "text-muted-foreground",
  None: "text-muted-foreground",
};

function Metric({
  label,
  value,
  cls,
  title,
}: {
  label: string;
  value: string;
  cls?: string;
  title?: string;
}) {
  return (
    <div className="flex flex-col leading-tight" title={title}>
      <span className="text-[8px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={`text-[11px] font-semibold ${cls || "text-foreground"}`}>{value}</span>
    </div>
  );
}

// Compact strength strip shown on every card — each value traces to evidence.
function ScoreStrip({ card }: { card: FeedCard }) {
  const s = card.insight?.scores;
  if (!s) return null;
  return (
    <div className="flex items-center gap-3 mt-2 flex-wrap">
      <span
        className={`inline-flex items-baseline gap-1 rounded-md border px-1.5 py-0.5 ${oppClass(s.opportunity)}`}
        title="Blended priority (relevance, freshness, network, competitive, source confidence)"
      >
        <span className="text-sm font-bold tabular-nums leading-none">{s.opportunity}</span>
        <span className="text-[8px] uppercase tracking-wider">opp</span>
      </span>
      <Metric
        label="Fresh"
        value={s.freshnessLabel}
        title="Time since the event (from the signal date)"
      />
      <Metric
        label="Network"
        value={s.network.level === "None" ? "—" : s.network.level}
        cls={LEVEL_CLASS[s.network.level]}
        title={
          s.network.count > 0
            ? `${s.network.count} of your contacts at this company`
            : "No contacts here yet"
        }
      />
      {s.competitive.level !== "None" && (
        <Metric
          label="Compete"
          value={s.competitive.level}
          cls={RISK_CLASS[s.competitive.level]}
          title="Threat/relevance to your portfolio's space"
        />
      )}
      <Metric
        label="Confidence"
        value={s.confidence.level}
        cls={LEVEL_CLASS[s.confidence.level]}
        title={s.confidence.reason}
      />
    </div>
  );
}

// ── Event badges (Signals v2) ────────────────────────────────────
// DETECTED BEFORE PRESS is the alpha class — intel-engine evidence with no
// press coverage yet — and renders visibly distinct from everything else.
function EventBadges({ card }: { card: FeedCard }) {
  const badges = card.badges ?? [];
  const chips: React.ReactNode[] = [];
  if (badges.includes("DETECTED_BEFORE_PRESS")) {
    chips.push(
      <span
        key="dbp"
        title="The intel engine measured this development directly — no press coverage exists yet. The firm knows before the market does."
        className="inline-flex items-center gap-1 rounded-md border border-violet-400 bg-violet-600 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white shadow-sm"
      >
        <Zap className="h-3 w-3" /> Detected before press
      </span>,
    );
  }
  if (badges.includes("CONFIRMED_BY_PRESS")) {
    chips.push(
      <span
        key="cbp"
        title="The intel engine detected this first; press coverage has since confirmed it."
        className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700"
      >
        <BadgeCheck className="h-3 w-3" /> Confirmed by press
      </span>,
    );
  } else if (badges.includes("INTEL_CORROBORATED")) {
    chips.push(
      <span
        key="ic"
        title="Independent intel-engine observations corroborate this story."
        className="inline-flex items-center gap-1 rounded-md border border-sky-300 bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700"
      >
        <BadgeCheck className="h-3 w-3" /> Intel corroborated
      </span>,
    );
  }
  if ((card.sourceCount ?? 1) > 1) {
    chips.push(
      <span
        key="src"
        title={`${card.sourceCount} corroborating sources collapsed into this card`}
        className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
      >
        <Layers className="h-3 w-3" /> ×{card.sourceCount} sources
      </span>,
    );
  }
  if (chips.length === 0) return null;
  return <div className="flex items-center gap-1.5 flex-wrap mt-1.5">{chips}</div>;
}

// ── WS6 — watch-universe tier editor ─────────────────────────────
// Tier 1: portcos/active targets — everything, daily. Tier 2: watchlist —
// intel daily, news weekly. Tier 3: broad universe — ATS + Form D only.
// Auto-promotion T3→T2 is signal-driven; edits here are the reversal path.
const TIER_LABEL: Record<number, string> = {
  1: "1 — full, daily",
  2: "2 — intel daily · news weekly",
  3: "3 — ATS + Form D only",
};

function WatchUniverseDialog({
  open,
  onOpenChange,
  user,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  user?: string;
}) {
  const [entities, setEntities] = useState<WatchEntity[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetchWatchUniverse()
      .then((r) => setEntities(r.entities))
      .catch(() => toast.error("Could not load the watch universe."))
      .finally(() => setLoading(false));
  }, [open]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? entities.filter(
          (e) => e.name.toLowerCase().includes(needle) || e.domain.includes(needle),
        )
      : entities;
    return [...list].sort((a, b) => a.watchTier - b.watchTier || a.name.localeCompare(b.name));
  }, [entities, q]);

  const changeTier = async (e: WatchEntity, wt: number) => {
    const prev = e.watchTier;
    setEntities((list) =>
      list.map((x) => (x.urid === e.urid ? { ...x, watchTier: wt } : x)),
    );
    const r = await setWatchTier({ data: { urid: e.urid, watchTier: wt, user } }).catch(
      () => ({ ok: false as const }),
    );
    if (!r.ok) {
      setEntities((list) =>
        list.map((x) => (x.urid === e.urid ? { ...x, watchTier: prev } : x)),
      );
      toast.error(`Could not update ${e.name}.`);
    }
  };

  const counts = useMemo(() => {
    const c: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
    for (const e of entities) c[e.watchTier] = (c[e.watchTier] || 0) + 1;
    return c;
  }, [entities]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">Watch universe</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground -mt-1">
          Tier 1 full+daily · Tier 2 intel daily, news weekly · Tier 3 cheap
          high-precision only (ATS + SEC Form D). Tier-3 companies that trip ≥2
          detector families in 30 days auto-promote to Tier 2 — demoting here
          reverses that and resets the evidence.
        </p>
        <div className="flex items-center gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search companies…"
            className="h-8 text-xs"
          />
          <span className="text-[10px] text-muted-foreground whitespace-nowrap tabular-nums">
            T1 {counts[1]} · T2 {counts[2]} · T3 {counts[3]}
          </span>
        </div>
        <div className="max-h-[50vh] overflow-auto rounded-md border border-border divide-y divide-border/60">
          {loading ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mx-auto mb-2" /> Loading…
            </div>
          ) : shown.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No tracked companies match.
            </div>
          ) : (
            shown.slice(0, 300).map((e) => (
              <div key={e.urid} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <span className="font-medium truncate">{e.name}</span>
                {e.domain && (
                  <span className="text-muted-foreground truncate">{e.domain}</span>
                )}
                <Badge variant="outline" className="text-[9px] uppercase shrink-0">
                  {e.tier}
                </Badge>
                <div className="ml-auto shrink-0">
                  <Select
                    value={String(e.watchTier)}
                    onValueChange={(v) => changeTier(e, Number(v))}
                  >
                    <SelectTrigger className="h-7 w-52 text-[11px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[1, 2, 3].map((t) => (
                        <SelectItem key={t} value={String(t)} className="text-xs">
                          {TIER_LABEL[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CompanyAvatar({ card }: { card: FeedCard }) {
  const [stage, setStage] = useState(0);
  const d = card.logoDomain;
  const confidence = card.logoConfident === false ? "low" : "high";
  const sources = useMemo(
    () => (d ? companyLogoSources(d, confidence) : []),
    [d, confidence],
  );
  useEffect(() => {
    setStage(0);
  }, [sources.join("|")]);

  if (d && stage < sources.length) {
    const src = sources[stage];
    return (
      <img
        key={src}
        src={src}
        alt=""
        className="h-9 w-9 rounded-md border border-border object-contain bg-white shrink-0"
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setStage((s) => s + 1)}
      />
    );
  }
  return (
    <div className="h-9 w-9 rounded-md bg-primary/10 text-primary flex items-center justify-center text-sm font-semibold shrink-0">
      {card.initial}
    </div>
  );
}

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

// Groups the filter rail into the user's top-level buckets (PortCo / Industry).
function SectionHeader({ title }: { title: string }) {
  return (
    <div className="pt-1 border-b border-border pb-1 text-[11px] font-bold uppercase tracking-wider text-foreground/80">
      {title}
    </div>
  );
}

function CheckRow({
  checked,
  onChange,
  label,
  count,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  count?: number;
}) {
  return (
    <label className="flex items-center gap-2 text-xs cursor-pointer py-0.5 hover:text-foreground">
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onChange(Boolean(v))}
        className="h-3.5 w-3.5"
      />
      <span className="flex-1 truncate">{label}</span>
      {count != null && <span className="text-muted-foreground tabular-nums">{count}</span>}
    </label>
  );
}

function SignalsPage() {
  const { signals: stored, linkedin, drive, gmail, portfolio, contacts } = Route.useLoaderData();
  const { q: focusQuery } = Route.useSearch();
  const [windowDays, setWindowDays] = useState("14");
  const [sortBy, setSortBy] = useState<"fresh" | "opportunity" | "rank">("rank");
  const [lowerOpen, setLowerOpen] = useState(false);
  // p@10 trend for the header readout (lazy — never blocks the feed).
  const [precision, setPrecision] = useState<Array<{ date: string; value: number }>>([]);
  useEffect(() => {
    fetchSignalQualityMetrics()
      .then((r) => setPrecision(r.precisionAt10.slice(-14)))
      .catch(() => {});
  }, []);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState(
    stored && (stored.recommendations.length > 0 || stored.otherSignals.length > 0) ? stored : null,
  );

  // Filters (search seeded from a `?q=` deep-link, e.g. from the home page).
  const [search, setSearch] = useState(focusQuery ?? "");
  const [dateRange, setDateRange] = useState("120"); // "120" = 120+ days = all
  const [sourceSel, setSourceSel] = useState<string[]>([]);
  const [segSel, setSegSel] = useState<string[]>([]);
  const [coSel, setCoSel] = useState<string[]>([]);
  const [invSel, setInvSel] = useState<string[]>([]);
  const [indSel, setIndSel] = useState<string[]>([]);
  const [keyCompaniesOnly, setKeyCompaniesOnly] = useState(false);

  const [expanded, setExpanded] = useState<string | null>(null);

  // Lazily-fetched outreach bodies (elided from the feed load to keep it light),
  // keyed by card id, plus in-flight tracking.
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [bodyBusy, setBodyBusy] = useState<Record<string, boolean>>({});
  // Partner feedback per card — labels for the intel learning loop.
  const [verdicts, setVerdicts] = useState<Record<string, string>>({});
  const { email: authEmail } = useAuth();
  const submitVerdict = async (
    card: FeedCard,
    verdict: "useful" | "not_useful" | "already_knew",
  ) => {
    if (!card.storedId) return;
    setVerdicts((prev) => ({ ...prev, [card.id]: verdict }));
    // "Not useful" is the feed's dismissal — it also lands in the WS5
    // interaction log so the nightly job never counts the card as ignored.
    if (verdict === "not_useful") logFeedback(card, "dismissed");
    try {
      await recordVerdict({
        data: {
          signalId: card.storedId,
          company: card.company,
          verdict,
          user: authEmail || undefined,
        },
      });
    } catch (e) {
      console.error("recordVerdict failed", e);
    }
  };

  const loadBody = async (card: FeedCard) => {
    if (!card.storedId || bodies[card.id] != null || bodyBusy[card.id]) return;
    setBodyBusy((b) => ({ ...b, [card.id]: true }));
    try {
      const r = await fetchSignalBody({ data: { id: card.storedId } });
      setBodies((m) => ({ ...m, [card.id]: r.body || "" }));
    } catch {
      setBodies((m) => ({ ...m, [card.id]: "" }));
    } finally {
      setBodyBusy((b) => ({ ...b, [card.id]: false }));
    }
  };

  // ── Topic search bar (tuneable keyword collection) ──────────────
  // Type keywords → instant filter of stored signals; "Scan web" grabs fresh
  // stories about the subject (grounded, attributed, clustered, ranked like
  // any other signal); pinning makes the topic ride every scheduled scan.
  const [topicInput, setTopicInput] = useState("");
  const [topicScanning, setTopicScanning] = useState(false);
  const [pinnedTopics, setPinnedTopics] = useState<string[]>([]);
  const [pinBusy, setPinBusy] = useState(false);
  useEffect(() => {
    fetchSignalTopics()
      .then((r) => setPinnedTopics(r.topics))
      .catch(() => {});
  }, []);

  const applyTopicFilter = (phrase: string) => {
    setTopicInput(phrase);
    setSearch(phrase);
  };

  const runTopicScan = async () => {
    const topic = topicInput.trim();
    if (!topic || topicScanning) return;
    setTopicScanning(true);
    try {
      const res = await scanSignals({ data: { windowDays: Number(windowDays), topic } });
      if (!res.found && res.error) {
        toast.error(res.error);
      } else {
        setResult(res);
        setSearch(topic);
        const n = res.newCount ?? 0;
        toast[n > 0 ? "success" : "info"](
          n > 0
            ? `${n} new stor${n === 1 ? "y" : "ies"} about “${topic}” added to the feed.`
            : `No new stories found for “${topic}” — showing what's already stored.`,
        );
      }
    } catch (e) {
      console.error("topic scan failed", e);
      toast.error("Topic scan failed — see console.");
    } finally {
      setTopicScanning(false);
    }
  };

  const togglePin = async (phrase: string, pinned: boolean) => {
    const topic = phrase.trim();
    if (!topic || pinBusy) return;
    setPinBusy(true);
    try {
      const r = await pinSignalTopic({ data: { topic, pinned } });
      if (r.ok) {
        setPinnedTopics(r.topics);
        toast.success(
          pinned
            ? `Pinned “${topic}” — every scheduled morning scan now covers it.`
            : `Unpinned “${topic}”.`,
        );
      } else {
        toast.error(r.error || "Could not update pinned topics.");
      }
    } finally {
      setPinBusy(false);
    }
  };

  // Broadcast + email dialogs
  const [watchOpen, setWatchOpen] = useState(false);
  const [broadcastCard, setBroadcastCard] = useState<FeedCard | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftContact, setDraftContact] = useState<Contact | null>(null);
  const [draftSeed, setDraftSeed] = useState<{ purpose: string; notes: string }>({
    purpose: "",
    notes: "",
  });

  const feed = useMemo(
    () =>
      buildFeed({
        recommendations: result?.recommendations ?? [],
        otherSignals: result?.otherSignals ?? [],
        linkedinPosts: linkedin?.posts ?? [],
        driveDocs: drive?.docs ?? [],
        emails: gmail?.emails ?? [],
        orgName: linkedin?.orgName,
        portfolio: portfolio ?? [],
        contacts: contacts ?? [],
      }),
    [result, linkedin, drive, gmail, portfolio, contacts],
  );

  // Filter lists are the full canonical taxonomies (always shown). The portfolio
  // company list is the full portfolio, narrowed to the selected segments.
  const companies = useMemo(() => {
    let list: PortfolioCompany[] = portfolio ?? [];
    if (segSel.length) list = list.filter((p) => segSel.includes(bucketOf(p.domain)));
    return [...list].map((p) => p.name).sort((a, b) => a.localeCompare(b));
  }, [portfolio, segSel]);

  // DTC investor names, from the portfolio companies' "Lead Investor" Asana field.
  const investors = useMemo(() => {
    const set = new Set<string>();
    for (const p of portfolio ?? []) {
      const raw = p.asanaFields?.["Lead Investor"]?.trim();
      if (raw) set.add(raw);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [portfolio]);

  const filtered = useMemo(() => {
    // Keyword search is token-AND: every term must appear somewhere in the
    // card text, so "agentic security" matches "agentic identity security".
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const minTs = dateRange in DATE_RANGES ? Date.now() - DATE_RANGES[dateRange] * 86_400_000 : 0;
    const out = feed.filter((c) => {
      if (terms.length > 0) {
        const hay = `${c.headline} ${c.summary} ${c.company} ${c.category || ""}`.toLowerCase();
        if (!terms.every((t) => hay.includes(t))) return false;
      }
      if (minTs && (!c.sortTs || c.sortTs < minTs)) return false;
      if (sourceSel.length && !sourceSel.includes(c.sourceType)) return false;
      if (segSel.length && !segSel.includes(c.segmentBucket)) return false;
      if (coSel.length && !coSel.includes(c.company)) return false;
      if (invSel.length && (!c.investor || !invSel.includes(c.investor))) return false;
      if (indSel.length && (!c.industry || !indSel.includes(c.industry))) return false;
      if (keyCompaniesOnly && !(c.insight && c.insight.scores.network.count > 0)) return false;
      return true;
    });
    if (sortBy === "opportunity") {
      // feed is already newest-first, so sortTs is a stable tiebreak.
      return [...out].sort(
        (a, b) => (b.insight?.scores.opportunity ?? 0) - (a.insight?.scores.opportunity ?? 0),
      );
    }
    if (sortBy === "rank") {
      // Materiality rank first; unscored cards fall back to opportunity below
      // every scored card.
      return [...out].sort(
        (a, b) =>
          (b.rankScore ?? -1) - (a.rankScore ?? -1) ||
          (b.insight?.scores.opportunity ?? 0) - (a.insight?.scores.opportunity ?? 0),
      );
    }
    return out;
  }, [feed, search, dateRange, sourceSel, segSel, coSel, invSel, indSel, keyCompaniesOnly, sortBy]);

  const activeFilterCount =
    sourceSel.length +
    segSel.length +
    coSel.length +
    invSel.length +
    indSel.length +
    (search ? 1 : 0) +
    (dateRange !== "120" ? 1 : 0) +
    (keyCompaniesOnly ? 1 : 0);

  // ── WS5 feed budget & abstention (presentation-layer only) ──────
  // In rank mode with no filters active, the morning view shows at most
  // FEED_BUDGET_N cards clearing FEED_MIN_RANK; the rest collapse into
  // "Lower priority (K)" — fully retrievable, never padded.
  const budgetActive = sortBy === "rank" && activeFilterCount === 0;
  const { topCards, lowerCards } = useMemo(() => {
    if (!budgetActive) return { topCards: filtered, lowerCards: [] as FeedCard[] };
    const top: FeedCard[] = [];
    const lower: FeedCard[] = [];
    for (const c of filtered) {
      if (top.length < FEED_BUDGET_N && (c.rankScore ?? -1) >= FEED_MIN_RANK) top.push(c);
      else lower.push(c);
    }
    return { topCards: top, lowerCards: lower };
  }, [filtered, budgetActive]);

  // Rank position (1-based) of each top card — frozen into feedback rows.
  const rankPositionOf = (card: FeedCard): number | null => {
    const i = topCards.indexOf(card);
    return i >= 0 ? i + 1 : null;
  };

  // What actually renders: the budgeted top-N, plus the lower tier only when
  // the user expands it. Without the budget, everything (as before).
  const displayCards = budgetActive ? (lowerOpen ? [...topCards, ...lowerCards] : topCards) : filtered;

  // ── WS5 instrumentation ─────────────────────────────────────────
  const logFeedback = (
    card: FeedCard,
    action: "rendered" | "expanded" | "clicked_source" | "actioned" | "dismissed",
  ) => {
    logSignalFeedback({
      data: {
        user: authEmail || undefined,
        events: [
          {
            eventId: card.eventId,
            signalId: card.storedId,
            action,
            rankPosition: rankPositionOf(card),
            features: {
              opportunity: card.insight?.scores.opportunity,
              clientRank: card.rankScore,
              badges: card.badges?.join(";") || undefined,
            },
          },
        ],
      },
    }).catch(() => {});
  };
  // One "rendered" batch per page load for the budgeted top-N.
  const renderedLogged = useRef(false);
  useEffect(() => {
    if (renderedLogged.current || !budgetActive || topCards.length === 0) return;
    renderedLogged.current = true;
    logSignalFeedback({
      data: {
        user: authEmail || undefined,
        events: topCards
          .filter((c) => c.eventId || c.storedId)
          .map((c, i) => ({
            eventId: c.eventId,
            signalId: c.storedId,
            action: "rendered" as const,
            rankPosition: i + 1,
            features: {
              opportunity: c.insight?.scores.opportunity,
              clientRank: c.rankScore,
            },
          })),
      },
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budgetActive, topCards]);

  const activeFilters = activeFilterCount;
  const clearFilters = () => {
    setSearch("");
    setDateRange("120");
    setSourceSel([]);
    setSegSel([]);
    setCoSel([]);
    setInvSel([]);
    setIndSel([]);
    setKeyCompaniesOnly(false);
  };
  const toggle = (arr: string[], set: (v: string[]) => void, val: string) =>
    set(arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val]);

  const runScan = async () => {
    setScanning(true);
    setResult(null);
    try {
      const res = await scanSignals({ data: { windowDays: Number(windowDays) } });
      if (!res.found && res.error) {
        toast.error(res.error);
      } else {
        const total = res.recommendations.length + res.otherSignals.length;
        const newCount = res.newCount ?? 0;
        if (newCount === 0)
          toast.info(total > 0 ? "No new signals — showing stored ones." : "No signals found yet.");
        else
          toast.success(
            `${newCount} new signal${newCount !== 1 ? "s" : ""} added · ${total} total`,
          );
      }
      setResult(res);
    } catch (e) {
      console.error("scanSignals failed", e);
      toast.error("Scan failed — see console.");
    } finally {
      setScanning(false);
    }
  };

  // Email a scored Broadcast target (reuses EmailDraftDialog).
  const emailTarget = (t: ScoredTarget) => {
    const card = broadcastCard;
    if (!t.email) {
      toast.error("No email on file for this contact.");
      return;
    }
    setDraftContact({
      id: `signal-${t.email}`,
      name: t.name,
      title: t.title,
      company: t.company,
      email: t.email,
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
    });
    setDraftSeed({
      purpose: card ? `${card.company}: ${card.headline}` : "Outreach on a recent signal",
      notes: card?.sourceUrl ? `Reference: ${card.sourceUrl}` : "",
    });
    setBroadcastCard(null);
    setDraftOpen(true);
  };

  // Email a network connection surfaced on a card (the attached person or anyone
  // in the "who might care" list) — seeds EmailDraftDialog with the signal.
  const emailConnection = (
    card: FeedCard,
    conn: { name?: string; title?: string; email?: string },
  ) => {
    if (!conn.email) {
      toast.error("No email on file for this contact.");
      return;
    }
    logFeedback(card, "actioned");
    setDraftContact({
      id: `signal-${conn.email}`,
      name: conn.name || "",
      title: conn.title || "",
      company: card.company,
      email: conn.email,
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
    });
    setDraftSeed({
      purpose: `${card.category ? `${card.category}: ` : ""}${card.headline}`,
      notes: card.sourceUrl ? `Reference: ${card.sourceUrl}` : "",
    });
    setDraftOpen(true);
  };

  // The "who might care" connections shown at the bottom of an expanded card:
  // the attached person plus any network contacts at the company (deduped).
  const connectionsFor = (card: FeedCard): { name: string; title: string; email: string }[] => {
    const out: { name: string; title: string; email: string }[] = [];
    const seen = new Set<string>();
    const add = (name: string, title: string, email: string) => {
      const key = (email || name).toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push({ name, title, email });
    };
    if (card.email) add(card.person || "Contact", "", card.email);
    for (const c of card.insight?.scores.network.contacts ?? []) add(c.name, c.title, c.email);
    return out;
  };

  const nothingAtAll = feed.length === 0;

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-3">
        <div>
          <h1 className="text-lg font-bold tracking-tight flex items-center gap-2">
            <Radar className="h-5 w-5 text-primary" /> Signal Radar
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Real signals across your network — Gemini web-search + LinkedIn + shared-drive docs,
            with one-click Share.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" onClick={() => setWatchOpen(true)}>
            <Building2 className="h-4 w-4" /> Watch universe
          </Button>
          <Select value={windowDays} onValueChange={setWindowDays}>
            <SelectTrigger className="h-9 w-32 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="14">Last 14 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={runScan} disabled={scanning}>
            {scanning ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Scanning…
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" /> Run scan
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Topic bar — tuneable keyword collection. Enter filters what's stored;
          "Scan web" fetches fresh stories about the subject; pinning makes the
          topic part of every scheduled morning scan. */}
      <div className="border-b border-border bg-muted/20 px-6 py-2.5">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 max-w-xl">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={topicInput}
              onChange={(e) => setTopicInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setSearch(topicInput.trim());
              }}
              placeholder="Search stories by keyword — e.g. agentic security, warehouse robotics…"
              className="h-9 pl-8 text-sm bg-card"
            />
            {topicInput && (
              <button
                type="button"
                onClick={() => {
                  setTopicInput("");
                  setSearch("");
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                title="Clear"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <Button
            variant="secondary"
            className="h-9"
            onClick={() => setSearch(topicInput.trim())}
            disabled={!topicInput.trim()}
            title="Filter the stored feed to these keywords (all terms must match)"
          >
            <Search className="h-4 w-4" /> Filter
          </Button>
          <Button
            className="h-9"
            onClick={runTopicScan}
            disabled={topicScanning || !topicInput.trim()}
            title="Search the web for recent stories about this subject and add them to the feed"
          >
            {topicScanning ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Scanning…
              </>
            ) : (
              <>
                <Globe className="h-4 w-4" /> Scan web
              </>
            )}
          </Button>
          <Button
            variant="outline"
            className="h-9"
            onClick={() => togglePin(topicInput, true)}
            disabled={
              pinBusy ||
              !topicInput.trim() ||
              pinnedTopics.some((t) => t.toLowerCase() === topicInput.trim().toLowerCase())
            }
            title="Pin this topic — every scheduled morning scan will cover it"
          >
            <Pin className="h-4 w-4" /> Pin
          </Button>
        </div>
        {pinnedTopics.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap mt-2">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
              Pinned topics (scanned daily)
            </span>
            {pinnedTopics.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 rounded-md border border-primary/25 bg-primary/5 pl-1.5 pr-1 py-0.5 text-[11px] text-primary"
              >
                <button
                  type="button"
                  onClick={() => applyTopicFilter(t)}
                  className="hover:underline"
                  title="Filter the feed to this topic"
                >
                  {t}
                </button>
                <button
                  type="button"
                  onClick={() => togglePin(t, false)}
                  className="rounded hover:bg-primary/10 p-0.5"
                  title="Unpin — stop scanning this topic daily"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Filter rail */}
        <aside className="w-64 shrink-0 overflow-auto border-r border-border p-4 space-y-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold">Filters</span>
            {activeFilters > 0 && (
              <button
                onClick={clearFilters}
                className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5"
              >
                <X className="h-3 w-3" /> Clear ({activeFilters})
              </button>
            )}
          </div>

          <FilterGroup title="Search">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search signals…"
                className="h-9 pl-7 text-xs"
              />
            </div>
          </FilterGroup>

          <FilterGroup title="Time">
            <Select value={dateRange} onValueChange={setDateRange}>
              <SelectTrigger className="h-9 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">Last day</SelectItem>
                <SelectItem value="7">Last week</SelectItem>
                <SelectItem value="30">Last month</SelectItem>
                <SelectItem value="60">Last 60 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
                <SelectItem value="120">Last 120+ days</SelectItem>
              </SelectContent>
            </Select>
          </FilterGroup>

          <FilterGroup title="Sources">
            {SOURCE_TYPES.map((s) => (
              <CheckRow
                key={s}
                checked={sourceSel.includes(s)}
                onChange={() => toggle(sourceSel, setSourceSel, s)}
                label={s}
              />
            ))}
          </FilterGroup>

          <SectionHeader title="PortCo Filters" />

          <FilterGroup title="Segment">
            {SEGMENTS.map((s) => (
              <CheckRow
                key={s}
                checked={segSel.includes(s)}
                onChange={() => toggle(segSel, setSegSel, s)}
                label={s}
              />
            ))}
          </FilterGroup>

          <FilterGroup title="Port Co">
            {companies.length > 0 ? (
              <div className="max-h-56 overflow-auto rounded-md border border-border p-2">
                {companies.map((s) => (
                  <CheckRow
                    key={s}
                    checked={coSel.includes(s)}
                    onChange={() => toggle(coSel, setCoSel, s)}
                    label={s}
                  />
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                No portfolio companies in this segment.
              </p>
            )}
          </FilterGroup>

          <FilterGroup title="Investor">
            {investors.length > 0 ? (
              <div className="max-h-56 overflow-auto rounded-md border border-border p-2">
                {investors.map((s) => (
                  <CheckRow
                    key={s}
                    checked={invSel.includes(s)}
                    onChange={() => toggle(invSel, setInvSel, s)}
                    label={s}
                  />
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                No investors on the portfolio records yet.
              </p>
            )}
          </FilterGroup>

          <SectionHeader title="Industry Filters" />

          <FilterGroup title="Industry">
            {INDUSTRIES.map((s) => (
              <CheckRow
                key={s}
                checked={indSel.includes(s)}
                onChange={() => toggle(indSel, setIndSel, s)}
                label={s}
              />
            ))}
          </FilterGroup>

          <FilterGroup title="Key companies">
            <CheckRow
              checked={keyCompaniesOnly}
              onChange={setKeyCompaniesOnly}
              label="Only companies in my network"
            />
          </FilterGroup>
        </aside>

        {/* Feed */}
        <main className="flex-1 overflow-auto p-6">
          {linkedin && !linkedin.configured && (
            <div className="mb-4 rounded-lg border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
              Connect LinkedIn (LINKEDIN_ACCESS_TOKEN + LINKEDIN_ORG_ID in .env) to pull
              company-page posts into the feed.
            </div>
          )}
          {drive && drive.configured && drive.error && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" /> Drive: {drive.error}
            </div>
          )}
          {gmail && !gmail.configured && (
            <div className="mb-4 rounded-lg border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
              Connect Gmail to pull recent emails with your network into the feed. Re-run{" "}
              <span className="font-mono">node mint-google-token.mjs</span> (now requests{" "}
              <span className="font-mono">gmail.readonly</span>), enable the Gmail API, then set{" "}
              <span className="font-mono">GMAIL_SIGNALS_ENABLED=true</span> in{" "}
              <span className="font-mono">.env</span>.
            </div>
          )}
          {gmail && gmail.configured && gmail.error && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" /> Gmail: {gmail.error}
            </div>
          )}
          {result?.compliance && result.compliance.length > 0 && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <div className="flex items-center gap-2 text-amber-800 text-sm font-semibold mb-1">
                <AlertTriangle className="h-4 w-4" /> Compliance flags
              </div>
              <ul className="list-disc pl-6 text-xs text-amber-700 space-y-0.5">
                {result.compliance.map((c: string, i: number) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}

          {scanning && (
            <div className="rounded-lg border border-border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin mx-auto mb-3 text-primary" />
              Searching the web and reasoning over your network. This can take 30–90 seconds.
            </div>
          )}

          {!scanning && nothingAtAll && (
            <div className="rounded-lg border border-dashed border-border p-10 text-center">
              <Newspaper className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Run a scan to surface recent news mapped to your relationships.
              </p>
            </div>
          )}

          {!scanning && !nothingAtAll && (
            <>
              <div className="flex items-center justify-between mb-3 gap-3">
                <div className="text-xs text-muted-foreground flex items-center gap-3">
                  <span>
                    {budgetActive
                      ? `Top ${topCards.length} of ${filtered.length} events`
                      : `${filtered.length} of ${feed.length} signals`}
                  </span>
                  {precision.length > 0 && (
                    <span
                      title={`precision@10 by day: ${precision.map((p) => `${p.date.slice(5)} ${(p.value * 100).toFixed(0)}%`).join(" · ")}`}
                      className="rounded border border-border px-1.5 py-0.5 text-[10px] tabular-nums"
                    >
                      p@10 {(precision[precision.length - 1].value * 100).toFixed(0)}%
                      {precision.length > 1
                        ? ` · 14d avg ${((precision.reduce((s, p) => s + p.value, 0) / precision.length) * 100).toFixed(0)}%`
                        : ""}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Sort
                  </span>
                  <Select
                    value={sortBy}
                    onValueChange={(v) => setSortBy(v as "fresh" | "opportunity" | "rank")}
                  >
                    <SelectTrigger className="h-7 w-40 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="rank">Materiality rank</SelectItem>
                      <SelectItem value="opportunity">Top opportunity</SelectItem>
                      <SelectItem value="fresh">Newest</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {filtered.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-10">
                  No signals match these filters.
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 items-start">
                  {displayCards.map((card) => {
                    const isOpen = expanded === card.id;
                    return (
                      <article
                        key={card.id}
                        className={`rounded-xl border bg-card overflow-hidden transition-colors flex flex-col ${
                          isOpen ? "border-primary/40 ring-1 ring-primary/20" : "border-border"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            const opening = !isOpen;
                            setExpanded(opening ? card.id : null);
                            if (opening && card.bodyElided) loadBody(card);
                            if (opening) logFeedback(card, "expanded");
                          }}
                          className="w-full text-left p-4 hover:bg-accent/30 transition-colors flex-1"
                        >
                          <div className="flex items-start gap-3">
                            <CompanyAvatar card={card} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-sm font-semibold text-foreground shrink-0">
                                  {card.company}
                                </span>
                                <div className="ml-auto flex items-center gap-1.5 shrink-0">
                                  {card.timeLabel && (
                                    <span className="text-[11px] text-muted-foreground">
                                      {card.timeLabel}
                                    </span>
                                  )}
                                  <span className="text-muted-foreground">
                                    {isOpen ? (
                                      <ChevronDown className="h-4 w-4" />
                                    ) : (
                                      <ChevronRight className="h-4 w-4" />
                                    )}
                                  </span>
                                </div>
                              </div>
                              <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                                <Badge
                                  variant="outline"
                                  className={`text-[10px] ${sourceTypeClass[card.sourceType] || ""}`}
                                >
                                  {card.sourceType}
                                </Badge>
                                {card.segment && (
                                  <Badge
                                    variant="outline"
                                    className={`text-[10px] ${segmentClass[card.segment] || ""}`}
                                  >
                                    {card.segment}
                                  </Badge>
                                )}
                                {card.industry && (
                                  <Badge variant="outline" className="text-[10px]">
                                    {card.industry}
                                  </Badge>
                                )}
                              </div>
                              <EventBadges card={card} />
                              <h3 className="text-sm font-bold tracking-tight mt-2 leading-snug line-clamp-2">
                                {card.headline}
                              </h3>
                              {card.summary && !isOpen && (
                                <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2">
                                  {card.summary}
                                </p>
                              )}
                              {!isOpen && card.insight?.scores && (
                                <div className="mt-2">
                                  <ScoreStrip card={card} />
                                </div>
                              )}
                            </div>
                          </div>
                        </button>

                        {isOpen && (
                          <div className="border-t border-border/60">
                            {/* Reading pane — the AI summary + link to the original, kept clean. */}
                            <div className="px-4 pt-3 pb-4 space-y-3">
                              {card.summary && (
                                <p className="text-xs text-muted-foreground">{card.summary}</p>
                              )}
                              <MarkdownMessage text={card.body || card.summary || "_No detail._"} />
                              {card.bodyElided &&
                                (bodyBusy[card.id] ? (
                                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading
                                    outreach…
                                  </div>
                                ) : bodies[card.id] ? (
                                  <MarkdownMessage text={bodies[card.id]} />
                                ) : null)}
                              <div className="flex items-center gap-2 flex-wrap">
                                {card.sourceUrl && (
                                  <a
                                    href={card.sourceUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={() => logFeedback(card, "clicked_source")}
                                    className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                                  >
                                    {card.sourceIsSearch ? "Find the original source" : "Read more"}
                                    <ExternalLink className="h-3.5 w-3.5" />
                                  </a>
                                )}
                                {card.docUrl && card.docUrl !== card.sourceUrl && (
                                  <a
                                    href={card.docUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                                    title="Archived copy saved to Drive"
                                  >
                                    Saved copy
                                    <FileText className="h-3.5 w-3.5" />
                                  </a>
                                )}
                                <Button
                                  size="sm"
                                  className="h-8 ml-auto text-xs"
                                  onClick={() => {
                                    setBroadcastCard(card);
                                    logFeedback(card, "actioned");
                                  }}
                                >
                                  <Share2 className="h-3.5 w-3.5" /> Share
                                </Button>
                              </div>
                              {card.storedId && (
                                <div className="flex items-center gap-1.5 pt-1">
                                  {verdicts[card.id] ? (
                                    <span className="text-[10px] text-muted-foreground">
                                      Feedback recorded — thanks.
                                    </span>
                                  ) : (
                                    <>
                                      <span className="text-[10px] text-muted-foreground mr-1">
                                        Was this useful?
                                      </span>
                                      {(
                                        [
                                          ["useful", "Useful"],
                                          ["not_useful", "Not useful"],
                                          ["already_knew", "Already knew"],
                                        ] as const
                                      ).map(([v, label]) => (
                                        <button
                                          key={v}
                                          onClick={() => submitVerdict(card, v)}
                                          className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                                        >
                                          {label}
                                        </button>
                                      ))}
                                    </>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Why it matters + scoring + who might care — pushed to the bottom
                                to preserve readability, actionable in place. */}
                            {card.insight && (
                              <div className="border-t border-border/60 bg-muted/20 px-4 py-3 space-y-3">
                                {card.insight.whyItMatters && (
                                  <div>
                                    <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1">
                                      Why it matters
                                    </div>
                                    <p className="text-xs text-foreground leading-snug">
                                      {card.insight.whyItMatters}
                                    </p>
                                  </div>
                                )}

                                <ScoreStrip card={card} />

                                {card.insight.suggestedPortcos.length > 0 && (
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                                      PortCos that might care
                                    </span>
                                    {card.insight.suggestedPortcos.map((p) => (
                                      <Link
                                        key={p}
                                        to="/companies"
                                        search={{ c: p }}
                                        className="inline-flex items-center gap-1 rounded-md border border-primary/20 bg-primary/5 px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/10 transition-colors"
                                      >
                                        <Building2 className="h-3 w-3" /> {p}
                                      </Link>
                                    ))}
                                  </div>
                                )}

                                {connectionsFor(card).length > 0 && (
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                                      Connections that might care
                                    </span>
                                    {connectionsFor(card).map((c) => (
                                      <button
                                        key={c.email || c.name}
                                        type="button"
                                        onClick={() => emailConnection(card, c)}
                                        title={`Email ${c.name}`}
                                        className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-1.5 py-0.5 text-[10px] hover:bg-accent transition-colors"
                                      >
                                        <Mail className="h-3 w-3 text-muted-foreground" />
                                        {c.name}
                                        {c.title ? ` · ${c.title}` : ""}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}

              {/* WS5 — abstention + the collapsed lower-priority tier. */}
              {budgetActive && topCards.length < FEED_BUDGET_N && (
                <p className="text-xs text-muted-foreground text-center mt-4">
                  Nothing else material today — {topCards.length} of {FEED_BUDGET_N} budget
                  used. Quiet days stay quiet; the feed does not pad.
                </p>
              )}
              {budgetActive && lowerCards.length > 0 && (
                <div className="mt-4 text-center">
                  <button
                    type="button"
                    onClick={() => setLowerOpen((v) => !v)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  >
                    {lowerOpen ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                    Lower priority ({lowerCards.length})
                  </button>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      <WatchUniverseDialog
        open={watchOpen}
        onOpenChange={setWatchOpen}
        user={authEmail || undefined}
      />
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
    </div>
  );
}
