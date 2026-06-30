import { createContext, useContext, useState, type ReactNode } from "react";
import type { PortfolioFilters } from "./types";

const defaultFilters: PortfolioFilters = {
  search: "",
  sector: "all",
  domain: "all",
  city: "all",
  dtcPriority: "all",
};

interface PortfolioFilterContextValue {
  filters: PortfolioFilters;
  setFilters: (filters: PortfolioFilters) => void;
}

const PortfolioFilterContext = createContext<PortfolioFilterContextValue>({
  filters: defaultFilters,
  setFilters: () => {},
});

export function PortfolioFilterProvider({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<PortfolioFilters>(defaultFilters);
  return (
    <PortfolioFilterContext.Provider value={{ filters, setFilters }}>
      {children}
    </PortfolioFilterContext.Provider>
  );
}

export function usePortfolioFilters() {
  return useContext(PortfolioFilterContext);
}
