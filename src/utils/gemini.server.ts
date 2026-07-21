// Google Gemini integration — drafts outreach emails, runs JSON reasoning calls,
// and powers the Signals scan. Replaces the former Anthropic/Claude client.
//
// Runs on the VERTEX AI Gemini API (enterprise path under our Google Cloud
// project), NOT the AI Studio key API:
//   POST https://{LOC}-aiplatform.googleapis.com/v1/projects/{PROJ}/locations/{LOC}/publishers/google/models/{model}:generateContent
// Auth is Google Cloud OAuth (Application Default Credentials) — a service-account
// key via GOOGLE_APPLICATION_CREDENTIALS, or `gcloud auth application-default
// login` for local dev. Config: GOOGLE_CLOUD_PROJECT + GEMINI_LOCATION.
//
// NOTE on gemini-2.5 "thinking": 2.5 models spend output tokens on internal
// reasoning BEFORE the visible answer. If maxOutputTokens is small, thinking eats
// it all and the answer comes back empty. We therefore cap thinkingBudget and size
// maxOutputTokens = answerTokens + thinkingBudget on every call (see genConfig).

import { getVertexProject, getVertexLocation, getServiceAccountJson } from "./google.server";

export const GEMINI_MODEL = "gemini-2.5-flash";

const VERTEX_PROJECT = getVertexProject();
const VERTEX_LOCATION = getVertexLocation();

export function isGeminiConfigured(): boolean {
  return Boolean(VERTEX_PROJECT);
}

function vertexUrl(model: string): string {
  // GEMINI_LOCATION=global routes to Google's global endpoint (no region prefix
  // on the host) — recommended for gemini-2.5 models: capacity is pooled across
  // regions, which avoids the regional dynamic-shared-quota 429 storms a single
  // region (e.g. us-central1) hits under load.
  const host =
    VERTEX_LOCATION === "global"
      ? "aiplatform.googleapis.com"
      : `${VERTEX_LOCATION}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/publishers/google/models/${model}:generateContent`;
}

// Parse a service-account JSON that may have been pasted with real newlines
// inside the private_key (which is invalid JSON). We try strict parse first,
// then fall back to escaping raw newlines that appear inside string values.
function parseServiceAccountJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Escape raw CR/LF inside string literals. Walk the text tracking whether
    // we're inside a "..." string and whether the previous char was a backslash.
    let out = "";
    let inStr = false;
    let esc = false;
    for (const ch of trimmed) {
      if (inStr) {
        if (esc) {
          out += ch;
          esc = false;
          continue;
        }
        if (ch === "\\") {
          out += ch;
          esc = true;
          continue;
        }
        if (ch === '"') {
          out += ch;
          inStr = false;
          continue;
        }
        if (ch === "\n") {
          out += "\\n";
          continue;
        }
        if (ch === "\r") {
          out += "\\r";
          continue;
        }
        if (ch === "\t") {
          out += "\\t";
          continue;
        }
        out += ch;
      } else {
        if (ch === '"') inStr = true;
        out += ch;
      }
    }
    return JSON.parse(out);
  }
}

type ServiceAccountCredentials = {
  client_email?: string;
  private_key?: string;
  token_uri?: string;
  project_id?: string;
};

let cachedVertexToken: { token: string; expiresAt: number } | null = null;

function base64Url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return bytes.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  return Buffer.from(body, "base64");
}

async function signJwtRs256(unsignedJwt: string, privateKeyPem: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedJwt),
  );
  return `${unsignedJwt}.${base64Url(new Uint8Array(signature))}`;
}

async function mintServiceAccountAccessToken(creds: ServiceAccountCredentials): Promise<string> {
  const clientEmail = creds.client_email?.trim();
  let privateKey = creds.private_key?.trim();
  const tokenUri = creds.token_uri?.trim() || "https://oauth2.googleapis.com/token";

  if (!clientEmail || !privateKey) {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS_JSON must be the full service-account JSON, including client_email and private_key.",
    );
  }
  if (!privateKey.includes("\n") && privateKey.includes("\\n")) {
    privateKey = privateKey.replace(/\\n/g, "\n");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: clientEmail,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }),
  );
  const assertion = await signJwtRs256(`${header}.${claims}`, privateKey);

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google service-account token refresh failed [${res.status}]: ${text}`);
  }
  const data = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Google service-account token response missing access_token");
  cachedVertexToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return data.access_token;
}

async function getVertexToken(): Promise<string> {
  if (cachedVertexToken && Date.now() < cachedVertexToken.expiresAt - 60_000) {
    return cachedVertexToken.token;
  }

  const credsJson = getServiceAccountJson();
  if (!credsJson) {
    throw new Error(
      "Could not obtain a Google Cloud access token — set GOOGLE_APPLICATION_CREDENTIALS_JSON to a service-account key JSON",
    );
  }

  try {
    const creds = parseServiceAccountJson(credsJson) as ServiceAccountCredentials;
    return await mintServiceAccountAccessToken(creds);
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON: ${e.message}`);
    }
    throw e;
  }
}

// ── Wire types (subset of the Gemini REST shape we use) ──────────
// JSON value type — kept serializable so GeminiContent can round-trip through a
// TanStack server function (the LLM Query agent persists it in AgentState).
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: { [k: string]: JsonValue }; id?: string };
  functionResponse?: { name: string; response: { [k: string]: JsonValue }; id?: string };
}
export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}
interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
  groundingMetadata?: Record<string, unknown>;
}
export interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  promptFeedback?: { blockReason?: string };
}

// Size the output budget so thinking can't starve the visible answer.
function genConfig(
  answerTokens: number,
  thinkingBudget = 1024,
  extra: Record<string, unknown> = {},
) {
  return {
    maxOutputTokens: answerTokens + thinkingBudget,
    thinkingConfig: { thinkingBudget },
    ...extra,
  };
}

type GeminiCallResult =
  | { ok: true; data: GeminiResponse }
  | { ok: false; status: number; error: string };

// ── Global Vertex rate limiter ───────────────────────────────────
// Every Gemini call funnels through callGeminiRaw. We serialize requests and
// space them out so bursts (signals scan, smart-paste, Query agent loops)
// cannot exhaust RPM/TPM quotas. Slow is fine; 429 storms are not.
//
// Env (optional):
//   VERTEX_MIN_INTERVAL_MS — minimum gap between request *starts* (default 4000)
//   VERTEX_MAX_RETRIES     — 429 retry attempts (default 8)

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const VERTEX_MIN_INTERVAL_MS = envInt("VERTEX_MIN_INTERVAL_MS", 4000, 500, 120_000);
const VERTEX_MAX_RETRIES = envInt("VERTEX_MAX_RETRIES", 8, 1, 20);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Serial queue: one Vertex call at a time, with a minimum gap after each finishes.
 *  After any 429 it enters an adaptive "slow mode": queued calls pre-space at a
 *  wider interval for a few minutes (escalating on repeat 429s) so a burst like
 *  the exec brief's 7 calls stops slamming into the same exhausted quota. */
class VertexRateLimiter {
  private tail: Promise<unknown> = Promise.resolve();
  private lastEndMs = 0;
  private slowUntilMs = 0;
  private slowIntervalMs = 0;

  /** Report a 429 — widens the pacing for the next few minutes. */
  reportRateLimited(): void {
    const base = Math.max(VERTEX_MIN_INTERVAL_MS, 15_000);
    this.slowIntervalMs =
      Date.now() < this.slowUntilMs
        ? Math.min(60_000, Math.round(Math.max(this.slowIntervalMs, base) * 1.5))
        : base;
    this.slowUntilMs = Date.now() + 3 * 60_000;
  }

  private intervalMs(): number {
    return Date.now() < this.slowUntilMs ? this.slowIntervalMs : VERTEX_MIN_INTERVAL_MS;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.tail.then(async () => {
      const wait = Math.max(0, this.intervalMs() - (Date.now() - this.lastEndMs));
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        this.lastEndMs = Date.now();
      }
    });
    // Keep the chain alive even when a job fails.
    this.tail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
}

const vertexLimiter = new VertexRateLimiter();

/** Backoff for 429: honor Retry-After when present, else grow aggressively. */
function retryAfterMs(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const sec = Number(header);
    if (Number.isFinite(sec) && sec > 0) return Math.min(180_000, sec * 1000);
    const when = Date.parse(header);
    if (!Number.isNaN(when)) return Math.min(180_000, Math.max(0, when - Date.now()));
  }
  // 15s, 30s, 60s, 90s… capped at 120s
  return Math.min(120_000, 15_000 * attempt);
}

// Low-level call with global pacing + generous 429 retry. Returns a result
// union (never throws for HTTP errors) so JSON callers can degrade gracefully.
async function callGeminiRaw(
  body: Record<string, unknown>,
  model = GEMINI_MODEL,
  maxAttempts = VERTEX_MAX_RETRIES,
): Promise<GeminiCallResult> {
  return vertexLimiter.run(() => callGeminiRawUngated(body, model, maxAttempts));
}

async function callGeminiRawUngated(
  body: Record<string, unknown>,
  model: string,
  maxAttempts: number,
): Promise<GeminiCallResult> {
  if (!VERTEX_PROJECT)
    return { ok: false, status: 0, error: "GOOGLE_CLOUD_PROJECT is not configured" };

  let token: string;
  try {
    token = await getVertexToken();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The recurring Workspace-reauth failure — make it actionable, not raw JSON.
    if (/invalid_rapt|reauth|invalid_grant/i.test(msg)) {
      return {
        ok: false,
        status: 0,
        error:
          "Google Cloud sign-in expired (reauth required). Quick fix: re-run `gcloud auth application-default login`. Permanent fix: set GOOGLE_APPLICATION_CREDENTIALS to a service-account key (Vertex AI User) — service accounts don't expire under the reauth policy.",
      };
    }
    return { ok: false, status: 0, error: msg };
  }

  let lastError = "";
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(vertexUrl(model), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : "Request to Vertex AI failed",
      };
    }

    if (res.ok) {
      try {
        return { ok: true, data: (await res.json()) as GeminiResponse };
      } catch {
        return { ok: false, status: res.status, error: "Could not parse Gemini response" };
      }
    }

    let detail = `Gemini API error (${res.status})`;
    try {
      const b = (await res.clone().json()) as { error?: { message?: string } };
      if (b?.error?.message) detail = b.error.message;
    } catch {
      /* ignore */
    }

    // 429 = RESOURCE_EXHAUSTED. Wait longer and retry — prefer delay over failure.
    if (res.status === 429 && attempt < maxAttempts) {
      // A per-day/exhausted-billing quota will not clear on retry — fail fast
      // with the quota name instead of hanging through 8 backoffs.
      if (/per day|daily/i.test(detail)) {
        console.error(`[vertex] daily quota exhausted — not retrying: ${detail}`);
        return { ok: false, status: 429, error: detail };
      }
      vertexLimiter.reportRateLimited();
      const waitMs = retryAfterMs(res, attempt);
      // Include Vertex's own message — it names WHICH quota was hit (project
      // RPM/TPM vs regional shared capacity), which decides the right fix.
      console.warn(
        `[vertex] rate limited (429), backing off ${Math.round(waitMs / 1000)}s ` +
          `(attempt ${attempt}/${maxAttempts}) — ${detail}`,
      );
      await sleep(waitMs);
      lastError = detail;
      // Refresh token in case the wait was long.
      try {
        token = await getVertexToken();
      } catch {
        /* keep previous token */
      }
      continue;
    }
    return { ok: false, status: res.status, error: lastError || detail };
  }
}

// Throwing wrapper for callers that handle their own try/catch (the agent loop).
export async function geminiGenerate(
  body: Record<string, unknown>,
  model = GEMINI_MODEL,
): Promise<GeminiResponse> {
  const r = await callGeminiRaw(body, model);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

// Concatenate all text parts of the first candidate.
export function responseText(r: GeminiResponse): string {
  const parts = r.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p) => typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
    .trim();
}

// Map an HTTP status to the coarse errorCode the callers branch on.
function codeFor(status: number): string {
  if (status === 0) return "network";
  if (status === 429) return "rate_limited";
  return "error";
}

// ── Email drafting ───────────────────────────────────────────────
export interface EmailDraftInput {
  contactName: string;
  contactTitle?: string;
  contactCompany?: string;
  contactSector?: string;
  /** What the email should accomplish. */
  purpose: string;
  /** "Warm" | "Professional" | "Brief" — steers voice/length. */
  tone?: string;
  /** Anything the sender wants woven in (dates, links, specifics). */
  notes?: string;
  /** Recent interaction summaries, newest first. */
  history?: string[];
  senderName?: string;
  senderOrg?: string;
  /** "PortCo" | "Event" | "General". Steers the framing. */
  emailType?: string;
  linkedPortcos?: string[];
  linkedEvent?: string;
}

export interface EmailDraftResult {
  found: boolean;
  subject?: string;
  body?: string;
  error?: string;
}

function buildPrompt(input: EmailDraftInput): string {
  const lines: string[] = [];
  lines.push(`Recipient: ${input.contactName}`);
  if (input.contactTitle) lines.push(`Title: ${input.contactTitle}`);
  if (input.contactCompany) lines.push(`Company: ${input.contactCompany}`);
  if (input.contactSector) lines.push(`Sector: ${input.contactSector}`);
  lines.push("");
  lines.push(`Goal of this email: ${input.purpose}`);
  if (input.emailType === "PortCo" && input.linkedPortcos && input.linkedPortcos.length > 0) {
    const cos = input.linkedPortcos;
    if (cos.length === 1) {
      lines.push(`Context: this is outreach on behalf of portfolio company "${cos[0]}".`);
    } else {
      lines.push(
        `Context: this is outreach referencing multiple portfolio companies: ${cos.map((c) => `"${c}"`).join(", ")}. Reference each of them where relevant, and frame the email around the connection across them rather than treating them as unrelated.`,
      );
    }
  } else if (input.emailType === "Event" && input.linkedEvent) {
    lines.push(`Context: this is a follow-up regarding the event "${input.linkedEvent}".`);
  }
  if (input.notes) lines.push(`Details to include: ${input.notes}`);
  lines.push(`Desired tone: ${input.tone || "Warm"}`);
  if (input.history && input.history.length > 0) {
    lines.push("");
    lines.push("Recent interaction history with this contact (newest first):");
    for (const h of input.history.slice(0, 6)) lines.push(`- ${h}`);
  }
  lines.push("");
  lines.push(
    `Sender: ${input.senderName || "[Your name]"}${input.senderOrg ? `, ${input.senderOrg}` : ""}`,
  );
  return lines.join("\n");
}

const SYSTEM_PROMPT = `You are an assistant that drafts concise, professional outreach emails for a venture capital relationship manager.

Rules:
- Write a complete email: a short subject line and a body.
- Keep it brief and human — usually 3 short paragraphs or fewer. Respect the requested tone.
- Reference the interaction history naturally when it helps; never invent facts, dates, links, or commitments that weren't provided.
- Use the sender name in the sign-off. If the sender name is a placeholder like "[Your name]", leave the sign-off as a placeholder rather than inventing one.
- Do not use placeholders for things you were given. Do not add "[insert ...]" unless the detail is genuinely missing and essential.
- Output ONLY a JSON object, no markdown, no preamble, in exactly this shape:
{"subject": "...", "body": "..."}
The body should use real newlines (\\n) between paragraphs.`;

export async function draftEmail(input: EmailDraftInput): Promise<EmailDraftResult> {
  if (!isGeminiConfigured())
    return { found: false, error: "GOOGLE_CLOUD_PROJECT is not configured" };

  const r = await callGeminiRaw({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: buildPrompt(input) }] }],
    generationConfig: genConfig(1024, 1024, { responseMimeType: "application/json" }),
  });
  if (!r.ok) return { found: false, error: r.error };

  const text = responseText(r.data);
  if (!text) return { found: false, error: "Gemini returned an empty response" };

  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as { subject?: string; body?: string };
    return {
      found: true,
      subject: (parsed.subject || "").trim(),
      body: (parsed.body || "").trim(),
    };
  } catch {
    return { found: true, subject: "", body: text };
  }
}

// ── Generic JSON completion ──────────────────────────────────────
export interface GeminiJSONResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  /** "no_key" | "rate_limited" | "network" | "parse" | "error" */
  errorCode?: string;
}

export async function callGeminiJSON<T>(
  system: string,
  user: string,
  maxTokens = 2000,
  opts?: { maxAttempts?: number },
): Promise<GeminiJSONResult<T>> {
  if (!isGeminiConfigured())
    return { ok: false, error: "GOOGLE_CLOUD_PROJECT is not configured", errorCode: "no_key" };

  const r = await callGeminiRaw(
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: genConfig(maxTokens, 1024, { responseMimeType: "application/json" }),
    },
    GEMINI_MODEL,
    opts?.maxAttempts ?? VERTEX_MAX_RETRIES,
  );
  if (!r.ok) return { ok: false, error: r.error, errorCode: codeFor(r.status) };

  const text = responseText(r.data);
  if (!text) return { ok: false, error: "Gemini returned an empty response", errorCode: "parse" };
  const candidate = extractJsonObject(text) || text;
  try {
    return { ok: true, data: JSON.parse(candidate) as T };
  } catch {
    const repaired = repairJson(candidate);
    if (repaired) return { ok: true, data: JSON.parse(repaired) as T };
    return { ok: false, error: "Gemini returned malformed JSON", errorCode: "parse" };
  }
}

// ── Signal Scan (relationship radar) ─────────────────────────────
// Uses Gemini + Google Search grounding to find recent news about the firm's
// portfolio + network companies, attribute each signal to people in the network,
// and draft warm outreach. Shared-drive PDFs ride along as inline document parts.

export interface SignalPortco {
  name: string;
  sector?: string;
  stage?: string;
  themes?: string;
}

export interface SignalPerson {
  name: string;
  title?: string;
  company?: string;
  strength?: string;
  sector?: string;
  email?: string;
  lastContact?: string;
}

/** A PDF from the team's shared drive, passed to Gemini as an inline document part. */
export interface SignalDocument {
  name: string;
  base64: string;
  mediaType: string;
  link?: string;
}

/** A real article from NewsAPI used to ground the scan (durable source URL). */
export interface SignalArticle {
  company: string;
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt: string;
}

export interface SignalScanInput {
  windowDays: number;
  portcos: SignalPortco[];
  companies: string[];
  people: SignalPerson[];
  documents?: SignalDocument[];
  /** Real NewsAPI articles. When present, Gemini grounds on these (no web search). */
  articles?: SignalArticle[];
  /** Links from the network's recent emails, pre-attributed to a company by domain.
   *  Gemini reads each via the URL-context tool and emits a per-company signal. */
  emailLinks?: Array<{ url: string; company?: string }>;
}

export interface SignalRecommendation {
  person: string;
  company: string;
  email: string;
  category: string;
  signal: string;
  sourceUrl?: string;
  subject: string;
  body: string;
  relevance: number;
  justification: string;
  urgency: "High" | "Medium" | "Low" | string;
  timing: string;
  /** Date this signal was stored (YYYY-MM-DD), for the feed's relative time. */
  dateFound?: string;
  /** Persisted source-type bucket (from the taxonomy) — set on stored signals. */
  sourceType?: string;
  /** Durable link to a saved Drive doc/PDF for this signal, when one exists. */
  docUrl?: string;
  /** Stored-signal ID, for lazy-loading the Body via fetchSignalBody. */
  storedId?: string;
  /** Whether a (possibly elided) Body exists for this signal. */
  hasBody?: boolean;
}

export interface SignalAwarenessItem {
  company: string;
  person?: string;
  category: string;
  summary: string;
  /** Article/post title when the signal is a specific piece (e.g. a digest-email
   *  blog link) — the feed uses it as the card headline instead of company—category. */
  title?: string;
  sourceUrl?: string;
  /** Date this signal was stored (YYYY-MM-DD), for the feed's relative time. */
  dateFound?: string;
  /** Persisted source-type bucket (from the taxonomy) — set on stored signals. */
  sourceType?: string;
  /** Durable link to a saved Drive doc/PDF for this signal, when one exists. */
  docUrl?: string;
}

export interface SignalScanResult {
  found: boolean;
  error?: string;
  recommendations: SignalRecommendation[];
  otherSignals: SignalAwarenessItem[];
  compliance: string[];
  newCount?: number;
  raw?: string;
}

const SIGNAL_SYSTEM_PROMPT = `You are a relationship-intelligence analyst for a venture capital firm. You scan recent public news and attribute it to people in the firm's network, then draft warm, high-signal outreach.

Method:
1. SEARCH the web (Google Search) for recent developments (within the configured window) about the listed portfolio companies, their sectors/themes, and the listed network companies. Search liberally; prefer reputable sources (company blogs, news outlets, regulatory filings). Do NOT fabricate news — every signal must be grounded in a real search result with a URL. You may ALSO be given attached internal PDF documents from the firm's shared drive: treat them as trusted first-party context to corroborate, enrich, or originate signals, and cite such a signal via the document link provided in the prompt.
2. CATEGORIZE each real signal into exactly one of: "Funding/M&A", "Product/Milestone", "Executive Movement", "Thought Leadership", "Partnership/Customer Win", "Crisis/Regulatory", "Industry Trend", "Personal Milestone".
3. ATTRIBUTE each signal to one or more people from the provided network list, with a relevance score 1-10. Direct (they work at / are named in the company) scores highest; strong-indirect (same sector + thesis overlap) and warm-connection (investor/advisor/portfolio overlap) can also qualify. ONLY produce an outreach recommendation when relevance >= 7.
4. DRAFT outreach for each qualifying attribution: a warm personalized subject (<8 words) and a 2-3 sentence body that references the specific signal, adds genuine value, and suggests a concrete next step (congrats, call, intro, share insight). Never spammy or purely self-serving. Use the person's real email from the list.
5. FLAG any compliance/confidentiality concerns (e.g. material non-public info, regulated communications) in the compliance array.

Output ONLY a single JSON object, no prose, no markdown fences, in exactly this shape:
{
  "recommendations": [
    {"person":"","company":"","email":"","category":"","signal":"","sourceUrl":"","subject":"","body":"","relevance":0,"justification":"","urgency":"High|Medium|Low","timing":"this week|next 7 days|within month"}
  ],
  "otherSignals": [
    {"company":"","person":"","category":"","summary":"","sourceUrl":""}
  ],
  "compliance": []
}
Sort recommendations by relevance then urgency (highest first) and include at most 10. Put real-but-lower-relevance or unattributed signals in otherSignals. If you find no real signals, return empty arrays. Body text uses real \\n newlines.`;

function buildSignalPrompt(input: SignalScanInput): string {
  const lines: string[] = [];
  lines.push(
    `News window: the last ${input.windowDays} days. Today's context: treat anything older as stale.`,
  );
  lines.push("");
  lines.push("PORTFOLIO COMPANIES (primary search targets):");
  for (const p of input.portcos) {
    const bits = [p.name];
    if (p.sector) bits.push(`sector: ${p.sector}`);
    if (p.stage) bits.push(`stage: ${p.stage}`);
    if (p.themes) bits.push(`themes: ${p.themes}`);
    lines.push(`- ${bits.join(" | ")}`);
  }
  if (input.companies.length > 0) {
    lines.push("");
    lines.push("OTHER NETWORK COMPANIES (also scan):");
    lines.push(input.companies.join(", "));
  }
  lines.push("");
  lines.push("NETWORK PEOPLE (attribution pool — Name | Company | sector | email):");
  for (const person of input.people) {
    lines.push(
      `- ${person.name} | ${person.company || ""} | ${person.sector || ""} | ${person.email || ""}`,
    );
  }
  if (input.documents && input.documents.length > 0) {
    lines.push("");
    lines.push(
      "INTERNAL DOCUMENTS (attached PDFs from the team's shared drive — trusted first-party context):",
    );
    for (const d of input.documents) {
      lines.push(`- ${d.name}${d.link ? ` (link: ${d.link})` : ""}`);
    }
    lines.push(
      "These documents are ALREADY attached to this message as inline PDFs — read them from the attachments. Do NOT attempt to fetch/browse the Drive links; they require authentication and are provided ONLY for citation. When a signal is grounded in one of these documents rather than a web result, set its sourceUrl to the document's link above (or leave it blank if none).",
    );
  }
  if (input.articles && input.articles.length > 0) {
    lines.push("");
    lines.push(
      "REAL NEWS ARTICLES — these are your ONLY allowed web sources. Do NOT perform web search and do NOT invent URLs. Every signal you report MUST be grounded in one of these articles, and its sourceUrl MUST be that article's EXACT url copied verbatim from the list. Ignore articles that aren't genuinely relevant.",
    );
    for (const a of input.articles) {
      lines.push(
        `- [${a.company}] "${a.title}"${a.source ? ` — ${a.source}` : ""}${a.publishedAt ? ` (${a.publishedAt.slice(0, 10)})` : ""}\n  url: ${a.url}\n  ${a.description}`,
      );
    }
  }
  if (input.emailLinks && input.emailLinks.length > 0) {
    lines.push("");
    lines.push(
      "EMAIL LINKS TO ANALYZE — each URL is a blog post/article shared in your network's email, pre-attributed to the company in [brackets] (matched by the link's domain). For EACH link: OPEN and READ the page, then emit a signal for that company — set company to the bracketed name, sourceUrl to the EXACT url, category appropriately, and summary to what the post says + why it matters to that company. Put these in otherSignals, unless a post clearly maps to a listed network person (then a recommendation). Cover every link.",
    );
    for (const l of input.emailLinks) lines.push(`- ${l.company ? `[${l.company}] ` : ""}${l.url}`);
  }
  return lines.join("\n");
}

function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  // No closing brace at all (response truncated before any `}`): take from the
  // first `{` to the end so the repair pass can balance it.
  if (start !== -1) return text.slice(start);
  return null;
}

// Best-effort recovery of a JSON object/array that the model truncated (the most
// common cause: thinking + grounding exhaust maxOutputTokens mid-emit) or wrote
// with trailing commas. Walks the string tracking string/escape state, drops any
// dangling partial trailing token, and closes every still-open [ and { in order.
// Returns null if it still can't be parsed.
function repairJson(raw: string): string | null {
  const tryParse = (s: string): string | null => {
    try {
      JSON.parse(s);
      return s;
    } catch {
      return null;
    }
  };
  let s = raw.trim();
  // Strip trailing commas before a close, then try as-is.
  const noTrailingCommas = s.replace(/,(\s*[}\]])/g, "$1");
  const quick = tryParse(noTrailingCommas);
  if (quick) return quick;
  s = noTrailingCommas;

  // Walk to find the structural state at the point of truncation.
  const stack: string[] = [];
  let inStr = false;
  let escaped = false;
  let lastSafe = -1; // index (exclusive) of the last position that closed a top-level-safe token
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") stack.pop();
    // A comma at depth>=1 outside a string marks a clean element boundary we can
    // safely truncate back to if the tail is a half-written element.
    if (!inStr && c === "," && stack.length) lastSafe = i;
  }

  // If we ended inside a string, the truncation cut a value mid-quote: roll back
  // to the last clean element boundary so we don't keep a partial key/value.
  if (inStr && lastSafe !== -1) {
    s = s.slice(0, lastSafe);
    // Recompute the open-structure stack on the rolled-back string.
    stack.length = 0;
    inStr = false;
    escaped = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
      else if (c === "}" || c === "]") stack.pop();
    }
  } else if (inStr) {
    // No safe boundary — just close the open string.
    s += '"';
  }

  // Drop a dangling trailing comma/colon left by truncation, then close openers.
  s = s.replace(/[,:]\s*$/, "");
  while (stack.length) s += stack.pop();
  return tryParse(s.replace(/,(\s*[}\]])/g, "$1"));
}

export async function scanSignals(input: SignalScanInput): Promise<SignalScanResult> {
  const empty = { recommendations: [], otherSignals: [], compliance: [] };
  if (!isGeminiConfigured())
    return { found: false, error: "GOOGLE_CLOUD_PROJECT is not configured", ...empty };

  // User parts: the text prompt + any shared-drive PDFs as inline document parts.
  const docs = input.documents ?? [];
  const parts: GeminiPart[] = [{ text: buildSignalPrompt(input) }];
  for (const d of docs) {
    parts.push({ inlineData: { mimeType: d.mediaType, data: d.base64 } });
  }

  // When real NewsAPI articles are supplied we ground on THEM (durable URLs) and
  // skip Google Search; otherwise fall back to live Google Search grounding. The
  // URL-context tool is added whenever we hand Gemini email links to read.
  const hasArticles = (input.articles?.length ?? 0) > 0;
  const hasLinks = (input.emailLinks?.length ?? 0) > 0;
  const requestBody: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: SIGNAL_SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts }],
    // Generous output budget: thinking + a multi-signal JSON array can be large,
    // and truncation here is the main cause of "broken JSON" from a scan.
    generationConfig: genConfig(12000, 6000),
  };
  const tools: Array<Record<string, unknown>> = [];
  if (!hasArticles) tools.push({ googleSearch: {} });
  if (hasLinks) tools.push({ urlContext: {} });
  if (tools.length) requestBody.tools = tools;

  const r = await callGeminiRaw(requestBody);

  if (!r.ok) {
    if (r.status === 429) {
      return {
        found: false,
        error:
          "Gemini rate limit / quota hit (429). The scan was retried but still exceeded it — wait a minute and try again, or raise your quota in Google AI Studio.",
        ...empty,
      };
    }
    return { found: false, error: r.error, ...empty };
  }

  const finishReason = r.data.candidates?.[0]?.finishReason;
  const truncated = finishReason === "MAX_TOKENS";
  const text = responseText(r.data);
  if (!text) {
    const why = truncated
      ? "Gemini hit its output-token limit while thinking and returned no answer — try the scan again (fewer companies/links helps)."
      : "Gemini returned no text (only tool calls or thinking)";
    return { found: false, error: why, ...empty };
  }

  const candidate = extractJsonObject(text);
  if (!candidate)
    return { found: false, error: "Gemini did not return parseable JSON", raw: text, ...empty };
  // Prefer a clean parse; if the payload was truncated/malformed, repair it
  // (close open braces, drop the half-written trailing element) before giving up.
  const json = (() => {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      return repairJson(candidate);
    }
  })();
  if (!json) {
    const why = truncated
      ? "Gemini's response was cut off at the output-token limit and couldn't be repaired — run the scan again, or narrow the company/link set."
      : "Gemini returned malformed JSON";
    return { found: false, error: why, raw: text, ...empty };
  }

  try {
    const parsed = JSON.parse(json) as {
      recommendations?: SignalRecommendation[];
      otherSignals?: SignalAwarenessItem[];
      compliance?: string[];
    };
    // Source-URL policy: in NewsAPI mode keep a URL only if it's one we supplied
    // (blocks fabrication); in Google-Search mode the model's URLs are unreliable
    // (and grounding redirects expire), so blank them — the UI uses a search link.
    // Real URLs we supplied (NewsAPI articles + email links) may be cited; anything
    // else the model writes is treated as fabricated and blanked (UI search fallback).
    const allowed = new Set<string>([
      ...(input.articles || []).map((a) => a.url),
      ...(input.emailLinks || []).map((l) => l.url),
    ]);
    const fixUrl = (u?: string) => (u && allowed.has(u) ? u : "");
    const recommendations = (parsed.recommendations || [])
      .filter((rec) => (rec.relevance ?? 0) >= 7)
      .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
      .slice(0, 10)
      .map((rec) => ({ ...rec, sourceUrl: fixUrl(rec.sourceUrl) }));
    const otherSignals = (parsed.otherSignals || []).map((s) => ({
      ...s,
      sourceUrl: fixUrl(s.sourceUrl),
    }));
    return {
      found: true,
      recommendations,
      otherSignals,
      compliance: parsed.compliance || [],
    };
  } catch {
    return { found: false, error: "Gemini returned malformed JSON", raw: text, ...empty };
  }
}
