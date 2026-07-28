// Pinned watch topics — server functions for the /signals keyword bar.
// A pinned topic is a standing subject search: every SCHEDULED morning news
// scan includes it (see executeSignalScan), so tuning the keywords tunes the
// collection, not just the display filter.

import { createServerFn } from "@tanstack/react-start";
import { loadSignalConfig, setSignalTopicPinned } from "./event-store.server";

export const fetchSignalTopics = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ topics: string[] }> => {
    try {
      const cfg = await loadSignalConfig();
      return { topics: cfg.topics };
    } catch {
      return { topics: [] };
    }
  },
);

export const pinSignalTopic = createServerFn({ method: "POST" })
  .inputValidator((data: { topic: string; pinned: boolean }) => data)
  .handler(async ({ data }) => setSignalTopicPinned(data.topic, data.pinned));
