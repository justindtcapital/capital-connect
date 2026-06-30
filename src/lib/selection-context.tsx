import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import type { Contact, Interaction } from "@/lib/types";

interface SelectionContextType {
  selectedIds: Set<string>;
  selectedContacts: Contact[];
  allFilteredContacts: Contact[];
  toggleId: (id: string) => void;
  toggleAll: () => void;
  clearSelection: () => void;
  setFilteredContacts: (contacts: Contact[]) => void;
  onBulkUpdate?: (updatedContacts: Contact[]) => void;
  setOnBulkUpdate: (fn: ((updatedContacts: Contact[]) => void) | undefined) => void;
}

const SelectionContext = createContext<SelectionContextType>({
  selectedIds: new Set(),
  selectedContacts: [],
  allFilteredContacts: [],
  toggleId: () => {},
  toggleAll: () => {},
  clearSelection: () => {},
  setFilteredContacts: () => {},
  setOnBulkUpdate: () => {},
});

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [allFilteredContacts, setAllFilteredContacts] = useState<Contact[]>([]);
  const [onBulkUpdate, setOnBulkUpdateState] = useState<((updatedContacts: Contact[]) => void) | undefined>();

  const toggleId = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (prev.size === allFilteredContacts.length && allFilteredContacts.length > 0) {
        return new Set();
      }
      return new Set(allFilteredContacts.map((c) => c.id));
    });
  }, [allFilteredContacts]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const selectedContacts = allFilteredContacts.filter((c) => selectedIds.has(c.id));

  const setFilteredContacts = useCallback((contacts: Contact[]) => {
    setAllFilteredContacts(contacts);
  }, []);

  const setOnBulkUpdate = useCallback((fn: ((updatedContacts: Contact[]) => void) | undefined) => {
    setOnBulkUpdateState(() => fn);
  }, []);

  return (
    <SelectionContext.Provider
      value={{
        selectedIds,
        selectedContacts,
        allFilteredContacts,
        toggleId,
        toggleAll,
        clearSelection,
        setFilteredContacts,
        onBulkUpdate,
        setOnBulkUpdate,
      }}
    >
      {children}
    </SelectionContext.Provider>
  );
}

export function useSelection() {
  return useContext(SelectionContext);
}
