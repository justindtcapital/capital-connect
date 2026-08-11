// Shared mailbox-noise heuristics for BD/GTM activity sync and CRM deepen.
// Pure — safe to unit-test without Gmail.

/** Local-parts that are almost never a real relationship contact. */
const SYSTEM_LOCAL =
  /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer-daemon|postmaster|calendar(-notification)?|info|support|admin|team|hello|contact|help|news(letter)?|marketing|updates?|noreply|bounce|bounces|email\.customerservice|customerservice|service|feedback|survey|digest|alerts?|automated?|robot|system|mailman|listserv|unsubscribe|subscriptions?|billing|receipts?|invoices?|orders?|shipping|noreply[\w.-]*)$/i;

/** Domains that are almost always marketing / platform noise. */
/** ESP / marketing platforms — almost never a human relationship contact. */
const NOISE_DOMAINS = new Set([
  "mailchimp.com",
  "mailchimpapp.com",
  "sendgrid.net",
  "sendgrid.com",
  "amazonses.com",
  "bounce.google.com",
  "facebookmail.com",
  "lnkd.in",
  "hubspotemail.net",
  "intercom-mail.com",
  "substack.com",
  "convertkit.com",
  "ck.page",
  "beehiiv.com",
  "mktomail.com",
  "exacttarget.com",
  "pardot.com",
  "constantcontact.com",
]);

export function emailLocalPart(email: string): string {
  return (email || "").trim().toLowerCase().split("@")[0] || "";
}

export function emailDomain(email: string): string {
  return (email || "").trim().toLowerCase().split("@")[1] || "";
}

/** True when this address should never become BD/GTM Person or a Notes match target. */
export function isNoiseEmail(email: string): boolean {
  const e = (email || "").trim().toLowerCase();
  if (!e.includes("@")) return true;
  const local = emailLocalPart(e);
  const domain = emailDomain(e);
  if (!local || !domain) return true;
  if (SYSTEM_LOCAL.test(local)) return true;
  // Nested system locals: alerts+xyz@, newsletter=foo@
  if (/^(no-?reply|newsletter|mailer|bounce|notifications?)/i.test(local)) return true;
  if (NOISE_DOMAINS.has(domain)) return true;
  // Common ESP subdomains: bounce.example.com, email.example.com (weak — only mailer patterns)
  if (/^(bounce|email|mail|news|newsletter|marketing|m)\./i.test(domain)) return true;
  return false;
}

export interface BulkMailSignals {
  listUnsubscribe?: string;
  precedence?: string;
  autoSubmitted?: string;
  xMailer?: string;
  feedbackId?: string;
}

/** True when headers look like a newsletter / bulk / automated blast. */
export function isBulkOrAutomatedMail(signals: BulkMailSignals): boolean {
  // List-Unsubscribe is the strongest newsletter signal. Do NOT treat Feedback-ID
  // alone as bulk — Amazon SES puts it on many 1:1 transactional/outreach mails.
  if ((signals.listUnsubscribe || "").trim()) return true;
  const prec = (signals.precedence || "").trim().toLowerCase();
  if (prec === "bulk" || prec === "list" || prec === "junk") return true;
  const auto = (signals.autoSubmitted || "").trim().toLowerCase();
  if (auto && auto !== "no") return true;
  return false;
}
export interface Counterparty {
  name: string;
  email: string;
  role: "from" | "to" | "cc";
}

/**
 * Pick the real relationship person for a BD/GTM row.
 * Inbound (to alias): prefer From.
 * Outbound (from alias): prefer first non-noise To, then Cc.
 */
export function pickPrimaryCounterparty(
  people: Counterparty[],
  outbound: boolean,
): Counterparty | undefined {
  const clean = people.filter((p) => p.email && !isNoiseEmail(p.email));
  if (clean.length === 0) return undefined;
  if (outbound) {
    return clean.find((p) => p.role === "to") || clean.find((p) => p.role === "cc") || clean[0];
  }
  return clean.find((p) => p.role === "from") || clean[0];
}
