import { createServerFn } from "@tanstack/react-start";
import { callGeminiJSON } from "./gemini.server";
import type { ConstellationQueryResult } from "@/lib/constellation-query";

export interface ConstellationIndexRow {
  id: string;
  name: string;
  company: string;
  sector: string;
  temperature: string;
  contactType: string;
  portCos: string[];
  prime: string;
}

export interface InterpretConstellationResult {
  ok: boolean;
  error?: string;
  errorCode?: string;
  result?: ConstellationQueryResult;
  source?: "gemini" | "local";
}

/**
 * Gemini interprets a natural-language constellation query against a compact
 * sheets-native contact index (no emails / Asana). Falls back is handled client-side.
 */
export const interpretConstellationQuery = createServerFn({ method: "POST" })
  .inputValidator((data: { query: string; index: ConstellationIndexRow[] }) => data)
  .handler(async ({ data }): Promise<InterpretConstellationResult> => {
    const q = (data.query || "").trim();
    if (!q) return { ok: false, error: "Empty query" };
    const index = (data.index || []).slice(0, 120);

    const system =
      "You are the VenturePulse constellation interpreter for a venture capital firm. " +
      "Map a partner's natural-language question onto a structured focus for a relationship graph. " +
      "Only use people/PortCos from the provided INDEX. Never invent IDs. " +
      "Respond ONLY as JSON with this shape:\n" +
      "{\n" +
      '  "summary": "short human summary",\n' +
      '  "contactIds": ["id", ...],\n' +
      '  "portcos": ["PortCo name", ...],\n' +
      '  "sector": "optional sector string or omit",\n' +
      '  "overlay": "decay|opportunity|bridges|blindspots or omit",\n' +
      '  "trace": { "fromContactId": "...", "toContactId": "...", "fromPortco": "...", "toPortco": "..." } or omit\n' +
      "}\n" +
      "Rules: prefer real IDs from INDEX; for path/trace questions fill trace; " +
      "for cooling/decay set overlay decay; for blind spots set overlay blindspots; " +
      "for bridges set overlay bridges; keep contactIds ≤ 24.";

    const lines = index.map(
      (r, i) =>
        `${i + 1}. id=${r.id} | ${r.name} | ${r.company || "—"} | ${r.temperature} | ${r.contactType || "—"} | sector=${r.sector || "—"} | prime=${r.prime || "—"} | portcos=${(r.portCos || []).slice(0, 6).join(", ") || "none"}`,
    );
    const user = `QUERY: ${q}\n\nINDEX (${index.length}):\n${lines.join("\n")}`;

    const res = await callGeminiJSON<{
      summary?: string;
      contactIds?: string[];
      portcos?: string[];
      sector?: string;
      overlay?: string;
      trace?: {
        fromContactId?: string;
        toContactId?: string;
        fromPortco?: string;
        toPortco?: string;
      };
    }>(system, user, 900, { maxAttempts: 2 });

    if (!res.ok || !res.data) {
      return {
        ok: false,
        error: res.error || "Constellation interpretation failed",
        errorCode: res.errorCode,
      };
    }

    const validIds = new Set(index.map((r) => r.id));
    const portcoSet = new Set(index.flatMap((r) => r.portCos || []));
    const contactIds = (res.data.contactIds || []).filter((id) => validIds.has(id)).slice(0, 24);
    const portcos = (res.data.portcos || [])
      .filter((p) => [...portcoSet].some((x) => x.toLowerCase() === p.toLowerCase()))
      .slice(0, 10);

    const overlayRaw = (res.data.overlay || "").toLowerCase();
    const overlay =
      overlayRaw === "decay" ||
      overlayRaw === "opportunity" ||
      overlayRaw === "bridges" ||
      overlayRaw === "blindspots"
        ? overlayRaw
        : undefined;

    const trace = res.data.trace
      ? {
          fromContactId: res.data.trace.fromContactId && validIds.has(res.data.trace.fromContactId)
            ? res.data.trace.fromContactId
            : undefined,
          toContactId: res.data.trace.toContactId && validIds.has(res.data.trace.toContactId)
            ? res.data.trace.toContactId
            : undefined,
          fromPortco: res.data.trace.fromPortco,
          toPortco: res.data.trace.toPortco,
        }
      : undefined;

    return {
      ok: true,
      source: "gemini",
      result: {
        summary: res.data.summary || "AI focus applied",
        contactIds,
        portcos,
        sector: res.data.sector,
        overlay,
        trace,
      },
    };
  });
