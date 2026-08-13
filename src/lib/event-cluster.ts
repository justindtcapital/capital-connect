// WS1 — event clustering & source tiering (pure functions, no app imports
// beyond config types). One real-world event covered by five outlets must
// become ONE event with five sources, never five cards.
//
// Design (per the implementation brief + SIGNAL_RADAR_V2_DESIGN §6.2):
//   Stage 1 — cheap blocking on (company, event-type, trailing window). The
//             blocking key does 90% of the work at Sheets scale; candidates
//             never cross a company boundary.
//   Stage 2 — deterministic token-set similarity within the block (Jaccard /
//             containment over normalized title+snippet tokens), with a hard
//             prior: same company + same type + published within 72h merges at
//             a lower similarity bar. A conflicting extracted magnitude (a $20M
//             vs a $50M round) BLOCKS a merge — two distinct events.
//   No LLM decides a merge. No vector store: the token centroid is a JSON cell.
//
// Every decision returns a `reason` string so merges are auditable.

import type { SignalConfig, SignalEventType, SourceTier } from "@/lib/signal-config";

// ── Text normalization ───────────────────────────────────────────

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have",
  "in", "into", "is", "it", "its", "of", "on", "or", "over", "said", "says",
  "that", "the", "their", "this", "to", "up", "was", "were", "will", "with",
  "after", "new", "more", "than", "amid", "how", "why", "what", "who", "about",
]);

/** Normalize text into a capped, deduplicated token set for similarity. */
export function tokensOf(title: string, text: string, cap = 40): string[] {
  const raw = `${title || ""} ${text || ""}`
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9$%. ]+/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[.$%]+|[.$%]+$/g, "").replace(/s$/, ""))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

/** Minimum token-set size before containment is trusted — a 5-token headline
 *  fully contained in a 40-token body is weak evidence, not a duplicate. */
const CONTAINMENT_MIN_TOKENS = 8;

/** max(Jaccard, containment) — containment handles a short headline vs a long
 *  body, but only when both sides carry enough tokens to be distinctive. */
export function tokenSim(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  let inter = 0;
  for (const t of b) if (sa.has(t)) inter++;
  const sb = new Set(b).size;
  const union = sa.size + sb - inter;
  const jaccard = union > 0 ? inter / union : 0;
  const minSize = Math.min(sa.size, sb);
  const containment = minSize >= CONTAINMENT_MIN_TOKENS ? inter / minSize : 0;
  return Math.max(jaccard, containment);
}

// ── Magnitude fingerprint (merge guard + WS2 verbatim validation) ─

/**
 * Extract a canonical money-magnitude key from text (e.g. "$20M Series B" →
 * "usd:20000000"). Deterministic regex — used to (a) BLOCK merges between
 * events with conflicting magnitudes and (b) verify LLM-extracted magnitudes
 * appear verbatim in grounded source text (WS2).
 */
export function magnitudeKeyOf(text: string): string | undefined {
  const m = (text || "").match(
    /[$€£]\s?(\d+(?:[.,]\d+)?)\s*(billion|million|thousand|bn|b|mm|m|k)\b/i,
  );
  if (!m) return undefined;
  const n = parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2].toLowerCase();
  const mult =
    unit.startsWith("b") ? 1e9 : unit === "k" || unit === "thousand" ? 1e3 : 1e6;
  return `usd:${Math.round(n * mult)}`;
}

// ── Source tiering ───────────────────────────────────────────────

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * Tier a source URL: first-party (the event company's own domain) and
 * registry/wire hosts are Tier A; configured original-reporting press is
 * Tier B; everything else (aggregators, syndication, unknown) is Tier C.
 */
export function tierForUrl(
  url: string,
  companyDomain: string | undefined,
  cfg: SignalConfig,
): SourceTier {
  const host = hostOfUrl(url);
  if (!host) return "C";
  const dom = (companyDomain || "").trim().toLowerCase();
  if (dom && (hostMatches(host, dom) || hostMatches(dom, host))) return "A";
  for (const s of cfg.sourceTiers.tierA) if (hostMatches(host, s)) return "A";
  for (const s of cfg.sourceTiers.tierB) if (hostMatches(host, s)) return "B";
  return "C";
}

export function bestTier(tiers: SourceTier[]): SourceTier {
  if (tiers.includes("A")) return "A";
  if (tiers.includes("B")) return "B";
  return "C";
}

/**
 * Event confidence — a pure function of (best tier, source count, intel
 * corroboration), reproducible from the event row's stored columns alone
 * (WS1 acceptance criterion).
 */
export function eventConfidence(
  sourceCount: number,
  best: SourceTier,
  hasIntelCorroboration: boolean,
  cfg: SignalConfig,
): number {
  const c = cfg.confidence;
  const extras = Math.min(c.maxExtraSources, Math.max(0, sourceCount - 1));
  const v =
    c.tierBase[best] +
    extras * c.perExtraSource +
    (hasIntelCorroboration ? c.intelCorroboration : 0);
  return Math.min(c.cap, Math.round(v * 100) / 100);
}

// ── Company blocking key ─────────────────────────────────────────

/** Same normalization family as attribution-score's normCompany. */
export function normCompanyKey(name: string): string {
  return (name || "")
    .toLowerCase()
    .replace(/[.,'’]/g, "")
    .replace(
      /\b(incorporated|inc|corporation|corp|company|co|llc|llp|lp|ltd|limited|labs|technologies|ai)\b/g,
      "",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ── Cluster matching ─────────────────────────────────────────────

export interface ClusterCandidate {
  company: string;
  /** Phase 1 — resolved entity id when known; preferred blocking key. */
  entityUrid?: string;
  eventType: SignalEventType;
  title: string;
  text: string;
  /** ISO date the story was found (dateFound). */
  dateIso: string;
  sourceUrl: string;
}

export interface OpenEventLite {
  eventId: string;
  company: string;
  entityUrid?: string;
  eventType: SignalEventType;
  firstSeen: string;
  lastUpdated: string;
  status: string;
  /** Stored token centroid (JSON cell on the event row). */
  tokens: string[];
  /** Canonical magnitude key when one is known ("usd:20000000"). */
  magnitudeKey?: string;
  sourceUrls: string[];
}

export interface MatchResult {
  event: OpenEventLite | null;
  /** Audit trail — why it merged (or didn't). */
  reason: string;
  similarity: number;
  /**
   * True when the best match was blocked only by conflicting magnitudes —
   * pipeline should merge into one event with disputedFields instead of
   * seeding a second card.
   */
  magnitudeDispute?: boolean;
  disputedMagnitudeKey?: string;
}

const HOUR_MS = 3_600_000;

function hoursBetween(aIso: string, bIso: string): number {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(a - b) / HOUR_MS;
}

function daysBetween(aIso: string, bIso: string): number {
  return hoursBetween(aIso, bIso) / 24;
}

function blockKey(company: string, entityUrid?: string): string {
  const id = (entityUrid || "").trim();
  if (id) return `id:${id}`;
  return `n:${normCompanyKey(company)}`;
}

/**
 * Find the open event this candidate belongs to, or null to seed a new one.
 * Conservative by design: below thresholds ⇒ new event (a bad merge fuses two
 * real-world events, which is worse than a rare duplicate card).
 *
 * Types must match, with ONE exception: an `other`-classified candidate may
 * join a typed event at the high-similarity bar (classifier noise on one of
 * five syndicated copies must not split the cluster).
 */
export function matchEvent(
  cand: ClusterCandidate,
  openEvents: OpenEventLite[],
  cfg: SignalConfig,
): MatchResult {
  const { windowDays, simHigh, simLow, hardWindowHours } = cfg.clustering;
  const candTokens = tokensOf(cand.title, cand.text);
  const candMag = magnitudeKeyOf(`${cand.title} ${cand.text}`);
  const candBlock = blockKey(cand.company, cand.entityUrid);
  const candUrl = (cand.sourceUrl || "").trim().toLowerCase().replace(/\/+$/, "");

  let best: OpenEventLite | null = null;
  let bestSim = 0;
  let bestReason = "";
  let dispute: { event: OpenEventLite; sim: number; candMag: string; evMag: string } | null =
    null;

  for (const ev of openEvents) {
    // Stage 1 — blocking: entity (or company), status, trailing window, type.
    if (ev.status === "closed") continue;
    if (blockKey(ev.company, ev.entityUrid) !== candBlock) continue;
    if (daysBetween(cand.dateIso, ev.lastUpdated) > windowDays) continue;
    const typeMatches = ev.eventType === cand.eventType;
    const otherJoin = cand.eventType === "other" || ev.eventType === "other";
    if (!typeMatches && !otherJoin) continue;

    // Exact source URL already on the event ⇒ trivially the same event.
    if (candUrl && ev.sourceUrls.some((u) => u.trim().toLowerCase().replace(/\/+$/, "") === candUrl)) {
      return { event: ev, reason: "identical source URL", similarity: 1 };
    }

    const sim = tokenSim(candTokens, ev.tokens);
    const within72h = hoursBetween(cand.dateIso, ev.firstSeen) <= hardWindowHours;

    // Magnitude conflict: if otherwise merge-worthy, flag as dispute (Phase 2.4).
    if (candMag && ev.magnitudeKey && candMag !== ev.magnitudeKey) {
      if (sim >= simHigh || (within72h && sim >= simLow)) {
        if (!dispute || sim > dispute.sim) {
          dispute = { event: ev, sim, candMag, evMag: ev.magnitudeKey };
        }
      }
      continue;
    }

    // Stage 2 — similarity within the block.
    const sameMag = Boolean(candMag && ev.magnitudeKey && candMag === ev.magnitudeKey);

    let merges = false;
    let reason = "";
    if (typeMatches && sim >= simHigh) {
      merges = true;
      reason = `token similarity ${sim.toFixed(2)} ≥ ${simHigh}`;
    } else if (typeMatches && within72h && sim >= simLow) {
      merges = true;
      reason = `same company+type within ${hardWindowHours}h, similarity ${sim.toFixed(2)} ≥ ${simLow}`;
    } else if (typeMatches && within72h && sameMag) {
      merges = true;
      reason = `same company+type within ${hardWindowHours}h with matching magnitude ${candMag}`;
    } else if (!typeMatches && otherJoin && sim >= simHigh) {
      merges = true;
      reason = `"other"-typed duplicate at similarity ${sim.toFixed(2)} ≥ ${simHigh}`;
    }

    if (merges && sim >= bestSim) {
      best = ev;
      bestSim = sim;
      bestReason = reason;
    }
  }

  if (best) {
    return { event: best, reason: bestReason, similarity: bestSim };
  }
  if (dispute) {
    return {
      event: dispute.event,
      reason: `magnitude dispute ${dispute.candMag} vs ${dispute.evMag} (sim ${dispute.sim.toFixed(2)})`,
      similarity: dispute.sim,
      magnitudeDispute: true,
      disputedMagnitudeKey: dispute.candMag,
    };
  }
  return { event: null, reason: "no open event above thresholds — seeding new event", similarity: 0 };
}

/**
 * Merge a candidate's tokens into an event centroid: union preserving order,
 * capped. Keeps the centroid stable while letting genuinely new vocabulary in.
 */
export function mergeTokens(centroid: string[], addition: string[], cap = 60): string[] {
  const out = [...centroid];
  const seen = new Set(centroid);
  for (const t of addition) {
    if (out.length >= cap) break;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// ── Independence-aware corroboration (Phase 2.2) ─────────────────

export interface IndependenceSource {
  url: string;
  tier: SourceTier;
  /** ISO date the source joined. */
  dateIso: string;
  /** Optional title/snippet tokens for syndication detection. */
  tokens?: string[];
}

/**
 * Distinct independent evidence count: unique (tier, host-family) pairs.
 * Same-day Tier B/C stories that follow a Tier A wire/first-party doc and
 * are token-similar (≥ 0.7) are marked derivative (syndication) and count 0.
 */
export function independentSourceCount(sources: IndependenceSource[]): {
  /** All non-derivative host-families (any tier). */
  count: number;
  /** Tier A/B non-derivative families — used by the hold gate. */
  abCount: number;
  syndicated: number;
  why: string;
} {
  if (!sources.length) return { count: 0, abCount: 0, syndicated: 0, why: "no sources" };

  const sorted = [...sources].sort((a, b) => (a.dateIso || "").localeCompare(b.dateIso || ""));
  const tierA = sorted.filter((s) => s.tier === "A");
  const derivative = new Set<string>();

  for (const a of tierA) {
    const aTok = a.tokens || tokensOf(a.url, "");
    for (const s of sorted) {
      if (s.tier === "A") continue;
      if (!s.dateIso || !a.dateIso) continue;
      // Same day or later than the Tier A primary.
      if (s.dateIso < a.dateIso) continue;
      const dayGap = daysBetween(s.dateIso, a.dateIso);
      if (dayGap > 1) continue;
      const sTok = s.tokens || tokensOf(s.url, "");
      if (aTok.length && sTok.length && tokenSim(aTok, sTok) >= 0.7) {
        derivative.add(s.url.toLowerCase().replace(/\/+$/, ""));
      }
    }
  }

  const families = new Set<string>();
  const abFamilies = new Set<string>();
  let syndicated = 0;
  for (const s of sorted) {
    const key = (s.url || "").toLowerCase().replace(/\/+$/, "");
    if (derivative.has(key)) {
      syndicated++;
      continue;
    }
    let host = "";
    try {
      host = new URL(s.url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      host = key.slice(0, 40);
    }
    // Family = registrable-ish host (drop leading subdomain for news.* / www).
    const parts = host.split(".");
    const family = parts.length >= 2 ? parts.slice(-2).join(".") : host;
    const famKey = `${s.tier}:${family}`;
    families.add(famKey);
    if (s.tier === "A" || s.tier === "B") abFamilies.add(famKey);
  }

  const count = families.size;
  const abCount = abFamilies.size;
  const why =
    syndicated > 0
      ? `${abCount} independent Tier A/B (${count} total; ${syndicated} syndication${syndicated === 1 ? "" : "s"} of Tier A)`
      : `${abCount} independent Tier A/B (${count} total famil${count === 1 ? "y" : "ies"})`;
  return { count, abCount, syndicated, why };
}

