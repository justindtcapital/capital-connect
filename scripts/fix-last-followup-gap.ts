// Find the 1 attended contact still missing Follow Up and force-flag it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv(path: string) {
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
}
loadEnv(resolve(process.cwd(), ".env"));

async function main() {
  const {
    TAB_NAMES,
    fetchSheetTab,
    flagContactsForFollowUp,
    sheetEmails,
    updateSheetCells,
    colLetters,
    ensureColumn,
    logOpsEvent,
  } = await import("../src/utils/sheets.server");

  const [contacts, events] = await Promise.all([
    fetchSheetTab(TAB_NAMES.contacts),
    fetchSheetTab(TAB_NAMES.events),
  ]);
  const ch = contacts[0].map((h) => h.trim().toLowerCase());
  const eh = events[0].map((h) => h.trim().toLowerCase());
  const cEmail = ch.indexOf("email");
  const cFlag = ch.indexOf("follow up flag");
  const cName = ch.indexOf("name");
  const eEmail = eh.indexOf("contact email");
  const eType = eh.indexOf("type");

  const flagByEmail = new Map<string, { flag: string; row: number; name: string; raw: string }>();
  for (let i = 1; i < contacts.length; i++) {
    const r = contacts[i];
    const flag = (r[cFlag] || "").trim().toLowerCase();
    const name = (r[cName] || "").trim();
    const raw = r[cEmail] || "";
    for (const e of sheetEmails(raw)) {
      flagByEmail.set(e, { flag, row: i + 1, name, raw });
    }
  }

  const gaps: string[] = [];
  for (const r of events.slice(1)) {
    const type = (r[eType] || "").trim().toLowerCase();
    if (type && type !== "attended") continue;
    const e = sheetEmails(r[eEmail] || "")[0];
    if (!e) continue;
    const hit = flagByEmail.get(e);
    if (!hit) continue;
    if (hit.flag !== "true") {
      gaps.push(e);
      console.log(`GAP  ${hit.name} <${e}> raw="${hit.raw}" flag="${hit.flag}" row=${hit.row}`);
    }
  }
  const unique = [...new Set(gaps)];
  console.log(`gaps: ${unique.length}`);
  if (unique.length === 0) return;

  // Force: match rows by any sheetEmails, including empty/odd flag values.
  await ensureColumn(TAB_NAMES.contacts, "Follow Up Flag");
  const wanted = new Set(unique);
  const updates: { range: string; value: string }[] = [];
  for (let i = 1; i < contacts.length; i++) {
    const addrs = sheetEmails(contacts[i][cEmail] || "");
    if (!addrs.some((a) => wanted.has(a))) continue;
    const cur = (contacts[i][cFlag] || "").trim().toLowerCase();
    if (cur === "true") continue;
    updates.push({ range: `${colLetters(cFlag)}${i + 1}`, value: "TRUE" });
  }
  if (updates.length) {
    await updateSheetCells(TAB_NAMES.contacts, updates);
    console.log(`forced ${updates.length} flag(s)`);
  }
  const again = await flagContactsForFollowUp(unique);
  console.log(`flagContactsForFollowUp updated ${again.updated}`);
  await logOpsEvent({
    action: "maintenance",
    source: "event_followup_gap_fix",
    status: "ok",
    summary: `Forced Follow Up on ${updates.length + again.updated} remaining attended gap(s)`,
    records: updates.length,
    items: unique.slice(0, 20),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
