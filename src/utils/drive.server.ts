// Google Drive integration — read PDFs from a shared drive for the Signals tab,
// and archive Gmail PDF attachments into that folder for durable "Open in Drive".
//
// Reuses the SAME Google OAuth refresh token as Sheets (getAccessToken). For this
// to work the refresh token must be minted with the Drive write scope
// (https://www.googleapis.com/auth/drive) — re-run mint-google-token.mjs and paste
// the new GOOGLE_REFRESH_TOKEN.
//
// Layers:
//  - listDriveDocs():         cheap metadata-only listing (Signals reel lane).
//  - downloadDriveFile():     raw bytes as base64 (scan grounding).
//  - uploadDriveFile() / findDriveFileByGmailAttachment(): archive Gmail PDFs
//    (orchestration lives in gmail.functions to avoid import cycles).
//
// Everything degrades gracefully when GOOGLE_DRIVE_SIGNALS_FOLDER_ID is unset
// (isDriveConfigured() === false), mirroring the LinkedIn connector.

import { sha256Hex } from "./sha256";
import { getAccessToken } from "./sheets.server";
import { driveFileViewUrl } from "@/lib/safe-url";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
/** Soft ceiling for archiving email PDFs (Gmail attachments are usually smaller). */
export const MAX_ARCHIVE_PDF_BYTES = 25_000_000;
/** Short appProperties key — Drive caps key+value at 124 UTF-8 bytes.
 *  `gak` = stable identity (message + filename + size). Gmail attachmentIds
 *  change on every API fetch, so they must NOT be part of this key. */
export const GMAIL_ATTACH_PROP = "gak";
/** Content fingerprint of the PDF bytes (also appProperties). */
export const GMAIL_CONTENT_PROP = "gch";

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

/** Folder for email-PDF archives — optional override, else the Signals folder. */
export function emailPdfFolderId(): string {
  return (
    process.env.GOOGLE_DRIVE_EMAIL_PDF_FOLDER_ID?.trim() ||
    process.env.GOOGLE_DRIVE_SIGNALS_FOLDER_ID?.trim() ||
    ""
  );
}

/** Stable short fingerprint for a Gmail PDF (fits Drive appProperties).
 *  Uses messageId + filename + size — NOT Gmail's attachmentId, which is
 *  regenerated on every messages.get and was causing endless Drive dupes.
 *  Pure-JS sha256 so this module is safe if pulled into the client bundle. */
export function gmailAttachmentKey(
  messageId: string,
  filename: string,
  sizeBytes = 0,
): string {
  const name = (filename || "attachment.pdf").trim().toLowerCase();
  return sha256Hex(`${messageId}|${name}|${Number(sizeBytes) || 0}`).slice(0, 40);
}

/** Fingerprint of PDF payload (base64 string is a stable proxy for the bytes). */
export function gmailPdfContentKey(base64: string): string {
  return sha256Hex(base64 || "").slice(0, 40);
}

function mapDriveFile(f: Record<string, unknown>): DriveDoc {
  const id = String(f.id || "");
  const modifiedMs = f.modifiedTime ? Date.parse(String(f.modifiedTime)) || 0 : 0;
  const webViewLink = String(f.webViewLink || "").trim() || driveFileViewUrl(id);
  return {
    id,
    name: String(f.name || "Untitled"),
    mimeType: String(f.mimeType || ""),
    modifiedTime: modifiedMs,
    modifiedLabel: toLabel(modifiedMs),
    webViewLink,
    sizeBytes: Number(f.size) || 0,
  };
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
      error =
        "Google token lacks Drive access — re-run mint-google-token.mjs (requests drive write scope) and update GOOGLE_REFRESH_TOKEN.";
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

  const docs: DriveDoc[] = (data.files || []).map(mapDriveFile);

  return { configured: true, found: true, docs };
}

/** Find a file in the email-PDF folder by a single appProperties key/value. */
async function findDriveFileByAppProperty(
  propKey: string,
  propValue: string,
): Promise<DriveDoc | null> {
  const folderId = emailPdfFolderId();
  if (!folderId || !propKey || !propValue) return null;

  const key = propValue.replace(/'/g, "\\'");
  const safeProp = propKey.replace(/'/g, "\\'");
  const safeFolder = folderId.replace(/'/g, "\\'");
  const driveId = process.env.GOOGLE_SHARED_DRIVE_ID;
  const params = new URLSearchParams({
    q: `'${safeFolder}' in parents and trashed=false and appProperties has { key='${safeProp}' and value='${key}' }`,
    fields: "files(id,name,mimeType,modifiedTime,webViewLink,size)",
    pageSize: "1",
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
    console.error("[drive] auth failed (find):", e);
    return null;
  }

  try {
    const res = await fetch(`${DRIVE_API}/files?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[drive] find by appProperties ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as { files?: Array<Record<string, unknown>> };
    const f = data.files?.[0];
    return f ? mapDriveFile(f) : null;
  } catch (e) {
    console.error("[drive] find network error:", e);
    return null;
  }
}

/** Find a previously archived Gmail PDF by stable message+filename+size key. */
export async function findDriveFileByGmailAttachment(
  messageId: string,
  filename: string,
  sizeBytes = 0,
): Promise<DriveDoc | null> {
  return findDriveFileByAppProperty(
    GMAIL_ATTACH_PROP,
    gmailAttachmentKey(messageId, filename, sizeBytes),
  );
}

/** Find by PDF content hash (survives legacy keys / re-forwards of same bytes). */
export async function findDriveFileByContentHash(base64: string): Promise<DriveDoc | null> {
  if (!base64) return null;
  return findDriveFileByAppProperty(GMAIL_CONTENT_PROP, gmailPdfContentKey(base64));
}

/**
 * Fallback for files uploaded before the stable-key fix: match exact filename
 * + size in the archive folder (keeps the oldest copy).
 */
export async function findDriveFileByNameAndSize(
  filename: string,
  sizeBytes: number,
): Promise<DriveDoc | null> {
  const folderId = emailPdfFolderId();
  const name = (filename || "").trim();
  if (!folderId || !name || !sizeBytes) return null;

  const safeFolder = folderId.replace(/'/g, "\\'");
  const safeName = name.replace(/'/g, "\\'");
  const driveId = process.env.GOOGLE_SHARED_DRIVE_ID;
  const params = new URLSearchParams({
    q: `'${safeFolder}' in parents and trashed=false and name='${safeName}'`,
    fields: "files(id,name,mimeType,modifiedTime,webViewLink,size,createdTime)",
    orderBy: "createdTime asc",
    pageSize: "10",
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
  } catch {
    return null;
  }

  try {
    const res = await fetch(`${DRIVE_API}/files?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { files?: Array<Record<string, unknown>> };
    const match = (data.files || []).find((f) => Number(f.size) === sizeBytes);
    return match ? mapDriveFile(match) : null;
  } catch {
    return null;
  }
}

/** Upload a PDF (base64) into the email-PDF / Signals folder. */
export async function uploadDriveFile(opts: {
  name: string;
  mimeType?: string;
  base64: string;
  folderId?: string;
  appProperties?: Record<string, string>;
}): Promise<DriveDoc | null> {
  const folderId = opts.folderId || emailPdfFolderId();
  if (!folderId || !opts.base64) return null;

  let token: string;
  try {
    token = await getAccessToken();
  } catch (e) {
    console.error("[drive] auth failed (upload):", e);
    return null;
  }

  const mimeType = opts.mimeType || "application/pdf";
  const metadata: Record<string, unknown> = {
    name: opts.name || "attachment.pdf",
    mimeType,
    parents: [folderId],
  };
  if (opts.appProperties && Object.keys(opts.appProperties).length > 0) {
    metadata.appProperties = opts.appProperties;
  }

  const boundary = `dtc_boundary_${Date.now().toString(36)}`;
  const binary = Buffer.from(opts.base64, "base64");
  const preamble =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n` +
    `Content-Transfer-Encoding: binary\r\n\r\n`;
  const epilogue = `\r\n--${boundary}--`;
  const body = Buffer.concat([Buffer.from(preamble, "utf8"), binary, Buffer.from(epilogue, "utf8")]);

  try {
    const res = await fetch(
      `${DRIVE_UPLOAD_API}/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,modifiedTime,webViewLink,size`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body,
      },
    );
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error(`[drive] upload ${res.status}: ${errBody.slice(0, 300)}`);
      return null;
    }
    const data = (await res.json()) as Record<string, unknown>;
    return mapDriveFile(data);
  } catch (e) {
    console.error("[drive] upload network error:", e);
    return null;
  }
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
