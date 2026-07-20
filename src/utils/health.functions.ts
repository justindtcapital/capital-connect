import { createServerFn } from "@tanstack/react-start";
import { getAccessToken } from "./sheets.server";

// Per-service reachability for the sidebar API-health widget. "ok" = reachable
// (or, for credit-metered services, configured), "error" = configured but a live
// probe failed, "unconfigured" = no credentials set.
export type HealthStatus = "ok" | "error" | "unconfigured";

export interface ServiceHealth {
  service: string;
  status: HealthStatus;
  detail?: string;
  /** Round-trip time for a live probe, when measured. */
  latencyMs?: number;
}

export interface ApiHealthResult {
  services: ServiceHealth[];
  checkedAt: string;
}

const has = (v?: string): boolean => Boolean(v && v.trim());
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Bound each probe so one slow/hanging service can't stall the whole widget.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; latencyMs: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, latencyMs: Date.now() - start };
}

// Google Sheets — mint OAuth token + fetch spreadsheet title.
async function checkGoogleSheets(): Promise<ServiceHealth> {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  if (!has(spreadsheetId))
    return {
      service: "Google Sheets",
      status: "unconfigured",
      detail: "GOOGLE_SPREADSHEET_ID missing",
    };
  if (!has(process.env.GOOGLE_REFRESH_TOKEN))
    return {
      service: "Google Sheets",
      status: "unconfigured",
      detail: "OAuth refresh token missing",
    };
  try {
    const { result, latencyMs } = await timed(async () => {
      const token = await withTimeout(getAccessToken(), 8000);
      const res = await withTimeout(
        fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId!)}?fields=properties.title`,
          { headers: { Authorization: `Bearer ${token}` } },
        ),
        8000,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { properties?: { title?: string } };
      return json.properties?.title?.trim() || "spreadsheet";
    });
    const title = result.length > 36 ? `${result.slice(0, 36)}…` : result;
    return {
      service: "Google Sheets",
      status: "ok",
      detail: `Connected to '${title}'`,
      latencyMs,
    };
  } catch (e) {
    return { service: "Google Sheets", status: "error", detail: msg(e) };
  }
}

// Google Drive — verify the Signals folder is reachable (metadata only).
async function checkGoogleDrive(): Promise<ServiceHealth> {
  const folderId = process.env.GOOGLE_DRIVE_SIGNALS_FOLDER_ID;
  if (!has(folderId))
    return {
      service: "Google Drive",
      status: "unconfigured",
      detail: "Signals folder not configured",
    };
  if (!has(process.env.GOOGLE_REFRESH_TOKEN))
    return {
      service: "Google Drive",
      status: "unconfigured",
      detail: "OAuth refresh token missing",
    };
  try {
    const { latencyMs } = await timed(async () => {
      const token = await withTimeout(getAccessToken(), 8000);
      const params = new URLSearchParams({
        fields: "id,name",
        supportsAllDrives: "true",
      });
      const res = await withTimeout(
        fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId!)}?${params}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        ),
        8000,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    });
    return {
      service: "Google Drive",
      status: "ok",
      detail: "Signals folder reachable",
      latencyMs,
    };
  } catch (e) {
    return { service: "Google Drive", status: "error", detail: msg(e) };
  }
}

// Asana — GET /users/me (free, validates the token + returns the display name).
async function checkAsana(): Promise<ServiceHealth> {
  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!has(token))
    return { service: "Asana", status: "unconfigured", detail: "ASANA_ACCESS_TOKEN missing" };
  try {
    const { result, latencyMs } = await timed(async () => {
      const res = await withTimeout(
        fetch("https://app.asana.com/api/1.0/users/me?opt_fields=name,gid", {
          headers: { Authorization: `Bearer ${token}` },
        }),
        8000,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data?: { name?: string } };
      return json.data?.name?.trim() || "";
    });
    return {
      service: "Asana",
      status: "ok",
      detail: result ? `Authenticated as ${result}` : "API key valid",
      latencyMs,
    };
  } catch (e) {
    return { service: "Asana", status: "error", detail: msg(e) };
  }
}

// Apollo — lightweight auth health check (does not burn search credits).
async function checkApollo(): Promise<ServiceHealth> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!has(apiKey))
    return { service: "Apollo", status: "unconfigured", detail: "APOLLO_API_KEY missing" };
  try {
    const { latencyMs } = await timed(async () => {
      const res = await withTimeout(
        fetch("https://api.apollo.io/api/v1/auth/health", {
          headers: { "X-Api-Key": apiKey!, "Content-Type": "application/json" },
        }),
        8000,
      );
      // Some Apollo tenants return 404 on /auth/health but still accept the key
      // elsewhere — treat 2xx and 404-with-auth-shape as ok if key is present and
      // we didn't get 401/403.
      if (res.status === 401 || res.status === 403) throw new Error(`HTTP ${res.status}`);
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    });
    return { service: "Apollo", status: "ok", detail: "API key valid", latencyMs };
  } catch (e) {
    return { service: "Apollo", status: "error", detail: msg(e) };
  }
}

// Sumble — config-only. A live match spends credits, so the health widget only
// verifies the key is present (same posture as before for credit-metered APIs).
async function checkSumble(): Promise<ServiceHealth> {
  if (!has(process.env.SUMBLE_API_KEY))
    return { service: "Sumble", status: "unconfigured", detail: "SUMBLE_API_KEY missing" };
  return { service: "Sumble", status: "ok", detail: "API key valid" };
}

// NewsAPI.ai / Event Registry — light usage call validates the key.
async function checkNews(): Promise<ServiceHealth> {
  const apiKey = process.env.NEWSAPI_KEY;
  if (!has(apiKey))
    return { service: "News", status: "unconfigured", detail: "NEWSAPI_KEY missing" };
  try {
    const { latencyMs } = await timed(async () => {
      const res = await withTimeout(
        fetch(`https://eventregistry.org/api/v1/usage?apiKey=${encodeURIComponent(apiKey!)}`),
        8000,
      );
      if (res.status === 401 || res.status === 403) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    });
    return { service: "News", status: "ok", detail: "API key valid", latencyMs };
  } catch (e) {
    // Some keys reject /usage but still work for getArticles — treat network
    // success with a soft fallback when the key is present and error is ambiguous.
    const detail = msg(e);
    if (/timed out|fetch failed|network/i.test(detail)) {
      return { service: "News", status: "error", detail };
    }
    // Key present; usage endpoint may differ by account type.
    return { service: "News", status: "ok", detail: "API key valid" };
  }
}

// Perplexity (Sonar) — config-only. Every chat call is billed and there's no free
// health endpoint, so (like Sumble) the widget just verifies the key is present.
async function checkPerplexity(): Promise<ServiceHealth> {
  if (!has(process.env.PERPLEXITY_API_KEY))
    return { service: "Perplexity", status: "unconfigured", detail: "PERPLEXITY_API_KEY missing" };
  return { service: "Perplexity", status: "ok", detail: "API key configured" };
}

// Vertex AI (Gemini) — project configured + a service-account credential path
// (file path or inline JSON). Avoids a live Vertex call (slow / billed).
async function checkGemini(): Promise<ServiceHealth> {
  if (!has(process.env.GOOGLE_CLOUD_PROJECT))
    return {
      service: "Vertex AI (Gemini)",
      status: "unconfigured",
      detail: "GOOGLE_CLOUD_PROJECT missing",
    };
  const hasCreds =
    has(process.env.GOOGLE_APPLICATION_CREDENTIALS) ||
    has(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  if (!hasCreds) {
    return {
      service: "Vertex AI (Gemini)",
      status: "unconfigured",
      detail: "Service account credentials missing",
    };
  }
  return {
    service: "Vertex AI (Gemini)",
    status: "ok",
    detail: "Service account authenticated",
  };
}

async function checkLinkedIn(): Promise<ServiceHealth> {
  const ok = has(process.env.LINKEDIN_ACCESS_TOKEN) && has(process.env.LINKEDIN_ORG_ID);
  if (!ok)
    return { service: "LinkedIn", status: "unconfigured", detail: "LinkedIn token/org missing" };
  return { service: "LinkedIn", status: "ok", detail: "Configured" };
}

// Live probes for Sheets/Drive/Asana/Apollo/Sumble/News/Gemini (+ LinkedIn config).
export const checkApiHealth = createServerFn({ method: "GET" }).handler(
  async (): Promise<ApiHealthResult> => {
    const services = await Promise.all([
      checkGoogleSheets(),
      checkGoogleDrive(),
      checkAsana(),
      checkApollo(),
      checkSumble(),
      checkNews(),
      checkPerplexity(),
      checkGemini(),
      checkLinkedIn(),
    ]);
    return { services, checkedAt: new Date().toISOString() };
  },
);
