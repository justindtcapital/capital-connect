// K — user-facing "wrong attribution" flag (server function boundary).

import { createServerFn } from "@tanstack/react-start";
import {
  recordAttributionFlag,
  type AttributionFlagInput,
} from "./activity-attribution.server";

export const flagActivityAttribution = createServerFn({ method: "POST" })
  .inputValidator((data: AttributionFlagInput) => data)
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    if (!data?.gid) return { ok: false, error: "Missing activity id." };
    try {
      await recordAttributionFlag(data);
      return { ok: true };
    } catch (e) {
      console.error("[attribution] flag failed:", e);
      return { ok: false, error: e instanceof Error ? e.message : "Could not save the correction." };
    }
  });
