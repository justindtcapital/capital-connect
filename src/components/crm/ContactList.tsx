import { useState, useMemo, useEffect, useRef } from "react";
import type { Contact, ContactFilters as Filters } from "@/lib/types";
import { seniorityOf, departmentOf } from "@/lib/people-classify";
import { normalizeLocation } from "@/lib/location-utils";
import { ContactCard } from "./ContactCard";
import { ContactTable } from "./ContactTable";
import { ContactDetail } from "./ContactDetail";
import { BulkEditBar } from "./BulkEditBar";
import { Button } from "@/components/ui/button";
import { LayoutGrid, List } from "lucide-react";
import { useSelection } from "@/lib/selection-context";

interface ContactListProps {
  contacts: Contact[];
  filters: Filters;
  /** When set (e.g. deep-linked from the home page), open this contact's detail. */
  focusEmail?: string;
}

export function ContactList({ contacts, filters, focusEmail }: ContactListProps) {
  const [view, setView] = useState<"cards" | "table">("cards");
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [localContacts, setLocalContacts] = useState(contacts);
  const { setFilteredContacts, clearSelection, setOnBulkUpdate } = useSelection();

  const filtered = useMemo(() => {
    const result = localContacts.filter((c) => {
      if (filters.search) {
        const q = filters.search.toLowerCase();
        if (
          !c.name.toLowerCase().includes(q) &&
          !c.company.toLowerCase().includes(q) &&
          !c.email.toLowerCase().includes(q)
        )
          return false;
      }
      // Multi-select categorical filters: empty = no filter; OR within each field.
      if (filters.sector.length && !filters.sector.includes(c.sector)) return false;
      if (filters.temperature.length && !filters.temperature.includes(c.temperature)) return false;
      if (filters.prime.length && !filters.prime.includes(c.prime)) return false;
      if (
        filters.areaOfInterest.length &&
        !filters.areaOfInterest.some((a) => c.areasOfInterest.includes(a))
      )
        return false;
      if (filters.source.length && !filters.source.includes(c.source || "Manual Entry"))
        return false;
      if (filters.seniority.length && !filters.seniority.includes(seniorityOf(c.title)))
        return false;
      if (filters.department.length && !filters.department.includes(departmentOf(c.title)))
        return false;
      if (filters.title && !c.title.toLowerCase().includes(filters.title.toLowerCase()))
        return false;
      if (filters.location.length && !filters.location.includes(normalizeLocation(c.location)))
        return false;
      if (filters.followUpOnly && !c.followUpPending) return false;
      if (filters.dateFrom || filters.dateTo) {
        // Pick the date to filter on: when added, or last activity (latest
        // interaction / last contact). Formats vary (M/D/YYYY or ISO) → parse.
        let value: number;
        if (filters.dateField === "activity") {
          value = 0;
          for (const it of c.interactions) {
            const t = Date.parse(it.date || "");
            if (!Number.isNaN(t) && t > value) value = t;
          }
          const lc = Date.parse(c.lastContact || "");
          if (!Number.isNaN(lc) && lc > value) value = lc;
        } else {
          value = Date.parse(c.dateAdded || "");
          if (Number.isNaN(value)) value = 0;
        }
        if (value === 0) return false; // no usable date → exclude when a bound is set
        if (filters.dateFrom) {
          const from = Date.parse(filters.dateFrom);
          if (!Number.isNaN(from) && value < from) return false;
        }
        if (filters.dateTo) {
          // Include the whole "to" day by pushing the bound to end-of-day.
          const to = Date.parse(filters.dateTo);
          if (!Number.isNaN(to) && value > to + 86_399_999) return false;
        }
      }
      return true;
    });
    // Newest contacts first (by Date Added); rows without a date sink to the bottom.
    return [...result].sort((a, b) => {
      const at = Date.parse(a.dateAdded || "") || 0;
      const bt = Date.parse(b.dateAdded || "") || 0;
      if (bt !== at) return bt - at;
      return a.name.localeCompare(b.name);
    });
  }, [localContacts, filters]);

  useEffect(() => {
    setFilteredContacts(filtered);
  }, [filtered, setFilteredContacts]);

  useEffect(() => {
    setOnBulkUpdate((updatedContacts: Contact[]) => {
      setLocalContacts((prev) => {
        const map = new Map(updatedContacts.map((c) => [c.id, c]));
        return prev.map((c) => map.get(c.id) || c);
      });
    });
    return () => setOnBulkUpdate(undefined);
  }, [setOnBulkUpdate]);

  // Open a deep-linked contact's detail (e.g. from the home page). Guarded by a
  // ref so it fires once per distinct email and doesn't re-open after the user
  // closes the panel.
  const handledFocus = useRef<string | null>(null);
  useEffect(() => {
    const email = focusEmail?.trim().toLowerCase();
    if (!email || handledFocus.current === email) return;
    const match = localContacts.find((c) => c.email?.trim().toLowerCase() === email);
    if (match) {
      handledFocus.current = email;
      setSelectedContact(match);
      setDetailOpen(true);
    }
  }, [focusEmail, localContacts]);

  const handleSelect = (contact: Contact) => {
    setSelectedContact(contact);
    setDetailOpen(true);
  };

  const handleContactUpdate = (updated: Contact) => {
    setLocalContacts((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    setSelectedContact(updated);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">{filtered.length}</span> contacts
        </p>
        <div className="flex items-center gap-1">
          <Button
            variant={view === "cards" ? "default" : "ghost"}
            size="icon"
            className="h-8 w-8"
            onClick={() => {
              setView("cards");
              clearSelection();
            }}
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button
            variant={view === "table" ? "default" : "ghost"}
            size="icon"
            className="h-8 w-8"
            onClick={() => setView("table")}
          >
            <List className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {view === "cards" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((contact) => (
            <ContactCard key={contact.id} contact={contact} onClick={() => handleSelect(contact)} />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          <BulkEditBar />
          <ContactTable contacts={filtered} onSelect={handleSelect} />
        </div>
      )}

      <ContactDetail
        contact={selectedContact}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onContactUpdate={handleContactUpdate}
      />
    </div>
  );
}
