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

import {
  fetchStoredSignals,
  rowFromStored,
  keyForStored,
  type StoredSignal,
} from "./signal-store.server";
import { newsSourceType } from "@/lib/signal-feed";
import { loadIntelEntities, INTEL_TABS, type IntelEntity } from "./intel.server";
import {
  buildPortfolioCompanies,
  buildContacts,
  fetchSheetTab,
  writeSheetRow,
  logOpsEvent,
  TAB_NAMES,
} from "./sheets.server";
import { buildRadarWatchlist } from "./platform.server";
import { isGeminiConfigured, geminiGenerate, responseText } from "./gemini.server";
import {
  ensureSignalV2Tabs,
  loadSignalEvents,
  persistSignalEvents,
  loadSignalConfig,
  newEventId,
  appendTimeAdvantageRow,
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
  independentSourceCount,
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
  eventSurprise,
  detectBurst,
  type MagnitudeProposal,
  type ValidatedMagnitude,
} from "@/lib/materiality";
import {
  matchIntelCorroboration,
  mergeBadges,
  BADGE,
  type IntelEventLite,
} from "@/lib/fusion";
import { passesAwarenessQualityGate } from "@/lib/signal-quality";
import {
  resolveEntity,
  type EntityRegistry,
} from "@/lib/entity-resolve";
import { classifyNovelty } from "@/lib/novelty";
import { gateSignal } from "@/lib/signal-gates";

export interface PipelineResult {
  /** Candidates with eventId + scores stamped — append THESE. */
  enriched: StoredSignal[];
  /** NEW synthetic rows (burst meta-events) the caller must ALSO append. */
  extraRows: StoredSignal[];
  eventsCreated: number;
  eventsUpdated: number;
}

const today = () => new Date().toISOString().split("T")[0];
const daysBetweenIso = (a: string, b: string) =>
  Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

// ── Context loading ──────────────────────────────────────────────

export interface CompanyFacts {
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

export interface PipelineContext {
  cfg: SignalConfig;
  facts: Map<string, CompanyFacts>; // key = normCompanyKey
}

export function factsFor(ctx: PipelineContext, company: string): CompanyFacts {
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

export async function buildContext(): Promise<PipelineContext> {
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
      // Alias keys also resolve to the same facts / URID.
      for (const alias of e.aliases || []) {
        const af = get(alias);
        af.urid = e.urid;
        if (e.domain && !af.domain) af.domain = e.domain;
        if (f.isPortco) af.isPortco = true;
        if (f.isWatch) af.isWatch = true;
      }
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

// ── Intel Events loader (WS3 fusion input) ───────────────────────

interface IntelEvidenceItem {
  date?: string;
  metric?: string;
  prev?: number;
  next?: number;
  z?: number;
  reason?: string;
}

/** Parse the Intel Events tab into the fusion-lite shape. Read-only. */
export async function loadIntelEventsLite(): Promise<IntelEventLite[]> {
  let rows: string[][] = [];
  try {
    rows = await fetchSheetTab(INTEL_TABS.events);
  } catch {
    return [];
  }
  const out: IntelEventLite[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const eventId = (r[0] || "").trim();
    if (!eventId) continue;
    let evidenceLines: string[] = [];
    try {
      const items = JSON.parse(r[9] || "[]") as IntelEvidenceItem[];
      evidenceLines = items
        .slice(-6)
        .map(
          (ev) =>
            `${ev.date || ""} ${ev.metric || ""}: ${ev.prev ?? "?"} → ${ev.next ?? "?"}${
              ev.z ? ` (z=${ev.z})` : ""
            }`,
        );
    } catch {
      /* evidence unavailable — lines stay empty */
    }
    out.push({
      eventId,
      urid: (r[1] || "").trim(),
      entity: (r[2] || "").trim(),
      state: (r[3] || "").trim(),
      status: (r[4] || "emerging").trim().toLowerCase(),
      firstDetected: (r[5] || "").trim(),
      lastUpdated: (r[6] || "").trim(),
      confidence: Number(r[7]) || 0,
      evidenceLines,
      signalId: (r[10] || "").trim(),
    });
  }
  return out;
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
    independence: ev.scoreBreakdown.independence,
    novelty: ev.scoreBreakdown.novelty,
    gate: ev.scoreBreakdown.gate,
    resolve: ev.scoreBreakdown.resolve,
    disputedFields: ev.scoreBreakdown.disputedFields,
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
    return { enriched: candidates, extraRows: [], eventsCreated: 0, eventsUpdated: 0 };
  }
  try {
    await ensureSignalV2Tabs();
    const ctx = await buildContext();
    const cfg = ctx.cfg;
    const intelEntities = await loadIntelEntities().catch(() => [] as IntelEntity[]);
    const entityRegistry = registryFromIntelEntities(intelEntities);
    const classifications = await classifyCandidates(candidates);
    // ~400d of events: the clustering pool only needs the trailing window, but
    // the WS4 surprise term needs the company's own cadence history.
    const allEvents = await loadSignalEvents({ sinceDays: 400 });
    const poolCutoff = new Date(Date.now() - cfg.clustering.windowDays * 2 * 86_400_000)
      .toISOString()
      .split("T")[0];
    const stored = allEvents.filter((e) => (e.lastUpdated || e.firstSeen) >= poolCutoff);

    const created: SignalEventRow[] = [];
    const updated = new Set<SignalEventRow>();
    const byId = new Map<string, SignalEventRow>();
    for (const e of allEvents) byId.set(e.eventId, e);
    const openPool: OpenEventLite[] = stored.map((e) => toOpenLite(e));
    // Rec relevances per event accumulated this run (event row keeps only scores).
    const recRelByEvent = new Map<string, number[]>();
    const clsByEvent = new Map<string, Classification>();

    for (const cand of candidates) {
      const companyRaw = (cand.company || "").trim();
      if (!companyRaw) continue; // person-only signals stay event-less
      const cls = classifications.get(cand.id) || fallbackClassification(cand);
      const title = cand.subject || cand.signal || "";
      const text = cand.signal || cand.justification || "";
      const dateIso = cand.dateFound || today();
      const url = (cand.sourceUrl || "").trim();
      const realUrl = /^https?:\/\//i.test(url) ? url : "";
      const facts = factsFor(ctx, companyRaw);
      const articleHost = hostOfUrl(realUrl);
      const resolved = resolveEntity(
        {
          name: companyRaw,
          domain: facts.domain || articleHost || undefined,
          context: {
            contactCompanies: facts.networkContactCount > 0 ? [companyRaw] : undefined,
          },
        },
        entityRegistry,
      );
      const company = resolved.canonicalName || companyRaw;
      const entityUrid = resolved.entityId || facts.urid || "";
      const tier = realUrl ? tierForUrl(realUrl, facts.domain, cfg) : "C";
      const source: EventSource = { u: realUrl, t: tier, d: dateIso, ti: title.slice(0, 120) };

      const match = matchEvent(
        {
          company,
          entityUrid: entityUrid || undefined,
          eventType: cls.type,
          title,
          text,
          dateIso,
          sourceUrl: realUrl,
        },
        openPool,
        cfg,
      );

      let ev: SignalEventRow;
      if (match.event) {
        const found = byId.get(match.event.eventId);
        if (!found) continue;
        ev = found;
        if (!ev.entityUrid && entityUrid) ev.entityUrid = entityUrid;
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
        ev.scoreBreakdown.resolve = {
          rung: resolved.rung,
          confidence: resolved.confidence,
          why: resolved.why,
        };
        if (resolved.rung === "ambiguous") {
          ev.badges = mergeBadges(ev.badges, BADGE.ambiguousEntity);
        }
        if (match.magnitudeDispute && match.disputedMagnitudeKey) {
          const claims = (ev.scoreBreakdown.disputedFields as Array<Record<string, unknown>>) || [];
          const existingMag = ev.magnitude
            ? {
                value: ev.magnitude.value,
                unit: ev.magnitude.unit,
                verbatim: ev.magnitude.verbatim,
                key: magnitudeKeyOf(`${ev.magnitude.value} ${ev.magnitude.unit}`),
              }
            : { key: (ev.scoreBreakdown as { magKey?: string }).magKey };
          claims.push({
            field: "magnitude",
            claims: [
              existingMag,
              {
                key: match.disputedMagnitudeKey,
                verbatim: cls.magnitude?.verbatim || match.disputedMagnitudeKey,
                value: cls.magnitude?.value,
                unit: cls.magnitude?.unit,
                sourceUrl: realUrl,
                tier,
              },
            ],
          });
          ev.scoreBreakdown.disputedFields = claims.slice(-5);
          ev.badges = mergeBadges(ev.badges, BADGE.disputed);
          // Keep the best-tier existing magnitude; never average.
          if (!ev.magnitude && cls.magnitude) ev.magnitude = cls.magnitude;
        }
        updated.add(ev);
        const poolIdx = openPool.findIndex((p) => p.eventId === ev.eventId);
        if (poolIdx >= 0) openPool[poolIdx] = toOpenLite(ev);
      } else {
        ev = {
          eventId: newEventId(),
          company,
          entityUrid,
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
          badges: resolved.rung === "ambiguous" ? BADGE.ambiguousEntity : "",
          scoreBreakdown: {
            clusterLog: [`${dateIso} seeded: ${match.reason}`],
            typeSource: cls.typeSource,
            flaggedForReview: cls.flagged || undefined,
            resolve: {
              rung: resolved.rung,
              confidence: resolved.confidence,
              why: resolved.why,
            },
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
      cand.company = company;
      cand.entityUrid = entityUrid;
      cand.resolveRung = resolved.rung;
      cand.resolveConfidence = resolved.confidence;
      clsByEvent.set(ev.eventId, cls);
      if (cand.type === "recommendation" && cand.relevance > 0) {
        recRelByEvent.set(ev.eventId, [...(recRelByEvent.get(ev.eventId) || []), cand.relevance]);
      }
    }

    // ── Fusion (WS3): cross-reference the intel engine's events ──
    const intelEvents = await loadIntelEventsLite();
    // intel signal row ID → news eventId it merged into (stamped post-persist).
    const intelSignalStamps = new Map<string, { eventId: string; badge: string }>();

    // ── Score every event touched this run (WS2 + WS3) ──
    const touched = new Set<SignalEventRow>([...created, ...updated]);
    for (const ev of touched) {
      const facts = factsFor(ctx, ev.company);
      let corroborationMultiplier = 1;
      const fuse = matchIntelCorroboration(
        {
          newsType: ev.eventType,
          company: ev.company,
          entityUrid: ev.entityUrid,
          newsFirstSeen: ev.firstSeen,
        },
        intelEvents,
        cfg,
      );
      if (fuse) {
        ev.intelEventId = fuse.intel.eventId;
        corroborationMultiplier = cfg.fusion.materialityMultiplier;
        ev.scoreBreakdown.corroboration = {
          intelEventId: fuse.intel.eventId,
          state: fuse.intel.state,
          firstDetected: fuse.intel.firstDetected,
          observations: fuse.intel.evidenceLines,
        };
        if (fuse.intelWasFirst) {
          // The intel event was first — MERGE: it keeps first_seen_at, and the
          // press coverage confirms it.
          const pressFirstSeen = ev.firstSeen;
          if (fuse.intel.firstDetected && fuse.intel.firstDetected < ev.firstSeen) {
            ev.firstSeen = fuse.intel.firstDetected;
          }
          ev.badges = mergeBadges(ev.badges, BADGE.confirmedByPress);
          if (fuse.intel.firstDetected && pressFirstSeen) {
            void appendTimeAdvantageRow({
              eventId: ev.eventId,
              entityUrid: ev.entityUrid || fuse.intel.urid,
              company: ev.company,
              intelFirstSeen: fuse.intel.firstDetected,
              pressFirstSeen,
              intelEvidence: fuse.intel.evidenceLines,
            });
          }
          if (fuse.intel.signalId) {
            intelSignalStamps.set(fuse.intel.signalId, {
              eventId: ev.eventId,
              badge: BADGE.confirmedByPress,
            });
          }
        } else {
          ev.badges = mergeBadges(ev.badges, BADGE.intelCorroborated);
        }
      }
      ev.confidence = eventConfidence(ev.sourceCount, ev.topTier, Boolean(ev.intelEventId), cfg);
      // WS4 — surprise vs. the company's own cadence, from the events table.
      const companyKey = normCompanyKey(ev.company);
      const priorOf = (sameTypeOnly: boolean) =>
        [...byId.values()]
          .filter(
            (p) =>
              p.eventId !== ev.eventId &&
              normCompanyKey(p.company) === companyKey &&
              (!sameTypeOnly || p.eventType === ev.eventType) &&
              p.firstSeen <= ev.firstSeen,
          )
          .map((p) => p.firstSeen);
      const sur = eventSurprise(
        {
          sameTypePriorDates: priorOf(true),
          anyTypePriorDates: priorOf(false),
          currentDate: ev.firstSeen,
        },
        cfg,
      );
      ev.scoreBreakdown.surpriseWhy = sur.why;
      // Previously-scored relevance stays a candidate so joins never lower it.
      const rels = [...(recRelByEvent.get(ev.eventId) || [])];
      if (ev.relevance > 0) rels.push(ev.relevance);
      scoreEvent(ev, facts, rels, cfg, { corroborationMultiplier, surpriseNorm: sur.surpriseNorm });

      // ── Phase 2: independence → novelty → trust gate → novelty mult ──
      const indep = independentSourceCount(
        ev.sources.map((s) => ({
          url: s.u,
          tier: s.t,
          dateIso: s.d,
          tokens: tokensOf(s.ti || "", ""),
        })),
      );
      // Apply independence into corroboration (Tier A/B families, not syndications).
      if (indep.abCount > 1 && !fuse) {
        corroborationMultiplier = Math.max(
          corroborationMultiplier,
          1 + Math.min(0.25, (indep.abCount - 1) * 0.08),
        );
        if (corroborationMultiplier > 1) {
          scoreEvent(ev, facts, rels, cfg, {
            corroborationMultiplier,
            surpriseNorm: sur.surpriseNorm,
          });
        }
      }
      ev.scoreBreakdown.independence = indep;

      const resolveMeta = (ev.scoreBreakdown.resolve || {}) as {
        rung?: string;
        confidence?: number;
      };
      const sourceTitles = ev.sources.map((s) => s.ti || "").filter(Boolean).join(" ");
      const novelty = classifyNovelty(
        {
          company: ev.company,
          entityUrid: ev.entityUrid || undefined,
          eventType: ev.eventType,
          title: sourceTitles || ev.company,
          text: ev.tokens.join(" "),
          dateIso: ev.firstSeen,
          magnitudeKey:
            ev.magnitude && ev.magnitude.unit === "usd"
              ? `usd:${Math.round(ev.magnitude.value)}`
              : magnitudeKeyOf(ev.tokens.join(" ")),
          hasNewMaterialField: Boolean(ev.scoreBreakdown.disputedFields),
        },
        allEvents
          .filter((p) => p.eventId !== ev.eventId)
          .map((p) => ({
            eventId: p.eventId,
            company: p.company,
            entityUrid: p.entityUrid || undefined,
            eventType: p.eventType,
            firstSeen: p.firstSeen,
            lastUpdated: p.lastUpdated,
            tokens: p.tokens,
            magnitudeKey:
              p.magnitude && p.magnitude.unit === "usd"
                ? `usd:${Math.round(p.magnitude.value)}`
                : undefined,
            status: p.status,
          })),
      );
      ev.scoreBreakdown.novelty = novelty;
      if (novelty.class === "update") {
        ev.badges = mergeBadges(ev.badges, BADGE.updated);
      }
      if (novelty.noveltyMult > 0 && novelty.noveltyMult < 1) {
        ev.rankScore = Math.round(ev.rankScore * novelty.noveltyMult);
        ev.scoreBreakdown.noveltyMult = {
          name: "novelty",
          value: novelty.noveltyMult,
          why: novelty.why,
        };
      }

      // Confirmation/recycled of a *prior* event → no standalone card.
      const isDupOfPrior =
        (novelty.class === "confirmation" || novelty.class === "recycled") &&
        Boolean(novelty.matchedEventId) &&
        novelty.matchedEventId !== ev.eventId;

      const gate = gateSignal({
        resolveConfidence: resolveMeta.confidence ?? (ev.entityUrid ? 0.9 : 0),
        resolveRung: resolveMeta.rung || (ev.entityUrid ? "alias_exact" : "unknown"),
        independentSources: indep.abCount,
        hasIntelEvidence: Boolean(ev.intelEventId),
        noveltyClass: isDupOfPrior ? "recycled" : novelty.class,
      });
      ev.scoreBreakdown.gate = gate;
      if (gate.outcome === "needs_review") {
        ev.badges = mergeBadges(ev.badges, BADGE.needsReview);
      } else if (gate.outcome === "hold") {
        ev.badges = mergeBadges(ev.badges, BADGE.hold);
      } else if (gate.outcome === "withhold") {
        ev.badges = mergeBadges(ev.badges, BADGE.withheld);
        ev.rankScore = 0;
      }
    }

    // ── WS4 — burst detector: quiet company suddenly generating events ──
    const extraRows: StoredSignal[] = [];
    const touchedCompanies = new Set([...touched].map((e) => normCompanyKey(e.company)));
    for (const companyKey of touchedCompanies) {
      const companyEvents = [...byId.values()].filter(
        (e) => normCompanyKey(e.company) === companyKey && e.eventType !== "unusual_activity",
      );
      if (companyEvents.length === 0) continue;
      const burst = detectBurst(companyEvents.map((e) => e.firstSeen), today(), cfg);
      if (!burst.burst) continue;
      // One live meta-event per company — refresh, never duplicate.
      const existingMeta = [...byId.values()].find(
        (e) =>
          e.eventType === "unusual_activity" &&
          normCompanyKey(e.company) === companyKey &&
          e.status !== "closed" &&
          (e.lastUpdated || e.firstSeen) >= poolCutoff,
      );
      const constituents = companyEvents
        .filter((e) => daysBetweenIso(today(), e.firstSeen) <= cfg.surprise.burstWindowDays)
        .sort((a, b) => b.rankScore - a.rankScore);
      const companyName = constituents[0]?.company || companyEvents[0].company;
      const facts = factsFor(ctx, companyName);
      if (existingMeta) {
        existingMeta.constituentIds = [...new Set(constituents.map((e) => e.eventId))];
        existingMeta.lastUpdated = today();
        scoreEvent(existingMeta, facts, [], cfg, { surpriseNorm: 1 });
        updated.add(existingMeta);
        continue;
      }
      const meta: SignalEventRow = {
        eventId: newEventId(),
        company: companyName,
        entityUrid: facts.urid || "",
        eventType: "unusual_activity",
        firstSeen: today(),
        lastUpdated: today(),
        status: "open",
        sourceCount: constituents.length,
        topSourceUrl: constituents[0]?.topSourceUrl || "",
        topTier: constituents[0]?.topTier || "C",
        sources: [],
        confidence: eventConfidence(constituents.length, constituents[0]?.topTier || "C", false, cfg),
        materiality: 0,
        materialityAdj: 0,
        relevance: 0,
        actionability: 0,
        surprise: 1,
        rankScore: 0,
        magnitude: null,
        intelEventId: "",
        badges: "",
        scoreBreakdown: { burst: burst.why },
        tokens: [],
        constituentIds: constituents.map((e) => e.eventId),
        rowNumber: 0,
      };
      scoreEvent(meta, facts, [], cfg, { surpriseNorm: 1 });
      created.push(meta);
      byId.set(meta.eventId, meta);
      // The meta-event's feed card — links its constituents in the body.
      const lines = constituents
        .slice(0, 6)
        .map((e) => `• ${e.firstSeen} ${cfg.eventTaxonomy[e.eventType]?.label || e.eventType}${e.topSourceUrl ? ` — ${e.topSourceUrl}` : ""}`);
      const sig: StoredSignal = {
        id: "",
        dateFound: today(),
        type: "awareness",
        status: "New",
        person: "",
        company: companyName,
        email: "",
        category: "Unusual Activity",
        signal: `Unusual activity: ${burst.recentCount} distinct events in ${cfg.surprise.burstWindowDays} days after ≥${cfg.surprise.priorQuietDays}d of quiet.`,
        sourceUrl: meta.topSourceUrl,
        subject: `Unusual activity: ${companyName}`,
        body: `CONSTITUENT EVENTS\n${lines.join("\n")}\n\n${burst.why}. Burst meta-event ${meta.eventId}; constituents remain listed above.`,
        relevance: meta.relevance,
        justification: burst.why,
        urgency: "High",
        timing: `Burst window: last ${cfg.surprise.burstWindowDays} days`,
        sourceType: newsSourceType(undefined, facts.isPortco, meta.topSourceUrl),
        docUrl: "",
        hasBody: true,
        eventId: meta.eventId,
        materiality: meta.materialityAdj,
        rankScore: meta.rankScore,
        badges: meta.badges,
        scoreBreakdown: JSON.stringify({ burst: burst.why, rank: meta.rankScore }).slice(0, 3000),
      };
      sig.id = keyForStored(sig);
      meta.scoreBreakdown.signalId = sig.id;
      extraRows.push(sig);
    }

    // ── Stamp candidates from their (now scored) events ──
    for (const cand of candidates) {
      const ev = cand.eventId ? byId.get(cand.eventId) : undefined;
      if (!ev) continue;
      const cls = clsByEvent.get(ev.eventId) || fallbackClassification(cand);
      cand.materiality = ev.materialityAdj;
      cand.rankScore = ev.rankScore;
      cand.badges = ev.badges;
      cand.scoreBreakdown = rowBreakdown(ev, cls);
      // Awareness rows previously stayed at relevance 0; stamp the event's
      // CRM-proxy / attribution relevance so the sheet and soft gate agree.
      if (cand.type === "awareness") {
        cand.relevance = ev.relevance;
      }
      // Corroborating observations belong on the card, in prose.
      const corr = ev.scoreBreakdown.corroboration as
        | { state?: string; observations?: string[] }
        | undefined;
      if (corr?.observations?.length) {
        const line = `Corroborated by intel (${corr.state}): ${corr.observations.slice(-3).join("; ")}`;
        if (!(cand.justification || "").includes("Corroborated by intel")) {
          cand.justification = [cand.justification, line].filter(Boolean).join(" — ");
        }
      }
    }

    // Soft gate: keep all recommendations; awareness only when relevance or
    // materiality clears the configured floor. Drop orphaned newly-created
    // events so the Events tab does not accumulate gated-out noise.
    // Phase 2: also drop withheld (recycled/confirmation-of-prior) cards.
    const withheldEventIds = new Set(
      [...touched]
        .filter((e) => {
          const g = e.scoreBreakdown.gate as { outcome?: string } | undefined;
          return g?.outcome === "withhold";
        })
        .map((e) => e.eventId),
    );
    const enriched = candidates.filter(
      (c) =>
        passesAwarenessQualityGate(c, cfg) &&
        !(c.eventId && withheldEventIds.has(c.eventId)),
    );
    const keptExtra = extraRows.filter(
      (c) =>
        passesAwarenessQualityGate(c, cfg) &&
        !(c.eventId && withheldEventIds.has(c.eventId)),
    );
    const keptSignalIds = new Set([...enriched, ...keptExtra].map((s) => s.id));
    const keptEventIds = new Set(
      [...enriched, ...keptExtra].map((s) => s.eventId).filter(Boolean) as string[],
    );
    const candidateIds = new Set(candidates.map((c) => c.id));

    for (const ev of created) {
      ev.constituentIds = ev.constituentIds.filter((id) => keptSignalIds.has(id));
    }
    for (const ev of updated) {
      ev.constituentIds = ev.constituentIds.filter(
        (id) => !candidateIds.has(id) || keptSignalIds.has(id),
      );
    }
    const createdToPersist = created.filter(
      (ev) => keptEventIds.has(ev.eventId) && ev.constituentIds.length > 0,
    );
    // Drop updates that were only touched by gated-out candidates and gained
    // nothing durable — still persist if sources/scores changed and the event
    // remains referenced by prior or surviving rows.
    const updatedToPersist = [...updated].filter(
      (ev) => keptEventIds.has(ev.eventId) || ev.constituentIds.some((id) => !candidateIds.has(id)),
    );

    await persistSignalEvents({ created: createdToPersist, updated: updatedToPersist });

    // The intel engine's own feed card for a press-confirmed event joins the
    // news event's card group (one card per real-world event, WS3.2).
    if (intelSignalStamps.size > 0) await stampIntelSignalRows(intelSignalStamps);

    if (createdToPersist.length > 0 || updatedToPersist.length > 0) {
      await logOpsEvent({
        action: "sync",
        source: "signal_events",
        status: "ok",
        summary: `Event pipeline · ${createdToPersist.length} new event${createdToPersist.length === 1 ? "" : "s"} · ${updatedToPersist.length} gained sources`,
        records: createdToPersist.length + updatedToPersist.length,
        details: {
          candidates: candidates.length,
          kept: enriched.length + keptExtra.length,
          gated: candidates.length - enriched.length,
          created: createdToPersist.length,
          updated: updatedToPersist.length,
        },
        items: [
          ...createdToPersist.map(
            (e) =>
              `NEW ${e.eventId}: ${e.company} — ${e.eventType} [${e.topTier}] mat ${e.materialityAdj} rank ${e.rankScore}`,
          ),
          ...updatedToPersist.map(
            (e) =>
              `+SRC ${e.eventId}: ${e.company} — ${e.eventType} (${e.sourceCount} sources) rank ${e.rankScore}`,
          ),
        ].slice(0, 40),
      });
    }

    return {
      enriched,
      extraRows: keptExtra,
      eventsCreated: createdToPersist.length,
      eventsUpdated: updatedToPersist.length,
    };
  } catch (err) {
    console.error("[signal-events] pipeline failed (signals stored unenriched):", err);
    return { enriched: candidates, extraRows: [], eventsCreated: 0, eventsUpdated: 0 };
  }
}

// ── Signal-row stamping ──────────────────────────────────────────
// Rewrites existing Signals-tab rows with v2 columns. Reads WITH Body so an
// in-place rewrite never wipes the (lazily-loaded) outreach body column.

export interface SignalRowStamp {
  eventId?: string;
  addBadges?: string[];
  materiality?: number;
  rankScore?: number;
  scoreBreakdown?: string;
}

export async function stampSignalRowsById(
  stamps: Map<string, SignalRowStamp>,
): Promise<number> {
  if (stamps.size === 0) return 0;
  const all = await fetchStoredSignals({ withBody: true });
  // Row numbers by position: re-read the raw tab to locate each ID's sheet row.
  const raw = await fetchSheetTab(TAB_NAMES.signals);
  const rowById = new Map<string, number>();
  for (let i = 0; i < raw.length; i++) {
    const id = (raw[i][0] || "").trim();
    if (id && !rowById.has(id)) rowById.set(id, i + 1);
  }
  let stamped = 0;
  for (const s of all) {
    const stamp = stamps.get(s.id);
    if (!stamp) continue;
    const rowNum = rowById.get(s.id);
    if (!rowNum) continue;
    if (stamp.eventId) s.eventId = stamp.eventId;
    if (stamp.addBadges?.length) s.badges = mergeBadges(s.badges || "", ...stamp.addBadges);
    if (stamp.materiality != null) s.materiality = stamp.materiality;
    if (stamp.rankScore != null) s.rankScore = stamp.rankScore;
    if (stamp.scoreBreakdown != null) s.scoreBreakdown = stamp.scoreBreakdown;
    await writeSheetRow(TAB_NAMES.signals, rowNum, rowFromStored(s));
    stamped++;
  }
  return stamped;
}

async function stampIntelSignalRows(
  stamps: Map<string, { eventId: string; badge: string }>,
): Promise<void> {
  try {
    const mapped = new Map<string, SignalRowStamp>();
    for (const [id, s] of stamps) {
      mapped.set(id, { eventId: s.eventId, addBadges: [s.badge] });
    }
    const n = await stampSignalRowsById(mapped);
    if (n > 0) console.log(`[signal-events] stamped ${n} intel signal row(s) into news events`);
  } catch (e) {
    console.error("[signal-events] intel signal stamping failed:", e);
  }
}

function registryFromIntelEntities(entities: IntelEntity[]): EntityRegistry {
  return {
    entities: entities.map((e) => ({
      entityId: e.urid,
      canonicalName: e.name,
      primaryDomain: e.domain || undefined,
      aliases: e.aliases?.length ? e.aliases : undefined,
      xref: e.xref,
    })),
  };
}

function toOpenLite(e: SignalEventRow): OpenEventLite {
  return {
    eventId: e.eventId,
    company: e.company,
    entityUrid: e.entityUrid || undefined,
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
