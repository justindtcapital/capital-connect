// Server functions for Signal Radar v2 intel sweeps (see intel.server.ts).
import { createServerFn } from "@tanstack/react-start";
import {
  runIntelSweep,
  seedIntelEntities,
  intelStatus,
  recordSignalVerdict,
  setEntityWatchTier,
  loadIntelEntities,
  type IntelSweepResult,
  type IntelStatus,
  type SignalVerdict,
} from "./intel.server";

/** Run a collection sweep now (stale-first batch; API-budget capped). */
export const runIntelScan = createServerFn({ method: "POST" })
  .inputValidator((data: { limit?: number; tier?: string; entityName?: string }) => data)
  .handler(
    async ({ data }): Promise<IntelSweepResult> =>
      runIntelSweep({ limit: data.limit, tier: data.tier, entityName: data.entityName }),
  );

/** Seed/refresh the tracked-entity registry from PortCos + Radar Watchlist + Targets. */
export const seedIntel = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ added: number; total: number }> => seedIntelEntities(),
);

/** Registry/ledger counts for status displays. */
export const fetchIntelStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<IntelStatus> => intelStatus(),
);

/** Partner feedback on a signal — the learning loop's labels. */
export const recordVerdict = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      signalId: string;
      company: string;
      verdict: SignalVerdict;
      user?: string;
      note?: string;
    }) => data,
  )
  .handler(async ({ data }) =>
    recordSignalVerdict({
      signalId: data.signalId,
      company: data.company,
      verdict: data.verdict,
      user: data.user || "unknown",
      note: data.note,
    }),
  );

// ── WS6 — watch-universe tier editor ─────────────────────────────

export interface WatchEntity {
  urid: string;
  name: string;
  domain: string;
  tier: string;
  watchTier: number;
  lastScanned: string;
}

/** The tracked-entity registry, lean, for the tier editor. */
export const fetchWatchUniverse = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ entities: WatchEntity[] }> => {
    const entities = await loadIntelEntities();
    return {
      entities: entities.map((e) => ({
        urid: e.urid,
        name: e.name,
        domain: e.domain,
        tier: e.tier,
        watchTier: e.watchTier,
        lastScanned: e.lastScanned,
      })),
    };
  },
);

/** Set an entity's watch tier (1/2/3). Manual demotion to 3 resets the
 *  promotion evidence so the auto-rule doesn't instantly re-fire. */
export const setWatchTier = createServerFn({ method: "POST" })
  .inputValidator((data: { urid: string; watchTier: number; user?: string }) => data)
  .handler(async ({ data }) => setEntityWatchTier(data));
