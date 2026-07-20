import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { scanSignals, fetchSignals, fetchSignalBody } from "@/utils/gemini.functions";
import { fetchLinkedInFeed } from "@/utils/linkedin.functions";
import { fetchDriveDocs } from "@/utils/drive.functions";
import { fetchGmailFeed } from "@/utils/gmail.functions";
import { fetchPortfolioCompanies, fetchContacts } from "@/utils/sheets.functions";
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
  const [sortBy, setSortBy] = useState<"fresh" | "opportunity">("opportunity");
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

  // Broadcast + email dialogs
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
    const q = search.trim().toLowerCase();
    const minTs = dateRange in DATE_RANGES ? Date.now() - DATE_RANGES[dateRange] * 86_400_000 : 0;
    const out = feed.filter((c) => {
      if (q && !`${c.headline} ${c.summary} ${c.company}`.toLowerCase().includes(q)) return false;
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
    return out;
  }, [feed, search, dateRange, sourceSel, segSel, coSel, invSel, indSel, keyCompaniesOnly, sortBy]);

  const activeFilters =
    sourceSel.length +
    segSel.length +
    coSel.length +
    invSel.length +
    indSel.length +
    (search ? 1 : 0) +
    (dateRange !== "120" ? 1 : 0) +
    (keyCompaniesOnly ? 1 : 0);
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
                <div className="text-xs text-muted-foreground">
                  {filtered.length} of {feed.length} signals
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Sort
                  </span>
                  <Select
                    value={sortBy}
                    onValueChange={(v) => setSortBy(v as "fresh" | "opportunity")}
                  >
                    <SelectTrigger className="h-7 w-36 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
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
                  {filtered.map((card) => {
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
                              <h3 className="text-sm font-bold tracking-tight mt-2 leading-snug line-clamp-3">
                                {card.headline}
                              </h3>
                              {card.summary && !isOpen && (
                                <p className="text-xs text-muted-foreground mt-1.5 line-clamp-3">
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
                                  onClick={() => setBroadcastCard(card)}
                                >
                                  <Share2 className="h-3.5 w-3.5" /> Share
                                </Button>
                              </div>
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
            </>
          )}
        </main>
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
    </div>
  );
}
