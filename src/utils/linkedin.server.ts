// LinkedIn integration — OFFICIAL API ONLY.
//
// LinkedIn does not expose the home feed or arbitrary people's posts/profiles.
// The official Marketing / Community Management API only lets you read YOUR OWN
// organization (company page) posts and analytics, and only after the
// "Community Management API" product is approved on your LinkedIn app and a
// member-authorized OAuth token (scope r_organization_social) is minted.
//
// This module reads the authorized organization's recent posts via the versioned
// REST Posts API and normalizes them. Everything degrades gracefully when the
// env vars are absent (isLinkedInConfigured() === false).

const LINKEDIN_REST_URL = "https://api.linkedin.com/rest";
// Versioned-API month (YYYYMM). LinkedIn rotates these ~yearly; override via env
// if this one has been sunset. See developer.linkedin.com versioning docs.
const DEFAULT_API_VERSION = "202505";

export interface LinkedInPost {
  /** Post URN, e.g. "urn:li:share:123" or "urn:li:ugcPost:123". */
  id: string;
  /** Post body text (commentary). */
  text: string;
  /** Public permalink to the post. */
  url: string;
  /** Created time, epoch ms (0 when unknown). */
  createdAt: number;
  /** YYYY-MM-DD label (empty when unknown). */
  createdAtLabel: string;
}

export interface LinkedInFeedResult {
  /** True when LINKEDIN_ACCESS_TOKEN + LINKEDIN_ORG_ID are both set. */
  configured: boolean;
  /** True when the fetch succeeded (even if zero posts). */
  found: boolean;
  posts: LinkedInPost[];
  orgName?: string;
  error?: string;
}

export function isLinkedInConfigured(): boolean {
  return Boolean(process.env.LINKEDIN_ACCESS_TOKEN && process.env.LINKEDIN_ORG_ID);
}

function postUrl(urn: string): string {
  // The activity permalink accepts the post URN directly.
  return `https://www.linkedin.com/feed/update/${encodeURIComponent(urn)}/`;
}

function toLabel(ms: number): string {
  if (!ms) return "";
  // Avoid Date.now()-style nondeterminism concerns — this is a fixed timestamp.
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Pull the authorized organization's recent posts. `count` is capped to 50.
export async function fetchOrganizationPosts(count = 20): Promise<LinkedInFeedResult> {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  const orgId = process.env.LINKEDIN_ORG_ID;
  const orgName = process.env.LINKEDIN_ORG_NAME || undefined;
  const version = process.env.LINKEDIN_API_VERSION || DEFAULT_API_VERSION;

  if (!token || !orgId) {
    return { configured: false, found: false, posts: [], orgName };
  }

  const author = `urn:li:organization:${orgId}`;
  const params = new URLSearchParams({
    q: "author",
    author,
    count: String(Math.min(50, Math.max(1, count))),
    sortBy: "LAST_MODIFIED",
  });

  let res: Response;
  try {
    res = await fetch(`${LINKEDIN_REST_URL}/posts?${params.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "LinkedIn-Version": version,
        "X-Restli-Protocol-Version": "2.0.0",
      },
    });
  } catch (e) {
    console.error("[linkedin] network error:", e);
    return { configured: true, found: false, posts: [], orgName, error: "Could not reach LinkedIn." };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[linkedin] /posts ${res.status}: ${body.slice(0, 300)}`);
    let error = `LinkedIn API error ${res.status}.`;
    if (res.status === 401) error = "LinkedIn token is invalid or expired — re-authorize (r_organization_social).";
    else if (res.status === 403) error = "LinkedIn token lacks access to this organization, or the Community Management API isn't approved.";
    else if (res.status === 426 || /version/i.test(body)) error = `LinkedIn API version "${version}" is not supported — set LINKEDIN_API_VERSION to a current YYYYMM.`;
    return { configured: true, found: false, posts: [], orgName, error };
  }

  let data: { elements?: Array<Record<string, unknown>> };
  try {
    data = (await res.json()) as { elements?: Array<Record<string, unknown>> };
  } catch {
    return { configured: true, found: false, posts: [], orgName, error: "LinkedIn returned an unreadable response." };
  }

  const posts: LinkedInPost[] = (data.elements || []).map((el) => {
    const id = String(el.id || "");
    const text = String(el.commentary || "");
    // createdAt may be a number (epoch ms) or an object { time }.
    let createdMs = 0;
    if (typeof el.createdAt === "number") createdMs = el.createdAt;
    else if (el.createdAt && typeof el.createdAt === "object") {
      const t = (el.createdAt as Record<string, unknown>).time;
      if (typeof t === "number") createdMs = t;
    }
    return {
      id,
      text,
      url: id ? postUrl(id) : "https://www.linkedin.com/",
      createdAt: createdMs,
      createdAtLabel: toLabel(createdMs),
    };
  });

  // Newest first.
  posts.sort((a, b) => b.createdAt - a.createdAt);

  return { configured: true, found: true, posts, orgName };
}
