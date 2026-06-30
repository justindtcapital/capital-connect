import type { Contact } from "@/lib/types";

// Quote a cell if it contains a comma, quote, or newline; double any inner quotes.
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// Export columns. Headers use the same names the bulk importer recognizes
// (name, email, title, company, phone, location, prime, sector) so an exported
// file round-trips cleanly back through Upload CSV. Extra columns are ignored on import.
// Shared by both the CSV and Excel exporters so the two stay in sync.
export const EXPORT_COLUMNS: { header: string; value: (c: Contact) => string }[] = [
  { header: "Name", value: (c) => c.name },
  { header: "Email", value: (c) => c.email },
  { header: "Title", value: (c) => c.title },
  { header: "Company", value: (c) => c.company },
  { header: "Phone", value: (c) => c.phone },
  { header: "Location", value: (c) => c.location ?? "" },
  { header: "Prime", value: (c) => c.prime },
  { header: "Sector", value: (c) => c.sector },
  { header: "Temperature", value: (c) => c.temperature },
  { header: "Follow-up Pending", value: (c) => (c.followUpPending ? "Yes" : "No") },
  { header: "PortCo Intros", value: (c) => (c.portCoIntros ?? []).join("; ") },
  { header: "Events Attended", value: (c) => (c.eventsAttended ?? []).join("; ") },
  { header: "Last Contact", value: (c) => c.lastContact ?? "" },
];

export function contactsToCsv(contacts: Contact[]): string {
  const head = EXPORT_COLUMNS.map((col) => csvCell(col.header)).join(",");
  const rows = contacts.map((c) => EXPORT_COLUMNS.map((col) => csvCell(col.value(c) ?? "")).join(","));
  // Lead with a BOM so Excel reads UTF-8 (e.g. accented names) correctly.
  return "﻿" + [head, ...rows].join("\r\n");
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
