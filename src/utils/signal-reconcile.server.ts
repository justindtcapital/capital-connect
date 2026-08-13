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
  appendTimeAdvantageRow,
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
import { fetchStoredSignals, rowFromStored, keyForStored, type StoredSignal } from "./signal-store.server";
import { logOpsEvent, appendSheetRows, TAB_NAMES, fetchSheetTab } from "./sheets.server";
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
import {
  detectComposites,
  eventTypeForComposite,
  type EvidenceChange,
  type EvidenceFamily,
} from "@/lib/composite-events";
import { computeTrajectory, trajectorySurpriseMult } from "@/lib/trajectory";
import { policyFor } from "@/utils/intel-detect.server";
import { INTEL_TABS } from "./intel.server";
import { newsSourceType } from "@/lib/signal-feed";
import { categoryFromEventType } from "@/lib/signal-extract";
import type { SignalEventType } from "@/lib/signal-config";
export interface ReconcileResult {
  ok: boolean;
  error?: string;
  lateMerges: number;
  detectedBeforePress: number;
  rowsResynced: number;
  ignoredComputed: number;
  precisionAt10: number | null;
  /** Rows removed by the retention pass (null = pass disabled or failed). */
  pruned: number | null;
  compositesEmitted: number;
  trajectoryReversals: number;
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
      const pressFirstSeen = ev.firstSeen;
      if (fuse.intelWasFirst && fuse.intel.firstDetected && fuse.intel.firstDetected < ev.firstSeen) {
        ev.firstSeen = fuse.intel.firstDetected;
      }
      ev.badges = mergeBadges(
        ev.badges,
        fuse.intelWasFirst ? BADGE.confirmedByPress : BADGE.intelCorroborated,
      );
      if (fuse.intelWasFirst && fuse.intel.firstDetected && pressFirstSeen) {
        void appendTimeAdvantageRow({
          eventId: ev.eventId,
          entityUrid: ev.entityUrid || fuse.intel.urid,
          company: ev.company,
          intelFirstSeen: fuse.intel.firstDetected,
          pressFirstSeen,
          intelEvidence: fuse.intel.evidenceLines,
        });
      }
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

    // ── Pass G (Phase 4.1): composite weak-signal cards from intel evidence ──
    let compositesEmitted = 0;
    try {
      const intelRows = await fetchSheetTab(INTEL_TABS.events).catch(() => [] as string[][]);
      const changes: EvidenceChange[] = [];
      for (let i = 1; i < intelRows.length; i++) {
        const r = intelRows[i] || [];
        const eventId = (r[0] || "").trim();
        const urid = (r[1] || "").trim();
        const entity = (r[2] || "").trim();
        if (!eventId || !entity) continue;
        let items: Array<{
          date?: string;
          metric?: string;
          prev?: number;
          next?: number;
          reason?: string;
        }> = [];
        try {
          items = JSON.parse(r[9] || "[]");
        } catch {
          continue;
        }
        for (const ev of items) {
          const metric = (ev.metric || "").trim();
          if (!metric) continue;
          const fam = policyFor(metric).family as EvidenceFamily;
          const delta =
            Number.isFinite(ev.next) && Number.isFinite(ev.prev)
              ? Number(ev.next) - Number(ev.prev)
              : 0;
          const sign = delta >= 0 ? "+" : "";
          changes.push({
            id: `${eventId}:${metric}:${ev.date || ""}`,
            entityId: urid,
            company: entity,
            family: fam,
            metric,
            dateIso: (ev.date || "").slice(0, 10),
            label: `${sign}${Math.abs(Math.round(delta)) || 1} ${policyFor(metric).label}`,
            reason: ev.reason || "",
          });
        }
      }
      const todayIso = today();
      const { hits } = detectComposites(changes, todayIso);
      const existingCompositeKeys = new Set(
        stored
          .filter((s) => (s.badges || "").includes(BADGE.composite))
          .map((s) => `${normCompanyKey(s.company)}:${(s.signal || "").slice(0, 40)}`),
      );
      const compositeRows: StoredSignal[] = [];
      for (const hit of hits) {
        const key = `${normCompanyKey(hit.company)}:${hit.why.slice(0, 40)}`;
        if (existingCompositeKeys.has(key)) continue;
        const eventType = eventTypeForComposite(hit.rule) as SignalEventType;
        const category = categoryFromEventType(eventType);
        const row: StoredSignal = {
          id: "",
          dateFound: todayIso,
          type: "awareness",
          status: "New",
          person: "",
          company: hit.company,
          email: "",
          category,
          signal: hit.why,
          sourceUrl: "",
          subject: `${hit.ruleLabel}: ${hit.company}`,
          body: hit.evidence.map((e) => `• ${e.label} (${e.dateIso}) — ${e.metric}`).join("\n"),
          relevance: hit.prior,
          justification: `Composite ${hit.rule} · ${hit.evidence.length} independent family changes`,
          urgency: "High",
          timing: todayIso,
          sourceType: newsSourceType(category, false, ""),
          docUrl: "",
          hasBody: true,
          badges: BADGE.composite,
          entityUrid: hit.entityId || undefined,
          scoreBreakdown: JSON.stringify({
            pipeline: "phase4_composite",
            rule: hit.rule,
            compositeId: hit.compositeId,
            evidence: hit.evidence.map((e) => ({
              family: e.family,
              metric: e.metric,
              date: e.dateIso,
              label: e.label,
            })),
            parts: [{ name: "composite_prior", value: hit.prior, why: hit.why }],
          }).slice(0, 4000),
        };
        row.id = keyForStored(row);
        compositeRows.push(row);
      }
      if (compositeRows.length > 0) {
        const { enriched, extraRows } = await processCandidatesIntoEvents(compositeRows);
        await appendSheetRows(TAB_NAMES.signals, [...enriched, ...extraRows].map(rowFromStored));
        compositesEmitted = enriched.length + extraRows.length;
      }
    } catch (err) {
      console.error("[signals-reconcile] composite pass failed:", err);
    }

    // ── Pass H (Phase 4.2): trajectory reversal badges on open events ──
    let trajectoryReversals = 0;
    try {
      const seriesRows = await fetchSheetTab(INTEL_TABS.series).catch(() => [] as string[][]);
      // series: urid, entity, metric, current, baseline, slopeWk, z, history JSON, updated
      const byCompanyMetric = new Map<string, Array<{ dateIso: string; value: number }>>();
      for (let i = 1; i < seriesRows.length; i++) {
        const r = seriesRows[i] || [];
        const entity = (r[1] || "").trim();
        const metric = (r[2] || "").trim();
        if (!entity || !metric) continue;
        let history: Array<[string, number]> = [];
        try {
          history = JSON.parse(r[7] || "[]");
        } catch {
          continue;
        }
        const points = history.map(([d, v]) => ({ dateIso: String(d).slice(0, 10), value: Number(v) }));
        byCompanyMetric.set(`${normCompanyKey(entity)}::${metric}`, points);
      }
      for (const ev of newsEvents) {
        if (ev.status === "closed") continue;
        const key = `${normCompanyKey(ev.company)}::ats_open_roles`;
        const pts = byCompanyMetric.get(key);
        if (!pts || pts.length < 4) continue;
        const traj = computeTrajectory(pts);
        if (!traj.reversal) continue;
        const before = ev.badges;
        ev.badges = mergeBadges(ev.badges, BADGE.trajectoryReversal);
        const mult = trajectorySurpriseMult(traj);
        if (mult.value !== 1) {
          ev.rankScore = Math.round(ev.rankScore * mult.value);
          ev.scoreBreakdown.trajectory = {
            ...traj,
            surpriseMult: mult,
          };
        }
        if (ev.badges !== before) {
          updatedEvents.add(ev);
          trajectoryReversals++;
        }
      }
    } catch (err) {
      console.error("[signals-reconcile] trajectory pass failed:", err);
    }

    await persistSignalEvents({ created: [], updated: [...updatedEvents] });
    const stamped = await stampSignalRowsById(stamps);

    // ── Pass F: retention prune ───────────────────────────────────
    // Hold the Signals tab to its rolling window (SIGNALS_RETENTION_DAYS,
    // default 365; archive mode). Best-effort — a prune failure must never
    // fail the reconcile, and it logs its own ops event.
    let pruned: number | null = null;
    if ((process.env["SIGNALS_RETENTION_ENABLED"] || "true").toLowerCase() !== "false") {
      try {
        const { runSignalsPrune } = await import("./signals-prune.server");
        pruned = (await runSignalsPrune()).deleted;
      } catch (err) {
        console.error("[signals-reconcile] retention prune failed:", err);
      }
    }

    await logOpsEvent({
      action: "sync",
      source: "signals_reconcile",
      status: "ok",
      summary: `Signals reconcile · ${lateMerges} late merge${lateMerges === 1 ? "" : "s"} · ${dbp} detected-before-press · ${lateClustered} late-clustered · ${ignoredRows.length} ignored · ${compositesEmitted} composites · ${trajectoryReversals} traj reversals · ${stamped} rows restamped${precisionAt10 != null ? ` · p@10 ${precisionAt10}` : ""}${pruned != null ? ` · ${pruned} pruned` : ""}`,
      records: stamped,
      details: {
        lateMerges,
        detectedBeforePress: dbp,
        lateClustered,
        rowsResynced: resync,
        stamped,
        ignoredComputed: ignoredRows.length,
        precisionAt10,
        pruned,
        compositesEmitted,
        trajectoryReversals,
      },
    });

    return {
      ok: true,
      lateMerges,
      detectedBeforePress: dbp,
      rowsResynced: resync,
      ignoredComputed: ignoredRows.length,
      precisionAt10,
      pruned,
      compositesEmitted,
      trajectoryReversals,
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
      pruned: null,
      compositesEmitted: 0,
      trajectoryReversals: 0,
    };
  }
}
