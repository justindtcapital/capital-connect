/**
 * BD / GTM activity-tracking mail vs Signals news.
 * Pure helpers — safe on client and server.
 *
 * Ported from capital-connect / DTC_CRM_Local so "DTC: X — GTM Discussion"
 * threads that never touched a tracking alias still route into the activity
 * pipeline instead of the news feed.
 */

export type ActivityMailShape = {
  fromEmail?: string;
  toEmails?: string[];
  ccEmails?: string[];
  deliveredTo?: string[];
  subject?: string;
  body?: string;
  snippet?: string;
};

/**
 * True when a message belongs on Activity / GTM-Tracking / BD-Tracking —
 * not the Signals news feed.
 */
export function isActivityTrackingMessage(
  m: ActivityMailShape,
  aliasSet: Set<string> = new Set(),
): boolean {
  if (aliasSet.size > 0) {
    const addrs = [
      m.fromEmail,
      ...(m.toEmails || []),
      ...(m.ccEmails || []),
      ...(m.deliveredTo || []),
    ]
      .map((e) => (e || "").trim().toLowerCase())
      .filter(Boolean);
    if (addrs.some((e) => aliasSet.has(e))) return true;
    // Local-part match covers GTM-Tracking@dt-capital.net vs @gmail.com twins.
    const locals = [...aliasSet].map((a) => a.split("@")[0]).filter(Boolean);
    if (locals.some((lp) => addrs.some((e) => e === lp || e.startsWith(`${lp}@`)))) {
      return true;
    }
  }

  const subj = (m.subject || "").trim();
  // "RE: DTC: Bland.ai - GTM Discussion" and similar internal tracking threads.
  if (/\bDTC\s*:\s*.*\b(GTM|BD)\b/i.test(subj)) return true;
  if (/\b(GTM|BD)[- ]?(Tracking|Discussion|Sync|Call|Update)\b/i.test(subj)) return true;
  if (/\b(GTM-Tracking|BD-Tracking)\b/i.test(subj)) return true;

  const blob = `${subj}\n${m.snippet || ""}\n${(m.body || "").slice(0, 2000)}`;
  const looksLikeMeeting =
    /zoom\.us\/j\//i.test(blob) ||
    /\bMeeting ID\s*[:=]\s*\d/i.test(blob) ||
    /\bMicrosoft Teams meeting\b/i.test(blob) ||
    /\bJoin (Zoom|Microsoft Teams)\b/i.test(blob);
  if (looksLikeMeeting && /\b(GTM|BD|DTC)\b/i.test(subj)) return true;

  return false;
}

/** Subject/headline-only check for stored Signals rows (no full headers). */
export function isActivityTrackingHeadline(text?: string): boolean {
  return isActivityTrackingMessage({ subject: text || "" });
}

/**
 * True when a message is a calendar invite / appointment reply (ICS chrome),
 * not a prose email. Still belongs on BD/GTM as a Meeting with portcos from
 * the subject — not as a Received Email touch.
 */
export function isCalendarAppointmentMessage(m: ActivityMailShape): boolean {
  const subj = (m.subject || "").trim();
  if (
    /^(updated\s+)?invitation:/i.test(subj) ||
    /^accepted:/i.test(subj) ||
    /^tentative:/i.test(subj) ||
    /^declined:/i.test(subj) ||
    /^canceled?\s+event:/i.test(subj) ||
    /^cancelled\s+event:/i.test(subj)
  ) {
    return true;
  }
  const blob = `${subj}\n${m.snippet || ""}\n${(m.body || "").slice(0, 2500)}`;
  if (/original\s+appointment/i.test(blob)) return true;
  if (/begin:vcalendar|begin:vevent|filename=.*\.ics/i.test(blob)) return true;
  // Teams / Zoom invite chrome — including long join blocks Gmail keeps in-body.
  if (/\bMeeting ID\s*[:=]/i.test(blob) || /zoom\.us\/j\//i.test(blob)) return true;
  if (
    /\bMicrosoft Teams meeting\b/i.test(blob) &&
    (/\bWhen\s*:/i.test(blob) ||
      /\bJoin\s*:/i.test(blob) ||
      /teams\.microsoft\.com\//i.test(blob) ||
      /original\s+appointment/i.test(blob))
  ) {
    return true;
  }
  return false;
}

/**
 * Gmail query fragment that approximates the subject side of
 * isActivityTrackingMessage for a given track (OR'd into the activity fetch).
 */
export function activitySubjectQuery(track: "BD" | "GTM"): string {
  const tag = track === "GTM" ? "GTM" : "BD";
  return [
    `subject:(DTC) subject:(${tag})`,
    `subject:("${tag} Discussion" OR "${tag} Tracking" OR "${tag} Sync" OR "${tag} Call" OR "${tag} Update")`,
    `subject:(${tag}-Tracking)`,
  ].join(" OR ");
}
