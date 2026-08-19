// Decide whether a calendar / note title belongs in the CRM Events catalog
// (dinners, conferences, sponsored gatherings) vs a 1:1 / BD meeting that
// should stay on Activity / Notes only.
// Pure — safe to unit-test.

import { parseDtcMeetingSubject } from "./meeting-subject";
import { stripReplyForwardPrefixes } from "./news-subject";

/**
 * True when the title looks like a real CRM event (conference, dinner, meetup).
 * False for 1:1 syncs, briefings, DTC planning sessions, etc.
 */
export function shouldCatalogAsCrmEvent(name: string): boolean {
  return !isOneOnOneOrWorkingMeeting(name);
}

/**
 * True for 1:1 / working meetings that must NOT land on the Events page.
 */
export function isOneOnOneOrWorkingMeeting(name: string): boolean {
  const s = stripReplyForwardPrefixes(name || "")
    .replace(/^(updated\s+)?invitation:\s*/i, "")
    .replace(/^(accepted|tentative|declined):\s*/i, "")
    .replace(/^canceled?\s+event:\s*/i, "")
    .replace(/^cancelled\s+event:\s*/i, "")
    .trim();
  if (!s) return true;

  // Person <> Person (or Company <> Person) syncs.
  if (/<>|↔|⇄/.test(s)) return true;

  // Explicit 1:1 language.
  if (/\b(1\s*:\s*1|one[-\s]?on[-\s]?one)\b/i.test(s)) return true;

  // Briefing / handover / intro calls (not sponsored dinners).
  if (/^briefing\b/i.test(s)) return true;
  if (/\b(handover|hand[- ]?off)\s+call\b/i.test(s)) return true;
  if (/\bintro\s+call\b/i.test(s)) return true;

  // DTC subject convention: Flexor (Or) - DTC (Chris F) -Follow Up
  if (parseDtcMeetingSubject(s).externalName) return true;

  // Internal GTM/BD planning / sync sessions (not public events).
  if (
    /\b(gtm|bd|dtc)\b/i.test(s) &&
    /\b(sync|strategy|planning|session|connect|standup|stand-up|check[- ]?in)\b/i.test(s)
  ) {
    return true;
  }

  // Short "… Sync" working titles without event keywords.
  if (/\bsync\b/i.test(s) && !hasPublicEventKeyword(s) && s.length <= 90) {
    return true;
  }

  // "connect re …" style calendar notes.
  if (/\bconnect\s+re\b/i.test(s)) return true;

  return false;
}

function hasPublicEventKeyword(s: string): boolean {
  return /\b(dinner|breakfast|lunch|happy\s*hour|conference|summit|forum|expo|fair|meetup|meet-up|webinar|workshop|hackathon|tech\s*week|world\s*fair|black\s*hat|rsa|sponsored|cocktail|reception|awards?)\b/i.test(
    s,
  );
}
