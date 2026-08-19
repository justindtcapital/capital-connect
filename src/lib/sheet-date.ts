// Calendar dates for CRM sheets (Notes / BD / GTM).
//
// Google Sheets USER_ENTERED treats "YYYY-MM-DD" as a UTC datetime, which
// shifts a day in US timezones. We write M/D/YYYY (date-only) and always
// parse whatever comes back (ISO, M/D/YYYY, serial, named month) to ISO.

export const CRM_TIMEZONE = "America/New_York";

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/;
const MDY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+.*)?$/;
const SERIAL = /^\d+(\.\d+)?$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function ymd(year: number, month: number, day: number): string {
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Calendar day of `ms` in `timeZone` as YYYY-MM-DD. */
export function msToIsoDay(ms: number, timeZone: string = CRM_TIMEZONE): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const pick = (type: string) => parts.find((p) => p.type === type)?.value || "";
  const y = Number(pick("year"));
  const m = Number(pick("month"));
  const d = Number(pick("day"));
  return y && m && d ? ymd(y, m, d) : "";
}

/** Today's calendar date in the CRM timezone (America/New_York). */
export function todayIso(nowMs: number = Date.now()): string {
  return msToIsoDay(nowMs);
}

/** Today's calendar date in the runtime's local timezone (browser or server). */
export function localTodayIso(now: Date = new Date()): string {
  return ymd(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** Google Sheets / Excel serial (days since 1899-12-30) → YYYY-MM-DD. */
export function sheetsSerialToIso(serial: number): string {
  if (!Number.isFinite(serial)) return "";
  const days = Math.floor(serial);
  if (days < 20000 || days >= 80000) return "";
  const ms = Date.UTC(1899, 11, 30) + days * 86_400_000;
  return msToIsoDay(ms, "UTC");
}

/**
 * Coerce a sheet/Asana/Gmail date into YYYY-MM-DD. Empty when unparseable.
 * M/D/YYYY is treated as US month/day (matching the rest of the CRM).
 */
export function parseToIsoDate(raw: string | number | null | undefined): string {
  if (raw == null || raw === "") return "";
  if (typeof raw === "number") return sheetsSerialToIso(raw);

  const s = String(raw).trim().replace(/^'/, "");
  if (!s) return "";

  const iso = ISO_DAY.exec(s);
  if (iso) return ymd(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const mdy = MDY.exec(s);
  if (mdy) {
    const a = Number(mdy[1]);
    const b = Number(mdy[2]);
    const y = Number(mdy[3]);
    const us = ymd(y, a, b);
    if (us) return us;
    const eu = ymd(y, b, a);
    if (eu) return eu;
  }

  if (SERIAL.test(s)) {
    const n = Number(s);
    const fromSerial = sheetsSerialToIso(n);
    if (fromSerial) return fromSerial;
  }

  const parsed = Date.parse(s);
  if (!Number.isFinite(parsed)) return "";
  const d = new Date(parsed);
  return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/**
 * Format an ISO (or any parseable) date for Sheets USER_ENTERED writes.
 * M/D/YYYY is a date-only value and does not UTC-shift the way YYYY-MM-DD does.
 */
export function isoToSheetDate(raw: string | number | null | undefined): string {
  const iso = parseToIsoDate(raw);
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}/${y}`;
}

/** Display helper for the Interaction Trail (M/D/YYYY). */
export function formatIsoMdY(raw: string | number | null | undefined): string {
  return isoToSheetDate(raw);
}

/** Newest-first: positive when `b` is later than `a`. Undated values sort last. */
export function compareIsoDatesDesc(a: string, b: string): number {
  const aa = parseToIsoDate(a);
  const bb = parseToIsoDate(b);
  if (aa === bb) return 0;
  if (!aa) return 1;
  if (!bb) return -1;
  return bb.localeCompare(aa);
}
