// Server functions for Signal Radar v2 intel sweeps (see intel.server.ts).
import { createServerFn } from "@tanstack/react-start";
import {
  runIntelSweep,
  seedIntelEntities,
  intelStatus,
  recordSignalVerdict,
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
