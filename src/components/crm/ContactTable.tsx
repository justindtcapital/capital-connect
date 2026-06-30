import { useMemo, useState } from "react";
import type { Contact } from "@/lib/types";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { TemperatureBadge } from "./TemperatureBadge";
import { ContactAvatar } from "./ContactAvatar";
import { AlertCircle, CheckCircle2, ChevronUp, ChevronDown, ChevronsUpDown, Lock } from "lucide-react";
import { useSelection } from "@/lib/selection-context";

interface ContactTableProps {
  contacts: Contact[];
  onSelect: (contact: Contact) => void;
}

type SortKey =
  | "name"
  | "title"
  | "company"
  | "location"
  | "sector"
  | "areasOfInterest"
  | "prime"
  | "temperature"
  | "followUp"
  | "source"
  | "dateAdded";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Contact" },
  { key: "title", label: "Title" },
  { key: "company", label: "Company" },
  { key: "location", label: "Location" },
  { key: "sector", label: "Sector" },
  { key: "areasOfInterest", label: "Area of Interest" },
  { key: "prime", label: "Contact Prime" },
  { key: "temperature", label: "Status" },
  { key: "followUp", label: "Follow-up" },
  { key: "source", label: "Source" },
  { key: "dateAdded", label: "Added" },
];

// Hot/Warm/Cold sort by intensity rather than alphabetically.
const TEMP_RANK: Record<string, number> = { Hot: 3, Warm: 2, Cold: 1 };

function followUpRank(c: Contact): number {
  const open = c.interactions.some((i) => i.isFollowUp && !i.followUpComplete);
  if (open) return 2; // Pending
  const done = c.interactions.some((i) => i.isFollowUp);
  return done ? 1 : 0; // Done / none
}

function sortValue(c: Contact, key: SortKey): string | number {
  switch (key) {
    case "name":
      return c.name.toLowerCase();
    case "title":
      return c.title.toLowerCase();
    case "company":
      return c.company.toLowerCase();
    case "location":
      return (c.location ?? "").toLowerCase();
    case "sector":
      return c.sector.toLowerCase();
    case "areasOfInterest":
      return c.areasOfInterest.join(", ").toLowerCase();
    case "prime":
      return c.prime.toLowerCase();
    case "temperature":
      return TEMP_RANK[c.temperature] ?? 0;
    case "followUp":
      return followUpRank(c);
    case "source":
      return (c.source || "Manual Entry").toLowerCase();
    case "dateAdded":
      // Sort chronologically; blanks sort oldest.
      return Date.parse(c.dateAdded || "") || 0;
  }
}

export function ContactTable({ contacts, onSelect }: ContactTableProps) {
  const { selectedIds, toggleId, toggleAll, allFilteredContacts } = useSelection();
  const allSelected = contacts.length > 0 && selectedIds.size === allFilteredContacts.length;

  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(null);

  const toggleSort = (key: SortKey) =>
    setSort((prev) =>
      prev?.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }
    );

  const sorted = useMemo(() => {
    if (!sort) return contacts;
    const arr = [...contacts];
    arr.sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [contacts, sort]);

  return (
    <div className="rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-10">
              <Checkbox
                checked={allSelected}
                onCheckedChange={() => toggleAll()}
                aria-label="Select all"
              />
            </TableHead>
            {COLUMNS.map((col) => {
              const active = sort?.key === col.key;
              return (
                <TableHead
                  key={col.key}
                  className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground whitespace-nowrap"
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(col.key)}
                    className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                  >
                    {col.label}
                    {active ? (
                      sort!.dir === "asc" ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      )
                    ) : (
                      <ChevronsUpDown className="h-3 w-3 opacity-30" />
                    )}
                  </button>
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((contact) => {
            const hasOpenFollowUps = contact.interactions.some(
              (i) => i.isFollowUp && !i.followUpComplete
            );
            const allComplete = contact.interactions.some((i) => i.isFollowUp) && !hasOpenFollowUps;
            const isSelected = selectedIds.has(contact.id);

            return (
              <TableRow
                key={contact.id}
                className="cursor-pointer"
                data-state={isSelected ? "selected" : undefined}
              >
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggleId(contact.id)}
                    aria-label={`Select ${contact.name}`}
                  />
                </TableCell>
                <TableCell onClick={() => onSelect(contact)}>
                  <div className="flex items-center gap-2">
                    <ContactAvatar contact={contact} size="sm" />
                    <span
                      className="block max-w-[180px] truncate text-sm font-medium text-foreground"
                      title={contact.name}
                    >
                      {contact.name}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground" onClick={() => onSelect(contact)}>
                  <div className="max-w-[170px] truncate" title={contact.title}>{contact.title || "—"}</div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground" onClick={() => onSelect(contact)}>
                  <div className="max-w-[150px] truncate" title={contact.company}>{contact.company || "—"}</div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground" onClick={() => onSelect(contact)}>
                  <div className="max-w-[150px] truncate" title={contact.location || ""}>{contact.location || "—"}</div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground" onClick={() => onSelect(contact)}>
                  <div className="max-w-[130px] truncate" title={contact.sector}>{contact.sector || "—"}</div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground" onClick={() => onSelect(contact)}>
                  <div className="max-w-[170px] truncate" title={contact.areasOfInterest.join(", ")}>
                    {contact.areasOfInterest.join(", ") || "—"}
                  </div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground" onClick={() => onSelect(contact)}>
                  <div className="max-w-[130px] truncate" title={contact.prime}>{contact.prime || "—"}</div>
                </TableCell>
                <TableCell className="whitespace-nowrap" onClick={() => onSelect(contact)}>
                  <span className="inline-flex items-center gap-1">
                    <TemperatureBadge temperature={contact.temperature} />
                    {contact.ratingLocked && (
                      <Lock
                        className="h-3 w-3 text-muted-foreground"
                        aria-label="Rating manually locked"
                      />
                    )}
                  </span>
                </TableCell>
                <TableCell onClick={() => onSelect(contact)}>
                  {hasOpenFollowUps && (
                    <div className="flex items-center gap-1 text-red-500">
                      <AlertCircle className="h-3.5 w-3.5" />
                      <span className="text-xs font-medium">Pending</span>
                    </div>
                  )}
                  {allComplete && (
                    <div className="flex items-center gap-1 text-emerald-600">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span className="text-xs font-medium">Done</span>
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground whitespace-nowrap" onClick={() => onSelect(contact)}>
                  {contact.source || "Manual Entry"}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground whitespace-nowrap" onClick={() => onSelect(contact)}>
                  {contact.dateAdded || "—"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
