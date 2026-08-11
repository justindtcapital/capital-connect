// One-off: verify Google Drive folder reachability + PDF listing.
// Usage: node scripts/test-drive-connection.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readEnv() {
  const text = readFileSync(join(root, ".env"), "utf8");
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

function mask(id) {
  if (!id) return "(empty)";
  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

const env = readEnv();
const clientId = env.GOOGLE_CLIENT_ID;
const clientSecret = env.GOOGLE_CLIENT_SECRET;
const refresh = env.GOOGLE_REFRESH_TOKEN;
const signalsFolder = env.GOOGLE_DRIVE_SIGNALS_FOLDER_ID || "";
const emailFolder = (env.GOOGLE_DRIVE_EMAIL_PDF_FOLDER_ID || "").trim() || signalsFolder;
const sharedDrive = env.GOOGLE_SHARED_DRIVE_ID || "";

async function getToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`token refresh failed: ${JSON.stringify(data)}`);
  return data;
}

async function getFile(token, id) {
  const params = new URLSearchParams({
    fields: "id,name,mimeType,driveId,capabilities(canAddChildren,canListChildren,canEdit)",
    supportsAllDrives: "true",
  });
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = await res.text();
  return { status: res.status, body };
}

async function listPdfs(token, folderId) {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and mimeType='application/pdf' and trashed=false`,
    fields: "files(id,name,modifiedTime,webViewLink)",
    orderBy: "modifiedTime desc",
    pageSize: "5",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  if (sharedDrive) {
    params.set("corpora", "drive");
    params.set("driveId", sharedDrive);
  }
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

console.log("=== Drive connection test ===");
console.log("SIGNALS_FOLDER:", mask(signalsFolder));
console.log(
  "EMAIL_PDF_FOLDER:",
  mask(emailFolder),
  emailFolder === signalsFolder ? "(same as signals)" : "(override)",
);
console.log("SHARED_DRIVE_ID:", mask(sharedDrive));

if (!clientId || !clientSecret || !refresh) {
  console.error("FAIL: missing Google OAuth env vars");
  process.exit(1);
}
if (!signalsFolder) {
  console.error("FAIL: GOOGLE_DRIVE_SIGNALS_FOLDER_ID empty");
  process.exit(1);
}

const tok = await getToken();
console.log("Token refresh: OK");
console.log("Token scopes:", tok.scope || "(not returned)");

const folders = [["SIGNALS", signalsFolder]];
if (emailFolder && emailFolder !== signalsFolder) {
  folders.push(["EMAIL_PDF", emailFolder]);
}

let ok = true;
for (const [label, id] of folders) {
  const r = await getFile(tok.access_token, id);
  console.log(`\n[${label}] GET folder ${mask(id)} → HTTP ${r.status}`);
  if (r.status === 200) {
    const f = JSON.parse(r.body);
    console.log("  name:", f.name);
    console.log("  mimeType:", f.mimeType);
    console.log("  driveId:", f.driveId || "(none)");
    console.log("  canAddChildren:", f.capabilities?.canAddChildren);
    console.log("  canListChildren:", f.capabilities?.canListChildren);
    console.log("  canEdit:", f.capabilities?.canEdit);
  } else {
    ok = false;
    console.log("  body:", r.body.slice(0, 400));
  }

  const list = await listPdfs(tok.access_token, id);
  console.log(`  list PDFs → HTTP ${list.status}`);
  if (list.status === 200) {
    const files = list.data.files || [];
    console.log("  PDF count (first page, max 5 shown):", files.length);
    for (const file of files) console.log("   -", file.name);
  } else {
    ok = false;
    console.log("  list error:", JSON.stringify(list.data).slice(0, 400));
  }
}

const scope = tok.scope || "";
const scopes = new Set(scope.split(/\s+/).filter(Boolean));
const hasDriveWrite = scopes.has("https://www.googleapis.com/auth/drive");
const hasDriveReadonly = scopes.has("https://www.googleapis.com/auth/drive.readonly");
console.log("\n=== Scope check ===");
console.log("drive (write):", hasDriveWrite ? "YES" : "NO");
console.log("drive.readonly:", hasDriveReadonly ? "YES" : "NO");
if (!hasDriveWrite) {
  console.log("NOTE: upload/archive needs auth/drive — re-run node mint-google-token.mjs");
}

console.log(ok ? "\nRESULT: folder connection OK" : "\nRESULT: folder connection FAILED");
process.exit(ok ? 0 : 1);
