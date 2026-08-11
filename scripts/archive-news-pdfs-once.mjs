// Clean probe files + archive recent NEWS@ PDFs into GOOGLE_DRIVE_EMAIL_PDF_FOLDER_ID.
// Usage: node scripts/archive-news-pdfs-once.mjs
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const PROP = "gak";

function attachmentKey(messageId, attachmentId) {
  return createHash("sha256").update(`${messageId}:${attachmentId}`).digest("hex").slice(0, 40);
}

function readEnv() {
  const text = readFileSync(join(root, ".env"), "utf8");
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

function parseAliases(raw) {
  return (raw || "")
    .split(/[;,]/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes("@"));
}

const env = readEnv();
const folderId =
  (env.GOOGLE_DRIVE_EMAIL_PDF_FOLDER_ID || "").trim() ||
  (env.GOOGLE_DRIVE_SIGNALS_FOLDER_ID || "").trim();
const sharedDrive = (env.GOOGLE_SHARED_DRIVE_ID || "").trim();
const newsAliases = parseAliases(env.GMAIL_NEWS_ALIAS);
const windowDays = Number(env.GMAIL_SIGNALS_WINDOW_DAYS) || 14;

async function getToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`token: ${JSON.stringify(data)}`);
  return data.access_token;
}

function collectPdfs(part, out) {
  if (!part) return;
  const filename = String(part.filename || "");
  const mime = String(part.mimeType || "");
  if (part.body?.attachmentId && (mime === "application/pdf" || /\.pdf$/i.test(filename))) {
    out.push({
      filename: filename || "attachment.pdf",
      mimeType: "application/pdf",
      sizeBytes: Number(part.body.size) || 0,
      attachmentId: String(part.body.attachmentId),
    });
  }
  for (const p of part.parts || []) collectPdfs(p, out);
}

async function findExisting(token, key) {
  const safeKey = key.replace(/'/g, "\\'");
  const safeFolder = folderId.replace(/'/g, "\\'");
  const params = new URLSearchParams({
    q: `'${safeFolder}' in parents and trashed=false and appProperties has { key='${PROP}' and value='${safeKey}' }`,
    fields: "files(id,name,webViewLink)",
    pageSize: "1",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  if (sharedDrive) {
    params.set("corpora", "drive");
    params.set("driveId", sharedDrive);
  }
  const res = await fetch(`${DRIVE_API}/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.files?.[0] || null;
}

async function uploadPdf(token, { name, base64, key }) {
  const boundary = `arc_${Date.now().toString(36)}`;
  const metadata = {
    name,
    mimeType: "application/pdf",
    parents: [folderId],
    appProperties: { [PROP]: key },
  };
  const binary = Buffer.from(base64, "base64");
  const preamble =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n--${boundary}\r\n` +
    `Content-Type: application/pdf\r\nContent-Transfer-Encoding: binary\r\n\r\n`;
  const body = Buffer.concat([
    Buffer.from(preamble, "utf8"),
    binary,
    Buffer.from(`\r\n--${boundary}--`, "utf8"),
  ]);
  const res = await fetch(
    `${DRIVE_UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,parents`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`upload ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function cleanupProbes(token) {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and name contains '_dtc_upload_probe_' and trashed=false`,
    fields: "files(id,name)",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  if (sharedDrive) {
    params.set("corpora", "drive");
    params.set("driveId", sharedDrive);
  }
  const res = await fetch(`${DRIVE_API}/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  for (const f of data.files || []) {
    const del = await fetch(
      `${DRIVE_API}/files/${encodeURIComponent(f.id)}?supportsAllDrives=true`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    );
    console.log(`cleanup ${f.name} → ${del.status}`);
  }
}

console.log("Folder:", folderId);
console.log("NEWS aliases:", newsAliases.join(", ") || "(none)");
if (!folderId) {
  console.error("No email PDF folder configured");
  process.exit(1);
}
if (newsAliases.length === 0) {
  console.error("GMAIL_NEWS_ALIAS empty — nothing to archive");
  process.exit(1);
}

const token = await getToken();
await cleanupProbes(token);

const aliasClause = newsAliases
  .flatMap((a) => [`deliveredto:${a}`, `to:${a}`, `cc:${a}`])
  .join(" OR ");
const q = `newer_than:${windowDays}d has:attachment filename:pdf (${aliasClause})`;
console.log("Gmail query:", q);

const listRes = await fetch(
  `${GMAIL_API}/messages?${new URLSearchParams({ q, maxResults: "25" })}`,
  { headers: { Authorization: `Bearer ${token}` } },
);
const listData = await listRes.json();
if (!listRes.ok) {
  console.error("Gmail search failed:", listData);
  process.exit(1);
}
const ids = (listData.messages || []).map((m) => m.id);
console.log(`Found ${ids.length} candidate message(s)`);

let uploaded = 0;
let skipped = 0;
let failed = 0;

for (const id of ids) {
  const msgRes = await fetch(`${GMAIL_API}/messages/${id}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!msgRes.ok) {
    failed++;
    continue;
  }
  const msg = await msgRes.json();
  const subject =
    (msg.payload?.headers || []).find((h) => (h.name || "").toLowerCase() === "subject")?.value ||
    "(no subject)";
  const pdfs = [];
  collectPdfs(msg.payload, pdfs);
  if (pdfs.length === 0) continue;
  console.log(`\n${subject} — ${pdfs.length} PDF(s)`);

  for (const pdf of pdfs) {
    const key = attachmentKey(id, pdf.attachmentId);
    const existing = await findExisting(token, key);
    if (existing) {
      console.log(`  skip (exists): ${pdf.filename}`);
      skipped++;
      continue;
    }
    const attRes = await fetch(
      `${GMAIL_API}/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(pdf.attachmentId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!attRes.ok) {
      console.log(`  fail download: ${pdf.filename}`);
      failed++;
      continue;
    }
    const att = await attRes.json();
    if (!att.data) {
      failed++;
      continue;
    }
    const base64 = Buffer.from(att.data, "base64url").toString("base64");
    const safeName = (pdf.filename || "attachment.pdf").replace(/[\\/:*?"<>|]+/g, "_");
    try {
      const file = await uploadPdf(token, { name: safeName, base64, key });
      console.log(`  uploaded: ${file.name}`);
      console.log(`  link: ${file.webViewLink}`);
      uploaded++;
    } catch (e) {
      console.log(`  fail upload: ${pdf.filename} — ${e.message || e}`);
      failed++;
    }
  }
}

console.log(`\nDone. uploaded=${uploaded} skipped=${skipped} failed=${failed}`);
console.log(`Folder: https://drive.google.com/drive/folders/${folderId}`);
