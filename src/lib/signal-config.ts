// Signals v2 configuration — every weight, threshold, prior, window, and tier
// cadence for the materiality-ranked event feed lives HERE as data, never as
// magic numbers in pipeline code ("config over code", implementation brief).
//
// These are the checked-in defaults. At runtime the server merges overrides
// from the "Signal Config" sheet tab (loadSignalConfig in event-store.server),
// so analysts can tune weights without a deploy. Pure data + pure helpers —
// safe to import anywhere, fixture-testable.

/** Closed event taxonomy — the LLM may only propose types from this set. */
export type SignalEventType =
  | "funding_round"
  | "acquisition_or_exit"
  | "exec_change"
  | "layoffs_restructuring"
  | "product_launch"
  | "regulatory_legal"
  | "major_customer_or_partnership"
  | "strategy_pivot"
  | "security_incident"
  | "unusual_activity" // synthetic burst meta-event (WS4) — never LLM-proposed
  | "other";

export interface EventTypeConfig {
  /** Base materiality prior, 0–10. */
  prior: number;
  /** Human label for cards/config sheet. */
  label: string;
}

export type SourceTier = "A" | "B" | "C";

export interface CorroborationRule {
  /** News event type this rule applies to. */
  newsType: SignalEventType;
  /** Intel Events `state` values that corroborate it (intel-detect STATE_RULES names). */
  intelStates: string[];
  /** Trailing window (days) an intel event counts as corroborating. */
  windowDays: number;
}

export interface SignalConfig {
  /** WS2 — event taxonomy with base materiality priors (0–10). */
  eventTaxonomy: Record<SignalEventType, EventTypeConfig>;

  /** WS1 — source tiering. Hosts are matched by suffix ("sec.gov" matches "www.sec.gov"). */
  sourceTiers: {
    /** Primary sources: registries/filings + company-issued wires. First-party
     *  hosts (the event company's own domain) are always Tier A. */
    tierA: string[];
    /** Original reporting — major tech/business press. */
    tierB: string[];
    /** Everything else defaults to Tier C (aggregators/syndication/unknown). */
  };

  /** WS1 — clustering thresholds (see lib/event-cluster.ts for the algorithm). */
  clustering: {
    /** Trailing window (days) an event stays open for new sources to join. */
    windowDays: number;
    /** Token similarity at/above which same-block candidates always merge. */
    simHigh: number;
    /** Lower similarity bound that still merges WITHIN hardWindowHours. */
    simLow: number;
    /** Same company + same type + published within this window ⇒ strong merge prior. */
    hardWindowHours: number;
    /** Max source URLs kept per event row (cell budget). */
    maxSources: number;
  };

  /** WS1 — event confidence: pure function of (best tier, source count, intel corroboration). */
  confidence: {
    tierBase: Record<SourceTier, number>;
    /** Added per additional source beyond the first (capped). */
    perExtraSource: number;
    maxExtraSources: number;
    /** Added when an intel-engine event corroborates (WS3). */
    intelCorroboration: number;
    cap: number;
  };

  /** WS2 — final ranking formula rank = materialityAdj^α × relevance^β × actionability^γ. */
  ranking: {
    alpha: number;
    beta: number;
    gamma: number;
    /** materialityAdj below this floor caps rank regardless of relevance. */
    materialityFloor: number;
    /** The cap applied when below the floor (0–100 display scale). */
    floorRankCap: number;
    /** Relevance (0–10) proxy for events with no attributed recommendation —
     *  derived from CRM facts (portco / watchlist / network presence). */
    relevanceProxy: { portco: number; watch: number; networked: number; base: number };
    /** Actionability (0–1) component weights — mirrors attribution-score's
     *  actionability semantics so both scores read the same evidence. */
    actionability: {
      email: number;
      prime: number;
      reengagement: number;
      recentTouch: number;
      reengagementGapDays: number;
    };
  };

  /** WS2 — magnitude normalization relative to the company's own size.
   *  Size proxy = current ATS open-role count (the intel engine's series);
   *  brackets are [minValue, factor][] scanned top-down (value ≥ min ⇒ factor). */
  magnitudeNorm: {
    /** Crude headcount ≈ open roles × this ratio (stated in every breakdown). */
    postingToHeadcountRatio: number;
    /** ≤ this many open roles (or unknown) ⇒ "small" company bracket. */
    smallCompanyMaxRoles: number;
    /** ≥ this many open roles ⇒ "large" bracket ("mid" in between). */
    largeCompanyMinRoles: number;
    funding: {
      small: Array<[number, number]>;
      mid: Array<[number, number]>;
      large: Array<[number, number]>;
    };
    /** Layoff count as a fraction of proxy headcount → factor brackets. */
    layoffPct: Array<[number, number]>;
  };

  /** WS4 — surprise modulation: materialityAdj = m × (base + span × surpriseNorm). */
  surprise: {
    base: number;
    span: number;
    /** <2 prior same-type events AND company quiet ≥ quietDays ⇒ this default. */
    quietDefault: number;
    /** Cold-start default when the company has little monitoring history. */
    coldStartDefault: number;
    quietDays: number;
    /** When false, skip synthetic "unusual_activity" burst meta-events entirely. */
    burstEnabled: boolean;
    /** Burst detector: ≥ burstMinEvents within burstWindowDays after a quiet
     *  priorQuietDays ⇒ synthetic "unusual_activity" meta-event. */
    burstMinEvents: number;
    burstWindowDays: number;
    priorQuietDays: number;
  };

  /** WS3 — news↔intel fusion. */
  fusion: {
    corroborationMap: CorroborationRule[];
    /** Intel Events `state` → taxonomy type, for ranking intel-only cards
     *  (DETECTED BEFORE PRESS) on the same materiality scale as news. */
    intelStateTaxonomy: Record<string, SignalEventType>;
    /** Multiplier applied to materiality when intel corroborates a news event. */
    materialityMultiplier: number;
    /** DETECTED BEFORE PRESS: intel event age ≥ this with no news match. */
    detectedBeforePressAgeDays: number;
    /** …and intel confidence at least this. */
    detectedBeforePressMinConfidence: number;
    /** Rank-score multiplier for detected-before-press intel cards. */
    detectedBeforePressBoost: number;
  };

  /** WS5 — feed budget & abstention. */
  feed: {
    /** Morning feed shows at most this many full cards. */
    budgetN: number;
    /** Cards below this rank score don't count toward the budget (abstention). */
    minRankScore: number;
  };

  /** Pinned watch topics — subject searches every SCHEDULED news scan includes
   *  ("agentic security", "warehouse robotics"). Managed from the /signals
   *  topic bar; stored as `topics` rows in the Signal Config tab. */
  topics: string[];

  /** WS6 — tiered watch universe. */
  watchTiers: {
    /** Intel collector families allowed for Tier 3 (cheap, high-precision only). */
    tier3Collectors: string[];
    /** ISO day of week (1=Mon … 7=Sun) the news scan includes Tier 2 companies. */
    tier2NewsScanIsoDay: number;
    /** Auto-promotion T3→T2: ≥ this many DISTINCT evidence families … */
    promotionMinFamilies: number;
    /** … within this trailing window (days). */
    promotionWindowDays: number;
  };

  /**
   * Soft gate for awareness persistence. Recommendations always keep.
   * Awareness keeps when relevance ≥ minRelevance OR materiality ≥ minMateriality.
   */
  qualityGate: {
    /** 0–10; networked proxy is 5 — cold base(3) alone is insufficient. */
    minRelevance: number;
    /** 0–10; cold companies need a meaningful event (above ranking floor). */
    minMateriality: number;
  };
}

export const DEFAULT_SIGNAL_CONFIG: SignalConfig = {
  eventTaxonomy: {
    funding_round: { prior: 7, label: "Funding round" },
    acquisition_or_exit: { prior: 8, label: "Acquisition / exit" },
    exec_change: { prior: 6, label: "Executive change" },
    layoffs_restructuring: { prior: 7, label: "Layoffs / restructuring" },
    product_launch: { prior: 4, label: "Product launch" },
    regulatory_legal: { prior: 6, label: "Regulatory / legal" },
    major_customer_or_partnership: { prior: 5, label: "Major customer / partnership" },
    strategy_pivot: { prior: 6, label: "Strategy pivot" },
    security_incident: { prior: 7, label: "Security incident" },
    unusual_activity: { prior: 6, label: "Unusual activity (burst)" },
    other: { prior: 2, label: "Other" },
  },

  sourceTiers: {
    tierA: [
      "sec.gov",
      "uspto.gov",
      "edgar.sec.gov",
      "federalregister.gov",
      "courtlistener.com",
      // Company-issued wire services — primary statements, not reporting.
      "businesswire.com",
      "prnewswire.com",
      "globenewswire.com",
      "newswire.com",
    ],
    tierB: [
      "techcrunch.com",
      "bloomberg.com",
      "reuters.com",
      "wsj.com",
      "ft.com",
      "theinformation.com",
      "axios.com",
      "cnbc.com",
      "forbes.com",
      "fortune.com",
      "businessinsider.com",
      "theverge.com",
      "wired.com",
      "arstechnica.com",
      "venturebeat.com",
      "siliconangle.com",
      "theregister.com",
      "nytimes.com",
      "washingtonpost.com",
      "economist.com",
    ],
  },

  clustering: {
    windowDays: 14,
    simHigh: 0.62,
    simLow: 0.38,
    hardWindowHours: 72,
    maxSources: 20,
  },

  confidence: {
    tierBase: { A: 0.7, B: 0.55, C: 0.4 },
    perExtraSource: 0.08,
    maxExtraSources: 3,
    intelCorroboration: 0.15,
    cap: 0.95,
  },

  ranking: {
    alpha: 1.0,
    beta: 0.7,
    gamma: 0.5,
    materialityFloor: 3,
    floorRankCap: 25,
    relevanceProxy: { portco: 9, watch: 7, networked: 5, base: 3 },
    actionability: {
      email: 0.35,
      prime: 0.25,
      reengagement: 0.4,
      recentTouch: 0.15,
      reengagementGapDays: 45,
    },
  },

  magnitudeNorm: {
    postingToHeadcountRatio: 10,
    smallCompanyMaxRoles: 15,
    largeCompanyMinRoles: 75,
    funding: {
      small: [
        [10_000_000, 1.4],
        [3_000_000, 1.2],
        [0, 1.0],
      ],
      mid: [
        [50_000_000, 1.3],
        [20_000_000, 1.1],
        [5_000_000, 0.9],
        [0, 0.8],
      ],
      large: [
        [200_000_000, 1.2],
        [50_000_000, 1.0],
        [0, 0.7],
      ],
    },
    layoffPct: [
      [0.3, 1.5],
      [0.1, 1.2],
      [0.03, 1.0],
      [0, 0.8],
    ],
  },

  surprise: {
    base: 0.6,
    span: 0.4,
    quietDefault: 0.9,
    coldStartDefault: 0.7,
    quietDays: 90,
    burstEnabled: false,
    burstMinEvents: 3,
    burstWindowDays: 7,
    priorQuietDays: 90,
  },

  fusion: {
    corroborationMap: [
      { newsType: "funding_round", intelStates: ["Fundraising evidence"], windowDays: 90 },
      {
        newsType: "product_launch",
        intelStates: [
          "Product launch preparation",
          "Engineering acceleration",
          "Commercial maturation",
          "Infrastructure expansion",
        ],
        windowDays: 45,
      },
      {
        newsType: "layoffs_restructuring",
        intelStates: ["Hiring contraction", "Operational slowdown", "Engineering slowdown"],
        windowDays: 60,
      },
      {
        newsType: "major_customer_or_partnership",
        intelStates: ["Enterprise go-to-market expansion", "Commercial maturation"],
        windowDays: 60,
      },
      {
        newsType: "strategy_pivot",
        intelStates: ["Expansion preparation", "Enterprise go-to-market expansion"],
        windowDays: 60,
      },
      {
        newsType: "acquisition_or_exit",
        intelStates: ["Operational slowdown", "Engineering slowdown"],
        windowDays: 90,
      },
    ],
    intelStateTaxonomy: {
      "Fundraising evidence": "funding_round",
      "Product launch preparation": "product_launch",
      "Enterprise go-to-market expansion": "strategy_pivot",
      "Expansion preparation": "strategy_pivot",
      "Commercial maturation": "strategy_pivot",
      "Hiring acceleration": "other",
      "Hiring contraction": "layoffs_restructuring",
      "Engineering acceleration": "other",
      "Engineering slowdown": "other",
      "Infrastructure expansion": "other",
      "Operational slowdown": "layoffs_restructuring",
    },
    materialityMultiplier: 1.25,
    detectedBeforePressAgeDays: 3,
    detectedBeforePressMinConfidence: 0.6,
    detectedBeforePressBoost: 1.2,
  },

  feed: {
    budgetN: 8,
    minRankScore: 20,
  },

  topics: [],

  watchTiers: {
    tier3Collectors: ["ats", "edgar"],
    tier2NewsScanIsoDay: 1,
    promotionMinFamilies: 2,
    promotionWindowDays: 30,
  },

  qualityGate: {
    minRelevance: 5,
    minMateriality: 6,
  },
};

/**
 * Deterministic fallback classification from the news scan's existing category
 * taxonomy — used when the LLM classifier is unavailable AND by the replay
 * harness, so the pipeline never depends on a model call to function.
 */
export function eventTypeFromCategory(category: string | undefined): SignalEventType {
  const c = (category || "").trim().toLowerCase();
  if (c === "funding/m&a") return "funding_round";
  if (c === "executive movement") return "exec_change";
  if (c === "crisis/regulatory") return "regulatory_legal";
  if (c === "partnership/customer win") return "major_customer_or_partnership";
  if (c === "product/milestone") return "product_launch";
  return "other";
}

export const SIGNAL_EVENT_TYPES: SignalEventType[] = [
  "funding_round",
  "acquisition_or_exit",
  "exec_change",
  "layoffs_restructuring",
  "product_launch",
  "regulatory_legal",
  "major_customer_or_partnership",
  "strategy_pivot",
  "security_incident",
  "other",
];

/** Validate an LLM-proposed type against the closed set; unknown ⇒ "other". */
export function validateEventType(proposed: string | undefined): {
  type: SignalEventType;
  valid: boolean;
} {
  const p = (proposed || "").trim().toLowerCase() as SignalEventType;
  if (SIGNAL_EVENT_TYPES.includes(p) && p !== "other") return { type: p, valid: true };
  if (p === "other") return { type: "other", valid: true };
  return { type: "other", valid: false };
}
