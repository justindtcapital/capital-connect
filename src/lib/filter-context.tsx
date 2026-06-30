import { createContext, useContext, useState, type ReactNode } from "react";
import type { ContactFilters } from "@/lib/types";

export const defaultFilters: ContactFilters = {
  search: "",
  sector: [],
  temperature: [],
  prime: [],
  areaOfInterest: [],
  source: [],
  seniority: [],
  department: [],
  title: "",
  location: [],
  followUpOnly: false,
  dateField: "added",
  dateFrom: "",
  dateTo: "",
};

interface FilterContextType {
  filters: ContactFilters;
  setFilters: (filters: ContactFilters) => void;
}

const FilterContext = createContext<FilterContextType>({
  filters: defaultFilters,
  setFilters: () => {},
});

export function FilterProvider({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<ContactFilters>(defaultFilters);
  return (
    <FilterContext.Provider value={{ filters, setFilters }}>{children}</FilterContext.Provider>
  );
}

export function useFilters() {
  return useContext(FilterContext);
}
