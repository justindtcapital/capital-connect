// Mint a LinkedIn OAuth access token for the company-page integration.
//
// Usage:
//   node mint-linkedin-token.mjs
//
// Prerequisites (one-time, in the LinkedIn Developer Portal — your app):
//   1. Products tab: request + get approved for the "Community Management API"
//      (this is what grants the r_organization_social scope used below). Without
//      it, the consent screen errors with "unauthorized_scope_error".
//   2. Auth tab → "Authorized redirect URLs for your app": add this EXACT URL:
//        http://localhost:53682/
//   3. Put LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET in .env.
//   4. Authorize as a user who is an ADMIN of the company page you want to read.
//
// The script opens the LinkedIn consent screen, captures the auth code on a tiny
// local server, exchanges it for an access token, prints it (paste into .env as
// LINKEDIN_ACCESS_TOKEN), and best-effort prints the org IDs you administer.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/`;
// Scope needed to read your organization's posts. Add more (space-separated) only
// if your app is approved for them, e.g. "r_organization_social w_organization_social".
const SCOPE = "r_organization_social";
const API_VERSION = "202505";

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
const clientId = env.LINKEDIN_CLIENT_ID;
const clientSecret = env.LINKEDIN_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET missing from .env.");
  process.exit(1);
}

const authUrl =
  "https://www.linkedin.com/oauth/v2/authorization?" +
  new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state: "venturepulse",
  }).toString();

function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      // Use rundll32, NOT `cmd start` — cmd treats the URL's & as command
      // separators and truncates it (dropping scope/redirect_uri).
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

// Best-effort: list the organizations the authorized member administers so the
// user can grab the numeric LINKEDIN_ORG_ID. Requires an admin scope on the
// token; silently skipped (with guidance) when not granted.
async function printAdministeredOrgs(accessToken) {
  try {
    const res = await fetch(
      "https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "LinkedIn-Version": API_VERSION,
          "X-Restli-Protocol-Version": "2.0.0",
        },
      },
    );
    if (!res.ok) {
      console.log(
        "\n(ℹ️  Couldn't auto-list org IDs — that needs an admin scope. Find the numeric",
      );
      console.log("    org id in your company page admin URL: linkedin.com/company/<id>/admin/)");
      return;
    }
    const data = await res.json();
    const ids = (data.elements || [])
      .map((e) => String(e.organization || "").split(":").pop())
      .filter(Boolean);
    if (ids.length) {
      console.log("\nOrganizations you administer (use one as LINKEDIN_ORG_ID):");
      ids.forEach((id) => console.log(`  • ${id}`));
    }
  } catch {
    /* non-fatal */
  }
}

console.log("\nOpening LinkedIn consent screen. If it doesn't open, paste this URL:\n");
console.log(authUrl + "\n");
openBrowser(authUrl);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const errorDesc = url.searchParams.get("error_description");
  if (!code && !error) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (error) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h2>Authorization failed: ${error}</h2><p>${errorDesc || ""}</p>`);
    console.error(`\nAuthorization failed: ${error} — ${errorDesc || ""}`);
    if (/scope/i.test(`${error} ${errorDesc}`)) {
      console.error(
        "This usually means the Community Management API product isn't approved on your app yet.",
      );
    }
    server.close();
    process.exit(1);
  }

  try {
    const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
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
    if (!tokenRes.ok || !data.access_token) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h2>No access token returned — see terminal.</h2>");
      console.error("\nToken exchange response:", JSON.stringify(data, null, 2));
      server.close();
      process.exit(1);
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h2>Success! You can close this tab and return to the terminal.</h2>");

    const days = data.expires_in ? Math.round(data.expires_in / 86400) : "?";
    console.log("\n✅ Access token (paste into .env as LINKEDIN_ACCESS_TOKEN):\n");
    console.log(data.access_token + "\n");
    console.log(`Expires in ~${days} days. Re-run this script to mint a fresh one.`);
    if (data.refresh_token) {
      console.log("\nRefresh token (your app is approved for refresh — keep it safe):");
      console.log(data.refresh_token + "\n");
    }

    await printAdministeredOrgs(data.access_token);

    server.close();
    process.exit(0);
  } catch (e) {
    console.error("Token exchange error:", e);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`Waiting for the LinkedIn redirect on ${REDIRECT_URI} …`);
});
