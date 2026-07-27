/**
 * Server-only entry for scheduled / cron signal scans.
 * Call this from Inngest and HTTP cron — never from client code.
 */
import { scanSignals } from "./gemini.functions";

export async function runScheduledSignalScan(input: {
  windowDays?: number;
  maxPeople?: number;
  maxCompanies?: number;
  companyName?: string;
} = {}) {
  // WS6 — tier cadence applies only to SCHEDULED scans: Tier 1 daily; Tier 2
  // joins on its configured weekday; Tier 3 is never news-scanned. Manual
  // scans from the UI stay unrestricted.
  return scanSignals({ data: { ...input, scheduled: true } });
}
