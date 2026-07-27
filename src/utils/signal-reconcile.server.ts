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
  loadSignalFeedback,
  appendSignalFeedback,
  appendSignalMetric,
  loadSignalMetrics,
  type SignalEventRow,
  type FeedbackRow,
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
import { fetchStoredSignals, rowFromStored } from "./signal-store.server";
import { logOpsEvent, appendSheetRows, TAB_NAMES } from "./sheets.server";
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
  ignoredComputed: number;
  precisionAt10: number | null;
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
      const { enriched, extraRows } = await processCandidatesIntoEvents(unclustered);
      if (extraRows.length > 0) {
        // Burst meta-event cards created during reconcile are NEW rows.
        await appendSheetRows(TAB_NAMES.signals, extraRows.map(rowFromStored));
      }
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

    // ── Pass E (WS5): terminal feedback rows + precision@10 ───────
    // "Ignored" = rendered in top-N today, session over, no interaction —
    // computed HERE nightly, never client-side. Idempotent: existing ignored
    // rows and an existing metric row for today short-circuit re-runs.
    const todayIso = today();
    const feedback = await loadSignalFeedback({ sinceDays: 2 });
    const todays = feedback.filter((f) => f.dateIso.startsWith(todayIso));
    const renderedByKey = new Map<string, FeedbackRow>();
    const interacted = new Set<string>();
    const dismissedSet = new Set<string>();
    const alreadyIgnored = new Set<string>();
    for (const f of todays) {
      const key = f.eventId || f.signalId;
      if (!key) continue;
      if (f.action === "rendered") {
        if (!renderedByKey.has(key)) renderedByKey.set(key, f);
      } else if (f.action === "expanded" || f.action === "clicked_source" || f.action === "actioned") {
        interacted.add(key);
      } else if (f.action === "dismissed") {
        dismissedSet.add(key);
      } else if (f.action === "ignored") {
        alreadyIgnored.add(key);
      }
    }
    const ignoredRows: FeedbackRow[] = [];
    for (const [key, r] of renderedByKey) {
      if (interacted.has(key) || dismissedSet.has(key) || alreadyIgnored.has(key)) continue;
      ignoredRows.push({ ...r, dateIso: new Date().toISOString(), action: "ignored" });
    }
    if (ignoredRows.length > 0) await appendSignalFeedback(ignoredRows);

    let precisionAt10: number | null = null;
    const top10 = [...renderedByKey.values()].filter(
      (r) => r.rankPosition != null && r.rankPosition <= 10,
    );
    if (top10.length > 0) {
      const existing = await loadSignalMetrics("precision_at_10", { sinceDays: 1 });
      if (!existing.some((m) => m.date === todayIso)) {
        const hit = top10.filter((r) => interacted.has(r.eventId || r.signalId)).length;
        precisionAt10 = Math.round((hit / top10.length) * 100) / 100;
        await appendSignalMetric("precision_at_10", precisionAt10, {
          date: todayIso,
          interacted: hit,
          rendered: top10.length,
        });
      }
    }

    await persistSignalEvents({ created: [], updated: [...updatedEvents] });
    const stamped = await stampSignalRowsById(stamps);

    await logOpsEvent({
      action: "sync",
      source: "signals_reconcile",
      status: "ok",
      summary: `Signals reconcile · ${lateMerges} late merge${lateMerges === 1 ? "" : "s"} · ${dbp} detected-before-press · ${lateClustered} late-clustered · ${ignoredRows.length} ignored · ${stamped} rows restamped${precisionAt10 != null ? ` · p@10 ${precisionAt10}` : ""}`,
      records: stamped,
      details: {
        lateMerges,
        detectedBeforePress: dbp,
        lateClustered,
        rowsResynced: resync,
        stamped,
        ignoredComputed: ignoredRows.length,
        precisionAt10,
      },
    });

    return {
      ok: true,
      lateMerges,
      detectedBeforePress: dbp,
      rowsResynced: resync,
      ignoredComputed: ignoredRows.length,
      precisionAt10,
    };
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
    return {
      ok: false,
      error: message,
      lateMerges: 0,
      detectedBeforePress: 0,
      rowsResynced: 0,
      ignoredComputed: 0,
      precisionAt10: null,
    };
  }
}
