import { createContext, useContext, useState, type ReactNode } from "react";

export interface DashboardFilters {
  sector: string;
  prime: string;
  temperature: string;
  city: string;
  portfolioCompany: string;
}

const defaultFilters: DashboardFilters = {
  sector: "all",
  prime: "all",
  temperature: "all",
  city: "all",
  portfolioCompany: "all",
};

interface DashboardFilterContextType {
  filters: DashboardFilters;
  setFilters: (filters: DashboardFilters) => void;
}

const DashboardFilterContext = createContext<DashboardFilterContextType>({
  filters: defaultFilters,
  setFilters: () => {},
});

export function DashboardFilterProvider({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<DashboardFilters>(defaultFilters);
  return (
    <DashboardFilterContext.Provider value={{ filters, setFilters }}>
      {children}
    </DashboardFilterContext.Provider>
  );
}

export function useDashboardFilters() {
  return useContext(DashboardFilterContext);
}
