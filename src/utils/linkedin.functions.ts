import { createServerFn } from "@tanstack/react-start";
import { fetchOrganizationPosts, type LinkedInFeedResult } from "./linkedin.server";

// Recent posts from the authorized LinkedIn company page (official API only).
// Returns { configured:false } when LinkedIn env vars are absent so the UI can
// show a connect-prompt instead of an error.
export const fetchLinkedInFeed = createServerFn({ method: "GET" }).handler(
  async (): Promise<LinkedInFeedResult> => {
    try {
      return await fetchOrganizationPosts(20);
    } catch (e) {
      console.error("fetchLinkedInFeed failed:", e);
      return { configured: false, found: false, posts: [], error: "LinkedIn fetch failed." };
    }
  },
);
