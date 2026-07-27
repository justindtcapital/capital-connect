// Signals v2 — the event pipeline: candidate stories → clustered real-world
// events (WS1) → materiality-ranked, evidence-decomposed scores (WS2) →
// Signal Events tab, with constituent signal rows stamped with event_id,
// materiality, rank, and the score breakdown.
//
// Runs as a post-step of every signal write path (news scan, digest links).
// LLM usage follows the house pattern: the model may PROPOSE an event type
// (closed set, JSON only) and a magnitude (number + unit + verbatim quote);
// deterministic validators confirm against grounded text before anything is
// stored. Clustering and every score are deterministic and reproducible from
// the stored rows alone.

import type { StoredSignal } from "./signal-store.server";
import { loadIntelEntities, INTEL_TABS } from "./intel.server";
import {
  buildPortfolioCompanies,
  buildContacts,
  fetchSheetTab,
  logOpsEvent,
} from "./sheets.server";
import { buildRadarWatchlist } from "./platform.server";
import { isGeminiConfigured, geminiGenerate, responseText } from "./gemini.server";
import {
  ensureSignalV2Tabs,
  loadSignalEvents,
  persistSignalEvents,
  loadSignalConfig,
  newEventId,
  type SignalEventRow,
  type EventSource,
} from "./event-store.server";
import {
  matchEvent,
  mergeTokens,
  tokensOf,
  tierForUrl,
  bestTier,
  eventConfidence,
  magnitudeKeyOf,
  normCompanyKey,
  hostOfUrl,
  type OpenEventLite,
} from "@/lib/event-cluster";
import {
  eventTypeFromCategory,
  validateEventType,
  SIGNAL_EVENT_TYPES,
  type SignalConfig,
  type SignalEventType,
} from "@/lib/signal-config";
import {
  validateMagnitude,
  scoreMateriality,
  applySurprise,
  eventRelevance,
  eventActionability,
  rankScore,
  type MagnitudeProposal,
  type ValidatedMagnitude,
} from "@/lib/materiality";

export interface PipelineResult {
  /** Candidates with eventId + scores stamped — append THESE. */
  enriched: StoredSignal[];
  eventsCreated: number;
  eventsUpdated: number;
}

const today = () => new Date().toISOString().split("T")[0];

// ── Context loading ──────────────────────────────────────────────

interface CompanyFacts {
  isPortco: boolean;
  isWatch: boolean;
  domain?: string;
  urid?: string;
  atsOpenRoles: number | null;
  networkContactCount: number;
  hasContactEmail: boolean;
  hasPrime: boolean;
  daysSinceLastContact: number | null;
}

interface PipelineContext {
  cfg: SignalConfig;
  facts: Map<string, CompanyFacts>; // key = normCompanyKey
}

function factsFor(ctx: PipelineContext, company: string): CompanyFacts {
  return (
    ctx.facts.get(normCompanyKey(company)) || {
      isPortco: false,
      isWatch: false,
      atsOpenRoles: null,
      networkContactCount: 0,
      hasContactEmail: false,
      hasPrime: false,
      daysSinceLastContact: null,
    }
  );
}

async function buildContext(): Promise<PipelineContext> {
  const cfg = await loadSignalConfig();
  const facts = new Map<string, CompanyFacts>();
  const get = (name: string): CompanyFacts => {
    const key = normCompanyKey(name);
    let f = facts.get(key);
    if (!f) {
      f = {
        isPortco: false,
        isWatch: false,
        atsOpenRoles: null,
        networkContactCount: 0,
        hasContactEmail: false,
        hasPrime: false,
        daysSinceLastContact: null,
      };
      facts.set(key, f);
    }
    return f;
  };

  try {
    for (const p of await buildPortfolioCompanies()) {
      if (!p.name) continue;
      const f = get(p.name);
      f.isPortco = true;
      const d = hostOfUrl(p.website || "") || (p.website || "").trim().toLowerCase();
      if (d) f.domain = d.replace(/^www\./, "");
    }
  } catch {
    /* portfolio unavailable */
  }
  try {
    for (const w of await buildRadarWatchlist()) {
      if (w.company) get(w.company).isWatch = true;
    }
  } catch {
    /* watchlist unavailable */
  }
  try {
    const nowMs = Date.now();
    for (const c of await buildContacts()) {
      if (!c.company) continue;
      const f = get(c.company);
      f.networkContactCount++;
      if (c.email) f.hasContactEmail = true;
      if (c.prime) f.hasPrime = true;
      const t = Date.parse(c.lastContact || "");
      if (Number.isFinite(t)) {
        const days = Math.max(0, (nowMs - t) / 86_400_000);
        f.daysSinceLastContact =
          f.daysSinceLastContact == null ? days : Math.min(f.daysSinceLastContact, days);
      }
    }
  } catch {
    /* contacts unavailable */
  }
  try {
    const uridToKey = new Map<string, string>();
    for (const e of await loadIntelEntities()) {
      const f = get(e.name);
      f.urid = e.urid;
      if (e.domain && !f.domain) f.domain = e.domain;
      uridToKey.set(e.urid, normCompanyKey(e.name));
    }
    // Current ATS open-role counts from the intel series (size proxy for WS2).
    const rows = await fetchSheetTab(INTEL_TABS.series).catch(() => [] as string[][]);
    for (let i = 1; i < rows.length; i++) {
      const [urid, , metric, current] = rows[i] || [];
      if ((metric || "").trim() !== "ats_open_roles") continue;
      const key = uridToKey.get((urid || "").trim());
      if (!key) continue;
      const f = facts.get(key);
      if (f) f.atsOpenRoles = Number(current) || 0;
    }
  } catch {
    /* intel registry unavailable */
  }
  return { cfg, facts };
}

// ── Classification (LLM proposes, closed-set validator disposes) ─

interface Classification {
  type: SignalEventType;
  typeSource: "llm" | "category_fallback";
  /** Flagged for review when the LLM answer was invalid/unparseable. */
  flagged: boolean;
  magnitude: ValidatedMagnitude | null;
}

function groundedTextOf(c: StoredSignal): string {
  return [c.subject, c.signal, c.justification].filter(Boolean).join(" ");
}

function fallbackClassification(c: StoredSignal): Classification {
  return {
    type: eventTypeFromCategory(c.category),
    typeSource: "category_fallback",
    flagged: false,
    magnitude: null,
  };
}

/**
 * One batched Gemini call for all candidates. JSON-only output against the
 * closed taxonomy; anything invalid degrades to the deterministic category
 * map. The pipeline is fully functional with the LLM disabled.
 */
async function classifyCandidates(
  candidates: StoredSignal[],
): Promise<Map<string, Classification>> {
  const out = new Map<string, Classification>();
  for (const c of candidates) out.set(c.id, fallbackClassification(c));
  if (!isGeminiConfigured() || candidates.length === 0) return out;

  const items = candidates.map((c, i) => ({
    i,
    title: (c.subject || c.signal || "").slice(0, 200),
    text: (c.signal || c.justification || "").slice(0, 500),
  }));
  const prompt = [
    "Classify each company-news item into EXACTLY one event type from this closed set:",
    SIGNAL_EVENT_TYPES.join(", "),
    "",
    "If the item states a concrete magnitude (a raise amount, layoff count, deal size),",
    "extract it with the EXACT substring it appears as (the quote must be copied verbatim",
    'from the item text). unit is "usd" for money, "people" for headcount. If no explicit',
    "magnitude appears, magnitude must be null. Never infer or compute numbers.",
    "",
    "ITEMS:",
    JSON.stringify(items),
    "",
    'Respond ONLY with a JSON array: [{"i":0,"type":"funding_round","magnitude":{"value":20000000,"unit":"usd","quote":"$20M"}}, {"i":1,"type":"other","magnitude":null}]',
    "One entry per item, same order. No prose.",
  ].join("\n");

  try {
    const r = await geminiGenerate({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 4000,
        temperature: 0,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 512 },
      },
    });
    const text = responseText(r) || "";
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return out;
    const parsed = JSON.parse(match[0]) as Array<{
      i?: number;
      type?: string;
      magnitude?: MagnitudeProposal | null;
    }>;
    if (!Array.isArray(parsed)) return out;
    for (const p of parsed) {
      const cand = typeof p?.i === "number" ? candidates[p.i] : undefined;
      if (!cand) continue;
      const v = validateEventType(p.type);
      const magnitude = validateMagnitude(p.magnitude, groundedTextOf(cand));
      out.set(cand.id, {
        // A valid LLM type wins; an invalid one flags the row and falls back.
        type: v.valid ? v.type : eventTypeFromCategory(cand.category),
        typeSource: v.valid ? "llm" : "category_fallback",
        flagged: !v.valid,
        magnitude,
      });
    }
  } catch (e) {
    console.error("[signal-events] classification call failed (category fallback):", e);
  }
  return out;
}

// ── Event scoring (WS2) ──────────────────────────────────────────

/** (Re)score one event from its own stored evidence + CRM facts. Deterministic. */
export function scoreEvent(
  ev: SignalEventRow,
  facts: CompanyFacts,
  recRelevances: number[],
  cfg: SignalConfig,
  opts: { corroborationMultiplier?: number; surpriseNorm?: number | null } = {},
): void {
  const mat = scoreMateriality(
    {
      eventType: ev.eventType,
      magnitude: ev.magnitude,
      isPortco: facts.isPortco,
      isWatch: facts.isWatch,
      atsOpenRoles: facts.atsOpenRoles,
      corroborationMultiplier: opts.corroborationMultiplier ?? 1,
    },
    cfg,
  );
  const sur = applySurprise(mat.materiality, opts.surpriseNorm ?? null, cfg);
  const rel = eventRelevance(
    {
      recRelevances,
      isPortco: facts.isPortco,
      isWatch: facts.isWatch,
      networkContactCount: facts.networkContactCount,
    },
    cfg,
  );
  const act = eventActionability(
    {
      hasContactEmail: facts.hasContactEmail,
      hasPrime: facts.hasPrime,
      daysSinceLastContact: facts.daysSinceLastContact,
    },
    cfg,
  );
  const rank = rankScore(
    { materialityAdj: sur.materialityAdj, relevance: rel.relevance, actionability: act.actionability },
    cfg,
  );

  ev.materiality = mat.materiality;
  ev.materialityAdj = sur.materialityAdj;
  ev.surprise = opts.surpriseNorm ?? 0;
  ev.relevance = rel.relevance;
  ev.actionability = act.actionability;
  ev.rankScore = rank.rank;
  ev.scoreBreakdown = {
    ...ev.scoreBreakdown,
    materiality: mat.parts,
    surprise: sur.part,
    relevance: rel.part,
    actionability: act.part,
    rank: rank.parts,
    suppressed: rank.suppressed,
  };
}

/** Compact per-row breakdown stamped onto the signal row (Score Breakdown col). */
function rowBreakdown(ev: SignalEventRow, cls: Classification): string {
  return JSON.stringify({
    eventId: ev.eventId,
    type: ev.eventType,
    typeSource: cls.typeSource,
    flagged: cls.flagged || undefined,
    materiality: ev.materiality,
    materialityAdj: ev.materialityAdj,
    relevance: ev.relevance,
    actionability: ev.actionability,
    surprise: ev.surprise,
    rank: ev.rankScore,
    confidence: ev.confidence,
    sources: ev.sourceCount,
    topTier: ev.topTier,
    magnitude: ev.magnitude || undefined,
  }).slice(0, 3000);
}

// ── The pipeline ─────────────────────────────────────────────────

/**
 * Cluster candidate signals into events, score them, and stamp each candidate.
 * Never throws — on any failure the candidates are returned unenriched so the
 * caller's signal write proceeds exactly as before (the pipeline is additive).
 */
export async function processCandidatesIntoEvents(
  candidates: StoredSignal[],
): Promise<PipelineResult> {
  if (candidates.length === 0) {
    return { enriched: candidates, eventsCreated: 0, eventsUpdated: 0 };
  }
  try {
    await ensureSignalV2Tabs();
    const ctx = await buildContext();
    const cfg = ctx.cfg;
    const classifications = await classifyCandidates(candidates);
    // Trailing window ×2 so a candidate near the window edge still sees the event.
    const stored = await loadSignalEvents({ sinceDays: cfg.clustering.windowDays * 2 });

    const created: SignalEventRow[] = [];
    const updated = new Set<SignalEventRow>();
    const byId = new Map<string, SignalEventRow>();
    for (const e of stored) byId.set(e.eventId, e);
    const openPool: OpenEventLite[] = stored.map((e) => toOpenLite(e));
    // Rec relevances per event accumulated this run (event row keeps only scores).
    const recRelByEvent = new Map<string, number[]>();
    const clsByEvent = new Map<string, Classification>();

    for (const cand of candidates) {
      const company = (cand.company || "").trim();
      if (!company) continue; // person-only signals stay event-less
      const cls = classifications.get(cand.id) || fallbackClassification(cand);
      const title = cand.subject || cand.signal || "";
      const text = cand.signal || cand.justification || "";
      const dateIso = cand.dateFound || today();
      const url = (cand.sourceUrl || "").trim();
      const realUrl = /^https?:\/\//i.test(url) ? url : "";
      const facts = factsFor(ctx, company);
      const tier = realUrl ? tierForUrl(realUrl, facts.domain, cfg) : "C";
      const source: EventSource = { u: realUrl, t: tier, d: dateIso, ti: title.slice(0, 120) };

      const match = matchEvent(
        { company, eventType: cls.type, title, text, dateIso, sourceUrl: realUrl },
        openPool,
        cfg,
      );

      let ev: SignalEventRow;
      if (match.event) {
        const found = byId.get(match.event.eventId);
        if (!found) continue;
        ev = found;
        const known = new Set(
          ev.sources.map((s) => s.u.trim().toLowerCase().replace(/\/+$/, "")),
        );
        const urlKey = realUrl.toLowerCase().replace(/\/+$/, "");
        if (realUrl && !known.has(urlKey)) {
          ev.sources = [...ev.sources, source].slice(0, cfg.clustering.maxSources);
        }
        ev.sourceCount = Math.max(ev.sourceCount, ev.sources.length || 1);
        const tiers = ev.sources.map((s) => s.t);
        ev.topTier = bestTier(tiers.length > 0 ? tiers : [tier]);
        const top = ev.sources.find((s) => s.t === ev.topTier);
        ev.topSourceUrl = top?.u || ev.topSourceUrl || realUrl;
        // An "other"-typed event upgraded by a typed duplicate keeps the type.
        if (ev.eventType === "other" && cls.type !== "other") ev.eventType = cls.type;
        if (!ev.magnitude && cls.magnitude) ev.magnitude = cls.magnitude;
        ev.tokens = mergeTokens(ev.tokens, tokensOf(title, text));
        ev.lastUpdated = dateIso;
        if (ev.status === "open") ev.status = "updated";
        ev.constituentIds = [...new Set([...ev.constituentIds, cand.id])];
        const sb = (ev.scoreBreakdown.clusterLog as string[]) || [];
        ev.scoreBreakdown.clusterLog = [
          ...sb,
          `${dateIso} +${hostOfUrl(realUrl) || "row"}: ${match.reason}`,
        ].slice(-10);
        updated.add(ev);
        const poolIdx = openPool.findIndex((p) => p.eventId === ev.eventId);
        if (poolIdx >= 0) openPool[poolIdx] = toOpenLite(ev);
      } else {
        ev = {
          eventId: newEventId(),
          company,
          entityUrid: facts.urid || "",
          eventType: cls.type,
          firstSeen: dateIso,
          lastUpdated: dateIso,
          status: "open",
          sourceCount: 1,
          topSourceUrl: realUrl,
          topTier: tier,
          sources: realUrl ? [source] : [],
          confidence: 0,
          materiality: 0,
          materialityAdj: 0,
          relevance: 0,
          actionability: 0,
          surprise: 0,
          rankScore: 0,
          magnitude: cls.magnitude,
          intelEventId: "",
          badges: "",
          scoreBreakdown: {
            clusterLog: [`${dateIso} seeded: ${match.reason}`],
            typeSource: cls.typeSource,
            flaggedForReview: cls.flagged || undefined,
          },
          tokens: tokensOf(title, text),
          constituentIds: [cand.id],
          rowNumber: 0,
        };
        created.push(ev);
        byId.set(ev.eventId, ev);
        openPool.push(toOpenLite(ev));
      }

      cand.eventId = ev.eventId;
      clsByEvent.set(ev.eventId, cls);
      if (cand.type === "recommendation" && cand.relevance > 0) {
        recRelByEvent.set(ev.eventId, [...(recRelByEvent.get(ev.eventId) || []), cand.relevance]);
      }
    }

    // ── Score every event touched this run (WS2) ──
    const touched = new Set<SignalEventRow>([...created, ...updated]);
    for (const ev of touched) {
      const facts = factsFor(ctx, ev.company);
      ev.confidence = eventConfidence(ev.sourceCount, ev.topTier, Boolean(ev.intelEventId), cfg);
      // Previously-scored relevance stays a candidate so joins never lower it.
      const rels = [...(recRelByEvent.get(ev.eventId) || [])];
      if (ev.relevance > 0) rels.push(ev.relevance);
      scoreEvent(ev, facts, rels, cfg);
    }

    // ── Stamp candidates from their (now scored) events ──
    for (const cand of candidates) {
      const ev = cand.eventId ? byId.get(cand.eventId) : undefined;
      if (!ev) continue;
      const cls = clsByEvent.get(ev.eventId) || fallbackClassification(cand);
      cand.materiality = ev.materialityAdj;
      cand.rankScore = ev.rankScore;
      cand.scoreBreakdown = rowBreakdown(ev, cls);
    }

    await persistSignalEvents({ created, updated: [...updated] });

    if (created.length > 0 || updated.size > 0) {
      await logOpsEvent({
        action: "sync",
        source: "signal_events",
        status: "ok",
        summary: `Event pipeline · ${created.length} new event${created.length === 1 ? "" : "s"} · ${updated.size} gained sources`,
        records: created.length + updated.size,
        details: { candidates: candidates.length, created: created.length, updated: updated.size },
        items: [
          ...created.map(
            (e) =>
              `NEW ${e.eventId}: ${e.company} — ${e.eventType} [${e.topTier}] mat ${e.materialityAdj} rank ${e.rankScore}`,
          ),
          ...[...updated].map(
            (e) =>
              `+SRC ${e.eventId}: ${e.company} — ${e.eventType} (${e.sourceCount} sources) rank ${e.rankScore}`,
          ),
        ].slice(0, 40),
      });
    }

    return { enriched: candidates, eventsCreated: created.length, eventsUpdated: updated.size };
  } catch (err) {
    console.error("[signal-events] pipeline failed (signals stored unenriched):", err);
    return { enriched: candidates, eventsCreated: 0, eventsUpdated: 0 };
  }
}

function toOpenLite(e: SignalEventRow): OpenEventLite {
  return {
    eventId: e.eventId,
    company: e.company,
    eventType: e.eventType,
    firstSeen: e.firstSeen,
    lastUpdated: e.lastUpdated,
    status: e.status,
    tokens: e.tokens,
    magnitudeKey:
      e.magnitude && e.magnitude.unit === "usd"
        ? `usd:${Math.round(e.magnitude.value)}`
        : magnitudeKeyOf(e.tokens.join(" ")),
    sourceUrls: e.sources.map((s) => s.u),
  };
}

export type { SignalConfig, SignalEventType };
