// Saved AI-generated platform content (/platform tab).
//
// Every generation (executive brief, board reading list, questions for
// management, diligence run) is persisted to the "Platform Content" sheet tab
// as an append-only row with the full typed payload JSON-in-a-cell — the same
// pattern as the Daily Briefing tab. History is the point: rows are never
// edited, the newest row per (type, subject) is the "current" one, and older
// rows remain as a reviewable trail.

export type PlatformContentType = "exec_brief" | "board_article" | "mgmt_questions" | "diligence";

export const CONTENT_TYPE_LABELS: Record<PlatformContentType, string> = {
  exec_brief: "Executive brief",
  board_article: "Board reading",
  mgmt_questions: "Management questions",
  diligence: "Diligence",
};

export const CONTENT_TYPES = Object.keys(CONTENT_TYPE_LABELS) as PlatformContentType[];

export function isContentType(v: string): v is PlatformContentType {
  return v in CONTENT_TYPE_LABELS;
}

export interface ProspectiveCompany {
  company: string;
  /** Funding stage as grounded on the web — Seed, Series A, or Series B. */
  stage: string;
  whatTheyDo: string;
  /** Why it fits DTC's deep-tech investing thesis. */
  whyFits: string;
  sourceUrl: string;
}

/** One quantified market figure — e.g. label "TAM 2024", value "$45B". */
export interface MarketFigure {
  label: string;
  value: string;
  sourceUrl: string;
}

/** One company placed in the market-landscape tiers. */
export interface LandscapePlayer {
  company: string;
  /** One-line positioning note. */
  note: string;
  sourceUrl?: string;
}

/** Confidence label for forward-looking / opinion claims. */
export type Confidence = "high" | "medium" | "speculative";

/** A standardized 1–10 scorecard category. */
export interface ScoreLine {
  category: string;
  score: number;
  note?: string;
}

/** A ranked opportunity (conviction 1–5). */
export interface RankedOpportunity {
  area: string;
  conviction: number;
  rationale: string;
}

/** Competitive-landscape group (companies clustered by sub-sector). */
export interface LandscapeGroup {
  category: string;
  companies: { company: string; note: string; tier?: string; sourceUrl?: string }[];
}

/** A notable financing round. */
export interface FundingRound {
  company: string;
  amount: string;
  stage: string;
  investors?: string;
  sourceUrl?: string;
}

/** A founder/company profile for the founder map. */
export interface FounderProfile {
  company: string;
  founders: string;
  background: string;
  location?: string;
  investors?: string;
  sourceUrl?: string;
}

/** One layer of the value-chain / ecosystem stack (ordered top → bottom). */
export interface ValueChainLayer {
  layer: string;
  description: string;
  /** Representative players in this layer. */
  players?: string;
}

/** A white-space (billion-dollar gap) opportunity. */
export interface WhiteSpaceItem {
  opportunity: string;
  rationale: string;
  category?: string;
  confidence?: Confidence;
}

/** A recommended next action, optionally referencing companies/entities to deep-link. */
export interface RecommendedAction {
  action: string;
  /** e.g. "Meet founders", "Monitor", "Track lab", "Watch event", "Follow investor", "Revisit". */
  category?: string;
  /** Company/person/lab names referenced, used for in-platform deep links. */
  entities?: string[];
}

export interface ExecBriefPayload {
  /** V2 investment thesis (what changed / why now / why it matters / where to focus). */
  thesis?: string;
  /** Legacy one-liner; retained for older rows and as a fallback. */
  tldr: string;
  /** Executive at-a-glance dashboard (absent on older rows). */
  atAGlance?: {
    /** 1–5 stars. */
    stageAttractiveness?: number;
    marketMaturity?: string;
    /** Low | Medium | High. */
    capitalIntensity?: string;
    /** Low | Medium | High. */
    competitiveDensity?: string;
    exitWindow?: string;
    /** 0–10 overall VC conviction. */
    convictionScore?: number;
  };
  /** Standardized 1–10 investment scorecard (absent on older rows). */
  scorecard?: ScoreLine[];
  /** Why-now inflections (tech, economic, regulatory, behavioral, infra). */
  whyNow?: { driver: string; detail: string; sourceUrl?: string }[];
  /** Actionable market dynamics (budgets, buying cycle, adoption, unit economics). */
  marketDynamics?: {
    narrative: string;
    budgetOwners?: string;
    buyingCycle?: string;
    existingSpend?: string;
    newSpend?: string;
    adoptionCurve?: string;
    procurementFriction?: string;
    replacementVsNetNew?: string;
    unitEconomics?: string;
    purchasingDrivers?: string;
  };
  /** Market sizing & study — TAM/SAM/SOM, growth rates (absent on older rows). */
  marketSizing?: { narrative: string; figures: MarketFigure[] };
  /** Areas most interesting from an enterprise buyer's standpoint (absent on older rows). */
  enterpriseAngle?: { area: string; whyItMatters: string }[];
  /** Competitive field grouped by sub-sector (v2; supersedes marketLandscape). */
  competitiveLandscape?: LandscapeGroup[];
  /** Legacy three-tier competitive field (absent on older rows). */
  marketLandscape?: {
    incumbents: LandscapePlayer[];
    upstarts: LandscapePlayer[];
    emerging: LandscapePlayer[];
  };
  /** Funding landscape — rounds, active investors, acquisitions, benchmarks. */
  fundingLandscape?: {
    summary: string;
    largestRounds?: FundingRound[];
    activeInvestors?: string[];
    recentAcquisitions?: { detail: string; sourceUrl?: string }[];
    benchmarks?: { label: string; value: string }[];
  };
  /** Legacy VC-flow section (absent on older rows). */
  capitalFlows?: {
    summary: string;
    hotspots: { area: string; detail: string; sourceUrl: string }[];
  };
  /** Founder map for major companies. */
  founderMap?: FounderProfile[];
  /** Ecosystem / value-chain stack (top → bottom). */
  valueChain?: ValueChainLayer[];
  /** White-space (billion-dollar gaps) opportunities. */
  whiteSpace?: WhiteSpaceItem[];
  /** Where we would invest — ranked by conviction. */
  investHere?: RankedOpportunity[];
  /** Where we wouldn't invest — with reasons. */
  avoidHere?: { area: string; reason: string }[];
  /** Recent developments (last 6–12 months), each with a grounded sourceUrl. */
  keyDevelopments: { point: string; detail: string; sourceUrl: string }[];
  /** Seed–Series B startups in the theme that fit the investing thesis (absent on older rows). */
  prospectiveCompanies?: ProspectiveCompany[];
  /** Open-source / research traction that often precedes startups. */
  openSource?: { project: string; detail: string; sourceUrl?: string }[];
  technicalRisks?: string[];
  commercialRisks?: string[];
  regulatoryRisks?: string[];
  /** Exit landscape — acquirers, IPO candidates, recent deals. */
  exitLandscape?: {
    note?: string;
    likelyAcquirers?: string[];
    ipoCandidates?: string[];
    recentDeals?: { detail: string; sourceUrl?: string }[];
  };
  /** Leading indicators to watch for monthly updates. */
  metricsToWatch?: string[];
  /** Bull / base / bear scenarios. */
  scenarios?: { bull: string; base: string; bear: string };
  /** Actionable next steps that feed the sourcing pipeline. */
  recommendedActions?: RecommendedAction[];
  portfolioImplications: { company: string; implication: string }[];
  watchlistSuggestions: string[];
  sources: string[];
  /** Readable label (publisher title + domain) for each cited URL (absent on older rows). */
  sourceMeta?: { url: string; title: string; domain: string }[];
}

export interface BoardArticlePayload {
  digest: string;
  articles: { title: string; url: string; whyRead: string }[];
}

export interface MgmtQuestionsPayload {
  questions: { area: string; question: string; why: string }[];
}

/** Mirrors the score_company_dna contract: 1-10 overall + per-dimension. */
export interface DiligenceDimension {
  name: string;
  score: number;
  note: string;
}

export interface DiligencePayload {
  score: number;
  dimensions: DiligenceDimension[];
  rationale: string;
  questions: { area: string; question: string; why: string }[];
  sources: string[];
  /** Stored Signal Radar headlines that were fed into the run (absent on older rows). */
  signalsUsed?: string[];
}

export type PlatformContentPayload =
  | ExecBriefPayload
  | BoardArticlePayload
  | MgmtQuestionsPayload
  | DiligencePayload;

/** One parsed row of the "Platform Content" tab. */
export interface PlatformContentRow {
  id: string;
  type: PlatformContentType;
  /** Research theme or company name the content is about. */
  subject: string;
  /** Set when the subject is a portfolio company, "" otherwise. */
  portcoUrid: string;
  title: string;
  payload: PlatformContentPayload;
  /** Grounded source URLs (also inside payloads; duplicated for auditability). */
  sources: string[];
  generatedAt: string;
  generatedBy: string;
}

/** One row of the "Competitive Radar" watchlist tab. */
export interface RadarEntry {
  id: string;
  company: string;
  website: string;
  segment: string;
  relatedPortcoUrids: string[];
  theme: string;
  note: string;
  addedBy: string;
  addedAt: string;
}

export interface NewRadarEntry {
  company: string;
  website?: string;
  segment?: string;
  relatedPortcoUrids?: string[];
  theme?: string;
  note?: string;
}
