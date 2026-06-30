// Mint a fresh Google OAuth refresh token for the Sheets integration.
//
// Usage:
//   node mint-google-token.mjs
//
// Prerequisite (one-time): in Google Cloud Console → APIs & Services →
// Credentials, open the OAuth client whose ID/secret are in .env and add this
// EXACT redirect URI under "Authorized redirect URIs", then Save:
//   http://localhost:53682/
//
// The script reads GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from .env, opens the
// Google consent screen, captures the auth code on a tiny local server, and
// prints a new GOOGLE_REFRESH_TOKEN to paste back into .env.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/`;
// Sheets (read/write the CRM workbook) + Drive read-only (pull shared-drive PDFs
// into the Signals tab) + Gmail read-only (pull network emails into Signals).
const SCOPE = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
].join(" ");

function readEnv() {
  let text;
  try {
    text = readFileSync(new URL("./.env", import.meta.url), "utf8");
  } catch {
    console.error("Could not read .env next to this script.");
    process.exit(1);
  }
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = readEnv();
const clientId = env.GOOGLE_CLIENT_ID;
const clientSecret = env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing from .env.");
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // force a refresh_token even on re-auth
  }).toString();

function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      // Use rundll32, NOT `cmd start` — cmd treats the URL's & as command
      // separators and truncates it (dropping response_type/scope).
      spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
        stdio: "ignore",
        detached: true,
      }).unref();
    } else {
      const cmd = platform === "darwin" ? "open" : "xdg-open";
      spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    /* fall back to manual copy/paste */
  }
}

console.log("\nOpening Google consent screen. If it doesn't open, paste this URL:\n");
console.log(authUrl + "\n");
openBrowser(authUrl);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (!code && !error) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (error) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h2>Authorization failed: ${error}</h2>`);
    console.error("\nAuthorization failed:", error);
    server.close();
    process.exit(1);
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const data = await tokenRes.json();
    if (!tokenRes.ok || !data.refresh_token) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h2>No refresh token returned — see terminal.</h2>");
      console.error("\nToken exchange response:", JSON.stringify(data, null, 2));
      console.error(
        "\nIf there's no refresh_token, revoke prior access at https://myaccount.google.com/permissions and re-run."
      );
      server.close();
      process.exit(1);
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h2>Success! You can close this tab and return to the terminal.</h2>");
    console.log("\n✅ New refresh token (paste into .env as GOOGLE_REFRESH_TOKEN):\n");
    console.log(data.refresh_token + "\n");
    server.close();
    process.exit(0);
  } catch (e) {
    console.error("Token exchange error:", e);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`Waiting for the Google redirect on ${REDIRECT_URI} …`);
});
