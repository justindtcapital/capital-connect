// Apollo.io API integration
// Primary: POST /people/match (searches full Apollo database)
// Fallback: POST /contacts/search + PATCH /contacts/{id} (your account only)

const APOLLO_API_URL = "https://api.apollo.io/api/v1";

export interface ApolloEnrichmentResult {
  found: boolean;
  name?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  company?: string;
  linkedinUrl?: string;
  city?: string;
  state?: string;
  country?: string;
  headline?: string;
  photoUrl?: string;
  phone?: string;
  /** Where the phone came from — UI uses this to label "Mobile/Personal/Work/Company". */
  phoneSource?: "personal" | "mobile" | "work" | "company" | "";
  email?: string;
  employmentHistory?: Array<{
    title: string;
    company: string;
    current: boolean;
  }>;
  rawResponse?: Record<string, string | number | boolean | null>;
  error?: string;
  errorCode?: string;
  accessDenied?: boolean;
}

async function apolloFetch(
  path: string,
  method: string,
  body: Record<string, unknown>,
  apiKey: string,
): Promise<Response> {
  return fetch(`${APOLLO_API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify(body),
  });
}

function extractPerson(person: Record<string, unknown>): ApolloEnrichmentResult {
  const employmentHistory = Array.isArray(person.employment_history)
    ? (person.employment_history as Array<Record<string, unknown>>)
        .slice(0, 5)
        .map((e) => ({
          title: String(e.title || ""),
          company: String(e.organization_name || ""),
          current: Boolean(e.current),
        }))
    : [];

  // Phone — Apollo's free/lower tiers don't return personal/mobile numbers
  // unless you opt into reveal_phone_number (which requires a webhook URL).
  // We still try every documented field; if nothing personal is available we
  // fall back to the organization's main switchboard so there's at least
  // *some* number on the contact record.
  let phone = "";
  let phoneSource: "personal" | "mobile" | "work" | "company" | "" = "";
  if (
    Array.isArray(person.phone_numbers) &&
    (person.phone_numbers as Array<Record<string, unknown>>).length > 0
  ) {
    const arr = person.phone_numbers as Array<Record<string, unknown>>;
    const byType = (t: string) =>
      arr.find((n) => String(n.type || "").toLowerCase().includes(t));
    const pick = byType("mobile") || byType("personal") || byType("work") || arr[0];
    phone = String(pick.sanitized_number || pick.raw_number || pick.number || "");
    const t = String(pick.type || "").toLowerCase();
    phoneSource = t.includes("mobile") ? "mobile" : t.includes("personal") ? "personal" : t.includes("work") ? "work" : "personal";
  }
  if (!phone && person.mobile_phone) { phone = String(person.mobile_phone); phoneSource = "mobile"; }
  if (!phone && person.personal_phone) { phone = String(person.personal_phone); phoneSource = "personal"; }
  if (!phone && person.sanitized_phone) { phone = String(person.sanitized_phone); phoneSource = "personal"; }
  if (!phone && person.phone) { phone = String(person.phone); phoneSource = "personal"; }
  if (!phone && person.direct_phone) { phone = String(person.direct_phone); phoneSource = "work"; }
  if (!phone && person.work_direct_phone) { phone = String(person.work_direct_phone); phoneSource = "work"; }
  if (!phone && person.corporate_phone) { phone = String(person.corporate_phone); phoneSource = "work"; }

  // Last-resort fallback: company switchboard from the org record.
  if (!phone && person.organization && typeof person.organization === "object") {
    const org = person.organization as Record<string, unknown>;
    const orgPhone = org.sanitized_phone || org.phone ||
      (typeof org.primary_phone === "object" && org.primary_phone
        ? (org.primary_phone as Record<string, unknown>).sanitized_number || (org.primary_phone as Record<string, unknown>).number
        : null);
    if (orgPhone) {
      phone = String(orgPhone);
      phoneSource = "company";
    }
  }

  // City: check person directly, then organization
  let city = String(person.city || "");
  let state = String(person.state || "");
  let country = String(person.country || "");

  // Fall back to organization location if person-level is empty
  if (!city && person.organization && typeof person.organization === "object") {
    const org = person.organization as Record<string, unknown>;
    if (!city && org.city) city = String(org.city);
    if (!state && org.state) state = String(org.state);
    if (!country && org.country) country = String(org.country);
  }

  // Also try present_raw_address or raw_address as fallback
  if (!city && person.present_raw_address) {
    city = String(person.present_raw_address);
    state = "";
    country = "";
  }

  return {
    found: true,
    name: String(person.name || [person.first_name, person.last_name].filter(Boolean).join(" ")),
    firstName: String(person.first_name || ""),
    lastName: String(person.last_name || ""),
    title: String(person.title || ""),
    company: String(person.organization_name || (person.organization && typeof person.organization === "object" ? (person.organization as Record<string, unknown>).name || "" : "") || ""),
    linkedinUrl: String(person.linkedin_url || ""),
    city,
    state,
    country,
    headline: String(person.headline || ""),
    photoUrl: String(person.photo_url || ""),
    phone,
    phoneSource,
    email: String(person.email || ""),
    employmentHistory,
    rawResponse: JSON.parse(JSON.stringify(person)) as Record<
      string,
      string | number | boolean | null
    >,
  };
}

/**
 * Try /people/match first (full Apollo DB). If the key doesn't have access,
 * fall back to /contacts/search (your account contacts only).
 */
export async function enrichPerson(params: {
  id?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  organizationName?: string;
  linkedinUrl?: string;
}): Promise<ApolloEnrichmentResult> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    throw new Error("APOLLO_API_KEY is not configured");
  }

  // --- Attempt 1: /people/match (full database) ---
  // Defensive: only forward params that look like valid strings. The TanStack
  // server-fn serializer can occasionally encode `undefined` as a non-string
  // sentinel; ignore anything non-string-y to avoid corrupting the Apollo query.
  const isValidStr = (v: unknown): v is string =>
    typeof v === "string" && v.trim().length > 0;
  const isValidUrl = (v: unknown): v is string =>
    typeof v === "string" && /^https?:\/\//i.test(v.trim());

  const matchBody: Record<string, string | boolean> = {
    reveal_personal_emails: true,
    // NOTE: do NOT enable reveal_phone_number here — Apollo requires a
    // webhook_url alongside it and otherwise returns HTTP 400, which would
    // make the whole lookup look like "no match". Phones still come through
    // when present on the matched person record.
  };
  // An Apollo person id (from people search) is the strongest, exact matcher.
  if (isValidStr(params.id)) matchBody.id = params.id.trim();
  if (isValidStr(params.email)) matchBody.email = params.email.trim();
  if (isValidStr(params.firstName)) matchBody.first_name = params.firstName.trim();
  if (isValidStr(params.lastName)) matchBody.last_name = params.lastName.trim();
  if (isValidStr(params.organizationName)) matchBody.organization_name = params.organizationName.trim();
  if (isValidUrl(params.linkedinUrl)) matchBody.linkedin_url = params.linkedinUrl.trim();

  console.log("[Apollo] /people/match request keys:", Object.keys(matchBody).join(","));

  const matchRes = await apolloFetch("/people/match", "POST", matchBody, apiKey);

  if (matchRes.ok) {
    const data = (await matchRes.json()) as { person?: Record<string, unknown> };
    if (data.person) {
      console.log("[Apollo] /people/match succeeded");
      return extractPerson(data.person);
    }
    console.log("[Apollo] /people/match: 200 OK but no person matched. Falling back to /contacts/search.");
  } else {
    const errorBody = await matchRes.text();
    console.log(`[Apollo] /people/match returned ${matchRes.status}, falling back to /contacts/search. Body: ${errorBody.slice(0, 300)}`);
    if (matchRes.status !== 403) {
      console.error(`[Apollo] /people/match unexpected error: ${errorBody}`);
    }
  }

  // --- Attempt 2: /contacts/search (account contacts) ---
  const searchKeywords = [params.firstName, params.lastName, params.email]
    .filter(Boolean)
    .join(" ");

  const searchRes = await apolloFetch(
    "/contacts/search",
    "POST",
    { q_keywords: searchKeywords, per_page: 5 },
    apiKey,
  );

  if (!searchRes.ok) {
    const errorBody = await searchRes.text();
    try {
      const parsed = JSON.parse(errorBody) as { error?: string; error_code?: string };
      if (searchRes.status === 403 && parsed.error_code === "API_INACCESSIBLE") {
        return {
          found: false,
          accessDenied: true,
          errorCode: parsed.error_code,
          error:
            "Neither /people/match nor /contacts/search are accessible with this API key. Please check your Apollo plan or key permissions.",
        };
      }
    } catch {
      // non-JSON
    }
    throw new Error(`Apollo API error [${searchRes.status}]: ${errorBody}`);
  }

  const searchData = (await searchRes.json()) as {
    contacts?: Array<Record<string, unknown>>;
  };
  const contacts = searchData.contacts;

  if (!contacts || contacts.length === 0) {
    const tried = [
      params.email && `email "${params.email}"`,
      params.firstName && params.lastName && `name "${params.firstName} ${params.lastName}"`,
      params.organizationName && `at "${params.organizationName}"`,
    ]
      .filter(Boolean)
      .join(", ");
    return {
      found: false,
      error: tried
        ? `No Apollo match found for ${tried}. This person may not be in Apollo's database, or the email/company may be too generic to match. Try adding a LinkedIn URL.`
        : "No match found. Add an email, name + company, or LinkedIn URL to improve matching.",
    };
  }

  // Try to match by email
  let match = contacts[0];
  if (params.email) {
    const emailLower = params.email.toLowerCase();
    const emailMatch = contacts.find(
      (c) => String(c.email || "").toLowerCase() === emailLower,
    );
    if (emailMatch) match = emailMatch;
  }

  console.log("[Apollo] /contacts/search matched, returning data");
  return extractPerson(match);
}

// ── People search (network builder / discovery) ──────────────────────────────
// Wraps Apollo's POST /mixed_people/search — find NEW people by criteria
// (title, location, company domain, headcount, keywords). Note: result emails
// are often "locked" on lower plans; reveal them later via enrichPerson.

// Search results are intentionally obfuscated by Apollo — last name, email,
// location, and LinkedIn are hidden until revealed (via enrichPerson by id).
// We surface what's available plus "has X" availability flags.
export interface ApolloPersonResult {
  id: string;
  firstName: string;
  title: string;
  company: string;
  hasEmail: boolean;
  hasPhone: boolean;
  hasLocation: boolean;
}

export interface ApolloSearchResponse {
  people: ApolloPersonResult[];
  total: number;
  page: number;
  totalPages: number;
  error?: string;
  accessDenied?: boolean;
}

export interface ApolloSearchParams {
  titles?: string[];
  /** Apollo person_seniorities, e.g. "c_suite" | "vp" | "director" | "manager" | "senior". */
  seniorities?: string[];
  locations?: string[];
  organizationDomains?: string[];
  employeeRanges?: string[];
  keywords?: string;
  page?: number;
  perPage?: number;
}

export async function searchPeople(params: ApolloSearchParams): Promise<ApolloSearchResponse> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) throw new Error("APOLLO_API_KEY is not configured");

  const body: Record<string, unknown> = {
    page: params.page && params.page > 0 ? params.page : 1,
    per_page: params.perPage && params.perPage > 0 ? Math.min(params.perPage, 100) : 25,
  };
  if (params.titles?.length) body.person_titles = params.titles;
  if (params.seniorities?.length) body.person_seniorities = params.seniorities;
  if (params.locations?.length) body.person_locations = params.locations;
  if (params.organizationDomains?.length) body.q_organization_domains = params.organizationDomains.join("\n");
  if (params.employeeRanges?.length) body.organization_num_employees_ranges = params.employeeRanges;
  if (params.keywords?.trim()) body.q_keywords = params.keywords.trim();

  // NOTE: /mixed_people/search is deprecated; api_search is the current endpoint.
  const res = await apolloFetch("/mixed_people/api_search", "POST", body, apiKey);

  if (!res.ok) {
    const errorBody = await res.text();
    try {
      const parsed = JSON.parse(errorBody) as { error?: string; error_code?: string };
      if (res.status === 403) {
        return {
          people: [], total: 0, page: 1, totalPages: 0, accessDenied: true,
          error: parsed.error || "Apollo people-search isn't accessible with this API key/plan.",
        };
      }
    } catch {
      // non-JSON error body
    }
    throw new Error(`Apollo search error [${res.status}]: ${errorBody.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    people?: Array<Record<string, unknown>>;
    total_entries?: number; // api_search returns the total at the top level
  };

  const people: ApolloPersonResult[] = (data.people || []).map((p) => {
    const org = (p.organization && typeof p.organization === "object"
      ? (p.organization as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    return {
      id: String(p.id || ""),
      firstName: String(p.first_name || ""),
      title: String(p.title || ""),
      company: String(p.organization_name || org.name || ""),
      hasEmail: Boolean(p.has_email),
      hasPhone: Boolean(p.has_direct_phone),
      hasLocation: Boolean(p.has_city || p.has_state || p.has_country),
    };
  });

  const total = data.total_entries ?? people.length;
  const perPage = body.per_page as number;
  return {
    people,
    total,
    page: body.page as number,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  };
}
