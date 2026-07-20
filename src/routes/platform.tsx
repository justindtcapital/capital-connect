import { Suspense, useEffect, useState } from "react";
import { Await, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  BookOpen,
  Compass,
  RefreshCw,
  SearchCheck,
  Telescope,
  TrendingUp,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { buildFeed } from "@/lib/signal-feed";
import type { KpiPoint } from "@/lib/platform-kpi";
import type { PlatformContentRow, RadarEntry } from "@/lib/platform-content";
import { fetchContacts, fetchPortfolioCompanies, fetchTargets } from "@/utils/sheets.functions";
import { fetchAsanaPortcoData, type AsanaPortcoData } from "@/utils/asana.functions";
import { fetchSignals } from "@/utils/gemini.functions";
import {
  fetchPlatformContent,
  fetchPlatformKpis,
  fetchRadar,
  fetchTheses,
  fetchThesisMatches,
} from "@/utils/platform.functions";
import type { PortfolioCompany, TargetLead } from "@/lib/types";
import {
  contactCountsByCompany,
  thesisCoverage,
  type Thesis,
  type ThesisCoverage,
  type ThesisMatch,
} from "@/lib/platform-thesis";
import { KpisTab } from "@/components/platform/KpisTab";
import { ResearchTab } from "@/components/platform/ResearchTab";
import { DiligenceTab } from "@/components/platform/DiligenceTab";
import { SourcingSkeleton, SourcingTab, type SourcingRow } from "@/components/platform/SourcingTab";

const TABS = ["research", "sourcing", "diligence", "kpis"] as const;
type PlatformTab = (typeof TABS)[number];

// Everything the Sourcing tab streams in: the signal-derived company ranking,
// plus network coverage per thesis and contact counts per company (warm-path
// chips on thesis matches). One deferred bundle so the data is fetched once.
interface SourcingBundle {
  rows: SourcingRow[];
  coverage: Record<string, ThesisCoverage>;
  companyContacts: Record<string, number>;
}

// Deal-sourcing lens over stored signals: non-portfolio companies ranked by
// their best grounded opportunity score. Pure read — reuses the Signal Radar's
// stored rows + scorer; never triggers a scan or an LLM call.
async function buildSourcingBundle(theses: Thesis[]): Promise<SourcingBundle> {
  try {
    const [signals, contacts, portfolio, targets] = await Promise.all([
      fetchSignals(),
      fetchContacts().catch(() => []),
      fetchPortfolioCompanies().catch(() => []),
      fetchTargets().catch(() => [] as TargetLead[]),
    ]);
    const feed = buildFeed({
      recommendations: signals?.recommendations ?? [],
      otherSignals: signals?.otherSignals ?? [],
      linkedinPosts: [],
      driveDocs: [],
      portfolio,
      contacts,
    });
    const portcoNames = new Set(portfolio.map((p) => p.name.trim().toLowerCase()));
    const byCompany = new Map<string, SourcingRow>();
    for (const card of feed) {
      const name = card.company.trim();
      if (!name || portcoNames.has(name.toLowerCase())) continue;
      const opportunity = card.insight?.scores.opportunity ?? 0;
      const existing = byCompany.get(name.toLowerCase());
      if (existing) {
        existing.signalCount += 1;
        if (opportunity > existing.opportunity) {
          existing.opportunity = opportunity;
          existing.headline = card.headline;
          existing.timeLabel = card.timeLabel;
          existing.sortTs = card.sortTs;
          existing.segment = card.segment;
          existing.networkLevel = card.insight?.scores.network.level ?? existing.networkLevel;
          existing.networkCount = card.insight?.scores.network.count ?? existing.networkCount;
          existing.logoDomain = card.logoDomain || existing.logoDomain;
          existing.summary = card.summary || existing.summary;
        }
      } else {
        byCompany.set(name.toLowerCase(), {
          company: name,
          segment: card.segment,
          headline: card.headline,
          timeLabel: card.timeLabel,
          sortTs: card.sortTs,
          opportunity,
          networkLevel: card.insight?.scores.network.level ?? "none",
          networkCount: card.insight?.scores.network.count ?? 0,
          signalCount: 1,
          logoDomain: card.logoDomain,
          summary: card.summary,
        });
      }
    }
    const rows = [...byCompany.values()]
      .sort((a, b) => b.opportunity - a.opportunity || b.sortTs - a.sortTs)
      .slice(0, 40);
    const coverage: Record<string, ThesisCoverage> = {};
    for (const t of theses) coverage[t.id] = thesisCoverage(t, contacts, targets as TargetLead[]);
    return {
      rows,
      coverage,
      companyContacts: Object.fromEntries(contactCountsByCompany(contacts)),
    };
  } catch (error) {
    console.error("buildSourcingBundle failed:", error);
    return { rows: [], coverage: {}, companyContacts: {} };
  }
}

export const Route = createFileRoute("/platform")({
  head: () => ({
    meta: [
      { title: "Platform — VenturePulse" },
      {
        name: "description",
        content: "Thematic research, deal sourcing, diligence and portfolio KPI tracking",
      },
    ],
  }),
  validateSearch: (search: Record<string, unknown>) => ({
    tab:
      typeof search.tab === "string" && (TABS as readonly string[]).includes(search.tab)
        ? (search.tab as PlatformTab)
        : undefined,
  }),
  loader: async () => {
    const [companies, kpis, radar, content, asana, theses, thesisMatches] = await Promise.all([
      fetchPortfolioCompanies().catch(() => [] as PortfolioCompany[]),
      fetchPlatformKpis().catch(() => [] as KpiPoint[]),
      fetchRadar().catch(() => [] as RadarEntry[]),
      fetchPlatformContent().catch(() => [] as PlatformContentRow[]),
      fetchAsanaPortcoData().catch(
        (): AsanaPortcoData => ({
          fieldsByCompanyName: {},
          namesByCompanyName: {},
          eventsByCompanyName: {},
        }),
      ),
      fetchTheses().catch(() => [] as Thesis[]),
      fetchThesisMatches().catch(() => [] as ThesisMatch[]),
    ]);
    // Enrich sheet portcos with Asana custom fields (ownership, investment, etc.)
    // so Portfolio KPIs can show the live investment profile.
    const merged: PortfolioCompany[] = (companies as PortfolioCompany[]).map((c) => {
      const key = c.name.trim().toLowerCase();
      const asanaFields = asana.fieldsByCompanyName[key];
      return {
        ...c,
        asanaFields: asanaFields && Object.keys(asanaFields).length > 0 ? asanaFields : c.asanaFields,
      };
    });
    // Unawaited on purpose — streams to the Sourcing tab via <Await> while the
    // rest of the page paints (same pattern as the Home digest).
    const sourcing = buildSourcingBundle(theses);
    return { companies: merged, kpis, radar, content, sourcing, theses, thesisMatches };
  },
  component: PlatformPage,
});

function PlatformPage() {
  const data = Route.useLoaderData();
  const { tab } = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const { email } = useAuth();
  const userEmail = email ?? "";

  // Loader data is copied to local state so generations/mutations can patch
  // in place; the effects resync after a router.invalidate() reload.
  const [kpis, setKpis] = useState<KpiPoint[]>(data.kpis);
  const [radar, setRadar] = useState<RadarEntry[]>(data.radar);
  const [content, setContent] = useState<PlatformContentRow[]>(data.content);
  const [theses, setTheses] = useState<Thesis[]>(data.theses);
  const [thesisMatches, setThesisMatches] = useState<ThesisMatch[]>(data.thesisMatches);
  const [diligenceCompany, setDiligenceCompany] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => setKpis(data.kpis), [data.kpis]);
  useEffect(() => setRadar(data.radar), [data.radar]);
  useEffect(() => setContent(data.content), [data.content]);
  useEffect(() => setTheses(data.theses), [data.theses]);
  useEffect(() => setThesisMatches(data.thesisMatches), [data.thesisMatches]);

  const active: PlatformTab = tab ?? "research";
  const setTab = (t: PlatformTab) =>
    navigate({ to: "/platform", search: { tab: t } });

  const refresh = async () => {
    setRefreshing(true);
    try {
      await router.invalidate();
    } finally {
      setRefreshing(false);
    }
  };

  const addContent = (row: PlatformContentRow) => setContent((prev) => [row, ...prev]);

  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold text-foreground">
            <Telescope className="h-5 w-5 text-primary" />
            Platform
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Thematic research, deal sourcing, diligence, and portfolio KPI tracking — AI output is
            generated on demand and saved to the workbook.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          onClick={refresh}
          disabled={refreshing}
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <Tabs value={active} onValueChange={(v) => setTab(v as PlatformTab)}>
        <TabsList className="mb-4">
          <TabsTrigger value="research" className="text-xs gap-1.5">
            <BookOpen className="h-3.5 w-3.5" /> Research
          </TabsTrigger>
          <TabsTrigger value="sourcing" className="text-xs gap-1.5">
            <Compass className="h-3.5 w-3.5" /> Sourcing
          </TabsTrigger>
          <TabsTrigger value="diligence" className="text-xs gap-1.5">
            <SearchCheck className="h-3.5 w-3.5" /> Diligence
          </TabsTrigger>
          <TabsTrigger value="kpis" className="text-xs gap-1.5">
            <TrendingUp className="h-3.5 w-3.5" /> Portfolio KPIs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="research">
          <ResearchTab
            content={content}
            radar={radar}
            userEmail={userEmail}
            onContent={addContent}
            onRadarAdded={(entry) => setRadar((prev) => [entry, ...prev])}
            onRadarRemoved={(id) => setRadar((prev) => prev.filter((r) => r.id !== id))}
          />
        </TabsContent>

        <TabsContent value="sourcing">
          <Suspense fallback={<SourcingSkeleton />}>
            <Await promise={data.sourcing}>
              {(bundle) => {
                const b = bundle as SourcingBundle;
                return (
                  <SourcingTab
                    rows={b.rows}
                    theses={theses}
                    matches={thesisMatches}
                    coverage={b.coverage}
                    companyContacts={b.companyContacts}
                    userEmail={userEmail}
                    onThesesChanged={setTheses}
                    onMatchesChanged={setThesisMatches}
                    onDiligence={(company) => {
                      setDiligenceCompany(company);
                      setTab("diligence");
                    }}
                  />
                );
              }}
            </Await>
          </Suspense>
        </TabsContent>

        <TabsContent value="diligence">
          <DiligenceTab
            content={content}
            prefillCompany={diligenceCompany}
            userEmail={userEmail}
            onContent={addContent}
          />
        </TabsContent>

        <TabsContent value="kpis">
          <KpisTab
            companies={data.companies}
            kpis={kpis}
            content={content}
            userEmail={userEmail}
            onRefresh={refresh}
            onContent={addContent}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
