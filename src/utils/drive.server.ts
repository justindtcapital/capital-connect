// Google Drive integration — read PDFs from a shared drive for the Signals tab.
//
// Reuses the SAME Google OAuth refresh token as Sheets (getAccessToken). For this
// to work the refresh token must be minted with the Drive read-only scope
// (https://www.googleapis.com/auth/drive.readonly) — re-run mint-google-token.mjs
// (the scope is already added there) and paste the new GOOGLE_REFRESH_TOKEN.
//
// Two layers:
//  - listDriveDocs():    cheap metadata-only listing (powers the Signals reel lane).
//  - downloadDriveFile(): pulls one file's raw bytes as base64 (for feeding PDFs to
//    Claude as document blocks during a scan).
//
// Everything degrades gracefully when GOOGLE_DRIVE_SIGNALS_FOLDER_ID is unset
// (isDriveConfigured() === false), mirroring the LinkedIn connector.

import { getAccessToken } from "./sheets.server";

const DRIVE_API = "https://www.googleapis.com/drive/v3";

export interface DriveDoc {
  id: string;
  name: string;
  mimeType: string;
  /** Last-modified time, epoch ms (0 when unknown). */
  modifiedTime: number;
  /** YYYY-MM-DD label (empty when unknown). */
  modifiedLabel: string;
  /** Permalink to open the file in Drive. */
  webViewLink: string;
  /** File size in bytes (0 when unknown — Google omits size for some types). */
  sizeBytes: number;
}

export interface DriveFeedResult {
  /** True when GOOGLE_DRIVE_SIGNALS_FOLDER_ID is set. */
  configured: boolean;
  /** True when the listing succeeded (even if zero docs). */
  found: boolean;
  docs: DriveDoc[];
  error?: string;
}

export function isDriveConfigured(): boolean {
  return Boolean(process.env.GOOGLE_DRIVE_SIGNALS_FOLDER_ID);
}

function toLabel(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// List PDF files in the configured shared-drive folder, newest first.
// `limit` is capped to 100. Returns metadata only — no file bytes downloaded.
export async function listDriveDocs(limit = 25): Promise<DriveFeedResult> {
  const folderId = process.env.GOOGLE_DRIVE_SIGNALS_FOLDER_ID;
  if (!folderId) return { configured: false, found: false, docs: [] };

  // Optional: the Shared Drive id. When set we scope the query to that drive
  // (corpora=drive) which is required for items that live on a Shared Drive
  // rather than "My Drive". Folders shared into My Drive don't need it.
  const driveId = process.env.GOOGLE_SHARED_DRIVE_ID;

  const params = new URLSearchParams({
    q: `'${folderId}' in parents and mimeType='application/pdf' and trashed=false`,
    fields: "files(id,name,mimeType,modifiedTime,webViewLink,size)",
    orderBy: "modifiedTime desc",
    pageSize: String(Math.min(100, Math.max(1, limit))),
    // Shared Drive support — harmless for My Drive items.
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  if (driveId) {
    params.set("corpora", "drive");
    params.set("driveId", driveId);
  }

  let token: string;
  try {
    token = await getAccessToken();
  } catch (e) {
    console.error("[drive] auth failed:", e);
    return { configured: true, found: false, docs: [], error: "Google auth failed." };
  }

  let res: Response;
  try {
    res = await fetch(`${DRIVE_API}/files?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    console.error("[drive] network error:", e);
    return { configured: true, found: false, docs: [], error: "Could not reach Google Drive." };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[drive] /files ${res.status}: ${body.slice(0, 300)}`);
    let error = `Drive API error ${res.status}.`;
    if (res.status === 401 || /insufficient.*scope|ACCESS_TOKEN_SCOPE/i.test(body)) {
      error = "Google token lacks Drive access — re-run mint-google-token.mjs (now requests drive.readonly) and update GOOGLE_REFRESH_TOKEN.";
    } else if (res.status === 403) {
      error = "No permission for this folder/drive, or the Drive API isn't enabled in the Google Cloud project.";
    } else if (res.status === 404) {
      error = "Folder not found — check GOOGLE_DRIVE_SIGNALS_FOLDER_ID (and GOOGLE_SHARED_DRIVE_ID for a Shared Drive).";
    }
    return { configured: true, found: false, docs: [], error };
  }

  let data: { files?: Array<Record<string, unknown>> };
  try {
    data = (await res.json()) as { files?: Array<Record<string, unknown>> };
  } catch {
    return { configured: true, found: false, docs: [], error: "Drive returned an unreadable response." };
  }

  const docs: DriveDoc[] = (data.files || []).map((f) => {
    const modifiedMs = f.modifiedTime ? Date.parse(String(f.modifiedTime)) || 0 : 0;
    return {
      id: String(f.id || ""),
      name: String(f.name || "Untitled"),
      mimeType: String(f.mimeType || ""),
      modifiedTime: modifiedMs,
      modifiedLabel: toLabel(modifiedMs),
      webViewLink: String(f.webViewLink || ""),
      sizeBytes: Number(f.size) || 0,
    };
  });

  return { configured: true, found: true, docs };
}

// Download one file's raw bytes and return them base64-encoded, ready to drop
// into an Anthropic `document` content block. Returns null on any failure so the
// caller can skip the doc and continue.
export async function downloadDriveFile(
  id: string,
): Promise<{ base64: string; mediaType: string } | null> {
  if (!id) return null;
  let token: string;
  try {
    token = await getAccessToken();
  } catch (e) {
    console.error("[drive] auth failed (download):", e);
    return null;
  }

  let res: Response;
  try {
    res = await fetch(
      `${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  } catch (e) {
    console.error("[drive] download network error:", e);
    return null;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[drive] download ${id} ${res.status}: ${body.slice(0, 200)}`);
    return null;
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString("base64"), mediaType: "application/pdf" };
}
