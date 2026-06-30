import { createServerFn } from "@tanstack/react-start";
import {
  enrichPerson,
  searchPeople as runPeopleSearch,
  type ApolloEnrichmentResult,
  type ApolloSearchResponse,
} from "./apollo.server";

export const enrichContact = createServerFn({ method: "POST" })
  .inputValidator((data: {
    id?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    company?: string;
    linkedinUrl?: string;
  }) => data)
  .handler(async ({ data }): Promise<ApolloEnrichmentResult> => {
    return enrichPerson({
      id: data.id,
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      organizationName: data.company,
      linkedinUrl: data.linkedinUrl,
    });
  });

// Network builder: search Apollo's database for new people by criteria.
export const searchContacts = createServerFn({ method: "POST" })
  .inputValidator((data: {
    titles?: string[];
    locations?: string[];
    organizationDomains?: string[];
    employeeRanges?: string[];
    keywords?: string;
    page?: number;
    perPage?: number;
  }) => data)
  .handler(async ({ data }): Promise<ApolloSearchResponse> => {
    try {
      return await runPeopleSearch(data);
    } catch (err) {
      console.error("[apollo] searchContacts failed:", err);
      return {
        people: [], total: 0, page: 1, totalPages: 0,
        error: err instanceof Error ? err.message : "Apollo search failed.",
      };
    }
  });
