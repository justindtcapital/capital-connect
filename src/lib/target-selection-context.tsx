import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import type { TargetLead } from "@/lib/types";

interface TargetSelectionContextType {
  selectedIds: Set<string>;
  selectedTargets: TargetLead[];
  allFilteredTargets: TargetLead[];
  toggleId: (id: string) => void;
  toggleAll: () => void;
  clearSelection: () => void;
  setFilteredTargets: (targets: TargetLead[]) => void;
  onBulkUpdate?: (updatedTargets: TargetLead[]) => void;
  setOnBulkUpdate: (fn: ((updatedTargets: TargetLead[]) => void) | undefined) => void;
  onBulkDelete?: (deletedIds: string[]) => void;
  setOnBulkDelete: (fn: ((deletedIds: string[]) => void) | undefined) => void;
}

const TargetSelectionContext = createContext<TargetSelectionContextType>({
  selectedIds: new Set(),
  selectedTargets: [],
  allFilteredTargets: [],
  toggleId: () => {},
  toggleAll: () => {},
  clearSelection: () => {},
  setFilteredTargets: () => {},
  setOnBulkUpdate: () => {},
  setOnBulkDelete: () => {},
});

export function TargetSelectionProvider({ children }: { children: ReactNode }) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [allFilteredTargets, setAllFilteredTargets] = useState<TargetLead[]>([]);
  const [onBulkUpdate, setOnBulkUpdateState] = useState<((updatedTargets: TargetLead[]) => void) | undefined>();
  const [onBulkDelete, setOnBulkDeleteState] = useState<((deletedIds: string[]) => void) | undefined>();

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
      if (prev.size === allFilteredTargets.length && allFilteredTargets.length > 0) {
        return new Set();
      }
      return new Set(allFilteredTargets.map((t) => t.id));
    });
  }, [allFilteredTargets]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const selectedTargets = allFilteredTargets.filter((t) => selectedIds.has(t.id));

  const setFilteredTargets = useCallback((targets: TargetLead[]) => {
    setAllFilteredTargets(targets);
  }, []);

  const setOnBulkUpdate = useCallback((fn: ((updatedTargets: TargetLead[]) => void) | undefined) => {
    setOnBulkUpdateState(() => fn);
  }, []);

  const setOnBulkDelete = useCallback((fn: ((deletedIds: string[]) => void) | undefined) => {
    setOnBulkDeleteState(() => fn);
  }, []);

  return (
    <TargetSelectionContext.Provider
      value={{
        selectedIds,
        selectedTargets,
        allFilteredTargets,
        toggleId,
        toggleAll,
        clearSelection,
        setFilteredTargets,
        onBulkUpdate,
        setOnBulkUpdate,
        onBulkDelete,
        setOnBulkDelete,
      }}
    >
      {children}
    </TargetSelectionContext.Provider>
  );
}

export function useTargetSelection() {
  return useContext(TargetSelectionContext);
}
