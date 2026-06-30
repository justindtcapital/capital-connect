// Shared client-side loader for Asana BD/GTM activities. The detail panels (Contact
// and PortCo) all call this; a module-level cache + in-flight promise dedupes the
// fetch so opening several records doesn't re-hit the server (which is itself cached
// 5 min). Refreshes once per page load.

import { useEffect, useState } from "react";
import { fetchAsanaActivities } from "@/utils/asana.functions";
import type { AsanaActivity } from "@/lib/types";

let cache: AsanaActivity[] | null = null;
let inflight: Promise<AsanaActivity[]> | null = null;

export function useAsanaActivities() {
  const [activities, setActivities] = useState<AsanaActivity[]>(cache ?? []);
  const [loading, setLoading] = useState(cache === null);

  useEffect(() => {
    if (cache !== null) return;
    let cancelled = false;
    if (!inflight) {
      inflight = fetchAsanaActivities()
        .then((a) => {
          cache = a;
          return a;
        })
        .catch(() => {
          cache = [];
          return [];
        });
    }
    inflight.then((a) => {
      if (!cancelled) {
        setActivities(a);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { activities, loading };
}
