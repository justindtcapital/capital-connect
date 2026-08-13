// Trash duplicate PDFs in the email-PDF / Signals folder.
// Keeps the oldest file for each (name, size) group; moves the rest to trash.
//
// Usage:
//   node scripts/cleanup-drive-pdf-dupes.mjs          # dry-run
//   node scripts/cleanup-drive-pdf-dupes.mjs --apply  # actually trash

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const apply = process.argv.includes("--apply");

function readEnv() {
  const text = readFileSync(join(root, ".env"), "utf8");
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = readEnv();
const folderId = env.GOOGLE_DRIVE_EMAIL_PDF_FOLDER_ID || env.GOOGLE_DRIVE_SIGNALS_FOLDER_ID;
const driveId = env.GOOGLE_SHARED_DRIVE_ID;

const tokRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  }),
});
const tok = await tokRes.json();
if (!tok.access_token) {
  console.error("token fail", tok);
  process.exit(1);
}
const token = tok.access_token;

async function listAll() {
  const files = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and mimeType='application/pdf' and trashed=false`,
      fields: "nextPageToken,files(id,name,size,createdTime)",
      orderBy: "createdTime asc",
      pageSize: "100",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (driveId) {
      params.set("corpora", "drive");
      params.set("driveId", driveId);
    }
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return files;
}

async function trash(id) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trashed: true }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`trash ${id} ${res.status}: ${body.slice(0, 200)}`);
  }
}

const files = await listAll();
const groups = new Map();
for (const f of files) {
  const k = `${(f.name || "").toLowerCase()}|${f.size || 0}`;
  const list = groups.get(k) || [];
  list.push(f);
  groups.set(k, list);
}

let keep = 0;
let trashCount = 0;
console.log(apply ? "APPLY mode — trashing duplicates" : "DRY-RUN — pass --apply to trash");
console.log(`Scanned ${files.length} PDF(s) in folder ${folderId}\n`);

for (const [k, list] of groups) {
  if (list.length < 2) {
    keep++;
    continue;
  }
  // Already sorted by createdTime asc from listing pages… re-sort to be sure.
  list.sort((a, b) => String(a.createdTime).localeCompare(String(b.createdTime)));
  const [keeper, ...dupes] = list;
  console.log(`KEEP  ${keeper.name} (${keeper.size}b) id=${keeper.id} @ ${keeper.createdTime}`);
  keep++;
  for (const d of dupes) {
    console.log(`TRASH ${d.name} id=${d.id} @ ${d.createdTime}`);
    if (apply) await trash(d.id);
    trashCount++;
  }
}

console.log(`\nDone. keep=${keep} trash=${trashCount}${apply ? "" : " (dry-run)"}`);
