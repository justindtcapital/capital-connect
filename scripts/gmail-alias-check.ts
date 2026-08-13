// Diagnostic — live-check the BD/GTM Gmail alias activity sync.
// Shows the raw messages each track's query pulls, which ones survive the
// noise filters (messageToActivity), and the final fetchAliasActivities()
// output the app writes to the BD/GTM sheets.
// Run: npx tsx scripts/gmail-alias-check.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load .env before importing server modules (they read process.env at call time,
// but dynamic-import-after-load is the safe order).
{
  const envPath = resolve(import.meta.dirname, "..", ".env");
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
// Unlock searchGmail for the raw-pull view (process-local; does not change app config).
process.env.GMAIL_SIGNALS_ENABLED = "true";

const gmail = await import("../src/utils/gmail.server");
const { isNoiseEmail } = await import("../src/lib/email-noise");

function parseAliases(raw?: string): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[;,]/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes("@"));
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

const windowDays = Number(process.env.GMAIL_ACTIVITY_WINDOW_DAYS) || 90;
const max = Number(process.env.GMAIL_ACTIVITY_MAX) || 50;

const tracks: Array<{ track: "BD" | "GTM"; aliases: string[] }> = [
  { track: "BD", aliases: parseAliases(process.env.GMAIL_BD_ALIAS) },
  { track: "GTM", aliases: parseAliases(process.env.GMAIL_GTM_ALIAS) },
];

console.log("=== Gmail BD/GTM alias diagnostic ===");
console.log(`Window: ${windowDays}d   Max per track: ${max}`);
console.log(`Activity sync configured: ${gmail.isGmailActivityConfigured()}`);

for (const { track, aliases } of tracks) {
  console.log(`\n───── ${track} ─────`);
  console.log(`Aliases: ${aliases.join(", ") || "(none configured)"}`);
  if (aliases.length === 0) continue;

  // Same query fetchTrackFromAliases builds internally.
  const terms = aliases.flatMap((a) => [`from:${a}`, `to:${a}`, `cc:${a}`]).join(" OR ");
  const q = `newer_than:${windowDays}d (${terms})`;
  console.log(`Query: ${q}`);

  const res = await gmail.searchGmail(q, max);
  if (!res.ok) {
    console.log(`RAW PULL FAILED: ${res.error}`);
    continue;
  }
  console.log(`Raw messages matched: ${res.messages.length}`);

  const aliasSet = new Set(aliases);
  let kept = 0;
  for (const m of res.messages) {
    const act = gmail.messageToActivity(m, track, aliasSet);
    let verdict: string;
    if (act) {
      kept++;
      verdict = `KEPT → ${act.status} | ${act.person || "?"} @ ${act.company || "?"}`;
    } else if (m.isBulk) {
      verdict = "FILTERED (bulk/automated headers)";
    } else if (
      m.fromEmail &&
      isNoiseEmail(m.fromEmail.toLowerCase()) &&
      !aliasSet.has(m.fromEmail.toLowerCase())
    ) {
      verdict = "FILTERED (noise sender)";
    } else {
      verdict = "FILTERED (no human counterparty)";
    }
    console.log(
      `  [${m.dateLabel}] ${trunc(m.fromEmail, 38)} → ${trunc(m.toEmails.join(","), 38)}` +
        `\n    "${trunc(m.subject, 70)}"  ${verdict}`,
    );
  }
  console.log(`Survived filters: ${kept}/${res.messages.length}`);
}

console.log("\n───── fetchAliasActivities() (what the app pipeline gets) ─────");
const acts = await gmail.fetchAliasActivities();
console.log(`Total activities: ${acts.length}`);
for (const a of acts) {
  console.log(
    `  [${a.date || "?"}] ${a.track} ${a.status} | ${trunc(a.name, 60)} | ` +
      `${a.person || "?"} @ ${a.company || "?"}`,
  );
}
