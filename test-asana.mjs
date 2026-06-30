// Quick health check for the Asana integration.
//
// Usage:
//   node test-asana.mjs
//
// Reads ASANA_ACCESS_TOKEN / ASANA_PORTCO_PROJECT_GID / ASANA_EVENTS_PROJECT_GID
// from .env and hits Asana directly, printing the HTTP status for:
//   1. /users/me            → is the token valid at all?
//   2. /projects/<portco>   → can it read the PortCo project?
//   3. /projects/<events>   → can it read the Events project?
//
// 200 = OK · 401 = bad/expired token · 403 = no access · 404 = wrong GID.

import { readFileSync } from "node:fs";

const BASE = "https://app.asana.com/api/1.0";

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
const token = env.ASANA_ACCESS_TOKEN;
const portcoGid = env.ASANA_PORTCO_PROJECT_GID;
const eventsGid = env.ASANA_EVENTS_PROJECT_GID;

if (!token) {
  console.error("ASANA_ACCESS_TOKEN missing from .env.");
  process.exit(1);
}

async function check(label, path) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      const name = body?.data?.name || body?.data?.email || "(ok)";
      console.log(`✅ ${label}: ${res.status} — ${name}`);
    } else {
      const msg = body?.errors?.[0]?.message || JSON.stringify(body).slice(0, 200);
      console.log(`❌ ${label}: ${res.status} — ${msg}`);
    }
    return res.status;
  } catch (e) {
    console.log(`❌ ${label}: network error — ${e instanceof Error ? e.message : e}`);
    return 0;
  }
}

// Replicate the EXACT tasks call the app makes (opt_fields + custom fields).
async function checkTasks(label, gid) {
  const params = new URLSearchParams({
    opt_fields:
      "name,due_on,due_at,completed,custom_fields,custom_fields.name,custom_fields.type,custom_fields.display_value,custom_fields.enum_value,custom_fields.multi_enum_values,custom_fields.text_value,custom_fields.number_value",
    limit: "5",
  });
  try {
    const res = await fetch(`${BASE}/projects/${gid}/tasks?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      const tasks = body?.data || [];
      // Aggregate distinct custom-field names across ALL returned tasks.
      const names = new Set();
      for (const t of tasks) for (const f of t.custom_fields || []) if (f?.name) names.add(f.name);
      console.log(`✅ ${label} tasks: ${res.status} — ${tasks.length} task(s); custom fields seen: ${names.size ? [...names].join(", ") : "NONE"}`);
    } else {
      const msg = body?.errors?.[0]?.message || JSON.stringify(body).slice(0, 250);
      console.log(`❌ ${label} tasks: ${res.status} — ${msg}`);
    }
  } catch (e) {
    console.log(`❌ ${label} tasks: network error — ${e instanceof Error ? e.message : e}`);
  }
}

console.log("\nTesting Asana token + project access…\n");
const meStatus = await check("Token (/users/me)", "/users/me");
if (portcoGid) await check(`PortCo project ${portcoGid}`, `/projects/${portcoGid}`);
else console.log("⚠️  ASANA_PORTCO_PROJECT_GID not set.");
if (eventsGid) await check(`Events project ${eventsGid}`, `/projects/${eventsGid}`);
else console.log("⚠️  ASANA_EVENTS_PROJECT_GID not set.");

console.log("");
if (portcoGid) await checkTasks("PortCo", portcoGid);
if (eventsGid) await checkTasks("Events", eventsGid);

console.log(
  meStatus === 401
    ? "\n→ 401 on the token = it's expired/revoked. Generate a new Asana PAT and update ASANA_ACCESS_TOKEN.\n"
    : "\n→ If the TASKS lines error (402/429/400) that's the cause. 402 = plan/custom-fields; 429 = rate limit.\n      If tasks return 200 with data, the token path is fine and the bug is app-side.\n",
);
