import { createContext, useContext, useState, type ReactNode } from "react";
import type { TargetingFilters } from "./types";

const defaultFilters: TargetingFilters = {
  search: "",
  stage: "all",
  sector: "all",
  city: "all",
  origin: "all",
};

interface TargetingFilterContextType {
  filters: TargetingFilters;
  setFilters: (filters: TargetingFilters) => void;
}

const TargetingFilterContext = createContext<TargetingFilterContextType>({
  filters: defaultFilters,
  setFilters: () => {},
});

export function TargetingFilterProvider({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<TargetingFilters>(defaultFilters);
  return (
    <TargetingFilterContext.Provider value={{ filters, setFilters }}>
      {children}
    </TargetingFilterContext.Provider>
  );
}

export function useTargetingFilters() {
  return useContext(TargetingFilterContext);
}
