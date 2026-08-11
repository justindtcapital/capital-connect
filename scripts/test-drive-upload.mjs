// Probe: can we upload a tiny PDF into GOOGLE_DRIVE_EMAIL_PDF_FOLDER_ID?
// Usage: node scripts/test-drive-upload.mjs
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

const env = readEnv();
const folderId =
  (env.GOOGLE_DRIVE_EMAIL_PDF_FOLDER_ID || "").trim() ||
  (env.GOOGLE_DRIVE_SIGNALS_FOLDER_ID || "").trim();

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
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

// Minimal valid 1-page PDF
const MINI_PDF = Buffer.from(
  `%PDF-1.1
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>endobj
4 0 obj<< /Length 44 >>stream
BT /F1 12 Tf 50 150 Td (DTC upload probe) Tj ET
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000214 00000 n 
trailer<< /Size 5 /Root 1 0 R >>
startxref
307
%%EOF`,
);

console.log("Target folder:", folderId);
const tok = await getToken();
const scopes = new Set((tok.scope || "").split(/\s+/).filter(Boolean));
console.log("Has drive write:", scopes.has("https://www.googleapis.com/auth/drive"));
console.log("Has drive.readonly:", scopes.has("https://www.googleapis.com/auth/drive.readonly"));
console.log("Scopes:", tok.scope);

const boundary = `probe_${Date.now().toString(36)}`;
const metadata = {
  name: `_dtc_upload_probe_${Date.now()}.pdf`,
  mimeType: "application/pdf",
  parents: [folderId],
  appProperties: { dtcProbe: "true" },
};
const preamble =
  `--${boundary}\r\n` +
  `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
  `${JSON.stringify(metadata)}\r\n` +
  `--${boundary}\r\n` +
  `Content-Type: application/pdf\r\n` +
  `Content-Transfer-Encoding: binary\r\n\r\n`;
const epilogue = `\r\n--${boundary}--`;
const body = Buffer.concat([Buffer.from(preamble, "utf8"), MINI_PDF, Buffer.from(epilogue, "utf8")]);

const up = await fetch(
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,parents,webViewLink",
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tok.access_token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  },
);
const upText = await up.text();
console.log("Upload HTTP", up.status);
console.log(upText.slice(0, 800));

if (up.ok) {
  const file = JSON.parse(upText);
  // Clean up probe file
  const del = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?supportsAllDrives=true`,
    { method: "DELETE", headers: { Authorization: `Bearer ${tok.access_token}` } },
  );
  console.log("Cleanup delete HTTP", del.status);
  console.log("RESULT: upload to email PDF folder OK");
  process.exit(0);
}

console.log("RESULT: upload FAILED");
process.exit(1);
