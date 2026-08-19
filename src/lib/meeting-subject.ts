// Parse DTC calendar / meeting subject conventions into structured hints.
// Pure — safe to unit-test.
//
// Common pattern from the team:
//   Flexor (Or) - DTC (Chris F) -Follow Up
//   RE: Flexor (Or) - DTC (Chris F) -Follow Up
// → company Flexor, external short-name Or, owner hint Chris F

import { stripReplyForwardPrefixes } from "./news-subject";

export interface DtcMeetingSubjectHints {
  /** Company / PortCo token before the first parenthetical. */
  company?: string;
  /** Short name in the first (...), usually the external contact. */
  externalName?: string;
  /** Short name in the DTC (...) group, when present. */
  ownerHint?: string;
}

/**
 * Extract company + external person hints from a DTC meeting subject.
 * Returns {} when the subject doesn't match the convention.
 */
export function parseDtcMeetingSubject(subject: string): DtcMeetingSubjectHints {
  const s = stripReplyForwardPrefixes(subject || "");
  if (!s) return {};

  // Company (External) - DTC (Owner) …
  // Company (External) — DTC …
  const withOwner = s.match(
    /^(.+?)\s*\(([^)]+)\)\s*[-–—]\s*DTC\s*\(([^)]+)\)(?:\s|[-–—]|$)/i,
  );
  if (withOwner) {
    return {
      company: cleanToken(withOwner[1]),
      externalName: cleanToken(withOwner[2]),
      ownerHint: cleanToken(withOwner[3]),
    };
  }
  const noOwner = s.match(/^(.+?)\s*\(([^)]+)\)\s*[-–—]\s*DTC(?:\s|[-–—]|$)/i);
  if (noOwner) {
    return {
      company: cleanToken(noOwner[1]),
      externalName: cleanToken(noOwner[2]),
    };
  }
  return {};
}

function cleanToken(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim().slice(0, 80);
}
