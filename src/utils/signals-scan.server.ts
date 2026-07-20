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
  return scanSignals({ data: input });
}
