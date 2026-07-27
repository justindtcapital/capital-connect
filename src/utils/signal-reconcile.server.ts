// Signals v2 — nightly reconciliation (WS3): idempotent passes that keep the
// two pipelines' views of the world fused after both morning runs are done.
//
//   A. Late-arriving news: open intel events whose matching news event arrived
//      AFTER the morning fusion ran → merge (intel keeps first_seen_at, news
//      event badged CONFIRMED_BY_PRESS, intel's feed card joins the group).
//   B. DETECTED BEFORE PRESS — the alpha class: live, material intel events
//      with NO press coverage after N days get the badge and a rank boost so
//      the feed surfaces what the firm knows before the market does.
//   C. Constituent sync: signal rows whose event was rescored since they were
//      stamped get their rank/materiality columns refreshed.
//
// Every pass is deterministic and re-runnable: badges are set-unions, scores
// recompute from stored evidence, firstSeen only ever moves earlier.

import {
  loadSignalEvents,
  persistSignalEvents,
  loadSignalConfig,
  type SignalEventRow,
} from "./event-store.server";
import {
  loadIntelEventsLite,
  stampSignalRowsById,
  buildContext,
  factsFor,
  scoreEvent,
  processCandidatesIntoEvents,
  type SignalRowStamp,
} from "./event-pipeline.server";
import { fetchStoredSignals } from "./signal-store.server";
import { logOpsEvent } from "./sheets.server";
import {
  matchIntelCorroboration,
  newsTypesForIntelState,
  isDetectedBeforePress,
  taxonomyTypeForIntelState,
  isLiveIntelEvent,
  mergeBadges,
  BADGE,
} from "@/lib/fusion";
import { normCompanyKey } from "@/lib/event-cluster";
import {
  scoreMateriality,
  applySurprise,
  eventRelevance,
  eventActionability,
  rankScore,
} from "@/lib/materiality";

export interface ReconcileResult {
  ok: boolean;
  error?: string;
  lateMerges: number;
  detectedBeforePress: number;
  rowsResynced: number;
}

const today = () => new Date().toISOString().split("T")[0];

export async function runSignalsReconcile(): Promise<ReconcileResult> {
  try {
    const cfg = await loadSignalConfig();
    const ctx = await buildContext();
    const intelEvents = await loadIntelEventsLite();
    // 120d window comfortably covers the longest corroboration rule (90d).
    const newsEvents = await loadSignalEvents({ sinceDays: 120 });
    const updatedEvents = new Set<SignalEventRow>();
    const stamps = new Map<string, SignalRowStamp>();

    // ── Pass A: late-arriving news for open intel events ──────────
    let lateMerges = 0;
    for (const ev of newsEvents) {
      if (ev.intelEventId) continue; // already fused
      if (ev.status === "closed") continue;
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
      if (!fuse) continue;
      ev.intelEventId = fuse.intel.eventId;
      ev.scoreBreakdown.corroboration = {
        intelEventId: fuse.intel.eventId,
        state: fuse.intel.state,
        firstDetected: fuse.intel.firstDetected,
        observations: fuse.intel.evidenceLines,
        reconciled: today(),
      };
      if (fuse.intelWasFirst && fuse.intel.firstDetected && fuse.intel.firstDetected < ev.firstSeen) {
        ev.firstSeen = fuse.intel.firstDetected;
      }
      ev.badges = mergeBadges(
        ev.badges,
        fuse.intelWasFirst ? BADGE.confirmedByPress : BADGE.intelCorroborated,
      );
      const facts = factsFor(ctx, ev.company);
      const rels = ev.relevance > 0 ? [ev.relevance] : [];
      scoreEvent(ev, facts, rels, cfg, {
        corroborationMultiplier: cfg.fusion.materialityMultiplier,
      });
      updatedEvents.add(ev);
      if (fuse.intel.signalId) {
        stamps.set(fuse.intel.signalId, {
          eventId: ev.eventId,
          addBadges: [BADGE.confirmedByPress],
        });
      }
      lateMerges++;
    }

    // ── Pass B: DETECTED BEFORE PRESS (the alpha class) ───────────
    let dbp = 0;
    for (const ie of intelEvents) {
      if (!isLiveIntelEvent(ie.status) || !ie.signalId) continue;
      const confirmTypes = newsTypesForIntelState(ie.state, cfg);
      const hasNews = newsEvents.some((ev) => {
        const sameCompany =
          (ev.entityUrid && ie.urid && ev.entityUrid === ie.urid) ||
          normCompanyKey(ev.company) === normCompanyKey(ie.entity);
        return sameCompany && (confirmTypes.includes(ev.eventType) || ev.intelEventId === ie.eventId);
      });
      if (!isDetectedBeforePress(ie, hasNews, today(), cfg)) continue;

      // Rank the intel-only card on the shared materiality scale, then boost.
      const facts = factsFor(ctx, ie.entity);
      const taxonomyType = taxonomyTypeForIntelState(ie.state, cfg);
      const mat = scoreMateriality(
        {
          eventType: taxonomyType,
          magnitude: null,
          isPortco: facts.isPortco,
          isWatch: facts.isWatch,
          atsOpenRoles: facts.atsOpenRoles,
        },
        cfg,
      );
      const sur = applySurprise(mat.materiality, null, cfg);
      const rel = eventRelevance(
        {
          recRelevances: [],
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
      const base = rankScore(
        {
          materialityAdj: sur.materialityAdj,
          relevance: rel.relevance,
          actionability: act.actionability,
        },
        cfg,
      );
      const boosted = Math.min(100, Math.round(base.rank * cfg.fusion.detectedBeforePressBoost));
      stamps.set(ie.signalId, {
        addBadges: [BADGE.detectedBeforePress],
        materiality: sur.materialityAdj,
        rankScore: boosted,
        scoreBreakdown: JSON.stringify({
          detectedBeforePress: true,
          intelEventId: ie.eventId,
          intelState: ie.state,
          taxonomyType,
          intelConfidence: ie.confidence,
          firstDetected: ie.firstDetected,
          baseRank: base.rank,
          boost: cfg.fusion.detectedBeforePressBoost,
          rank: boosted,
          parts: [...mat.parts, sur.part, rel.part, act.part],
          observations: ie.evidenceLines,
        }).slice(0, 3000),
      });
      dbp++;
    }

    // ── Pass D: cluster recent rows that arrived without an event ──
    // Digest-link rows (stored by a client-retained module that cannot import
    // this pipeline) and any rows from a scan whose pipeline step failed get
    // clustered/scored here. Intel "Momentum" rows are the intel engine's own
    // cards and stay event-less (fusion links them via passes A/B instead).
    const stored = await fetchStoredSignals();
    const cutoffD = new Date(Date.now() - 3 * 86_400_000).toISOString().split("T")[0];
    const unclustered = stored.filter(
      (s) =>
        !s.eventId &&
        (s.company || "").trim() &&
        s.category !== "Momentum" &&
        s.dateFound >= cutoffD,
    );
    let lateClustered = 0;
    if (unclustered.length > 0) {
      const { enriched } = await processCandidatesIntoEvents(unclustered);
      for (const s of enriched) {
        if (!s.eventId) continue;
        stamps.set(s.id, {
          eventId: s.eventId,
          materiality: s.materiality ?? undefined,
          rankScore: s.rankScore ?? undefined,
          scoreBreakdown: s.scoreBreakdown,
          addBadges: (s.badges || "").split(";").filter(Boolean),
        });
        lateClustered++;
      }
    }

    // ── Pass C: re-sync constituent signal rows with rescored events ──
    const eventById = new Map(newsEvents.map((e) => [e.eventId, e]));
    let resync = 0;
    for (const s of stored) {
      if (!s.eventId) continue;
      const ev = eventById.get(s.eventId);
      if (!ev) continue;
      const drifted =
        (s.rankScore ?? -1) !== ev.rankScore || (s.materiality ?? -1) !== ev.materialityAdj;
      if (!drifted) continue;
      const prev = stamps.get(s.id) || {};
      stamps.set(s.id, {
        ...prev,
        materiality: ev.materialityAdj,
        rankScore: ev.rankScore,
        addBadges: [...(prev.addBadges || []), ...ev.badges.split(";").filter(Boolean)],
      });
      resync++;
    }

    await persistSignalEvents({ created: [], updated: [...updatedEvents] });
    const stamped = await stampSignalRowsById(stamps);

    await logOpsEvent({
      action: "sync",
      source: "signals_reconcile",
      status: "ok",
      summary: `Signals reconcile · ${lateMerges} late merge${lateMerges === 1 ? "" : "s"} · ${dbp} detected-before-press · ${lateClustered} late-clustered · ${stamped} rows restamped`,
      records: stamped,
      details: {
        lateMerges,
        detectedBeforePress: dbp,
        lateClustered,
        rowsResynced: resync,
        stamped,
      },
    });

    return { ok: true, lateMerges, detectedBeforePress: dbp, rowsResynced: resync };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Signals reconcile failed";
    console.error("[signals-reconcile] failed:", err);
    await logOpsEvent({
      action: "sync",
      source: "signals_reconcile",
      status: "error",
      summary: message,
      records: 0,
    });
    return { ok: false, error: message, lateMerges: 0, detectedBeforePress: 0, rowsResynced: 0 };
  }
}
