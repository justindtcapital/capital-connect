import type {
  Contact,
  TargetLead,
  PortfolioCompany,
  Interaction,
  PortfolioEmployee,
  PortfolioEvent,
  PortfolioIntro,
  Temperature,
  InteractionType,
  PipelineStage,
  PortfolioDomain,
  OutreachAttempt,
  AsanaEvent,
  EventFormat,
  EngagementSource,
  BulkEditField,
  EmailActivityRecord,
  ConnectionPlan,
  PortCoExposure,
  AsanaActivity,
} from "@/lib/types";
import { scoreContact } from "@/lib/activity-score";
import { inferInterestAreas } from "@/lib/interest-domains";
import { normalizeEmails } from "@/lib/email";
import { normalizeLinkedinUrl } from "@/lib/linkedin";
import { normalizeSource, targetKeyOf, normalizeInteractionType } from "@/lib/types";
import { buildPortCoCanonicalMap, canonicalizePortCo } from "@/lib/portco-canonical";
import { getGoogleOAuthCreds, requireSpreadsheetId } from "./google.server";

// ── Cache ────────────────────────────────────────────────────
const TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, { data: string[][]; ts: number }>();

function getCached(key: string): string[][] | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < TTL_MS) return entry.data;
  return null;
}
function setCache(key: string, data: string[][]) {
  cache.set(key, { data, ts: Date.now() });
}

// ── Google Auth (OAuth2 Refresh Token → access token) ────────
let cachedToken: { token: string; expiresAt: number } | null = null;

export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 30_000) {
    return cachedToken.token;
  }

  const { clientId, clientSecret, refreshToken } = getGoogleOAuthCreds();

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Google OAuth2 credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN) are not configured",
    );
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google token refresh failed [${res.status}]: ${body}`);
  }

  const { access_token, expires_in } = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };

  cachedToken = { token: access_token, expiresAt: Date.now() + expires_in * 1000 };
  return access_token;
}

// ── Fetch a single sheet tab ─────────────────────────────────
export async function fetchSheetTab(tabName: string): Promise<string[][]> {
  const cached = getCached(tabName);
  if (cached) return cached;

  const spreadsheetId = requireSpreadsheetId();

  const token = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(tabName)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets API error for tab "${tabName}" [${res.status}]: ${body}`);
  }

  const json = (await res.json()) as { values?: string[][] };
  const rows = json.values || [];
  setCache(tabName, rows);
  return rows;
}

// ── Append a row to a sheet tab ──────────────────────────────
export async function appendSheetRow(tabName: string, values: string[]): Promise<void> {
  const spreadsheetId = requireSpreadsheetId();

  const token = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(tabName)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: [values] }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets append error for tab "${tabName}" [${res.status}]: ${body}`);
  }

  // Invalidate cache for this tab
  cache.delete(tabName);
}

// ── Append multiple rows to a sheet tab in one call ──────────
export async function appendSheetRows(tabName: string, rows: string[][]): Promise<void> {
  if (rows.length === 0) return;
  const spreadsheetId = requireSpreadsheetId();

  const token = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(tabName)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: rows }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets append error for tab "${tabName}" [${res.status}]: ${body}`);
  }
  cache.delete(tabName);
}

// ── Ensure a tab exists (creating it with a header row if not) ─
export async function ensureTab(tabName: string, headers: string[]): Promise<void> {
  const spreadsheetId = requireSpreadsheetId();
  const token = await getAccessToken();
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;

  // Is the tab already present?
  const metaRes = await fetch(`${base}?fields=sheets.properties.title`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (metaRes.ok) {
    const meta = (await metaRes.json()) as { sheets?: Array<{ properties?: { title?: string } }> };
    const titles = (meta.sheets || []).map((s) => s.properties?.title);
    if (titles.includes(tabName)) return;
  }

  // Create the tab.
  const addRes = await fetch(`${base}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] }),
  });
  if (!addRes.ok) {
    const body = await addRes.text();
    // A 400 "already exists" race is harmless; anything else is a real failure.
    if (!body.includes("already exists")) {
      throw new Error(`Sheets addSheet error for "${tabName}" [${addRes.status}]: ${body}`);
    }
  }

  // Write the header row.
  const headerUrl = `${base}/values/${encodeURIComponent(`${tabName}!A1`)}?valueInputOption=USER_ENTERED`;
  await fetch(headerUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [headers] }),
  });
  cache.delete(tabName);
}

// Extend a tab's header row in place so it contains at least `headers` columns.
// ensureTab only writes headers when it CREATES a tab, so a schema that grows new
// trailing columns (e.g. overflow cells for large payloads) needs this on tabs
// that already exist. Only extends — never reorders or shrinks — so existing data
// columns keep their positions. One PUT of the whole header row (no per-column
// race). Cheap no-op once the header row is already wide enough.
export async function ensureHeaderWidth(tabName: string, headers: string[]): Promise<void> {
  const spreadsheetId = requireSpreadsheetId();
  const token = await getAccessToken();
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
  const getRes = await fetch(`${base}/values/${encodeURIComponent(`${tabName}!1:1`)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (getRes.ok) {
    const data = (await getRes.json()) as { values?: string[][] };
    const current = data.values?.[0] ?? [];
    if (current.length >= headers.length) return; // already wide enough
  }
  const headerUrl = `${base}/values/${encodeURIComponent(`${tabName}!A1`)}?valueInputOption=USER_ENTERED`;
  await fetch(headerUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [headers] }),
  });
  cache.delete(tabName);
}

// Look up a tab's numeric sheetId (needed for structural batchUpdate requests
// like inserting a row). Returns null if the tab isn't found.
async function getSheetId(tabName: string): Promise<number | null> {
  const spreadsheetId = requireSpreadsheetId();
  const token = await getAccessToken();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties(sheetId,title)`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  const meta = (await res.json()) as {
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  };
  const found = (meta.sheets || []).find((s) => s.properties?.title === tabName);
  return found?.properties?.sheetId ?? null;
}

// All tab titles physically present in the spreadsheet (not just the ones the app
// knows about in TAB_NAMES). Powers the Query agent's full-workbook read access.
export async function listSheetTabs(): Promise<string[]> {
  const spreadsheetId = requireSpreadsheetId();
  const token = await getAccessToken();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return [];
  const meta = (await res.json()) as { sheets?: Array<{ properties?: { title?: string } }> };
  return (meta.sheets || []).map((s) => s.properties?.title).filter((t): t is string => !!t);
}

// ── Ensure a tab's first row is the header row ───────────────
// Unlike ensureTab (which only writes headers when it CREATES the tab), this
// repairs a tab that exists but whose first row is data — e.g. a Signals tab
// that was appended to before a header was ever written. It inserts a blank row
// at the top (shifting data down, never overwriting) and writes the headers.
export async function ensureHeaderRow(tabName: string, headers: string[]): Promise<void> {
  const rows = await fetchSheetTab(tabName).catch(() => [] as string[][]);
  const first = (rows[0] || []).map((c) => (c || "").trim().toLowerCase());
  // Already headed if the first row's first cell matches the first header.
  if (first[0] === (headers[0] || "").trim().toLowerCase()) return;
  if (rows.length === 0) return; // empty tab — ensureTab handles headers on create

  const sheetId = await getSheetId(tabName);
  if (sheetId == null) return; // best-effort: leave as-is if we can't resolve it
  const spreadsheetId = requireSpreadsheetId();
  const token = await getAccessToken();
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;

  // Insert a blank row at the very top, then write the header into it.
  const ins = await fetch(`${base}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        {
          insertDimension: {
            range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
            inheritFromBefore: false,
          },
        },
      ],
    }),
  });
  if (!ins.ok) return; // best-effort
  const headerUrl = `${base}/values/${encodeURIComponent(`${tabName}!A1`)}?valueInputOption=USER_ENTERED`;
  await fetch(headerUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [headers] }),
  });
  cache.delete(tabName);
}

// ── Ensure a tab has a column with the given header ──────────
// Returns the 0-based column index. If the header is missing, it's appended as
// a new rightmost column (the header cell is written). Used to add the
// "Engagement Source" column to the existing PortCos Introduced tab in place.
export async function ensureColumn(tabName: string, header: string): Promise<number> {
  const rows = await fetchSheetTab(tabName).catch(() => [] as string[][]);
  const headerRow = rows[0] || [];
  const idx = headerRow.findIndex((h) => h.trim().toLowerCase() === header.trim().toLowerCase());
  if (idx !== -1) return idx;
  const newIdx = headerRow.length;
  await updateSheetCell(tabName, `${colLetters(newIdx)}1`, header);
  return newIdx;
}

// ── Update a specific cell in a sheet tab ────────────────────
export async function updateSheetCell(
  tabName: string,
  cellRange: string,
  value: string,
): Promise<void> {
  const spreadsheetId = requireSpreadsheetId();

  const token = await getAccessToken();
  const range = `${tabName}!${cellRange}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: [[value]] }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets update error for "${range}" [${res.status}]: ${body}`);
  }

  cache.delete(tabName);
}

// ── Update many cells in one tab in a single API call ────────
// Each update is a cell range (e.g. "I42") + value. Uses values:batchUpdate so
// recomputing hundreds of ratings is one request rather than one-per-cell.
export async function updateSheetCells(
  tabName: string,
  updates: { range: string; value: string }[],
): Promise<void> {
  if (updates.length === 0) return;
  const spreadsheetId = requireSpreadsheetId();

  const token = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`;

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      valueInputOption: "USER_ENTERED",
      data: updates.map((u) => ({
        range: `${tabName}!${u.range}`,
        values: [[u.value]],
      })),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets batchUpdate error for "${tabName}" [${res.status}]: ${body}`);
  }
  cache.delete(tabName);
}

// 0-based column index → A1 column letters (0 → A, 26 → AA).
export function colLetters(index: number): string {
  let s = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ── Overwrite a whole row (starting at column A) ─────────────
export async function writeSheetRow(
  tabName: string,
  rowNumber: number,
  values: string[],
): Promise<void> {
  const spreadsheetId = requireSpreadsheetId();

  const token = await getAccessToken();
  const range = `${tabName}!A${rowNumber}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;

  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [values] }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets row write error for "${range}" [${res.status}]: ${body}`);
  }
  cache.delete(tabName);
}

// ── Column mapping helper ────────────────────────────────────
function mapRows<T>(rows: string[][], mapping: Record<string, string>): T[] {
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const fieldMap: Record<number, string> = {};

  for (const [sheetCol, fieldName] of Object.entries(mapping)) {
    const idx = headers.indexOf(sheetCol.toLowerCase());
    if (idx !== -1) fieldMap[idx] = fieldName;
  }

  return rows.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    for (const [idx, field] of Object.entries(fieldMap)) {
      obj[field] = (row[Number(idx)] || "").trim();
    }
    return obj as unknown as T;
  });
}

// ══════════════════════════════════════════════════════════════
// COLUMN MAPPINGS — matched to actual Google Sheet
// Keys = sheet column header (case-insensitive), values = TS field
// ══════════════════════════════════════════════════════════════

// Tab names — matched to actual sheet
export const TAB_NAMES = {
  contacts: "Contacts",
  events: "Events",
  portcoIntros: "PortCos Introduced",
  interactions: "Notes",
  targets: "Targets",
  portfolio: "Portfolio Companies",
  signals: "Signals",
  signalsArchive: "Signals Archive",
  appEvents: "App Events",
  portcoIntel: "PortCo Intel",
  sumbleProspects: "Sumble Prospects",
  customerDiscovery: "Customer Discovery",
  targetAccounts: "Target Accounts",
  llmLog: "LLM_Query_Log",
  ratingHistory: "Rating History",
  ratingOverrides: "Rating Overrides",
  fieldProvenance: "Field Provenance",
  apolloRaw: "Apollo Raw",
  emailActivity: "Email Activity",
  importHistory: "Import History",
  opsLog: "Ops Log",
  eventSynopsis: "Event Synopsis",
  targetOutreach: "Target Outreach",
  targetStrategy: "Target Strategy",
  dailySnapshots: "Daily Snapshots",
  dailyBriefing: "Daily Briefing",
  activityInsights: "Activity Insights Log",
  activityConnections: "Activity Connections",
  portcoExposure: "PortCo Event Exposure",
  bd: "BD",
  gtm: "GTM",
  portcoKpis: "PortCo KPIs",
  platformContent: "Platform Content",
  radarWatchlist: "Competitive Radar",
  theses: "Theses",
  thesisMatches: "Thesis Matches",
};

// One row per BD / GTM activity mirrored from its Asana Activity Tracking
// project. Append-only log, deduped on Activity GID so re-running the sync only
// adds activities created (or newly matched) since last time.
export const ACTIVITY_TRACK_HEADERS = [
  "Activity GID",
  "Date",
  "Name",
  "Type",
  "Status",
  "Owner",
  "Company",
  "Person",
  "Completed",
  "Notes",
  "URL",
];

export interface ActivityTrackSyncResult {
  /** New BD activity rows written this run. */
  bdLogged: number;
  /** New GTM activity rows written this run. */
  gtmLogged: number;
  /** BD activities skipped because already present (by GID). */
  bdSkipped: number;
  /** GTM activities skipped because already present (by GID). */
  gtmSkipped: number;
  /** Titles of new BD rows written this run. */
  bdItems: string[];
  /** Titles of new GTM rows written this run. */
  gtmItems: string[];
}

// Order values to ACTIVITY_TRACK_HEADERS.
function activityTrackRow(a: AsanaActivity): string[] {
  return [
    a.gid,
    a.date || "",
    a.name || "",
    a.type || "",
    a.status || "",
    a.owner || "",
    a.company || "",
    a.person || "",
    a.completed ? "TRUE" : "FALSE",
    a.notes || "",
    a.url || "",
  ];
}

function activityItemLabel(a: AsanaActivity): string {
  const bits = [
    a.name || "(untitled)",
    a.company ? `co:${a.company}` : "",
    a.person ? `person:${a.person}` : "",
    a.date || "",
    a.gid.startsWith("gmail-") ? "gmail" : "asana",
  ].filter(Boolean);
  return bits.join(" · ");
}

// Mirror one track's activities into its own tab (BD or GTM), deduped by GID.
// Also backfills blank Owner cells on existing rows when the live activity has one.
async function syncOneActivityTrack(
  tabName: string,
  activities: AsanaActivity[],
): Promise<{ logged: number; skipped: number; items: string[] }> {
  await ensureTab(tabName, ACTIVITY_TRACK_HEADERS);
  const rows = await fetchSheetTab(tabName).catch(() => [] as string[][]);
  const header = (rows[0] || []).map((h) => h.trim().toLowerCase());
  const gidIdx = header.indexOf("activity gid");
  const ownerIdx = header.indexOf("owner");
  const byGid = new Map<string, { rowNumber: number; owner: string }>();
  if (gidIdx !== -1) {
    for (let i = 1; i < rows.length; i++) {
      const g = (rows[i][gidIdx] || "").trim();
      if (!g) continue;
      byGid.set(g, {
        rowNumber: i + 1,
        owner: ownerIdx !== -1 ? (rows[i][ownerIdx] || "").trim() : "",
      });
    }
  }

  const newRows: string[][] = [];
  const items: string[] = [];
  const ownerUpdates: { range: string; value: string }[] = [];
  let skipped = 0;
  for (const a of activities) {
    const existing = byGid.get(a.gid);
    if (existing) {
      skipped++;
      if (a.owner && ownerIdx !== -1 && !existing.owner) {
        ownerUpdates.push({
          range: `${colLetters(ownerIdx)}${existing.rowNumber}`,
          value: a.owner,
        });
      }
      continue;
    }
    byGid.set(a.gid, { rowNumber: -1, owner: a.owner || "" });
    newRows.push(activityTrackRow(a));
    items.push(activityItemLabel(a));
  }

  if (newRows.length > 0) await appendSheetRows(tabName, newRows);
  if (ownerUpdates.length > 0) await updateSheetCells(tabName, ownerUpdates);
  return { logged: newRows.length, skipped, items };
}

/** Load BD + GTM Owner→GID ownership for a signed-in teammate. */
export async function buildOwnershipIndex(userEmail: string): Promise<{
  email: string;
  ownedGids: string[];
  firstName: string;
  displayName: string;
}> {
  const { teamProfile, buildOwnedGidSet } = await import("@/lib/user-ownership");
  const profile = teamProfile(userEmail);
  if (!profile) {
    return { email: userEmail, ownedGids: [], firstName: "there", displayName: userEmail };
  }
  const [bd, gtm] = await Promise.all([
    fetchSheetTab(TAB_NAMES.bd).catch(() => [] as string[][]),
    fetchSheetTab(TAB_NAMES.gtm).catch(() => [] as string[][]),
  ]);
  const owned = buildOwnedGidSet([bd, gtm], profile);
  return {
    email: profile.email,
    ownedGids: [...owned],
    firstName: profile.firstName,
    displayName: profile.displayName,
  };
}

/** Contacts attributed to the user via activity ownership. */
export async function buildMyContacts(userEmail: string): Promise<Contact[]> {
  const { teamProfile, filterMyContacts } = await import("@/lib/user-ownership");
  const profile = teamProfile(userEmail);
  if (!profile) return [];
  const [contacts, index] = await Promise.all([buildContacts(), buildOwnershipIndex(userEmail)]);
  return filterMyContacts(contacts, new Set(index.ownedGids), profile);
}

// Split Asana activities by track and mirror each into its own tab (BD / GTM).
// Idempotent: deduped by Activity GID, so it's safe to run repeatedly.
export async function syncActivityTracks(
  activities: AsanaActivity[],
): Promise<ActivityTrackSyncResult> {
  const bd = activities.filter((a) => a.track === "BD");
  const gtm = activities.filter((a) => a.track === "GTM");

  const [bdRes, gtmRes] = await Promise.all([
    syncOneActivityTrack(TAB_NAMES.bd, bd),
    syncOneActivityTrack(TAB_NAMES.gtm, gtm),
  ]);

  return {
    bdLogged: bdRes.logged,
    gtmLogged: gtmRes.logged,
    bdSkipped: bdRes.skipped,
    gtmSkipped: gtmRes.skipped,
    bdItems: bdRes.items,
    gtmItems: gtmRes.items,
  };
}

// One row per day of headline counts — the baseline the Home page diffs against
// for its "+N this week" deltas (and the substrate for future sparklines).
export const DAILY_SNAPSHOT_HEADERS = [
  "Date",
  "Contacts",
  "Hot Leads",
  "Open Follow-ups",
  "Targets",
  "Portfolio",
];

export interface DailyMetrics {
  contacts: number;
  hotLeads: number;
  openFollowUps: number;
  targets: number;
  portfolio: number;
}

export interface SnapshotResult {
  today: DailyMetrics;
  /** The metrics row to diff against (closest snapshot on/before 7 days ago, else earliest prior). */
  baseline: DailyMetrics | null;
  baselineDate: string | null;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().split("T")[0];
}

// Append today's headline counts (idempotently — once per day) and return the
// baseline row to diff against for "this week" deltas. Append-only: today's row
// is written the first time Home is opened each day; later opens reuse it.
export async function recordDailySnapshot(m: DailyMetrics): Promise<SnapshotResult> {
  await ensureTab(TAB_NAMES.dailySnapshots, DAILY_SNAPSHOT_HEADERS);
  const rows = await fetchSheetTab(TAB_NAMES.dailySnapshots).catch(() => [] as string[][]);
  const today = isoDay(Date.now());

  // Parse data rows (skip header) → { date, metrics }.
  const n = (v: string | undefined) => Number(v || "0") || 0;
  const parsed = rows.slice(1).map((r) => ({
    date: (r[0] || "").trim(),
    metrics: {
      contacts: n(r[1]),
      hotLeads: n(r[2]),
      openFollowUps: n(r[3]),
      targets: n(r[4]),
      portfolio: n(r[5]),
    } as DailyMetrics,
  }));

  if (!parsed.some((p) => p.date === today)) {
    await appendSheetRow(TAB_NAMES.dailySnapshots, [
      today,
      String(m.contacts),
      String(m.hotLeads),
      String(m.openFollowUps),
      String(m.targets),
      String(m.portfolio),
    ]);
  }

  // Baseline: prior days only, ISO dates sort lexically. Prefer the latest row
  // on/before a week ago; if none that old yet, fall back to the earliest prior.
  const weekAgo = isoDay(Date.now() - 7 * 86_400_000);
  const prior = parsed
    .filter((p) => p.date && p.date < today)
    .sort((a, b) => a.date.localeCompare(b.date));
  let chosen: (typeof prior)[number] | null = null;
  if (prior.length) {
    const onOrBeforeWeek = prior.filter((p) => p.date <= weekAgo);
    chosen = onOrBeforeWeek.length ? onOrBeforeWeek[onOrBeforeWeek.length - 1] : prior[0];
  }

  return { today: m, baseline: chosen?.metrics ?? null, baselineDate: chosen?.date ?? null };
}

// One row per generated morning briefing — the full briefing payload stored as
// JSON so it's produced once and ready when the user arrives. Append-only;
// latest row for a given day wins (a regenerate appends a fresh row).
export const DAILY_BRIEFING_HEADERS = ["Date", "GeneratedAt", "JSON"];

export async function readTodayBriefing(): Promise<{
  date: string;
  generatedAt: string;
  json: string;
} | null> {
  const rows = await fetchSheetTab(TAB_NAMES.dailyBriefing).catch(() => [] as string[][]);
  const today = isoDay(Date.now());
  let found: { date: string; generatedAt: string; json: string } | null = null;
  for (const r of rows.slice(1)) {
    if ((r[0] || "").trim() === today) {
      found = { date: r[0], generatedAt: r[1] || "", json: r[2] || "" }; // latest wins
    }
  }
  return found;
}

export async function saveBriefingRow(
  date: string,
  generatedAt: string,
  json: string,
): Promise<void> {
  await ensureTab(TAB_NAMES.dailyBriefing, DAILY_BRIEFING_HEADERS);
  await appendSheetRow(TAB_NAMES.dailyBriefing, [date, generatedAt, json]);
}

// Persisted outreach trail for targets (append-only; joined to a target by key).
export const TARGET_OUTREACH_HEADERS = [
  "Target Key",
  "Date",
  "Method",
  "Summary",
  "ID",
  "Target URID",
];

// Persisted AI connection plan per target (append-only; latest row per key wins).
export const TARGET_STRATEGY_HEADERS = ["Target Key", "Plan JSON", "Updated", "Target URID"];

// Per-event synopsis (manual or LLM-drafted). Append-only; latest row per event
// name wins. Keyed by event name since events are Asana-sourced (read-only there).
export const EVENT_SYNOPSIS_HEADERS = ["Event Name", "Synopsis", "Updated"];

// Persisted record per CSV/paste import — surfaced in the "Import History" panel.
export const IMPORT_HISTORY_HEADERS = [
  "Import ID",
  "Timestamp",
  "Filename",
  "Source", // bulk_upload | smart_paste
  "Total Rows",
  "Imported",
  "Duplicates",
  "Invalid",
  "Enriched",
  "Failed",
];

// Unified audit trail for every import, export, and sync the app runs.
export const OPS_LOG_HEADERS = [
  "Timestamp",
  "Action", // import | export | sync
  "Source", // bulk_upload | smart_paste | contacts_csv | asana_activities | …
  "Status", // ok | error
  "Summary",
  "Records", // primary count (imported / exported / logged)
  "Details", // compact key=value extras
  "Items", // concrete list of what was written (one per line)
];

export type OpsLogAction =
  | "import"
  | "export"
  | "sync"
  | "edit" // bulk field updates, stage promotes
  | "delete" // bulk deletes
  | "enrich" // Apollo/Sumble enrichment runs
  | "maintenance" // data repairs (e.g. URID backfill)
  | "prune"; // retention pruning (archive/delete stale rows)

export interface OpsLogInput {
  action: OpsLogAction;
  source: string;
  status: "ok" | "error";
  summary: string;
  records?: number;
  details?: Record<string, string | number | boolean | undefined | null>;
  /** Concrete items written this run (activity titles, contacts, etc.). */
  items?: string[];
}

function formatOpsDetails(details?: OpsLogInput["details"]): string {
  if (!details) return "";
  return Object.entries(details)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/** Join items for the sheet cell; caps length so a huge sync stays readable. */
export function formatOpsItems(items?: string[], maxItems = 80, maxChars = 45000): string {
  if (!items || items.length === 0) return "";
  const shown = items.slice(0, maxItems);
  let text = shown.join("\n");
  const omitted = items.length - shown.length;
  if (omitted > 0) text += `\n… +${omitted} more`;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars - 20) + "\n… (truncated)";
  }
  return text;
}

/** Append one row to the Ops Log tab (creates the tab on first write). */
export async function logOpsEvent(data: OpsLogInput): Promise<void> {
  try {
    await ensureTab(TAB_NAMES.opsLog, OPS_LOG_HEADERS);
    // Existing workbooks created before "Items" still get the column appended.
    await ensureColumn(TAB_NAMES.opsLog, "Items");
    await appendSheetRow(TAB_NAMES.opsLog, [
      new Date().toISOString(),
      data.action,
      data.source,
      data.status,
      data.summary.slice(0, 500),
      data.records != null ? String(data.records) : "",
      formatOpsDetails(data.details).slice(0, 2000),
      formatOpsItems(data.items),
    ]);
  } catch (e) {
    // Never fail the primary operation because audit logging failed.
    console.error("[ops-log] failed to append:", e);
  }
}

// One parsed Ops Log row, for the in-app audit trail viewer.
export interface OpsLogEntry {
  timestamp: string;
  action: string;
  source: string;
  status: string;
  summary: string;
  records: number | null;
  details: string;
  items: string[];
}

// Read the Ops Log tab into typed entries, newest first. Header-aware (tolerant of
// column order / a missing "Items" column on older workbooks). Returns [] if the
// tab doesn't exist yet.
export async function buildOpsLog(limit = 500): Promise<OpsLogEntry[]> {
  const rows = await fetchSheetTab(TAB_NAMES.opsLog).catch(() => [] as string[][]);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (name: string) => headers.indexOf(name);
  const tIdx = idx("timestamp");
  const aIdx = idx("action");
  const sIdx = idx("source");
  const stIdx = idx("status");
  const sumIdx = idx("summary");
  const rIdx = idx("records");
  const dIdx = idx("details");
  const iIdx = idx("items");
  const cell = (row: string[], i: number) => (i !== -1 ? (row[i] || "").trim() : "");

  const entries: OpsLogEntry[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const recordsRaw = cell(row, rIdx);
    const records = recordsRaw === "" ? null : Number(recordsRaw);
    entries.push({
      timestamp: cell(row, tIdx),
      action: cell(row, aIdx),
      source: cell(row, sIdx),
      status: cell(row, stIdx),
      summary: cell(row, sumIdx),
      records: Number.isFinite(records as number) ? (records as number) : null,
      details: cell(row, dIdx),
      items: cell(row, iIdx)
        ? cell(row, iIdx)
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    });
  }
  // Newest first; stable string compare on ISO timestamps.
  entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return entries.slice(0, limit);
}
// Typed, attributed email sends — the data foundation for surfacing outreach on
// the Events and PortCo modules and for the activity-weighted scorecard.
export const EMAIL_ACTIVITY_HEADERS = [
  "Contact Email",
  "Timestamp",
  "Subject",
  "Type", // PortCo | Event | General
  "Linked PortCo",
  "Linked Event",
];

// Per-field source tracking so non-destructive enrichment knows what a human
// has touched. Append-only; the latest row for an (email, field) pair wins.
export const FIELD_PROVENANCE_HEADERS = ["Email", "Field", "Source", "Updated", "URID"];

// Full last Apollo payload per contact, archived so nothing is ever lost.
export const APOLLO_RAW_HEADERS = ["Email", "Synced At", "Payload"];

// Append-only log of every automatic-scorecard tier change (and manual edits).
export const RATING_HISTORY_HEADERS = [
  "Timestamp",
  "Email",
  "Name",
  "Previous",
  "New",
  "Score",
  "Source", // "auto" | "manual"
  "Drivers",
];

// Current lock state per contact. Locked = the rating was set by hand and the
// automatic scorecard must leave it alone.
export const RATING_OVERRIDE_HEADERS = ["Email", "Locked", "Tier", "Updated", "URID"];

// Column order for the Target Accounts log (account-based people search + adds).
// Purpose distinguishes portfolio-development intros from investor/CVC outreach.
// PortCos / Tech Context are set by the Find-companies flow (install-tech search)
// and left blank by the plain Target Accounts finder.
export const TARGET_ACCOUNT_HEADERS = [
  "Date",
  "Purpose",
  "Account",
  "Account Domain",
  "Role Searched",
  "Name",
  "Title",
  "Email",
  "Phone",
  "Location",
  "LinkedIn",
  "Status",
  "PortCos",
  "Tech Context",
];

// Column order for the Customer Discovery cache tab. Like PortCo Intel, the full
// result is stored as JSON in the "Data" column; the flat columns are for
// human readability in the sheet.
export const CUSTOMER_DISCOVERY_HEADERS = [
  "Portfolio Company",
  "Generated At",
  "Opportunities",
  "Used Claude",
  "Credits Remaining",
  "Data",
];

// Audit-log columns for the LLM Query Tab (§5 of the spec). List-valued fields
// are stored as JSON strings so the whole record stays in one row.
export const LLM_QUERY_LOG_HEADERS = [
  "query_id",
  "session_id",
  "user",
  "timestamp_received",
  "timestamp_completed",
  "latency_ms",
  "input_text",
  "attachments_json",
  "clarification_json",
  "tools_called_json",
  "sources_json",
  "output_text",
  "output_artifacts_json",
  "model",
  "token_usage_json",
  "status",
  "review_required",
  "approved_by",
  "approved_at",
  "error_detail",
];

export interface AddContactInput {
  name: string;
  role: string;
  company: string;
  email: string;
  phone: string;
  location: string;
  prime: string;
  sector: string;
  temperature: string;
  /** Sourced LinkedIn profile URL (written to the "LinkedIn" column). */
  linkedin?: string;
  /** Canonical origin (RecordSource). Written to the "Source" column — callers
   *  should ensureColumn("Source") first so the column exists. */
  source?: string;
  /** V2: supporting "why surfaced" reasoning, written to "Source Context". */
  sourceContext?: string;
  /** Apollo professional headline (written to the "Headline" column). */
  headline?: string;
  /** Pre-formatted employment history (written to "Employment History"). */
  employmentHistory?: string;
}

// Portfolio-company match: returns "Portfolio" when the given company (or any
// comma/semicolon/slash-separated token within it) exactly matches a portfolio
// company name, else "". Used to stamp a contact's sector on add/enrich.
// buildPortfolioCompanies is cached (5-min TTL) so repeated calls in an import
// loop don't re-hit the Sheets API.
export async function resolvePortfolioSector(company: string): Promise<string> {
  const raw = (company || "").trim();
  if (!raw) return "";
  const companies = await buildPortfolioCompanies().catch(() => []);
  const set = new Set(companies.map((c) => c.name.trim().toLowerCase()).filter(Boolean));
  if (set.size === 0) return "";
  const tokens = raw
    .split(/[,;/]/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  for (const t of [raw.toLowerCase(), ...tokens]) {
    if (set.has(t)) return "Portfolio";
  }
  return "";
}

// Header-aware append to the Contacts tab: place each value in the column whose
// header matches, so the row aligns with WHATEVER order the columns are in.
// Shared by the addContact server fn and the prospect-importer.
export async function addContactRow(data: AddContactInput): Promise<void> {
  const now = new Date().toISOString().split("T")[0];
  // Unify multi-email separators (| , whitespace) to "; " so the rest of the app
  // (primaryEmail, dedup, mailto) treats the cell consistently.
  const email = normalizeEmails(data.email);
  // Stamp a stable surrogate key on every new contact. Ensure the column exists
  // first so the header-aware append below has a slot to write it into.
  await ensureColumn(TAB_NAMES.contacts, "urid");
  // Ensure the enrichment columns exist when we have something to put in them.
  if (data.headline) await ensureColumn(TAB_NAMES.contacts, "Headline");
  if (data.employmentHistory) await ensureColumn(TAB_NAMES.contacts, "Employment History");
  if (data.linkedin) await ensureColumn(TAB_NAMES.contacts, "LinkedIn");

  // Sector: a portfolio-company employer always wins ("Portfolio"); otherwise
  // keep whatever sector was passed in (e.g. the Apollo industry).
  const portfolioSector = await resolvePortfolioSector(data.company);
  const sector = portfolioSector || data.sector;

  const valueByHeader: Record<string, string> = {
    urid: crypto.randomUUID(),
    name: data.name,
    "full name": data.name,
    role: data.role,
    title: data.role,
    company: data.company,
    organization: data.company,
    email: email,
    "email address": email,
    "phone number": data.phone,
    phone: data.phone,
    location: data.location,
    city: data.location,
    linkedin: normalizeLinkedinUrl(data.linkedin),
    "relationship prime": data.prime,
    prime: data.prime,
    "industry category": sector,
    sector: sector,
    "relationship status": data.temperature,
    "follow up flag": "FALSE",
    "date added": now,
    // Canonical source — filled only when one of these columns exists.
    source: data.source ?? "",
    "lead source": data.source ?? "",
    origin: data.source ?? "",
    // V2 supporting reasoning.
    "source context": data.sourceContext ?? "",
    // Apollo enrichment extras (written only if the columns exist).
    headline: data.headline ?? "",
    "employment history": data.employmentHistory ?? "",
  };

  const rows = await fetchSheetTab(TAB_NAMES.contacts);
  const headers = (rows[0] || []).map((h) => h.trim().toLowerCase());

  if (headers.length === 0) {
    await appendSheetRow(TAB_NAMES.contacts, [
      data.name,
      data.role,
      data.company,
      email,
      data.phone,
      data.location,
      data.prime,
      data.sector,
      data.temperature,
      "FALSE",
      now,
    ]);
  } else {
    await appendSheetRow(
      TAB_NAMES.contacts,
      headers.map((h) => valueByHeader[h] ?? ""),
    );
  }
}

// Column order for the PortCo Intel cache tab (Sumble results, cached to avoid
// re-spending credits). The full result is stored as JSON in the "Data" column;
// the flat columns are for human readability in the sheet.
export const PORTCO_INTEL_HEADERS = [
  "Company",
  "Org ID",
  "Org Name",
  "Domain",
  "Jobs Count",
  "Has Brief",
  "Fetched At",
  "Brief Fetched At",
  "Credits Remaining",
  "Data",
];

// Column order for the Sumble Prospects log (network-finder results + adds).
export const SUMBLE_PROSPECT_HEADERS = [
  "Date",
  "Focus",
  "Sumble Industry",
  "Name",
  "Title",
  "Job Level",
  "Company",
  "Company Domain",
  "Location",
  "LinkedIn",
  "Status",
  "Email",
  "Reason",
];

// Column order for the App Events tab (events added in-app, NOT written to Asana).
export const APP_EVENT_HEADERS = [
  "Name",
  "Date",
  "Status",
  "Type",
  "Lead",
  "Format",
  "Role",
  "Sectors",
  "PortCos",
];

// Column order for the Signals tab (created on first scan).
// New columns are appended at the END so existing rows (read/written positionally)
// stay valid — older 16-column rows simply read "" for Source Type / Doc URL.
export const SIGNAL_HEADERS = [
  "ID",
  "Date Found",
  "Type",
  "Status",
  "Person",
  "Company",
  "Email",
  "Category",
  "Signal",
  "Source URL",
  "Subject",
  "Body",
  "Relevance",
  "Justification",
  "Urgency",
  "Timing",
  "Source Type",
  "Doc URL",
];

const CONTACT_COLS: Record<string, string> = {
  name: "name",
  role: "title",
  company: "company",
  email: "email",
  "phone number": "phone",
  location: "location",
  linkedin: "linkedinUrl",
  "relationship prime": "prime",
  "industry category": "sector",
  "relationship status": "temperature",
  "follow up flag": "followUpFlag",
  "date added": "dateAdded",
  "contact type": "contactType",
  "areas of interest": "areasOfInterest",
  // Canonical record source (accept a couple of legacy header names).
  source: "source",
  "lead source": "source",
  origin: "source",
  "source context": "sourceContext",
  "tech stack": "techStack",
  "apollo enriched": "apolloEnriched",
  "apollo enriched date": "apolloEnrichedDate",
  urid: "urid",
};

const EVENT_COLS: Record<string, string> = {
  "contact urid": "curid",
  "contact email": "email",
  "event name": "eventName",
  date: "date",
  type: "type",
};

const PORTCO_INTRO_COLS: Record<string, string> = {
  "contact urid": "curid",
  "contact email": "email",
  "portco name": "portcoName",
  date: "date",
  "engagement source": "source",
};

const INTERACTION_COLS: Record<string, string> = {
  "contact urid": "curid",
  "contact email": "email",
  timestamp: "date",
  "note content": "summary",
  "requires follow up": "isFollowUp",
  "follow up resolved": "followUpComplete",
  type: "type",
  "source ref": "sourceRef",
  owner: "owner",
};

// Canonical Notes-tab column order used when the tab is created from scratch.
// Existing tabs may also carry a "Contact URID" column (appended by the urid
// migration); every write below is header-aware so values land in the right
// physical columns no matter where "Type" / "Contact URID" sit.
const INTERACTION_HEADERS = [
  "Contact Email",
  "Timestamp",
  "Note Content",
  "Requires Follow Up",
  "Follow Up Resolved",
  "Type",
];

export interface InteractionRowInput {
  email: string;
  date: string;
  summary: string;
  /** Interaction type (call/email/meeting/intro/event/note/follow-up). */
  type: InteractionType;
  requiresFollowUp: boolean;
  /** Follow-up already resolved (defaults false). */
  resolved?: boolean;
  /** Optional stable contact key; left blank falls back to the email join. */
  urid?: string;
  /** Optional external source reference (e.g. "asana:12345"). */
  sourceRef?: string;
  /** DTC teammate who owned the underlying BD/GTM activity. */
  owner?: string;
}

// Append one or more interaction rows to the Notes tab in a single batched
// write. Header-aware: it ensures the "Type" column exists, then orders each
// row's values to the tab's actual header row, so it survives columns added by
// migrations (Contact URID) without misaligning.
export async function appendInteractionRows(rows: InteractionRowInput[]): Promise<void> {
  if (rows.length === 0) return;
  await ensureTab(TAB_NAMES.interactions, INTERACTION_HEADERS);
  await ensureColumn(TAB_NAMES.interactions, "Type");
  if (rows.some((r) => r.sourceRef)) await ensureColumn(TAB_NAMES.interactions, "Source Ref");
  if (rows.some((r) => r.owner)) await ensureColumn(TAB_NAMES.interactions, "Owner");
  const sheetRows = await fetchSheetTab(TAB_NAMES.interactions).catch(() => [] as string[][]);
  const headers = (sheetRows[0] || []).map((h) => h.trim().toLowerCase());

  const toValues = (r: InteractionRowInput): string[] => {
    const byHeader: Record<string, string> = {
      "contact urid": r.urid ?? "",
      "contact email": r.email,
      timestamp: r.date,
      "note content": r.summary,
      "requires follow up": r.requiresFollowUp ? "TRUE" : "FALSE",
      "follow up resolved": r.resolved ? "TRUE" : "FALSE",
      type: r.type,
      "source ref": r.sourceRef ?? "",
      owner: r.owner ?? "",
    };
    return headers.length
      ? headers.map((h) => byHeader[h] ?? "")
      : [
          r.email,
          r.date,
          r.summary,
          r.requiresFollowUp ? "TRUE" : "FALSE",
          r.resolved ? "TRUE" : "FALSE",
          r.type,
          r.sourceRef ?? "",
          r.owner ?? "",
        ];
  };

  await appendSheetRows(TAB_NAMES.interactions, rows.map(toValues));
}

const TARGET_COLS: Record<string, string> = {
  urid: "urid",
  "first name": "firstName",
  "last name": "lastName",
  company: "company",
  role: "role",
  linkedin: "linkedinUrl",
  email: "email",
  phone: "phone",
  location: "location",
  sector: "sector",
  stage: "stage",
  source: "originSource",
  "research purpose": "researchPurpose",
  "reason surfaced": "reasonSurfaced",
  "date added": "dateAdded",
  "last contacted": "lastContacted",
};

// Canonical Targets tab header order. Reading is header-name based (robust to
// order); writing is positional, so appends MUST follow this order. "Reason
// Surfaced" is ensured via ensureColumn so existing sheets get it appended last.
export const TARGET_HEADERS = [
  "URID",
  "First Name",
  "Last Name",
  "Company",
  "Role",
  "LinkedIn",
  "Email",
  "Phone",
  "Location",
  "Sector",
  "Stage",
  "Source",
  "Research Purpose",
  "Date Added",
  "Last Contacted",
  "Reason Surfaced",
];

// One row to add to the Targets tab. Written header-aware (see appendTargetRows)
// so column order in the live sheet never has to match this shape.
export interface TargetRowInput {
  firstName: string;
  lastName: string;
  company: string;
  role: string;
  linkedin: string;
  email: string;
  phone?: string;
  location: string;
  sector: string;
  stage: string;
  source: string;
  researchPurpose: string;
  dateAdded?: string;
  lastContacted?: string;
  reasonSurfaced?: string;
}

// Header-aware Targets append: stamps a stable URID on every new row and places
// each value in the column whose header matches, so a column insert in the Sheets
// UI can never silently misalign the write (the failure that produced fix_carmen).
export async function appendTargetRows(inputs: TargetRowInput[]): Promise<void> {
  if (inputs.length === 0) return;
  await ensureTab(TAB_NAMES.targets, TARGET_HEADERS);
  await ensureColumn(TAB_NAMES.targets, "URID");
  await ensureColumn(TAB_NAMES.targets, "Reason Surfaced");
  await ensureColumn(TAB_NAMES.targets, "Phone");

  const rows = await fetchSheetTab(TAB_NAMES.targets);
  const headers = (rows[0] || []).map((h) => h.trim().toLowerCase());
  const today = new Date().toISOString().split("T")[0];

  const built = inputs.map((t) => {
    const valueByHeader: Record<string, string> = {
      urid: crypto.randomUUID(),
      "first name": t.firstName,
      "last name": t.lastName,
      company: t.company,
      role: t.role,
      linkedin: normalizeLinkedinUrl(t.linkedin),
      email: t.email,
      phone: t.phone || "",
      location: t.location,
      sector: t.sector,
      stage: t.stage,
      source: t.source,
      "research purpose": t.researchPurpose,
      "date added": t.dateAdded || today,
      "last contacted": t.lastContacted || "",
      "reason surfaced": t.reasonSurfaced || "",
    };
    return headers.map((h) => valueByHeader[h] ?? "");
  });

  await appendSheetRows(TAB_NAMES.targets, built);
}

// Repair the Targets tab's stable-key column: create URID if the tab predates it,
// stamp a fresh UUID on every row whose URID cell is blank (legacy rows), and
// regenerate URIDs that collide (manual copy-paste in the Sheet). Only the URID
// column is touched — data columns are never moved, and reads are already
// header-aware so Title/Company/Sector stay put. Safe + idempotent: a second run
// with nothing to fix writes nothing. Outreach/strategy history that keyed on an
// old (duplicated) URID re-joins via the legacy email·name|company key, so no
// trail is lost. Returns the counts for a caller toast.
export async function repairTargetUrids(): Promise<{
  total: number;
  filled: number;
  deduped: number;
}> {
  await ensureTab(TAB_NAMES.targets, TARGET_HEADERS);
  await ensureColumn(TAB_NAMES.targets, "URID");

  const rows = await fetchSheetTab(TAB_NAMES.targets);
  if (rows.length < 2) return { total: 0, filled: 0, deduped: 0 };

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const uridIdx = headers.indexOf("urid");
  if (uridIdx === -1) return { total: 0, filled: 0, deduped: 0 };

  const updates: { range: string; value: string }[] = [];
  const seen = new Set<string>();
  let filled = 0;
  let deduped = 0;

  for (let i = 1; i < rows.length; i++) {
    const cur = (rows[i][uridIdx] || "").trim();
    const lower = cur.toLowerCase();
    if (!cur) {
      const fresh = crypto.randomUUID();
      updates.push({ range: `${colLetters(uridIdx)}${i + 1}`, value: fresh });
      seen.add(fresh.toLowerCase());
      filled++;
    } else if (seen.has(lower)) {
      const fresh = crypto.randomUUID();
      updates.push({ range: `${colLetters(uridIdx)}${i + 1}`, value: fresh });
      seen.add(fresh.toLowerCase());
      deduped++;
    } else {
      seen.add(lower);
    }
  }

  if (updates.length > 0) await updateSheetCells(TAB_NAMES.targets, updates);
  return { total: rows.length - 1, filled, deduped };
}

// Change the Engagement Source of an existing (contact, portco) intro in place —
// so a partner can reclassify a portfolio engagement (e.g. "event exposure" →
// "direct introduction") without deleting and re-adding it. Matched by portco name
// + contact (URID preferred, else email), case-insensitive; the latest matching
// row wins (mirrors how buildContacts reads it). Falls back to appending a fresh
// row (header-aware) if no matching intro exists yet.
export async function setPortcoIntroSource(
  contactEmail: string,
  portcoName: string,
  source: string,
  curid?: string,
): Promise<{ success: boolean; updated: boolean }> {
  const email = (contactEmail || "").trim().toLowerCase();
  const uridKey = (curid || "").trim().toLowerCase();
  const portco = (portcoName || "").trim().toLowerCase();
  if ((!email && !uridKey) || !portco) return { success: false, updated: false };

  await ensureColumn(TAB_NAMES.portcoIntros, "Engagement Source");
  const rows = await fetchSheetTab(TAB_NAMES.portcoIntros);
  const headers = (rows[0] || []).map((h) => h.trim().toLowerCase());
  const today = new Date().toISOString().split("T")[0];

  const appendFresh = async () => {
    const valueByHeader: Record<string, string> = {
      "contact urid": curid || "",
      "contact email": contactEmail,
      "portco name": portcoName,
      date: today,
      "engagement source": source,
    };
    await appendSheetRow(
      TAB_NAMES.portcoIntros,
      headers.length > 0
        ? headers.map((h) => valueByHeader[h] ?? "")
        : [contactEmail, portcoName, today, source],
    );
  };

  if (rows.length < 2) {
    await appendFresh();
    return { success: true, updated: false };
  }

  const emailIdx = headers.indexOf("contact email");
  const uridIdx = headers.indexOf("contact urid");
  const portcoIdx = headers.indexOf("portco name");
  const sourceIdx = headers.indexOf("engagement source");
  if (portcoIdx === -1 || sourceIdx === -1) return { success: false, updated: false };

  // Last matching row (latest wins on read → edit that same row).
  let rowNum = -1;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][portcoIdx] || "").trim().toLowerCase() !== portco) continue;
    const re = emailIdx !== -1 ? (rows[i][emailIdx] || "").trim().toLowerCase() : "";
    const ru = uridIdx !== -1 ? (rows[i][uridIdx] || "").trim().toLowerCase() : "";
    if ((uridKey && ru === uridKey) || (email && re === email)) rowNum = i + 1;
  }

  if (rowNum === -1) {
    await appendFresh();
    return { success: true, updated: false };
  }
  await updateSheetCell(TAB_NAMES.portcoIntros, `${colLetters(sourceIdx)}${rowNum}`, source);
  return { success: true, updated: true };
}

const PORTFOLIO_COLS: Record<string, string> = {
  urid: "urid",
  "company name": "name",
  website: "website",
  "focus area(s)": "domain",
  hq: "location",
  summary: "description",
};

// Canonical header row used when the Portfolio Companies tab is created from
// scratch. Existing tabs keep whatever columns they already have (the add path is
// header-aware), so this only matters on first-run.
const PORTFOLIO_HEADERS = ["URID", "Company Name", "Website", "Focus Area(s)", "HQ", "Summary"];

// ══════════════════════════════════════════════════════════════
// DATA BUILDERS
// ══════════════════════════════════════════════════════════════

// Read the Rating Overrides tab → set of lowercased emails whose rating is
// manually locked. Missing tab / malformed rows are treated as "nothing locked".
// Returns the set of lock KEYS — each row keyed by its stable urid when present,
// else by email (transition fallback). buildContacts checks both a contact's
// urid and its email against this set.
export async function buildRatingOverrides(): Promise<Set<string>> {
  const rows = await fetchSheetTab(TAB_NAMES.ratingOverrides).catch(() => [] as string[][]);
  if (rows.length < 2) return new Set();
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const emailIdx = headers.indexOf("email");
  const uridIdx = headers.indexOf("urid");
  const lockedIdx = headers.indexOf("locked");
  if (lockedIdx === -1 || (emailIdx === -1 && uridIdx === -1)) return new Set();
  const locked = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const urid = uridIdx !== -1 ? (rows[i][uridIdx] || "").trim().toLowerCase() : "";
    const email = emailIdx !== -1 ? (rows[i][emailIdx] || "").trim().toLowerCase() : "";
    const key = urid || email;
    if (!key) continue;
    const isLocked = (rows[i][lockedIdx] || "").trim().toLowerCase() === "true";
    if (isLocked) locked.add(key);
    else locked.delete(key); // a later FALSE row clears an earlier lock
  }
  return locked;
}

// Read the Field Provenance tab → email → { field: "user" | "apollo" }.
// Append-only log; the latest row for an (email, field) pair wins.
// Map keyed by each row's stable urid when present, else email (transition
// fallback). Lookups (buildContacts, mergeContactFields) merge a contact's
// urid-keyed and email-keyed records so nothing is lost mid-migration.
export async function buildFieldProvenance(): Promise<
  Map<string, Record<string, "user" | "apollo">>
> {
  const rows = await fetchSheetTab(TAB_NAMES.fieldProvenance).catch(() => [] as string[][]);
  const map = new Map<string, Record<string, "user" | "apollo">>();
  if (rows.length < 2) return map;
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const emailIdx = headers.indexOf("email");
  const uridIdx = headers.indexOf("urid");
  const fieldIdx = headers.indexOf("field");
  const sourceIdx = headers.indexOf("source");
  if (fieldIdx === -1 || sourceIdx === -1 || (emailIdx === -1 && uridIdx === -1)) return map;
  for (let i = 1; i < rows.length; i++) {
    const urid = uridIdx !== -1 ? (rows[i][uridIdx] || "").trim().toLowerCase() : "";
    const email = emailIdx !== -1 ? (rows[i][emailIdx] || "").trim().toLowerCase() : "";
    const key = urid || email;
    const field = (rows[i][fieldIdx] || "").trim();
    const source = (rows[i][sourceIdx] || "").trim().toLowerCase();
    if (!key || !field || (source !== "user" && source !== "apollo")) continue;
    const rec = map.get(key) || {};
    rec[field] = source;
    map.set(key, rec);
  }
  return map;
}

export async function buildContacts(): Promise<Contact[]> {
  const [
    contactRows,
    eventRows,
    introRows,
    interactionRows,
    lockedEmails,
    provenance,
    portfolioCompanies,
  ] = await Promise.all([
    fetchSheetTab(TAB_NAMES.contacts),
    fetchSheetTab(TAB_NAMES.events).catch(() => [] as string[][]),
    fetchSheetTab(TAB_NAMES.portcoIntros).catch(() => [] as string[][]),
    fetchSheetTab(TAB_NAMES.interactions).catch(() => [] as string[][]),
    buildRatingOverrides(),
    buildFieldProvenance(),
    buildPortfolioCompanies().catch(() => [] as PortfolioCompany[]),
  ]);

  const portCoMap = buildPortCoCanonicalMap(portfolioCompanies.map((p) => p.name));

  const rawContacts = mapRows<Record<string, string>>(contactRows, CONTACT_COLS);
  const rawEvents = mapRows<Record<string, string>>(eventRows, EVENT_COLS);
  const rawIntros = mapRows<Record<string, string>>(introRows, PORTCO_INTRO_COLS);
  const rawInteractions = mapRows<Record<string, string>>(interactionRows, INTERACTION_COLS);

  // Children join to a contact by stable urid when present, else by email
  // (transition fallback). Each child row lands in exactly ONE bucket, so a
  // contact's rows are the union of its urid-bucket and email-bucket (no dupes).
  const events = splitByParent(rawEvents);
  const intros = splitByParent(rawIntros);
  const interactionsByParent = splitByParent(rawInteractions);

  return rawContacts.map((c, idx) => {
    const email = c.email || "";
    const emailKeys = email
      .split(/[;,]/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes("@"));
    const uridKey = (c.urid || "").trim().toLowerCase();
    // Gather child rows by urid and by ANY of the contact's emails (Notes sync
    // writes the primary address; multi-email Contacts must still find them).
    const gather = (g: ParentBuckets) => {
      const out: Record<string, string>[] = [];
      const seen = new Set<string>();
      const add = (rows: Record<string, string>[]) => {
        for (const r of rows) {
          const sig = `${r.date || ""}|${r.summary || r.eventName || r.portcoName || ""}|${r.sourceRef || ""}|${r.email || ""}|${r.type || ""}`;
          if (seen.has(sig)) continue;
          seen.add(sig);
          out.push(r);
        }
      };
      if (uridKey) add(g.byUrid[uridKey] || []);
      for (const e of emailKeys) add(g.byEmail[e] || []);
      return out;
    };
    const contactEvents = gather(events);
    const contactIntros = gather(intros);
    const contactInteractions = gather(interactionsByParent);

    const eventsAttended = contactEvents
      .filter((e) => (e.type || "attended").toLowerCase() === "attended")
      .map((e) => e.eventName);
    const eventsInvited = contactEvents
      .filter((e) => (e.type || "").toLowerCase() === "invited")
      .map((e) => e.eventName);

    const portCoIntros = [
      ...new Set(
        contactIntros
          .map((i) => canonicalizePortCo(i.portcoName || "", portCoMap))
          .filter(Boolean),
      ),
    ];
    const portCoEngagements = contactIntros
      .filter((i) => i.portcoName)
      .map((i) => ({
        portco: canonicalizePortCo(i.portcoName || "", portCoMap),
        date: i.date || "",
        source: ((i.source || "direct introduction").trim() ||
          "direct introduction") as EngagementSource,
      }))
      .filter((e) => e.portco);

    const interactions: Interaction[] = contactInteractions
      .map((i, iIdx) => ({
        id: `i-${idx}-${iIdx}`,
        date: i.date || "",
        type: normalizeInteractionType(i.type),
        summary: i.summary || "",
        isFollowUp: i.isFollowUp?.toLowerCase() === "true",
        followUpComplete: i.followUpComplete?.toLowerCase() === "true",
        sourceRef: i.sourceRef || undefined,
        owner: i.owner || undefined,
      }))
      // Newest first so the Interaction Trail and lastContact stay current after sync.
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

    // Follow-up pending: either from Notes tab or from Contact's Follow Up Flag
    const followUpFromNotes = interactions.some((i) => i.isFollowUp && !i.followUpComplete);
    const followUpFromFlag = c.followUpFlag?.toLowerCase() === "true";
    const followUpPending = followUpFromNotes || followUpFromFlag;

    // Areas of interest: use the manual sheet value when present (override),
    // otherwise infer from title + company (rule-based auto-fill).
    const manualAreas = (c.areasOfInterest || "")
      .split(/[;,]/)
      .map((a) => a.trim())
      .filter(Boolean);
    const areasOfInterest =
      manualAreas.length > 0
        ? manualAreas
        : inferInterestAreas(c.title || "", c.company || "", c.sector || "");

    // Map "Relationship Status" to Temperature
    const rawTemp = (c.temperature || "").trim();
    const temperature: Temperature =
      rawTemp === "Council" || rawTemp === "Hot" || rawTemp === "Warm" || rawTemp === "Cold"
        ? rawTemp
        : "Cold";

    // Last activity = most recent Notes timestamp (not Date Added).
    const latestInteractionDate = interactions[0]?.date || "";

    const contact: Contact = {
      // Stable identity: the urid is the id when present, so the client key is
      // stable across edits/reorders. Falls back to the index for unmigrated rows.
      id: c.urid || `c-${idx}`,
      urid: c.urid || undefined,
      name: c.name || "",
      title: c.title || "",
      company: c.company || "",
      email,
      phone: c.phone || "",
      address: "",
      prime: c.prime || "",
      sector: c.sector || "",
      areasOfInterest,
      temperature,
      portCoIntros,
      portCoEngagements,
      eventsAttended: [...new Set(eventsAttended.filter(Boolean))],
      // Invited and attended stay separate — do not invent invites from attendance.
      eventsInvited: [...new Set(eventsInvited.filter(Boolean))],
      interactions,
      lastContact: latestInteractionDate || c.dateAdded || "",
      dateAdded: c.dateAdded || "",
      followUpPending,
      location: c.location || "",
      linkedinUrl: c.linkedinUrl || "",
      contactType: c.contactType || "",
      // Canonical origin — blank/legacy values backfill to "Manual Entry".
      source: normalizeSource(c.source),
      sourceContext: c.sourceContext || "",
      techStack: c.techStack || "",
      apolloEnriched: /^(true|yes|1)$/i.test((c.apolloEnriched || "").trim()),
      apolloEnrichedDate: (c.apolloEnrichedDate || "").trim() || undefined,
    };
    // Attach the live activity score and whether the rating is manually locked.
    // Lock + provenance match on urid first, then any of the contact's emails.
    const emailKey = emailKeys[0] || "";
    contact.activityScore = scoreContact(contact).score;
    contact.ratingLocked =
      (!!uridKey && lockedEmails.has(uridKey)) || emailKeys.some((e) => lockedEmails.has(e));
    let provMerged: Record<string, "user" | "apollo"> | undefined;
    for (const e of emailKeys) {
      const p = provenance.get(e);
      if (p) provMerged = { ...p, ...provMerged };
    }
    const provByUrid = uridKey ? provenance.get(uridKey) : undefined;
    if (provByUrid) provMerged = { ...provMerged, ...provByUrid };
    contact.fieldProvenance = provMerged;
    return contact;
  });
}

// ══════════════════════════════════════════════════════════════
// AUTOMATIC NETWORK SCORECARD
// ══════════════════════════════════════════════════════════════

export interface RatingChange {
  email: string;
  name: string;
  from: string;
  to: string;
  score: number;
}

export interface RecalcResult {
  scanned: number;
  updated: number;
  skippedLocked: number;
  changes: RatingChange[];
}

// Upsert a manual lock row in the Rating Overrides tab. Matched by stable urid
// when available, else email; the urid is stamped so future reads key on it.
async function setRatingOverride(
  email: string,
  urid: string | undefined,
  locked: boolean,
  tier: string,
  timestamp: string,
): Promise<void> {
  await ensureTab(TAB_NAMES.ratingOverrides, RATING_OVERRIDE_HEADERS);
  await ensureColumn(TAB_NAMES.ratingOverrides, "URID");
  const rows = await fetchSheetTab(TAB_NAMES.ratingOverrides);
  const headers = (rows[0] || []).map((h) => h.trim().toLowerCase());
  const emailIdx = headers.indexOf("email");
  const uridIdx = headers.indexOf("urid");
  const target = email.trim().toLowerCase();
  const uridKey = (urid || "").trim().toLowerCase();
  // Header-aware row so it aligns regardless of column order.
  const valueByHeader: Record<string, string> = {
    email,
    locked: locked ? "TRUE" : "FALSE",
    tier,
    updated: timestamp,
    urid: urid || "",
  };
  const newRow = headers.map((h) => valueByHeader[h] ?? "");
  for (let i = 1; i < rows.length; i++) {
    const rowUrid = uridIdx !== -1 ? (rows[i][uridIdx] || "").trim().toLowerCase() : "";
    const rowEmail = emailIdx !== -1 ? (rows[i][emailIdx] || "").trim().toLowerCase() : "";
    const match = (uridKey && rowUrid === uridKey) || (!!target && rowEmail === target);
    if (match) {
      await writeSheetRow(TAB_NAMES.ratingOverrides, i + 1, newRow);
      return;
    }
  }
  await appendSheetRow(TAB_NAMES.ratingOverrides, newRow);
}

// Recompute every unlocked contact's tier from activity, write the changed ones
// back to the Contacts "Relationship Status" column, and log each change.
export async function recalculateRatings(): Promise<RecalcResult> {
  const contacts = await buildContacts();
  const rows = await fetchSheetTab(TAB_NAMES.contacts);
  if (rows.length < 2) return { scanned: 0, updated: 0, skippedLocked: 0, changes: [] };

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const emailIdx = headers.indexOf("email");
  const uridIdx = headers.indexOf("urid");
  const statusIdx = headers.indexOf("relationship status");
  if (emailIdx === -1 || statusIdx === -1) {
    throw new Error("Contacts tab is missing the Email or Relationship Status column");
  }

  // Resolve a contact to its 1-based sheet row by stable urid first, then email.
  const rowByEmail = new Map<string, number>();
  const rowByUrid = new Map<string, number>();
  for (let i = 1; i < rows.length; i++) {
    const e = (rows[i][emailIdx] || "").trim().toLowerCase();
    if (e && !rowByEmail.has(e)) rowByEmail.set(e, i + 1);
    const u = uridIdx !== -1 ? (rows[i][uridIdx] || "").trim().toLowerCase() : "";
    if (u && !rowByUrid.has(u)) rowByUrid.set(u, i + 1);
  }

  const statusCol = colLetters(statusIdx);
  const now = Date.now();
  const ts = new Date().toISOString();
  const cellUpdates: { range: string; value: string }[] = [];
  const historyRows: string[][] = [];
  const changes: RatingChange[] = [];
  let skippedLocked = 0;

  for (const c of contacts) {
    if (c.ratingLocked) {
      skippedLocked++;
      continue;
    }
    const { score, tier, drivers } = scoreContact(c, now);
    if (tier === c.temperature) continue;
    const rowNum =
      (c.urid ? rowByUrid.get(c.urid.toLowerCase()) : undefined) ||
      (c.email ? rowByEmail.get(c.email.toLowerCase()) : undefined);
    if (!rowNum) continue;
    cellUpdates.push({ range: `${statusCol}${rowNum}`, value: tier });
    historyRows.push([
      ts,
      c.email,
      c.name,
      c.temperature,
      tier,
      String(score),
      "auto",
      drivers.join("; "),
    ]);
    changes.push({ email: c.email, name: c.name, from: c.temperature, to: tier, score });
  }

  if (cellUpdates.length > 0) {
    await updateSheetCells(TAB_NAMES.contacts, cellUpdates);
    await ensureTab(TAB_NAMES.ratingHistory, RATING_HISTORY_HEADERS);
    await appendSheetRows(TAB_NAMES.ratingHistory, historyRows);
  }

  return { scanned: contacts.length, updated: changes.length, skippedLocked, changes };
}

// Manually set a contact's rating. This LOCKS the contact so the automatic
// scorecard won't override it, and logs the change.
export async function setContactRating(
  email: string,
  tier: Temperature,
  urid?: string,
): Promise<{ success: boolean }> {
  const rows = await fetchSheetTab(TAB_NAMES.contacts);
  if (rows.length < 2) return { success: false };

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const emailIdx = headers.indexOf("email");
  const uridIdx = headers.indexOf("urid");
  const statusIdx = headers.indexOf("relationship status");
  const nameIdx = headers.indexOf("name");
  if (emailIdx === -1 || statusIdx === -1) {
    throw new Error("Contacts tab is missing the Email or Relationship Status column");
  }

  const target = email.trim().toLowerCase();
  const uridKey = (urid || "").trim().toLowerCase();
  const ts = new Date().toISOString();
  for (let i = 1; i < rows.length; i++) {
    const rowUrid = uridIdx !== -1 ? (rows[i][uridIdx] || "").trim().toLowerCase() : "";
    const rowEmail = (rows[i][emailIdx] || "").trim().toLowerCase();
    const match = (uridKey && rowUrid === uridKey) || (!!target && rowEmail === target);
    if (!match) continue;
    const rowUridVal = uridIdx !== -1 ? rows[i][uridIdx] || "" : "";
    const prev = (rows[i][statusIdx] || "").trim();
    await updateSheetCell(TAB_NAMES.contacts, `${colLetters(statusIdx)}${i + 1}`, tier);
    await setRatingOverride(rows[i][emailIdx] || email, rowUridVal || urid, true, tier, ts);
    await ensureTab(TAB_NAMES.ratingHistory, RATING_HISTORY_HEADERS);
    await appendSheetRow(TAB_NAMES.ratingHistory, [
      ts,
      email,
      nameIdx !== -1 ? rows[i][nameIdx] || "" : "",
      prev,
      tier,
      "",
      "manual",
      "Manual override",
    ]);
    return { success: true };
  }
  return { success: false };
}

// Remove a contact's manual lock so the automatic scorecard governs it again.
export async function clearContactRatingOverride(
  email: string,
  urid?: string,
): Promise<{ success: boolean }> {
  await setRatingOverride(email, urid, false, "", new Date().toISOString());
  return { success: true };
}

// ══════════════════════════════════════════════════════════════
// NON-DESTRUCTIVE CONTACT MERGE (Apollo enrichment + manual edits)
// ══════════════════════════════════════════════════════════════

// Editable contact fields → their Contacts sheet column header.
const MERGE_FIELD_HEADERS: Record<string, string> = {
  name: "name",
  title: "role",
  company: "company",
  email: "email",
  phone: "phone number",
  location: "location",
  linkedinUrl: "linkedin",
  prime: "relationship prime",
  sector: "industry category",
  contactType: "contact type",
  areasOfInterest: "areas of interest",
  source: "source",
  sourceContext: "source context",
  headline: "headline",
  employmentHistory: "employment history",
  techStack: "tech stack",
  apolloEnriched: "apollo enriched",
  apolloEnrichedDate: "apollo enriched date",
};

export interface MergeResult {
  success: boolean;
  written: string[]; // fields actually written
  skipped: string[]; // fields left untouched (protected or unchanged)
}

// Single merge path for both human edits and Apollo enrichment.
//   source "user"   → human intent: writes every provided field, stamps "user".
//   source "apollo" → fill-only & non-destructive: writes a field only when it's
//                     empty, or when it was previously apollo-sourced and the
//                     value changed. Never overwrites a user-edited field, and
//                     never clobbers a non-empty legacy value of unknown origin.
export async function mergeContactFields(
  email: string,
  fields: Record<string, string | undefined>,
  source: "user" | "apollo",
  urid?: string,
): Promise<MergeResult> {
  // A human edit may target a column that doesn't exist on older sheets
  // (e.g. "Contact Type", "Areas of Interest"); create it first. Idempotent.
  // Columns that may not exist on older sheets. Created for both sources so that
  // unattended Apollo enrichment (source "apollo") can also fill Headline /
  // Employment History, which older sheets won't have.
  for (const field of Object.keys(fields)) {
    if (
      (field === "contactType" ||
        field === "areasOfInterest" ||
        field === "source" ||
        field === "sourceContext" ||
        field === "headline" ||
        field === "employmentHistory" ||
        field === "linkedinUrl" ||
        field === "techStack" ||
        field === "apolloEnriched" ||
        field === "apolloEnrichedDate") &&
      fields[field] !== undefined
    ) {
      if (
        source === "user" ||
        field === "headline" ||
        field === "employmentHistory" ||
        field === "techStack" ||
        field === "apolloEnriched" ||
        field === "apolloEnrichedDate"
      ) {
        await ensureColumn(TAB_NAMES.contacts, MERGE_FIELD_HEADERS[field]);
      }
    }
  }

  // A portfolio-company employer always sets sector "Portfolio" (overrides any
  // Apollo-provided industry), mirroring addContactRow.
  if (fields.sector !== undefined && fields.company) {
    const portfolioSector = await resolvePortfolioSector(fields.company);
    if (portfolioSector) fields = { ...fields, sector: portfolioSector };
  }

  // Canonicalize a LinkedIn URL before it's written, so edits + Apollo enrichment
  // store the same normalized form as fresh adds.
  if (fields.linkedinUrl !== undefined) {
    fields = { ...fields, linkedinUrl: normalizeLinkedinUrl(fields.linkedinUrl) };
  }

  const rows = await fetchSheetTab(TAB_NAMES.contacts);
  if (rows.length < 2) return { success: false, written: [], skipped: [] };

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const emailIdx = headers.indexOf("email");
  const uridIdx = headers.indexOf("urid");
  if (emailIdx === -1) throw new Error("Contacts tab is missing the Email column");

  const provenance = await buildFieldProvenance();
  const target = email.trim().toLowerCase();
  const uridKey = (urid || "").trim().toLowerCase();
  // Provenance can live under either key mid-migration; merge so urid (newer) wins.
  const prov = {
    ...(provenance.get(target) || {}),
    ...(uridKey ? provenance.get(uridKey) || {} : {}),
  };
  const ts = new Date().toISOString();

  const written: string[] = [];
  const skipped: string[] = [];

  for (let i = 1; i < rows.length; i++) {
    const rowUrid = uridIdx !== -1 ? (rows[i][uridIdx] || "").trim().toLowerCase() : "";
    const rowEmail = (rows[i][emailIdx] || "").trim().toLowerCase();
    const match = (uridKey && rowUrid === uridKey) || (!!target && rowEmail === target);
    if (!match) continue;
    const rowUridVal = uridIdx !== -1 ? rows[i][uridIdx] || "" : "";

    const cellUpdates: { range: string; value: string }[] = [];
    const provStamps: string[][] = [];

    for (const [field, rawValue] of Object.entries(fields)) {
      if (rawValue === undefined) continue;
      const header = MERGE_FIELD_HEADERS[field];
      const colIdx = header ? headers.indexOf(header) : -1;
      if (colIdx === -1) {
        skipped.push(field);
        continue;
      }
      const value = rawValue;
      const current = (rows[i][colIdx] || "").trim();

      let shouldWrite = false;
      if (source === "user") {
        shouldWrite = true; // human intent always wins
      } else {
        // Apollo: fill-only / non-destructive.
        if (prov[field] === "user")
          shouldWrite = false; // protected
        else if (current === "")
          shouldWrite = true; // fill empty
        else if (prov[field] === "apollo" && current !== value)
          shouldWrite = true; // refresh apollo value
        else shouldWrite = false; // non-empty legacy or unchanged → leave it
      }

      if (!shouldWrite) {
        skipped.push(field);
        continue;
      }
      cellUpdates.push({ range: `${colLetters(colIdx)}${i + 1}`, value });
      // Provenance row: ["Email", "Field", "Source", "Updated", "URID"].
      provStamps.push([rows[i][emailIdx], field, source, ts, rowUridVal || urid || ""]);
      written.push(field);
    }

    if (cellUpdates.length > 0) {
      await updateSheetCells(TAB_NAMES.contacts, cellUpdates);
      await ensureTab(TAB_NAMES.fieldProvenance, FIELD_PROVENANCE_HEADERS);
      await ensureColumn(TAB_NAMES.fieldProvenance, "URID");
      await appendSheetRows(TAB_NAMES.fieldProvenance, provStamps);
    }
    return { success: true, written, skipped };
  }

  return { success: false, written: [], skipped: [] };
}

export interface BulkMergeUpdate {
  email: string;
  urid?: string;
  fields: Record<string, string | undefined>;
}

// Batched multi-contact version of mergeContactFields: reads the Contacts tab
// ONCE, applies the same fill/overwrite semantics per row, and commits every
// change in a single write. Used by the bulk actions (Apollo enrich, interest
// inference, tech-stack load) so N contacts cost ~one sheet read + one write
// instead of N of each. Same rules as mergeContactFields: source "user" always
// writes; "apollo" is fill-only and never clobbers a human-edited field. A
// portfolio-company employer still forces sector "Portfolio".
export async function bulkMergeContactFields(
  updates: BulkMergeUpdate[],
  source: "user" | "apollo",
  // When true, write a field only if the sheet cell is currently empty (never
  // clobber an existing value), while still stamping provenance as `source`.
  // Used to persist auto-inferred values (e.g. interest areas) without
  // overwriting anything a human curated.
  fillEmptyOnly = false,
): Promise<{ updated: number; written: number }> {
  if (updates.length === 0) return { updated: 0, written: 0 };

  // Create any columns that may not exist on older sheets, once up front (must
  // happen before the header row is read below).
  const allFields = new Set<string>();
  for (const u of updates) for (const f of Object.keys(u.fields)) allFields.add(f);
  const ensurable = [
    "contactType",
    "areasOfInterest",
    "source",
    "sourceContext",
    "headline",
    "employmentHistory",
    "techStack",
    "apolloEnriched",
    "apolloEnrichedDate",
  ];
  for (const f of ensurable) {
    if (allFields.has(f)) await ensureColumn(TAB_NAMES.contacts, MERGE_FIELD_HEADERS[f]);
  }

  const rows = await fetchSheetTab(TAB_NAMES.contacts);
  if (rows.length < 2) return { updated: 0, written: 0 };
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const emailIdx = headers.indexOf("email");
  const uridIdx = headers.indexOf("urid");
  if (emailIdx === -1) throw new Error("Contacts tab is missing the Email column");

  // Row lookup maps (stable urid first, then email).
  const rowByEmail = new Map<string, number>();
  const rowByUrid = new Map<string, number>();
  for (let i = 1; i < rows.length; i++) {
    const e = (rows[i][emailIdx] || "").trim().toLowerCase();
    if (e && !rowByEmail.has(e)) rowByEmail.set(e, i);
    const u = uridIdx !== -1 ? (rows[i][uridIdx] || "").trim().toLowerCase() : "";
    if (u && !rowByUrid.has(u)) rowByUrid.set(u, i);
  }

  const provenance = await buildFieldProvenance();
  const ts = new Date().toISOString();
  const cellUpdates: { range: string; value: string }[] = [];
  const provStamps: string[][] = [];
  const changedRows = new Set<number>();

  for (const upd of updates) {
    const emailKey = (upd.email || "").trim().toLowerCase();
    const uridKey = (upd.urid || "").trim().toLowerCase();
    const i =
      (uridKey ? rowByUrid.get(uridKey) : undefined) ??
      (emailKey ? rowByEmail.get(emailKey) : undefined);
    if (i === undefined) continue;

    let fields = upd.fields;
    // Portfolio-company employer forces sector "Portfolio".
    if (fields.sector !== undefined && fields.company) {
      const portfolioSector = await resolvePortfolioSector(fields.company);
      if (portfolioSector) fields = { ...fields, sector: portfolioSector };
    }

    const prov = {
      ...(emailKey ? provenance.get(emailKey) || {} : {}),
      ...(uridKey ? provenance.get(uridKey) || {} : {}),
    };
    const rowUridVal = uridIdx !== -1 ? rows[i][uridIdx] || "" : "";

    for (const [field, rawValue] of Object.entries(fields)) {
      if (rawValue === undefined) continue;
      const header = MERGE_FIELD_HEADERS[field];
      const colIdx = header ? headers.indexOf(header) : -1;
      if (colIdx === -1) continue;
      const value = rawValue;
      const current = (rows[i][colIdx] || "").trim();

      let shouldWrite = false;
      if (fillEmptyOnly) {
        shouldWrite = current === "";
      } else if (source === "user") {
        shouldWrite = true;
      } else if (prov[field] === "user") {
        shouldWrite = false;
      } else if (current === "") {
        shouldWrite = true;
      } else if (prov[field] === "apollo" && current !== value) {
        shouldWrite = true;
      }
      if (!shouldWrite) continue;

      cellUpdates.push({ range: `${colLetters(colIdx)}${i + 1}`, value });
      provStamps.push([rows[i][emailIdx], field, source, ts, rowUridVal || upd.urid || ""]);
      changedRows.add(i);
    }
  }

  if (cellUpdates.length > 0) {
    await updateSheetCells(TAB_NAMES.contacts, cellUpdates);
    await ensureTab(TAB_NAMES.fieldProvenance, FIELD_PROVENANCE_HEADERS);
    await ensureColumn(TAB_NAMES.fieldProvenance, "URID");
    await appendSheetRows(TAB_NAMES.fieldProvenance, provStamps);
  }

  return { updated: changedRows.size, written: cellUpdates.length };
}

// ── Rating transitions (network progression, #9) ─────────────

export interface RatingTransition {
  from: string;
  to: string;
  ts: string; // ISO timestamp from the Rating History row
}

// Read the Rating History tab → individual rating-change events. Used by the
// dashboard to count cold→warm / warm→hot etc. over a window.
export async function buildRatingTransitions(): Promise<RatingTransition[]> {
  const rows = await fetchSheetTab(TAB_NAMES.ratingHistory).catch(() => [] as string[][]);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const prevIdx = headers.indexOf("previous");
  const newIdx = headers.indexOf("new");
  const tsIdx = headers.indexOf("timestamp");
  if (newIdx === -1) return [];
  const out: RatingTransition[] = [];
  for (let i = 1; i < rows.length; i++) {
    const from = (rows[i][prevIdx] ?? "").trim();
    const to = (rows[i][newIdx] ?? "").trim();
    if (!to || from === to) continue;
    out.push({ from: from || "(new)", to, ts: tsIdx !== -1 ? (rows[i][tsIdx] ?? "") : "" });
  }
  return out;
}

// ── Event synopsis (#3) ──────────────────────────────────────

// Read the Event Synopsis tab → { eventNameLower: synopsis }. Latest row wins.
export async function buildEventSynopses(): Promise<Record<string, string>> {
  const rows = await fetchSheetTab(TAB_NAMES.eventSynopsis).catch(() => [] as string[][]);
  const out: Record<string, string> = {};
  if (rows.length < 2) return out;
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const nameIdx = headers.indexOf("event name");
  const synIdx = headers.indexOf("synopsis");
  if (nameIdx === -1 || synIdx === -1) return out;
  for (let i = 1; i < rows.length; i++) {
    const name = (rows[i][nameIdx] || "").trim().toLowerCase();
    if (!name) continue;
    out[name] = rows[i][synIdx] || ""; // later row overwrites earlier
  }
  return out;
}

// Append a synopsis row for an event (last-wins on read).
export async function setEventSynopsis(eventName: string, synopsis: string): Promise<void> {
  await ensureTab(TAB_NAMES.eventSynopsis, EVENT_SYNOPSIS_HEADERS);
  await appendSheetRow(TAB_NAMES.eventSynopsis, [
    eventName.trim(),
    synopsis,
    new Date().toISOString(),
  ]);
}

// ── CSV import: dedup + history ──────────────────────────────

export interface ImportResultInput {
  importId: string;
  filename: string;
  source: string; // "bulk_upload" | "smart_paste"
  totalRows: number;
  imported: number;
  duplicates: number;
  invalid: number;
  enriched: number;
  failed: number;
}

export interface ImportHistoryRow extends Omit<ImportResultInput, "totalRows"> {
  timestamp: string;
  totalRows: number;
}

// Fresh set of existing contact emails (lowercased), read at commit time so a
// re-import in the same session can't double-create rows the client snapshot
// doesn't know about yet (idempotency).
export async function fetchContactEmails(): Promise<string[]> {
  const rows = await fetchSheetTab(TAB_NAMES.contacts).catch(() => [] as string[][]);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const emailIdx = headers.indexOf("email");
  if (emailIdx === -1) return [];
  const out: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    const e = (rows[i][emailIdx] || "").trim().toLowerCase();
    if (e) out.push(e);
  }
  return out;
}

export async function logImportResult(data: ImportResultInput): Promise<void> {
  await ensureTab(TAB_NAMES.importHistory, IMPORT_HISTORY_HEADERS);
  await appendSheetRow(TAB_NAMES.importHistory, [
    data.importId,
    new Date().toISOString(),
    data.filename,
    data.source,
    String(data.totalRows),
    String(data.imported),
    String(data.duplicates),
    String(data.invalid),
    String(data.enriched),
    String(data.failed),
  ]);
  // Also land in the unified Ops Log.
  await logOpsEvent({
    action: "import",
    source: data.source,
    status: data.failed > 0 && data.imported === 0 ? "error" : "ok",
    summary: data.filename ? `Imported from ${data.filename}` : `Imported via ${data.source}`,
    records: data.imported,
    details: {
      importId: data.importId,
      totalRows: data.totalRows,
      duplicates: data.duplicates,
      invalid: data.invalid,
      enriched: data.enriched,
      failed: data.failed,
    },
    items: [
      data.filename ? `file: ${data.filename}` : `source: ${data.source}`,
      `imported=${data.imported}`,
      data.duplicates ? `duplicates=${data.duplicates}` : "",
      data.invalid ? `invalid=${data.invalid}` : "",
      data.enriched ? `enriched=${data.enriched}` : "",
      data.failed ? `failed=${data.failed}` : "",
    ].filter(Boolean),
  });
}

// Recent imports, newest first, for the Import History panel.
export async function buildImportHistory(limit = 25): Promise<ImportHistoryRow[]> {
  const rows = await fetchSheetTab(TAB_NAMES.importHistory).catch(() => [] as string[][]);
  if (rows.length < 2) return [];
  const num = (v: string) => Number(v || "0") || 0;
  const out: ImportHistoryRow[] = rows.slice(1).map((r) => ({
    importId: r[0] || "",
    timestamp: r[1] || "",
    filename: r[2] || "",
    source: r[3] || "",
    totalRows: num(r[4]),
    imported: num(r[5]),
    duplicates: num(r[6]),
    invalid: num(r[7]),
    enriched: num(r[8]),
    failed: num(r[9]),
  }));
  return out.reverse().slice(0, limit);
}

// All logged outreach emails (newest first) — surfaced on Event/PortCo views.
export async function buildEmailActivity(): Promise<EmailActivityRecord[]> {
  const rows = await fetchSheetTab(TAB_NAMES.emailActivity).catch(() => [] as string[][]);
  if (rows.length < 2) return [];
  const out: EmailActivityRecord[] = rows.slice(1).map((r) => ({
    contactEmail: r[0] || "",
    timestamp: r[1] || "",
    subject: r[2] || "",
    type: r[3] || "",
    linkedPortco: r[4] || "",
    linkedEvent: r[5] || "",
  }));
  return out.reverse();
}

// Record a sent email with its type + linked portco/event for activity tracking.
export async function logEmailActivity(data: {
  contactEmail: string;
  subject: string;
  emailType: string;
  linkedPortco?: string;
  linkedEvent?: string;
}): Promise<void> {
  await ensureTab(TAB_NAMES.emailActivity, EMAIL_ACTIVITY_HEADERS);
  await appendSheetRow(TAB_NAMES.emailActivity, [
    data.contactEmail,
    new Date().toISOString(),
    data.subject,
    data.emailType,
    data.linkedPortco || "",
    data.linkedEvent || "",
  ]);
}

// Archive the full Apollo payload so nothing is ever lost (mirrors apollo_raw).
export async function storeApolloRaw(email: string, payload: unknown): Promise<void> {
  await ensureTab(TAB_NAMES.apolloRaw, APOLLO_RAW_HEADERS);
  await appendSheetRow(TAB_NAMES.apolloRaw, [
    email,
    new Date().toISOString(),
    JSON.stringify(payload ?? null),
  ]);
}

// Bulk-edit one profile field across many contacts (matched by email), in a
// single batched write. Setting "status" also locks each contact's rating from
// the automatic scorecard and logs the change, consistent with a manual edit.
const BULK_FIELD_HEADERS: Record<BulkEditField, string> = {
  status: "relationship status",
  location: "location",
  sector: "industry category",
  prime: "relationship prime",
  title: "role",
  company: "company",
  contactType: "contact type",
  areasOfInterest: "areas of interest",
  source: "source",
};

export async function bulkUpdateContacts(
  emails: string[],
  field: BulkEditField,
  value: string,
): Promise<{ updated: number }> {
  const header = BULK_FIELD_HEADERS[field];
  if (!header) throw new Error(`Unsupported bulk-edit field: ${field}`);

  // Make sure the target column exists (e.g. "Contact Type" on older sheets).
  // Idempotent — a no-op when the column is already present.
  await ensureColumn(TAB_NAMES.contacts, header);

  const rows = await fetchSheetTab(TAB_NAMES.contacts);
  if (rows.length < 2) return { updated: 0 };

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const emailIdx = headers.indexOf("email");
  const uridIdx = headers.indexOf("urid");
  const colIdx = headers.indexOf(header);
  const nameIdx = headers.indexOf("name");
  if (emailIdx === -1 || colIdx === -1) {
    throw new Error(`Contacts tab is missing the Email or "${header}" column`);
  }

  const wanted = new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const col = colLetters(colIdx);
  const ts = new Date().toISOString();
  const cellUpdates: { range: string; value: string }[] = [];
  const overrideRows: string[][] = [];
  const historyRows: string[][] = [];

  for (let i = 1; i < rows.length; i++) {
    const e = (rows[i][emailIdx] || "").trim().toLowerCase();
    if (!wanted.has(e)) continue;
    const prev = (rows[i][colIdx] || "").trim();
    cellUpdates.push({ range: `${col}${i + 1}`, value });
    if (field === "status") {
      const name = nameIdx !== -1 ? rows[i][nameIdx] || "" : "";
      const rowUrid = uridIdx !== -1 ? rows[i][uridIdx] || "" : "";
      // Override row: ["Email", "Locked", "Tier", "Updated", "URID"].
      overrideRows.push([rows[i][emailIdx], "TRUE", value, ts, rowUrid]);
      historyRows.push([
        ts,
        rows[i][emailIdx],
        name,
        prev,
        value,
        "",
        "manual",
        "Bulk manual override",
      ]);
    }
  }

  if (cellUpdates.length === 0) return { updated: 0 };
  await updateSheetCells(TAB_NAMES.contacts, cellUpdates);

  // Setting status by hand locks those contacts from the auto-scorecard.
  if (field === "status" && overrideRows.length > 0) {
    await ensureTab(TAB_NAMES.ratingOverrides, RATING_OVERRIDE_HEADERS);
    await ensureColumn(TAB_NAMES.ratingOverrides, "URID");
    await appendSheetRows(TAB_NAMES.ratingOverrides, overrideRows);
    await ensureTab(TAB_NAMES.ratingHistory, RATING_HISTORY_HEADERS);
    await appendSheetRows(TAB_NAMES.ratingHistory, historyRows);
  }

  return { updated: cellUpdates.length };
}

// Read the Target Outreach tab → { targetKey: OutreachAttempt[] } (newest first).
async function buildTargetOutreachMap(): Promise<Record<string, OutreachAttempt[]>> {
  const rows = await fetchSheetTab(TAB_NAMES.targetOutreach).catch(() => [] as string[][]);
  const out: Record<string, OutreachAttempt[]> = {};
  if (rows.length < 2) return out;
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const keyIdx = headers.indexOf("target key");
  const uridIdx = headers.indexOf("target urid");
  const dateIdx = headers.indexOf("date");
  const methodIdx = headers.indexOf("method");
  const summaryIdx = headers.indexOf("summary");
  const idIdx = headers.indexOf("id");
  if (keyIdx === -1 && uridIdx === -1) return out;
  for (let i = 1; i < rows.length; i++) {
    // Prefer the stable target urid; fall back to the legacy target key.
    const urid = uridIdx !== -1 ? (rows[i][uridIdx] || "").trim().toLowerCase() : "";
    const key = urid || (keyIdx !== -1 ? (rows[i][keyIdx] || "").trim().toLowerCase() : "");
    if (!key) continue;
    const attempt: OutreachAttempt = {
      id: (idIdx !== -1 ? rows[i][idIdx] : "") || `o-${i}`,
      date: (dateIdx !== -1 ? rows[i][dateIdx] : "") || "",
      method: (methodIdx !== -1 ? rows[i][methodIdx] : "") || "Note",
      summary: (summaryIdx !== -1 ? rows[i][summaryIdx] : "") || "",
    };
    (out[key] ||= []).push(attempt);
  }
  // Newest first within each target.
  for (const key of Object.keys(out)) {
    out[key].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }
  return out;
}

// Read the Target Strategy tab → { targetKey: ConnectionPlan } (latest row wins).
async function buildTargetStrategyMap(): Promise<Record<string, ConnectionPlan>> {
  const rows = await fetchSheetTab(TAB_NAMES.targetStrategy).catch(() => [] as string[][]);
  const out: Record<string, ConnectionPlan> = {};
  if (rows.length < 2) return out;
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const keyIdx = headers.indexOf("target key");
  const uridIdx = headers.indexOf("target urid");
  const planIdx = headers.indexOf("plan json");
  const updIdx = headers.indexOf("updated");
  if (planIdx === -1 || (keyIdx === -1 && uridIdx === -1)) return out;
  for (let i = 1; i < rows.length; i++) {
    // Prefer the stable target urid; fall back to the legacy target key.
    const urid = uridIdx !== -1 ? (rows[i][uridIdx] || "").trim().toLowerCase() : "";
    const key = urid || (keyIdx !== -1 ? (rows[i][keyIdx] || "").trim().toLowerCase() : "");
    if (!key) continue;
    try {
      const plan = JSON.parse(rows[i][planIdx] || "{}") as ConnectionPlan;
      if (updIdx !== -1 && rows[i][updIdx]) plan.savedAt = rows[i][updIdx];
      out[key] = plan; // later row overwrites earlier
    } catch {
      /* skip malformed row */
    }
  }
  return out;
}

// Append one outreach attempt for a target (persisted to the Target Outreach tab).
// Updatable TargetLead field → Targets sheet column header (lowercased).
// "name" is handled separately (split across First/Last Name).
const TARGET_UPDATE_HEADERS: Record<string, string> = {
  title: "role",
  company: "company",
  email: "email",
  phone: "phone",
  location: "location",
  linkedinUrl: "linkedin",
  sector: "sector",
  stage: "stage",
  originSource: "source",
  notes: "research purpose",
};

// Update a target's row in the Targets tab, located by its stable key (email, or
// name|company). Writes only the provided fields, matched by header name so it's
// robust to column order. Returns whether a matching row was found and written.
export async function updateTargetFields(
  targetKey: string,
  fields: Record<string, string | undefined>,
  urid?: string,
): Promise<{ success: boolean }> {
  const key = (targetKey || "").trim().toLowerCase();
  const uridKey = (urid || "").trim().toLowerCase();
  if (!key && !uridKey) return { success: false };

  // Canonicalize a LinkedIn URL before writing (parity with contact writes).
  if (fields.linkedinUrl !== undefined) {
    fields = { ...fields, linkedinUrl: normalizeLinkedinUrl(fields.linkedinUrl) };
  }

  // Ensure columns that may not exist on older sheets (e.g. "Phone").
  if (fields.phone !== undefined) await ensureColumn(TAB_NAMES.targets, "Phone");

  const rows = await fetchSheetTab(TAB_NAMES.targets);
  if (rows.length < 2) return { success: false };

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const uridIdx = headers.indexOf("urid");
  const firstIdx = headers.indexOf("first name");
  const lastIdx = headers.indexOf("last name");
  const companyIdx = headers.indexOf("company");
  const emailIdx = headers.indexOf("email");

  // Locate by stable urid first (so editing email/name/company can't lose the
  // row), then fall back to the derived target key.
  let rowNum = -1;
  for (let i = 1; i < rows.length; i++) {
    const rowUrid = uridIdx !== -1 ? (rows[i][uridIdx] || "").trim().toLowerCase() : "";
    if (uridKey && rowUrid === uridKey) {
      rowNum = i + 1;
      break;
    }
    if (!uridKey) {
      const email = (emailIdx !== -1 ? rows[i][emailIdx] : "") || "";
      const name = [
        firstIdx !== -1 ? rows[i][firstIdx] || "" : "",
        lastIdx !== -1 ? rows[i][lastIdx] || "" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const company = (companyIdx !== -1 ? rows[i][companyIdx] : "") || "";
      if (targetKeyOf({ email, name, company }) === key) {
        rowNum = i + 1;
        break;
      }
    }
  }
  if (rowNum === -1) return { success: false };

  const updates: { range: string; value: string }[] = [];

  // Name → split across First Name / Last Name.
  if (fields.name !== undefined) {
    const parts = fields.name.trim().split(/\s+/).filter(Boolean);
    const first = parts[0] || "";
    const last = parts.slice(1).join(" ");
    if (firstIdx !== -1) updates.push({ range: `${colLetters(firstIdx)}${rowNum}`, value: first });
    if (lastIdx !== -1) updates.push({ range: `${colLetters(lastIdx)}${rowNum}`, value: last });
  }

  for (const [field, header] of Object.entries(TARGET_UPDATE_HEADERS)) {
    const val = fields[field];
    if (val === undefined) continue;
    const idx = headers.indexOf(header);
    if (idx === -1) continue;
    updates.push({ range: `${colLetters(idx)}${rowNum}`, value: val });
  }

  if (updates.length === 0) return { success: false };
  await updateSheetCells(TAB_NAMES.targets, updates);
  return { success: true };
}

// One target's fields to write, located by stable URID (preferred) or derived key.
export interface TargetFieldUpdate {
  key?: string;
  urid?: string;
  fields: Record<string, string | undefined>;
}

// Batch-update many target rows in ONE sheet read + ONE cell-batch write. Rows are
// located by URID (preferred) then derived target key. With opts.fillOnly the write
// is non-destructive — a field is written only where the target's current cell is
// blank (used by Apollo bulk-research so enrichment never clobbers curated data);
// otherwise provided fields overwrite (used by bulk stage-set / field-set).
export async function bulkUpdateTargetFields(
  entries: TargetFieldUpdate[],
  opts: { fillOnly?: boolean } = {},
): Promise<{ updated: number }> {
  const valid = entries.filter(
    (e) => (e.urid?.trim() || e.key?.trim()) && e.fields && Object.keys(e.fields).length > 0,
  );
  if (valid.length === 0) return { updated: 0 };

  if (valid.some((e) => e.fields.phone !== undefined)) {
    await ensureColumn(TAB_NAMES.targets, "Phone");
  }

  const rows = await fetchSheetTab(TAB_NAMES.targets);
  if (rows.length < 2) return { updated: 0 };

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const uridIdx = headers.indexOf("urid");
  const firstIdx = headers.indexOf("first name");
  const lastIdx = headers.indexOf("last name");
  const companyIdx = headers.indexOf("company");
  const emailIdx = headers.indexOf("email");

  // One pass to index every data row by URID and by derived key (first wins).
  const uridToRow = new Map<string, number>();
  const keyToRow = new Map<string, number>();
  for (let i = 1; i < rows.length; i++) {
    if (uridIdx !== -1) {
      const u = (rows[i][uridIdx] || "").trim().toLowerCase();
      if (u && !uridToRow.has(u)) uridToRow.set(u, i + 1);
    }
    const email = (emailIdx !== -1 ? rows[i][emailIdx] : "") || "";
    const name = [
      firstIdx !== -1 ? rows[i][firstIdx] || "" : "",
      lastIdx !== -1 ? rows[i][lastIdx] || "" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const company = (companyIdx !== -1 ? rows[i][companyIdx] : "") || "";
    const k = targetKeyOf({ email, name, company });
    if (k && !keyToRow.has(k)) keyToRow.set(k, i + 1);
  }

  const updates: { range: string; value: string }[] = [];
  const usedRows = new Set<number>();
  let updated = 0;

  for (const entry of valid) {
    const uridKey = (entry.urid || "").trim().toLowerCase();
    const key = (entry.key || "").trim().toLowerCase();
    let rowNum = -1;
    if (uridKey && uridToRow.has(uridKey)) rowNum = uridToRow.get(uridKey)!;
    else if (key && keyToRow.has(key)) rowNum = keyToRow.get(key)!;
    // Skip rows we can't find, and never write the same row twice in one batch.
    if (rowNum === -1 || usedRows.has(rowNum)) continue;
    usedRows.add(rowNum);

    const cell = (idx: number) => (rows[rowNum - 1][idx] || "").trim();
    let wrote = false;

    // Name → First/Last, respecting fill-only per sub-cell.
    if (entry.fields.name !== undefined) {
      const parts = entry.fields.name.trim().split(/\s+/).filter(Boolean);
      if (firstIdx !== -1 && !(opts.fillOnly && cell(firstIdx))) {
        updates.push({ range: `${colLetters(firstIdx)}${rowNum}`, value: parts[0] || "" });
        wrote = true;
      }
      if (lastIdx !== -1 && !(opts.fillOnly && cell(lastIdx))) {
        updates.push({ range: `${colLetters(lastIdx)}${rowNum}`, value: parts.slice(1).join(" ") });
        wrote = true;
      }
    }

    for (const [field, header] of Object.entries(TARGET_UPDATE_HEADERS)) {
      let val = entry.fields[field];
      if (val === undefined) continue;
      if (field === "linkedinUrl") val = normalizeLinkedinUrl(val);
      const idx = headers.indexOf(header);
      if (idx === -1) continue;
      if (opts.fillOnly && cell(idx)) continue; // don't overwrite curated data
      updates.push({ range: `${colLetters(idx)}${rowNum}`, value: val });
      wrote = true;
    }

    if (wrote) updated++;
  }

  if (updates.length === 0) return { updated: 0 };
  await updateSheetCells(TAB_NAMES.targets, updates);
  return { updated };
}

// Physically delete rows from a tab by their 1-based sheet row numbers. Issues a
// single batchUpdate of deleteDimension requests, sorted DESCENDING so earlier
// deletions don't shift the indices of later ones. Best-effort: no-op if the tab's
// sheetId can't be resolved. Invalidates the cache so the next read is fresh.
export async function deleteSheetRows(tabName: string, rowNumbers: number[]): Promise<number> {
  const rows = [...new Set(rowNumbers)].filter((n) => n >= 2).sort((a, b) => b - a);
  if (rows.length === 0) return 0;
  const sheetId = await getSheetId(tabName);
  if (sheetId == null) throw new Error(`Could not resolve sheetId for tab "${tabName}"`);
  const spreadsheetId = requireSpreadsheetId();
  const token = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: rows.map((n) => ({
        deleteDimension: {
          // rowNumber is 1-based; deleteDimension uses 0-based, end-exclusive.
          range: { sheetId, dimension: "ROWS", startIndex: n - 1, endIndex: n },
        },
      })),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets deleteDimension error for "${tabName}" [${res.status}]: ${body}`);
  }
  cache.delete(tabName);
  return rows.length;
}

// Hard-delete contacts from the Contacts tab, matched by email (case-insensitive).
export async function bulkDeleteContacts(emails: string[]): Promise<{ deleted: number }> {
  const wanted = new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return { deleted: 0 };

  const rows = await fetchSheetTab(TAB_NAMES.contacts);
  if (rows.length < 2) return { deleted: 0 };
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const emailIdx = headers.indexOf("email");
  if (emailIdx === -1) throw new Error("Contacts tab is missing the Email column");

  const rowNumbers: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const e = (rows[i][emailIdx] || "").trim().toLowerCase();
    if (e && wanted.has(e)) rowNumbers.push(i + 1);
  }
  const deleted = await deleteSheetRows(TAB_NAMES.contacts, rowNumbers);
  return { deleted };
}

// Hard-delete targets from the Targets tab. Each entry is matched by stable URID
// first (survives edits), falling back to the derived target key.
export async function bulkDeleteTargets(
  entries: { key?: string; urid?: string }[],
): Promise<{ deleted: number }> {
  const wantedUrids = new Set(
    entries.map((e) => (e.urid || "").trim().toLowerCase()).filter(Boolean),
  );
  const wantedKeys = new Set(
    entries.map((e) => (e.key || "").trim().toLowerCase()).filter(Boolean),
  );
  if (wantedUrids.size === 0 && wantedKeys.size === 0) return { deleted: 0 };

  const rows = await fetchSheetTab(TAB_NAMES.targets);
  if (rows.length < 2) return { deleted: 0 };
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const uridIdx = headers.indexOf("urid");
  const firstIdx = headers.indexOf("first name");
  const lastIdx = headers.indexOf("last name");
  const companyIdx = headers.indexOf("company");
  const emailIdx = headers.indexOf("email");

  const rowNumbers: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const rowUrid = uridIdx !== -1 ? (rows[i][uridIdx] || "").trim().toLowerCase() : "";
    if (rowUrid && wantedUrids.has(rowUrid)) {
      rowNumbers.push(i + 1);
      continue;
    }
    if (wantedKeys.size > 0) {
      const email = (emailIdx !== -1 ? rows[i][emailIdx] : "") || "";
      const name = [
        firstIdx !== -1 ? rows[i][firstIdx] || "" : "",
        lastIdx !== -1 ? rows[i][lastIdx] || "" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const company = (companyIdx !== -1 ? rows[i][companyIdx] : "") || "";
      if (wantedKeys.has(targetKeyOf({ email, name, company }).toLowerCase())) {
        rowNumbers.push(i + 1);
      }
    }
  }
  const deleted = await deleteSheetRows(TAB_NAMES.targets, rowNumbers);
  return { deleted };
}

export interface PortfolioCompanyInput {
  name: string;
  website?: string;
  /** Maps to the "Focus Area(s)" column (drives the derived domain). */
  focusArea?: string;
  /** Maps to the "HQ" column. */
  location?: string;
  /** Maps to the "Summary" column. */
  description?: string;
}

// Add a portfolio company as a new row in the Portfolio Companies tab. Stamps a
// stable URID (so it can later be edited/deleted by key), and writes fields
// header-aware so it works whatever column order the sheet actually uses.
export async function addPortfolioCompany(data: PortfolioCompanyInput): Promise<{ urid: string }> {
  const name = data.name.trim();
  if (!name) throw new Error("Company name is required");

  await ensureTab(TAB_NAMES.portfolio, PORTFOLIO_HEADERS);
  await ensureColumn(TAB_NAMES.portfolio, "URID");

  const urid = crypto.randomUUID();
  // Keys are the lowercased sheet headers (see PORTFOLIO_COLS).
  const valueByHeader: Record<string, string> = {
    urid,
    "company name": name,
    website: (data.website || "").trim(),
    "focus area(s)": (data.focusArea || "").trim(),
    hq: (data.location || "").trim(),
    summary: (data.description || "").trim(),
  };

  const rows = await fetchSheetTab(TAB_NAMES.portfolio);
  const headers = (rows[0] || []).map((h) => h.trim().toLowerCase());
  if (headers.length === 0) {
    // Brand-new tab — write in PORTFOLIO_HEADERS order.
    await appendSheetRow(TAB_NAMES.portfolio, [
      urid,
      name,
      valueByHeader.website,
      valueByHeader["focus area(s)"],
      valueByHeader.hq,
      valueByHeader.summary,
    ]);
  } else {
    await appendSheetRow(
      TAB_NAMES.portfolio,
      headers.map((h) => valueByHeader[h] ?? ""),
    );
  }
  return { urid };
}

// Hard-delete a portfolio company from the Portfolio Companies tab. Matched by
// stable URID when given (survives edits); otherwise falls back to an exact
// (case-insensitive) company-name match. Name fallback is skipped when a URID was
// supplied but didn't match, so a stale URID can never nuke a same-named row.
export async function deletePortfolioCompany(entry: {
  urid?: string;
  name?: string;
}): Promise<{ deleted: number }> {
  const wantUrid = (entry.urid || "").trim().toLowerCase();
  const wantName = (entry.name || "").trim().toLowerCase();
  if (!wantUrid && !wantName) return { deleted: 0 };

  const rows = await fetchSheetTab(TAB_NAMES.portfolio);
  if (rows.length < 2) return { deleted: 0 };
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const uridIdx = headers.indexOf("urid");
  const nameIdx = headers.indexOf("company name");

  const rowNumbers: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const rowUrid = uridIdx !== -1 ? (rows[i][uridIdx] || "").trim().toLowerCase() : "";
    if (wantUrid && rowUrid && rowUrid === wantUrid) {
      rowNumbers.push(i + 1);
      continue;
    }
    // Name fallback only for rows without a URID we were asked to match on.
    if (!wantUrid && wantName && nameIdx !== -1) {
      const rowName = (rows[i][nameIdx] || "").trim().toLowerCase();
      if (rowName && rowName === wantName) rowNumbers.push(i + 1);
    }
  }
  const deleted = await deleteSheetRows(TAB_NAMES.portfolio, rowNumbers);
  return { deleted };
}

export async function appendTargetOutreach(
  targetKey: string,
  attempt: { date: string; method: string; summary: string; id: string },
  urid?: string,
): Promise<void> {
  await ensureTab(TAB_NAMES.targetOutreach, TARGET_OUTREACH_HEADERS);
  await ensureColumn(TAB_NAMES.targetOutreach, "Target URID");
  // Row: ["Target Key", "Date", "Method", "Summary", "ID", "Target URID"].
  await appendSheetRow(TAB_NAMES.targetOutreach, [
    targetKey.trim().toLowerCase(),
    attempt.date,
    attempt.method,
    attempt.summary,
    attempt.id,
    (urid || "").trim().toLowerCase(),
  ]);
}

// Save (append, last-wins) the latest AI connection plan for a target.
export async function saveTargetStrategy(
  targetKey: string,
  plan: ConnectionPlan,
  urid?: string,
): Promise<string> {
  await ensureTab(TAB_NAMES.targetStrategy, TARGET_STRATEGY_HEADERS);
  await ensureColumn(TAB_NAMES.targetStrategy, "Target URID");
  const updated = new Date().toISOString();
  // Row: ["Target Key", "Plan JSON", "Updated", "Target URID"].
  await appendSheetRow(TAB_NAMES.targetStrategy, [
    targetKey.trim().toLowerCase(),
    JSON.stringify(plan),
    updated,
    (urid || "").trim().toLowerCase(),
  ]);
  return updated;
}

export async function buildTargets(): Promise<TargetLead[]> {
  const [targetRows, outreachMap, strategyMap] = await Promise.all([
    fetchSheetTab(TAB_NAMES.targets),
    buildTargetOutreachMap(),
    buildTargetStrategyMap(),
  ]);
  const rawTargets = mapRows<Record<string, string>>(targetRows, TARGET_COLS);

  // Guarantee a unique client id per row even when the sheet has blank or
  // duplicated URIDs (legacy rows, manual copy-paste). repairTargetUrids fixes the
  // sheet itself; this keeps the UI correct until then — no colliding React keys
  // and no selection that spans two rows. urid is left as-is so writes still key
  // on the real value.
  const seenIds = new Set<string>();

  return rawTargets.map((t, idx) => {
    const firstName = t.firstName || "";
    const lastName = t.lastName || "";
    const name = [firstName, lastName].filter(Boolean).join(" ");
    // Outreach/strategy join on the stable urid first, then the legacy derived
    // key (email else name|company), so editing those fields can't detach them.
    const legacyKey = targetKeyOf({ email: t.email, name, company: t.company });
    const uridKey = (t.urid || "").trim().toLowerCase();
    const outreach = [
      ...(uridKey ? outreachMap[uridKey] || [] : []),
      ...(outreachMap[legacyKey] || []),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    const connectionPlan = (uridKey ? strategyMap[uridKey] : undefined) || strategyMap[legacyKey];

    let id = (t.urid || "").trim() || `t-${idx}`;
    if (seenIds.has(id)) id = `${id}-${idx}`;
    seenIds.add(id);

    return {
      id,
      urid: t.urid || undefined,
      name,
      title: t.role || "",
      company: t.company || "",
      linkedinUrl: t.linkedinUrl || "",
      email: t.email || "",
      phone: t.phone || "",
      location: t.location || "",
      sector: t.sector || "",
      stage: (t.stage || "Prospecting") as PipelineStage,
      // Constrain the free-text "Source" column to the canonical enum on read
      // (legacy values like "Customer Discovery — Acme" → "Customer Discovery").
      originSource: normalizeSource(t.originSource),
      reasonSurfaced: t.reasonSurfaced || "",
      dateAdded: t.dateAdded || "",
      outreach,
      notes: t.researchPurpose || "",
      connectionPlan,
    };
  });
}

/**
 * Fill blank Portfolio Companies cells for a named company. Never overwrites
 * existing sheet values. Keys map to sheet columns: website, hq (location),
 * summary (description), focus area(s) (domain).
 * Returns the sheet column labels that were written.
 */
export async function fillBlankPortfolioFields(
  companyName: string,
  fields: {
    website?: string;
    location?: string;
    description?: string;
    domain?: string;
  },
): Promise<string[]> {
  const target = companyName.trim().toLowerCase();
  if (!target) return [];

  const rows = await fetchSheetTab(TAB_NAMES.portfolio).catch(() => [] as string[][]);
  if (rows.length < 2) return [];
  const headers = (rows[0] || []).map((h) => (h || "").trim().toLowerCase());
  const nameIdx = headers.findIndex((h) => h === "company name" || h === "name");
  if (nameIdx === -1) return [];

  const colFor: Record<string, string> = {
    website: "website",
    location: "hq",
    description: "summary",
    domain: "focus area(s)",
  };
  const proposed: Record<string, string> = {};
  if (fields.website?.trim()) proposed.website = fields.website.trim();
  if (fields.location?.trim()) proposed.location = fields.location.trim();
  if (fields.description?.trim()) proposed.description = fields.description.trim();
  if (fields.domain?.trim()) proposed.domain = fields.domain.trim();

  let rowNumber = -1; // 1-based sheet row
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][nameIdx] || "").trim().toLowerCase() === target) {
      rowNumber = i + 1;
      break;
    }
  }
  if (rowNumber === -1) return []; // Asana-only portcos have no sheet row

  const updates: { range: string; value: string }[] = [];
  const written: string[] = [];
  for (const [key, value] of Object.entries(proposed)) {
    const headerName = colFor[key];
    const colIdx = headers.indexOf(headerName);
    if (colIdx === -1) continue;
    const existing = (rows[rowNumber - 1][colIdx] || "").trim();
    if (existing) continue;
    updates.push({ range: `${colLetters(colIdx)}${rowNumber}`, value });
    written.push(headerName);
  }
  if (updates.length > 0) await updateSheetCells(TAB_NAMES.portfolio, updates);
  return written;
}

export async function buildPortfolioCompanies(): Promise<PortfolioCompany[]> {
  const companyRows = await fetchSheetTab(TAB_NAMES.portfolio);
  const rawCompanies = mapRows<Record<string, string>>(companyRows, PORTFOLIO_COLS);

  return rawCompanies.map((c, idx) => {
    const name = c.name || "";

    // Parse Focus Area(s) as domain — map to closest PortfolioDomain
    const rawDomain = (c.domain || "").trim();
    const domainMap: Record<string, PortfolioDomain> = {
      security: "Security",
      ai: "AI",
      "artificial intelligence": "AI",
      data: "Data",
      cloud: "Cloud",
      infrastructure: "Cloud",
      logistics: "Logistics",
      "supply chain": "Supply Chain",
      silicon: "Silicon",
      "developer tools": "Cloud",
    };
    // Check each focus area keyword
    const domainLower = rawDomain.toLowerCase();
    let domain: PortfolioDomain = "Cloud";
    for (const [keyword, mapped] of Object.entries(domainMap)) {
      if (domainLower.includes(keyword)) {
        domain = mapped;
        break;
      }
    }

    return {
      id: c.urid || `pc-${idx}`,
      urid: c.urid || undefined,
      name,
      sector: rawDomain,
      domain,
      website: c.website || "",
      linkedinUrl: "",
      location: c.location || "",
      description: c.description || "",
      contactName: "",
      contactEmail: "",
      contactPhone: "",
      employees: [],
      events: [],
      introductions: [],
    };
  });
}

// ── App-added events (stored in the Sheet, NEVER written to Asana) ──
// Returns the same AsanaEvent shape so they merge seamlessly with the
// Asana-sourced events on the Events page. gids are prefixed "app-" so the
// UI can mark them as locally added.
const APP_EVENT_COLS: Record<string, string> = {
  name: "name",
  date: "date",
  status: "status",
  type: "type",
  lead: "lead",
  format: "format",
  role: "role",
  sectors: "sectors",
  portcos: "portcos",
};

function splitList(v: string): string[] {
  return (v || "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** First usable address from a multi-email Contacts cell. */
export function primarySheetEmail(email: string): string {
  return (email || "").split(/[;,]/)[0]?.trim() || "";
}

/** Strip Gmail calendar prefix noise from an invitation subject. */
export function cleanCalendarEventName(subject: string): string {
  const cleaned = (subject || "")
    .replace(/^(updated\s+)?invitation:\s*/i, "")
    .replace(/^accepted:\s*/i, "")
    .replace(/^tentative:\s*/i, "")
    .replace(/^declined:\s*/i, "")
    .replace(/^canceled?\s+event:\s*/i, "")
    .replace(/^cancelled\s+event:\s*/i, "")
    .trim();
  return cleaned || (subject || "").trim();
}

const EVENT_ATTENDANCE_HEADERS = ["Contact Email", "Event Name", "Date", "Type"];
const CATALOG_EVENT_TYPES = new Set(["conference", "dinner", "webinar", "meeting"]);

export interface EventAttendanceInput {
  email: string;
  eventName: string;
  date?: string;
  type?: "attended" | "invited";
  urid?: string;
  /** Also ensure an App Events catalog row (default true). */
  ensureCatalog?: boolean;
  catalogType?: string;
}

export interface EventAttendanceWriteResult {
  attendanceWritten: number;
  catalogWritten: number;
  skipped: number;
}

/**
 * Idempotent Events-tab attendance (+ optional App Events catalog) writes.
 * Dedupes on lowercased `email|eventName`. Used by Gmail calendar sync, email
 * send close-the-loop, Notes backfill, and manual addEvent.
 */
export async function ensureEventAttendanceBatch(
  items: EventAttendanceInput[],
): Promise<EventAttendanceWriteResult> {
  if (items.length === 0) {
    return { attendanceWritten: 0, catalogWritten: 0, skipped: 0 };
  }

  const today = new Date().toISOString().slice(0, 10);
  const isIso = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

  await ensureTab(TAB_NAMES.events, EVENT_ATTENDANCE_HEADERS);
  if (items.some((i) => i.urid)) await ensureColumn(TAB_NAMES.events, "Contact URID");

  const existingAttendance = new Set<string>();
  const evRows = await fetchSheetTab(TAB_NAMES.events).catch(() => [] as string[][]);
  if (evRows.length > 1) {
    const hdr = evRows[0].map((h) => (h || "").trim().toLowerCase());
    const emailIdx = hdr.indexOf("contact email") >= 0 ? hdr.indexOf("contact email") : 0;
    const nameIdx = hdr.indexOf("event name") >= 0 ? hdr.indexOf("event name") : 1;
    for (const r of evRows.slice(1)) {
      const em = (r[emailIdx] || "").trim().toLowerCase();
      const nm = (r[nameIdx] || "").trim().toLowerCase();
      if (em && nm) existingAttendance.add(`${em}|${nm}`);
    }
  }

  const existingCatalog = new Set(
    (await buildAppEvents().catch(() => [] as AsanaEvent[])).map((e) =>
      e.name.trim().toLowerCase(),
    ),
  );

  const attendancePending: {
    email: string;
    eventName: string;
    date: string;
    type: string;
    urid?: string;
  }[] = [];
  const catalogRows: string[][] = [];
  let skipped = 0;

  for (const item of items) {
    const email = primarySheetEmail(item.email);
    const eventName = (item.eventName || "").trim();
    if (!email.includes("@") || !eventName) {
      skipped++;
      continue;
    }
    const nameKey = eventName.toLowerCase();
    const pairKey = `${email.toLowerCase()}|${nameKey}`;
    const date = isIso(item.date) ? item.date! : today;
    const linkType: "attended" | "invited" =
      item.type || (isIso(item.date) && item.date! > today ? "invited" : "attended");

    if (item.ensureCatalog !== false && !existingCatalog.has(nameKey)) {
      const typeRaw = (item.catalogType || "meeting").toLowerCase();
      const catalogType = CATALOG_EVENT_TYPES.has(typeRaw) ? typeRaw : "meeting";
      // APP_EVENT_HEADERS: Name, Date, Status, Type, Lead, Format, Role, Sectors, PortCos
      catalogRows.push([eventName, date, "", catalogType, "", "", "", "", ""]);
      existingCatalog.add(nameKey);
    }

    if (existingAttendance.has(pairKey)) {
      skipped++;
      continue;
    }
    existingAttendance.add(pairKey);
    attendancePending.push({
      email,
      eventName,
      date,
      type: linkType,
      urid: item.urid,
    });
  }

  if (catalogRows.length) {
    await ensureTab(TAB_NAMES.appEvents, APP_EVENT_HEADERS);
    await appendSheetRows(TAB_NAMES.appEvents, catalogRows);
  }

  if (attendancePending.length) {
    const sheetRows = await fetchSheetTab(TAB_NAMES.events).catch(() => [] as string[][]);
    const headers = (sheetRows[0] || []).map((h) => h.trim().toLowerCase());
    const values = attendancePending.map((r) => {
      const byHeader: Record<string, string> = {
        "contact urid": r.urid ?? "",
        "contact email": r.email,
        "event name": r.eventName,
        date: r.date,
        type: r.type,
      };
      return headers.length
        ? headers.map((h) => byHeader[h] ?? "")
        : [r.email, r.eventName, r.date, r.type];
    });
    await appendSheetRows(TAB_NAMES.events, values);
  }

  return {
    attendanceWritten: attendancePending.length,
    catalogWritten: catalogRows.length,
    skipped,
  };
}

/**
 * Backfill Events attendance from Notes already shaped as calendar meetings or
 * `[Event: …]` email tags. Idempotent via email|event dedupe.
 */
export async function shipNotesToEventAttendance(): Promise<EventAttendanceWriteResult> {
  const rows = await fetchSheetTab(TAB_NAMES.interactions).catch(() => [] as string[][]);
  if (rows.length < 2) return { attendanceWritten: 0, catalogWritten: 0, skipped: 0 };

  const hdr = rows[0].map((h) => (h || "").trim().toLowerCase());
  const emailIdx = hdr.indexOf("contact email");
  const dateIdx = hdr.indexOf("timestamp");
  const summaryIdx = hdr.indexOf("note content");
  const typeIdx = hdr.indexOf("type");
  const uridIdx = hdr.indexOf("contact urid");
  if (emailIdx < 0 || summaryIdx < 0) {
    return { attendanceWritten: 0, catalogWritten: 0, skipped: 0 };
  }

  const items: EventAttendanceInput[] = [];
  const seen = new Set<string>();

  for (const row of rows.slice(1)) {
    const email = primarySheetEmail(row[emailIdx] || "");
    const summary = (row[summaryIdx] || "").trim();
    const type = (typeIdx >= 0 ? row[typeIdx] || "" : "").trim().toLowerCase();
    const date = dateIdx >= 0 ? (row[dateIdx] || "").trim() : "";
    const urid = uridIdx >= 0 ? (row[uridIdx] || "").trim() : "";
    if (!email || !summary) continue;

    let eventName = "";
    let linkType: "attended" | "invited" | undefined;

    const eventTag = summary.match(/\[Event:\s*([^\]]+)\]/i);
    if (eventTag) {
      eventName = eventTag[1].trim();
      linkType = "invited";
    } else if (type === "meeting" || type === "event") {
      const meetingPrefix = summary.match(/^Meeting:\s*(.+)$/i);
      if (meetingPrefix) {
        eventName = cleanCalendarEventName(meetingPrefix[1]);
      } else if (type === "event" && summary.length <= 120 && !summary.includes("·")) {
        // Short, clean "event" notes (manual / picker) — use the summary as name.
        eventName = summary.trim();
      }
    }

    if (!eventName) continue;
    const key = `${email.toLowerCase()}|${eventName.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      email,
      eventName,
      date: date || undefined,
      type: linkType,
      urid: urid || undefined,
      ensureCatalog: true,
      catalogType: "meeting",
    });
  }

  return ensureEventAttendanceBatch(items);
}

export async function buildAppEvents(): Promise<AsanaEvent[]> {
  let rows: string[][] = [];
  try {
    rows = await fetchSheetTab(TAB_NAMES.appEvents);
  } catch {
    return []; // Tab doesn't exist yet — no app events.
  }
  const raw = mapRows<Record<string, string>>(rows, APP_EVENT_COLS);
  const today = new Date().toISOString().split("T")[0];

  return raw
    .filter((e) => (e.name || "").trim())
    .map((e, idx) => {
      const date = (e.date || "").trim();
      const status: AsanaEvent["status"] =
        (e.status || "").trim().toLowerCase() === "completed"
          ? "completed"
          : (e.status || "").trim().toLowerCase() === "planned"
            ? "planned"
            : date && date < today
              ? "completed"
              : "planned";
      const typeRaw = (e.type || "").trim().toLowerCase();
      const type = (
        ["conference", "dinner", "webinar", "meeting"].includes(typeRaw) ? typeRaw : "meeting"
      ) as AsanaEvent["type"];
      const fmtRaw = (e.format || "").trim().toLowerCase();
      const format = (["in-person", "virtual", "hybrid"].includes(fmtRaw) ? fmtRaw : undefined) as
        | EventFormat
        | undefined;
      const roleRaw = (e.role || "").trim().toLowerCase();
      const role = roleRaw === "hosted" || roleRaw === "sponsored" ? roleRaw : undefined;

      return {
        gid: `app-${idx}`,
        name: (e.name || "").trim(),
        date,
        status,
        portcos: splitList(e.portcos),
        role,
        type,
        lead: (e.lead || "").trim() || undefined,
        format,
        sectors: splitList(e.sectors),
      };
    });
}

// ── Utility ──────────────────────────────────────────────────

// Buckets of child rows keyed by parent identity: by stable urid when the child
// carries one, else by (lowercased) email. A row appears in exactly one bucket.
interface ParentBuckets {
  byUrid: Record<string, Record<string, string>[]>;
  byEmail: Record<string, Record<string, string>[]>;
}

function splitByParent(items: Record<string, string>[]): ParentBuckets {
  const byUrid: Record<string, Record<string, string>[]> = {};
  const byEmail: Record<string, Record<string, string>[]> = {};
  for (const it of items) {
    const cu = (it.curid || "").trim().toLowerCase();
    // Index by URID when present — AND still by email so multi-email contacts
    // (and urid mismatches) can still find Notes/Events/Intros rows.
    if (cu) (byUrid[cu] ||= []).push(it);
    const e = (it.email || "").trim().toLowerCase();
    if (e) (byEmail[e] ||= []).push(it);
  }
  return { byUrid, byEmail };
}

function groupBy(
  items: Record<string, string>[],
  key: string,
): Record<string, Record<string, string>[]> {
  const map: Record<string, Record<string, string>[]> = {};
  for (const item of items) {
    const k = (item[key] || "").toLowerCase();
    if (!k) continue;
    if (!map[k]) map[k] = [];
    map[k].push(item);
  }
  return map;
}

// ── PortCo Event Exposure ────────────────────────────────────

export const PORTCO_EXPOSURE_HEADERS = [
  "Company",
  "Event",
  "Date",
  "Format",
  "Source",
  "Logged Date",
];

/** Read the PortCo Event Exposure tab and group rows by company name. */
export async function buildPortcoExposures(): Promise<Map<string, PortCoExposure[]>> {
  await ensureTab(TAB_NAMES.portcoExposure, PORTCO_EXPOSURE_HEADERS);
  const rows = await fetchSheetTab(TAB_NAMES.portcoExposure).catch(() => [] as string[][]);
  if (rows.length < 2) return new Map();

  const map = new Map<string, PortCoExposure[]>();
  const header = (rows[0] || []).map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name.toLowerCase());
  const companyIdx = idx("Company");
  const eventIdx = idx("Event");
  const dateIdx = idx("Date");
  const formatIdx = idx("Format");
  const sourceIdx = idx("Source");
  const loggedDateIdx = idx("Logged Date");

  for (const r of rows.slice(1)) {
    const company = companyIdx === -1 ? "" : r[companyIdx] || "";
    if (!company.trim()) continue;
    const exp: PortCoExposure = {
      company: company.trim(),
      event: eventIdx === -1 ? "" : r[eventIdx] || "",
      date: dateIdx === -1 ? "" : r[dateIdx] || "",
      format: formatIdx === -1 ? "" : r[formatIdx] || "",
      source: sourceIdx === -1 ? "" : r[sourceIdx] || "",
      loggedDate: loggedDateIdx === -1 ? "" : r[loggedDateIdx] || "",
    };
    const key = company.trim().toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(exp);
  }

  return map;
}
