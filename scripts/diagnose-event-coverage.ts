// Diagnose event attendance + follow-up coverage for Network contacts.
// Answers: "contacts were uploaded — are they tagged to events / flagged follow-up?"
//
// Run: npx tsx scripts/diagnose-event-coverage.ts [--since 2026-07-01]
// Read-only — two Sheets tab fetches (Contacts + Events).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv(path: string) {
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 0) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (e) {
    console.error("Failed to load .env:", e);
    process.exit(1);
  }
}
loadEnv(resolve(process.cwd(), ".env"));

const sinceArg = (() => {
  const i = process.argv.indexOf("--since");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "2026-07-01";
})();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchTabWithRetry(tab: string, attempts = 5): Promise<string[][]> {
  const { fetchSheetTab, TAB_NAMES } = await import("../src/utils/sheets.server");
  const name = (TAB_NAMES as Record<string, string>)[tab] || tab;
  let last: unknown;
  for (let a = 1; a <= attempts; a++) {
    try {
      return await fetchSheetTab(name);
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/429|RATE_LIMIT|RESOURCE_EXHAUSTED/i.test(msg) || a === attempts) throw e;
      const wait = a * 20_000;
      console.warn(`[retry] ${name} hit quota — waiting ${wait / 1000}s (attempt ${a}/${attempts})`);
      await sleep(wait);
    }
  }
  throw last;
}

function idx(headers: string[], ...names: string[]): number {
  for (const n of names) {
    const i = headers.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

function primaryEmail(raw: string): string {
  return (raw || "").split(";")[0]?.trim().toLowerCase() || "";
}

/** Parse sheet dates: ISO, or M/D/YYYY (US). Returns YYYY-MM-DD or "". */
function toIsoDate(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const mm = m[1].padStart(2, "0");
    const dd = m[2].padStart(2, "0");
    return `${m[3]}-${mm}-${dd}`;
  }
  const t = Date.parse(s);
  if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10);
  return "";
}

function main() {
  return (async () => {
    console.log(`Diagnosing event coverage since ${sinceArg}…\n`);

    const [contactRows, eventRows] = await Promise.all([
      fetchTabWithRetry("contacts"),
      fetchTabWithRetry("events"),
    ]);

    const ch = (contactRows[0] || []).map((h) => h.trim().toLowerCase());
    const emailI = idx(ch, "email");
    const nameI = idx(ch, "name");
    const dateI = idx(ch, "date added");
    const sourceI = idx(ch, "source", "lead source", "origin");
    const flagI = idx(ch, "follow up flag");
    if (emailI < 0) {
      console.error("Contacts tab missing Email column");
      process.exit(1);
    }

    const eh = (eventRows[0] || []).map((h) => h.trim().toLowerCase());
    const eEmailI = idx(eh, "contact email");
    const eNameI = idx(eh, "event name");
    const eTypeI = idx(eh, "type");
    const eDateI = idx(eh, "date");

    const attendanceByEmail = new Map<string, { event: string; type: string; date: string }[]>();
    for (const r of eventRows.slice(1)) {
      const email = primaryEmail(r[eEmailI] || "");
      if (!email) continue;
      const list = attendanceByEmail.get(email) || [];
      list.push({
        event: (r[eNameI] || "").trim(),
        type: (r[eTypeI] || "").trim().toLowerCase(),
        date: (r[eDateI] || "").trim(),
      });
      attendanceByEmail.set(email, list);
    }

    type Row = {
      email: string;
      name: string;
      dateAdded: string;
      source: string;
      followUp: boolean;
      events: number;
      attended: number;
    };
    const all: Row[] = [];
    for (const r of contactRows.slice(1)) {
      const email = primaryEmail(r[emailI] || "");
      if (!email) continue;
      const evs = attendanceByEmail.get(email) || [];
      all.push({
        email,
        name: nameI >= 0 ? (r[nameI] || "").trim() : "",
        dateAdded: dateI >= 0 ? toIsoDate(r[dateI] || "") : "",
        source: sourceI >= 0 ? (r[sourceI] || "").trim() : "",
        followUp: flagI >= 0 && (r[flagI] || "").trim().toLowerCase() === "true",
        events: evs.length,
        attended: evs.filter((e) => e.type === "attended" || !e.type).length,
      });
    }

    const since = all.filter((c) => c.dateAdded && c.dateAdded >= sinceArg);
    const pool = since.length > 0 ? since : all;
    const poolLabel =
      since.length > 0
        ? `Date Added ≥ ${sinceArg}`
        : "ALL contacts (few/no parseable Date Added values)";

    // Event-date lens: attendance rows with Date ≥ since.
    let eventRowsSince = 0;
    const emailsOnEventsSince = new Set<string>();
    for (const r of eventRows.slice(1)) {
      const d = toIsoDate(r[eDateI] || "");
      if (d && d >= sinceArg) {
        eventRowsSince++;
        const em = primaryEmail(r[eEmailI] || "");
        if (em) emailsOnEventsSince.add(em);
      }
    }

    const withAttendance = pool.filter((c) => c.events > 0);
    const noAttendance = pool.filter((c) => c.events === 0);
    const attendedNoFollowUp = pool.filter((c) => c.attended > 0 && !c.followUp);
    const attendedWithFollowUp = pool.filter((c) => c.attended > 0 && c.followUp);
    const csvish = pool.filter((c) => /csv|import|bulk|event/i.test(c.source));

    console.log(`Contacts total:           ${all.length}`);
    console.log(`Pool (${poolLabel}): ${pool.length}`);
    console.log(`  with ≥1 Events row:     ${withAttendance.length}`);
    console.log(`  with NO Events row:     ${noAttendance.length}`);
    console.log(`  attended + follow-up:   ${attendedWithFollowUp.length}`);
    console.log(`  attended, NO follow-up: ${attendedNoFollowUp.length}`);
    console.log(`  source looks like CSV:  ${csvish.length}`);
    console.log(`Events attendance rows:   ${eventRows.length > 0 ? eventRows.length - 1 : 0}`);
    console.log(`Events rows dated ≥ ${sinceArg}: ${eventRowsSince} (unique emails: ${emailsOnEventsSince.size})`);
    console.log("");

    if (noAttendance.length > 0) {
      console.log(`— sample: in Contacts since filter, NO event tag (up to 15) —`);
      for (const c of noAttendance.slice(0, 15)) {
        console.log(`  ${c.dateAdded || "?"}  ${c.name || "(no name)"}  <${c.email}>  source=${c.source || "?"}  followUp=${c.followUp}`);
      }
      console.log("");
    }

    if (attendedNoFollowUp.length > 0) {
      console.log(`— sample: attended but Follow Up Flag not set (up to 15) —`);
      for (const c of attendedNoFollowUp.slice(0, 15)) {
        console.log(`  ${c.dateAdded || "?"}  ${c.name || "(no name)"}  <${c.email}>`);
      }
      console.log("");
    }

    if (withAttendance.length > 0 && noAttendance.length === 0 && attendedNoFollowUp.length === 0) {
      console.log("Coverage looks good for this pool: everyone has an Events row and attended people are follow-up flagged.");
    } else if (attendedNoFollowUp.length > 0) {
      console.log(
        "Verdict: attendance is tagged; Follow Up flags are missing on older tags. Re-mark attended (idempotent) to stamp flags, or run scripts/test-event-followup-e2e.ts.",
      );
    } else if (noAttendance.length > 0) {
      console.log(
        `Verdict: ${noAttendance.length} contact(s) in the pool have no Events attendance row — only those need Events → Upload attended (exact event name). Follow-up coverage on already-tagged people looks fine.`,
      );
    }
  })();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
