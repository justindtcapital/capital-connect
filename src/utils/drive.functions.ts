import { createServerFn } from "@tanstack/react-start";
import { listDriveDocs, type DriveFeedResult } from "./drive.server";

// Recent PDFs from the configured shared-drive folder (metadata only — no bytes).
// Returns { configured:false } when GOOGLE_DRIVE_SIGNALS_FOLDER_ID is absent so the
// UI can show a connect-prompt instead of an error. The scan path downloads the
// actual bytes separately (see gemini.functions.ts).
export const fetchDriveDocs = createServerFn({ method: "GET" }).handler(
  async (): Promise<DriveFeedResult> => {
    try {
      return await listDriveDocs(25);
    } catch (e) {
      console.error("fetchDriveDocs failed:", e);
      return { configured: false, found: false, docs: [], error: "Drive fetch failed." };
    }
  },
);
