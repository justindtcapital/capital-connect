import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

export interface FilterOptions {
  // CRM
  sectors: string[];
  primes: string[];
  areasOfInterest: string[];
  // Targeting
  targetSectors: string[];
  targetCities: string[];
  targetOrigins: string[];
  // Portfolio
  portfolioDomains: string[];
  portfolioCities: string[];
  portfolioDtcPriorities: string[];
  // Dashboard (shared from CRM + targets)
  allCities: string[];
  portfolioCompanies: string[];
}

const defaultOptions: FilterOptions = {
  sectors: [],
  primes: [],
  areasOfInterest: [],
  targetSectors: [],
  targetCities: [],
  targetOrigins: [],
  portfolioDomains: [],
  portfolioCities: [],
  portfolioDtcPriorities: [],
  allCities: [],
  portfolioCompanies: [],
};

interface FilterOptionsContextType {
  options: FilterOptions;
  updateOptions: (partial: Partial<FilterOptions>) => void;
}

const FilterOptionsContext = createContext<FilterOptionsContextType>({
  options: defaultOptions,
  updateOptions: () => {},
});

export function FilterOptionsProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<FilterOptions>(defaultOptions);
  const updateOptions = useCallback((partial: Partial<FilterOptions>) => {
    setOptions((prev) => ({ ...prev, ...partial }));
  }, []);
  return (
    <FilterOptionsContext.Provider value={{ options, updateOptions }}>
      {children}
    </FilterOptionsContext.Provider>
  );
}

export function useFilterOptions() {
  return useContext(FilterOptionsContext);
}
