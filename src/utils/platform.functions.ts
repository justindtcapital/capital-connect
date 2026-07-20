// Server functions for the /platform tab. Thin createServerFn wrappers over
// platform.server.ts (sheet I/O) — AI generation wrappers live further down
// and delegate to the same file. GET fetchers degrade to empty on error so
// the page always renders.

import { createServerFn } from "@tanstack/react-start";
import {
  buildPortcoKpis as buildPortcoKpisServer,
  appendKpiPoints as appendKpiPointsServer,
  deleteKpiPoint as deleteKpiPointServer,
  buildPlatformContent as buildPlatformContentServer,
  buildRadarWatchlist as buildRadarWatchlistServer,
  addRadarEntry as addRadarEntryServer,
  removeRadarEntry as removeRadarEntryServer,
  extractKpisFromText as extractKpisFromTextServer,
  fetchDigitalTraction as fetchDigitalTractionServer,
  fetchPublicValuation as fetchPublicValuationServer,
  generateExecBrief as generateExecBriefServer,
  generateBoardArticles as generateBoardArticlesServer,
  generateMgmtQuestions as generateMgmtQuestionsServer,
  runDiligence as runDiligenceServer,
  buildTheses as buildThesesServer,
  addThesis as addThesisServer,
  updateThesis as updateThesisServer,
  setThesisStatus as setThesisStatusServer,
  buildThesisMatches as buildThesisMatchesServer,
  setThesisMatchStatus as setThesisMatchStatusServer,
  screenThesis as screenThesisServer,
  promoteThesisMatch as promoteThesisMatchServer,
} from "./platform.server";
import type { KpiPasteAttachment, KpiPoint, NewKpiPoint } from "@/lib/platform-kpi";
import type { PlatformContentRow, RadarEntry, NewRadarEntry } from "@/lib/platform-content";
import type {
  NewThesis,
  Thesis,
  ThesisMatch,
  ThesisMatchStatus,
  ThesisStatus,
} from "@/lib/platform-thesis";

// ── KPI datapoints ───────────────────────────────────────────────

export const fetchPlatformKpis = createServerFn({ method: "GET" }).handler(
  async (): Promise<KpiPoint[]> => {
    try {
      return await buildPortcoKpisServer();
    } catch (error) {
      console.error("fetchPlatformKpis failed:", error);
      return [];
    }
  },
);

export const addKpiPoints = createServerFn({ method: "POST" })
  .inputValidator((data: { points: NewKpiPoint[]; enteredBy: string }) => data)
  .handler(async ({ data }) => {
    if (!data.points?.length) throw new Error("No datapoints to save");
    const company = data.points[0].companyName;
    const smartPaste = data.points[0].source === "smart_paste";
    const added = await appendKpiPointsServer(data.points, data.enteredBy, {
      action: smartPaste ? "import" : "edit",
      source: "platform-kpi",
      summary: smartPaste
        ? `Smart-paste saved ${data.points.length} KPI datapoint(s) for ${company}`
        : `Added ${data.points.length} KPI datapoint(s) for ${company}`,
    });
    return { added };
  });

export const removeKpiPoint = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    if (!data.id) throw new Error("Datapoint id is required");
    return { deleted: await deleteKpiPointServer(data.id) };
  });

// ── Saved platform content ───────────────────────────────────────

export const fetchPlatformContent = createServerFn({ method: "GET" }).handler(
  async (): Promise<PlatformContentRow[]> => {
    try {
      return await buildPlatformContentServer();
    } catch (error) {
      console.error("fetchPlatformContent failed:", error);
      return [];
    }
  },
);

// ── Competitive radar watchlist ──────────────────────────────────

export const fetchRadar = createServerFn({ method: "GET" }).handler(
  async (): Promise<RadarEntry[]> => {
    try {
      return await buildRadarWatchlistServer();
    } catch (error) {
      console.error("fetchRadar failed:", error);
      return [];
    }
  },
);

export const addRadarEntry = createServerFn({ method: "POST" })
  .inputValidator((data: { entry: NewRadarEntry; addedBy: string }) => data)
  .handler(async ({ data }) => {
    if (!data.entry?.company?.trim()) throw new Error("Company name is required");
    return await addRadarEntryServer(data.entry, data.addedBy);
  });

export const removeRadarEntry = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    if (!data.id) throw new Error("Radar entry id is required");
    return { removed: await removeRadarEntryServer(data.id) };
  });

// ── AI: KPI extraction + web refresh ─────────────────────────────

export const extractKpisFromPaste = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      urid?: string;
      name: string;
      text?: string;
      attachments?: KpiPasteAttachment[];
    }) => data,
  )
  .handler(async ({ data }) => {
    if (!data.name?.trim()) throw new Error("Company is required");
    const text = data.text || "";
    const attachments = data.attachments || [];
    if (!text.trim() && attachments.length === 0) {
      throw new Error("Paste text or upload a document to extract from");
    }
    return await extractKpisFromTextServer(
      { urid: data.urid, name: data.name },
      text,
      attachments,
    );
  });

export const refreshDigitalTraction = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { urid?: string; name: string; website?: string; enteredBy: string }) => data,
  )
  .handler(async ({ data }) => {
    if (!data.name?.trim()) throw new Error("Company is required");
    return await fetchDigitalTractionServer(
      { urid: data.urid, name: data.name, website: data.website },
      data.enteredBy,
    );
  });

export const refreshPublicValuation = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { urid?: string; name: string; website?: string; enteredBy: string }) => data,
  )
  .handler(async ({ data }) => {
    if (!data.name?.trim()) throw new Error("Company is required");
    return await fetchPublicValuationServer(
      { urid: data.urid, name: data.name, website: data.website },
      data.enteredBy,
    );
  });

// ── AI: on-demand content generation (persisted to Platform Content) ──

export const generateExecBrief = createServerFn({ method: "POST" })
  .inputValidator((data: { theme: string; generatedBy: string }) => data)
  .handler(async ({ data }) => {
    if (!data.theme?.trim()) throw new Error("Theme is required");
    return await generateExecBriefServer(data.theme.trim(), data.generatedBy);
  });

export const generateBoardArticles = createServerFn({ method: "POST" })
  .inputValidator((data: { theme: string; generatedBy: string }) => data)
  .handler(async ({ data }) => {
    if (!data.theme?.trim()) throw new Error("Theme is required");
    return await generateBoardArticlesServer(data.theme.trim(), data.generatedBy);
  });

export const generateMgmtQuestions = createServerFn({ method: "POST" })
  .inputValidator((data: { urid?: string; name: string; generatedBy: string }) => data)
  .handler(async ({ data }) => {
    if (!data.name?.trim()) throw new Error("Company is required");
    return await generateMgmtQuestionsServer({ urid: data.urid, name: data.name }, data.generatedBy);
  });

export const runPlatformDiligence = createServerFn({ method: "POST" })
  .inputValidator((data: { company: string; website?: string; generatedBy: string }) => data)
  .handler(async ({ data }) => {
    if (!data.company?.trim()) throw new Error("Company is required");
    return await runDiligenceServer(data.company.trim(), data.website?.trim(), data.generatedBy);
  });

// ── Investment theses + screening (Sourcing tab) ─────────────────

export const fetchTheses = createServerFn({ method: "GET" }).handler(
  async (): Promise<Thesis[]> => {
    try {
      return await buildThesesServer();
    } catch (error) {
      console.error("fetchTheses failed:", error);
      return [];
    }
  },
);

export const fetchThesisMatches = createServerFn({ method: "GET" }).handler(
  async (): Promise<ThesisMatch[]> => {
    try {
      return await buildThesisMatchesServer();
    } catch (error) {
      console.error("fetchThesisMatches failed:", error);
      return [];
    }
  },
);

export const saveThesis = createServerFn({ method: "POST" })
  .inputValidator((data: { thesis: NewThesis; id?: string; savedBy: string }) => data)
  .handler(async ({ data }): Promise<{ thesis?: Thesis; updated: boolean }> => {
    if (!data.thesis?.name?.trim()) throw new Error("Thesis name is required");
    if (data.id) {
      const ok = await updateThesisServer(data.id, data.thesis);
      if (!ok) throw new Error("Thesis not found — refresh and try again");
      return { updated: true };
    }
    return { thesis: await addThesisServer(data.thesis, data.savedBy), updated: false };
  });

export const setThesisStatusFn = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string; status: ThesisStatus }) => data)
  .handler(async ({ data }) => {
    if (!data.id) throw new Error("Thesis id is required");
    return { ok: await setThesisStatusServer(data.id, data.status) };
  });

export const runThesisScreen = createServerFn({ method: "POST" })
  .inputValidator((data: { thesisId: string; screenedBy: string }) => data)
  .handler(async ({ data }) => {
    if (!data.thesisId) throw new Error("Thesis id is required");
    return await screenThesisServer(data.thesisId, data.screenedBy);
  });

export const setThesisMatchStatusFn = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string; status: ThesisMatchStatus }) => data)
  .handler(async ({ data }) => {
    if (!data.id) throw new Error("Match id is required");
    return { ok: await setThesisMatchStatusServer(data.id, data.status) };
  });

export const promoteThesisMatchFn = createServerFn({ method: "POST" })
  .inputValidator((data: { matchId: string; promotedBy: string }) => data)
  .handler(async ({ data }) => {
    if (!data.matchId) throw new Error("Match id is required");
    return await promoteThesisMatchServer(data.matchId, data.promotedBy);
  });
