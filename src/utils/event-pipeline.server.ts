// Signals v2 — the event pipeline (WS1): candidate stories → clustered
// real-world events → Signal Events tab, with the constituent signal rows
// stamped with their event_id FK.
//
// Runs as a post-step of every signal write path (news scan, digest links).
// Deterministic end to end: event types come from the category map (the LLM
// classifier added in WS2 only *proposes*; the closed-set validator disposes),
// merges come from lib/event-cluster thresholds, tiers from config. No model
// output is ever a merge decision.

import type { StoredSignal } from "./signal-store.server";
import { loadIntelEntities } from "./intel.server";
import { buildPortfolioCompanies, logOpsEvent } from "./sheets.server";
import {
  ensureSignalV2Tabs,
  loadSignalEvents,
  persistSignalEvents,
  newEventId,
  type SignalEventRow,
  type EventSource,
} from "./event-store.server";
import { loadSignalConfig } from "./event-store.server";
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
  type SignalConfig,
  type SignalEventType,
} from "@/lib/signal-config";

export interface PipelineResult {
  /** Candidates with eventId (and later: scores) stamped — append THESE. */
  enriched: StoredSignal[];
  eventsCreated: number;
  eventsUpdated: number;
}

const today = () => new Date().toISOString().split("T")[0];

function toOpenLite(e: SignalEventRow): OpenEventLite {
  return {
    eventId: e.eventId,
    company: e.company,
    eventType: e.eventType,
    firstSeen: e.firstSeen,
    lastUpdated: e.lastUpdated,
    status: e.status,
    tokens: e.tokens,
    magnitudeKey: e.magnitude
      ? `usd:${Math.round(e.magnitude.value)}`
      : magnitudeKeyOf(e.tokens.join(" ")),
    sourceUrls: e.sources.map((s) => s.u),
  };
}

/** company (normalized) → domain, from portfolio websites + intel entity registry. */
async function buildCompanyDomains(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    for (const p of await buildPortfolioCompanies()) {
      const d = hostOfUrl(p.website || "") || (p.website || "").trim().toLowerCase();
      if (p.name && d) map.set(normCompanyKey(p.name), d.replace(/^www\./, ""));
    }
  } catch {
    /* portfolio unavailable — tiering falls back to config lists */
  }
  try {
    for (const e of await loadIntelEntities()) {
      const key = normCompanyKey(e.name);
      if (e.domain && !map.has(key)) map.set(key, e.domain);
    }
  } catch {
    /* intel registry unavailable */
  }
  return map;
}

/** entity name (normalized) → URID, for the Signal Events ↔ Intel Entities join. */
async function buildEntityUrids(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    for (const e of await loadIntelEntities()) {
      map.set(normCompanyKey(e.name), e.urid);
    }
  } catch {
    /* fine — URID stays "" until the entity exists */
  }
  return map;
}

/**
 * Cluster candidate signals into events and stamp each candidate's eventId.
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
    const cfg = await loadSignalConfig();
    const [domains, urids] = await Promise.all([buildCompanyDomains(), buildEntityUrids()]);
    // Trailing window ×2 so a candidate near the window edge still sees the event.
    const stored = await loadSignalEvents({ sinceDays: cfg.clustering.windowDays * 2 });

    const created: SignalEventRow[] = [];
    const updated = new Set<SignalEventRow>();
    const byId = new Map<string, SignalEventRow>();
    for (const e of stored) byId.set(e.eventId, e);
    const openPool: OpenEventLite[] = stored.map(toOpenLite);

    for (const cand of candidates) {
      const company = (cand.company || "").trim();
      if (!company) continue; // person-only signals stay event-less
      const eventType = eventTypeFromCategory(cand.category);
      const title = cand.subject || cand.signal || "";
      const text = cand.signal || cand.justification || "";
      const dateIso = cand.dateFound || today();
      const url = (cand.sourceUrl || "").trim();
      const realUrl = /^https?:\/\//i.test(url) ? url : "";
      const domain = domains.get(normCompanyKey(company));
      const tier = realUrl ? tierForUrl(realUrl, domain, cfg) : "C";
      const source: EventSource = {
        u: realUrl,
        t: tier,
        d: dateIso,
        ti: title.slice(0, 120),
      };

      const match = matchEvent(
        { company, eventType, title, text, dateIso, sourceUrl: realUrl },
        openPool,
        cfg,
      );

      if (match.event) {
        const ev = byId.get(match.event.eventId);
        if (!ev) continue;
        const known = new Set(ev.sources.map((s) => s.u.trim().toLowerCase().replace(/\/+$/, "")));
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
        if (ev.eventType === "other" && eventType !== "other") ev.eventType = eventType;
        ev.tokens = mergeTokens(ev.tokens, tokensOf(title, text));
        ev.lastUpdated = dateIso;
        if (ev.status === "open") ev.status = "updated";
        ev.confidence = eventConfidence(
          ev.sourceCount,
          ev.topTier,
          Boolean(ev.intelEventId),
          cfg,
        );
        ev.constituentIds = [...new Set([...ev.constituentIds, cand.id])];
        const sb = (ev.scoreBreakdown.clusterLog as string[]) || [];
        ev.scoreBreakdown.clusterLog = [...sb, `${dateIso} +${hostOfUrl(realUrl) || "row"}: ${match.reason}`].slice(-10);
        updated.add(ev);
        // Refresh the in-memory pool entry so later candidates see new tokens.
        const poolIdx = openPool.findIndex((p) => p.eventId === ev.eventId);
        if (poolIdx >= 0) openPool[poolIdx] = toOpenLite(ev);
        cand.eventId = ev.eventId;
      } else {
        const ev: SignalEventRow = {
          eventId: newEventId(),
          company,
          entityUrid: urids.get(normCompanyKey(company)) || "",
          eventType,
          firstSeen: dateIso,
          lastUpdated: dateIso,
          status: "open",
          sourceCount: 1,
          topSourceUrl: realUrl,
          topTier: tier,
          sources: realUrl ? [source] : [],
          confidence: eventConfidence(1, tier, false, cfg),
          materiality: 0,
          materialityAdj: 0,
          relevance: 0,
          actionability: 0,
          surprise: 0,
          rankScore: 0,
          magnitude: null,
          intelEventId: "",
          badges: "",
          scoreBreakdown: { clusterLog: [`${dateIso} seeded: ${match.reason}`] },
          tokens: tokensOf(title, text),
          constituentIds: [cand.id],
          rowNumber: 0,
        };
        created.push(ev);
        byId.set(ev.eventId, ev);
        openPool.push(toOpenLite(ev));
        cand.eventId = ev.eventId;
      }
    }

    await persistSignalEvents({ created, updated: [...updated] });

    if (created.length > 0 || updated.size > 0) {
      await logOpsEvent({
        action: "sync",
        source: "signal_events",
        status: "ok",
        summary: `Event clustering · ${created.length} new event${created.length === 1 ? "" : "s"} · ${updated.size} gained sources`,
        records: created.length + updated.size,
        details: {
          candidates: candidates.length,
          created: created.length,
          updated: updated.size,
        },
        items: [
          ...created.map((e) => `NEW ${e.eventId}: ${e.company} — ${e.eventType} [${e.topTier}]`),
          ...[...updated].map(
            (e) => `+SRC ${e.eventId}: ${e.company} — ${e.eventType} (${e.sourceCount} sources)`,
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

export type { SignalConfig, SignalEventType };
