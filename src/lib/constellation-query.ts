import type { Contact } from "@/lib/types";

export interface ConstellationQueryResult {
  /** Human summary of what we understood */
  summary: string;
  /** Person node contact ids to highlight */
  contactIds: string[];
  /** PortCo names to highlight */
  portcos: string[];
  /** Optional sector filter applied in matching */
  sector?: string;
  /** Suggested overlay */
  overlay?: "decay" | "opportunity" | "bridges" | "blindspots";
  /** If two entities resolved, suggest Pulse Trace endpoints (node ids without prefix) */
  trace?: { fromContactId?: string; fromPortco?: string; toContactId?: string; toPortco?: string };
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function scoreNameMatch(query: string, candidate: string): number {
  const q = norm(query);
  const c = norm(candidate);
  if (!q || !c) return 0;
  if (c === q) return 100;
  if (c.startsWith(q)) return 80;
  if (c.includes(q)) return 60;
  // token overlap
  const qt = q.split(/\s+/);
  const ct = c.split(/\s+/);
  const hits = qt.filter((t) => ct.some((x) => x.startsWith(t) || t.startsWith(x))).length;
  return hits ? hits * 25 : 0;
}

function findContacts(contacts: Contact[], phrase: string, limit = 8): Contact[] {
  return contacts
    .map((c) => ({
      c,
      s: Math.max(
        scoreNameMatch(phrase, c.name),
        scoreNameMatch(phrase, c.company) * 0.8,
        scoreNameMatch(phrase, c.sector) * 0.5,
      ),
    }))
    .filter((x) => x.s >= 50)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.c);
}

function findPortcos(portcoNames: string[], phrase: string, limit = 6): string[] {
  return portcoNames
    .map((name) => ({ name, s: scoreNameMatch(phrase, name) }))
    .filter((x) => x.s >= 50)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.name);
}

function uniquePortcos(contacts: Contact[]): string[] {
  const s = new Set<string>();
  for (const c of contacts) {
    for (const p of c.portCoIntros || []) {
      const n = p.trim();
      if (n) s.add(n);
    }
  }
  return [...s];
}

/**
 * Lightweight NL parser for constellation exploration.
 * Examples:
 * - "show bridges"
 * - "cooling relationships"
 * - "connected to Acme"
 * - "healthcare investors"
 * - "everyone connected to OpenAI through healthcare"
 * - "path from Jane to Acme"
 */
export function parseConstellationQuery(
  raw: string,
  contacts: Contact[],
): ConstellationQueryResult | null {
  const q = raw.trim();
  if (!q) return null;
  const lower = norm(q);
  const portcoNames = uniquePortcos(contacts);

  // Overlay shortcuts
  if (/\b(bridge|bridges)\b/.test(lower)) {
    const bridges = contacts.filter((c) => new Set(c.portCoIntros || []).size >= 2);
    return {
      summary: `Highlighting ${bridges.length} bridge contacts`,
      contactIds: bridges.map((c) => c.id),
      portcos: [],
      overlay: "bridges",
    };
  }
  if (/\b(cool|cooling|decay|stale|cold\s*trail)\b/.test(lower)) {
    return {
      summary: "Showing relationship decay alerts",
      contactIds: [],
      portcos: [],
      overlay: "decay",
    };
  }
  if (/\b(opportunit|follow[- ]?up|intro path|blind)\b/.test(lower)) {
    const overlay = /\bblind\b/.test(lower) ? "blindspots" : "opportunity";
    return {
      summary: overlay === "blindspots" ? "Portfolio blind spots" : "Opportunity overlays",
      contactIds: [],
      portcos: [],
      overlay,
    };
  }

  // Path / through patterns
  const pathMatch =
    lower.match(/\b(?:path|trace|route)\s+from\s+(.+?)\s+to\s+(.+)$/i) ||
    lower.match(/\bfrom\s+(.+?)\s+to\s+(.+)$/i);
  if (pathMatch) {
    const a = pathMatch[1]!.trim();
    const b = pathMatch[2]!.trim();
    const ca = findContacts(contacts, a, 1)[0];
    const cb = findContacts(contacts, b, 1)[0];
    const pa = findPortcos(portcoNames, a, 1)[0];
    const pb = findPortcos(portcoNames, b, 1)[0];
    return {
      summary: `Pulse Trace: ${ca?.name || pa || a} → ${cb?.name || pb || b}`,
      contactIds: [ca?.id, cb?.id].filter(Boolean) as string[],
      portcos: [pa, pb].filter(Boolean) as string[],
      trace: {
        fromContactId: ca?.id,
        fromPortco: !ca ? pa : undefined,
        toContactId: cb?.id,
        toPortco: !cb ? pb : undefined,
      },
    };
  }

  // "connected to X through Y" / "everyone connected to X"
  const throughMatch = lower.match(
    /\b(?:everyone\s+)?connected\s+to\s+(.+?)(?:\s+through\s+(.+))?$/i,
  );
  if (throughMatch || lower.startsWith("connected to")) {
    const m =
      throughMatch ||
      lower.match(/\bconnected\s+to\s+(.+?)(?:\s+through\s+(.+))?$/i);
    if (m) {
      const targetPhrase = m[1]!.trim();
      const throughPhrase = m[2]?.trim();
      const portcos = findPortcos(portcoNames, targetPhrase, 3);
      const people = findContacts(contacts, targetPhrase, 3);
      let sector: string | undefined;
      if (throughPhrase) {
        const sectorHit = contacts.find(
          (c) => c.sector && norm(c.sector).includes(norm(throughPhrase)),
        );
        sector = sectorHit?.sector;
      }

      let matched = contacts.filter((c) => {
        const intros = (c.portCoIntros || []).map((p) => norm(p));
        const hitPortco = portcos.some((p) => intros.includes(norm(p)));
        const hitPerson =
          people.some((p) => p.id === c.id) ||
          people.some((p) =>
            (p.portCoIntros || []).some((intro) =>
              (c.portCoIntros || []).some((x) => norm(x) === norm(intro)),
            ),
          );
        if (!hitPortco && !hitPerson && !intros.some((i) => i.includes(norm(targetPhrase)))) {
          return false;
        }
        if (sector && c.sector !== sector) return false;
        return true;
      });

      // If target is a person, include shared-portco neighbors
      if (people[0] && matched.length < 2) {
        const seed = new Set((people[0].portCoIntros || []).map(norm));
        matched = contacts.filter((c) =>
          (c.portCoIntros || []).some((p) => seed.has(norm(p))),
        );
        if (sector) matched = matched.filter((c) => c.sector === sector);
      }

      return {
        summary: sector
          ? `Connected to ${portcos[0] || people[0]?.name || targetPhrase} through ${sector}`
          : `Connected to ${portcos[0] || people[0]?.name || targetPhrase}`,
        contactIds: matched.map((c) => c.id),
        portcos: portcos.length ? portcos : [...new Set(matched.flatMap((c) => c.portCoIntros || []))].slice(0, 5),
        sector,
      };
    }
  }

  // Sector + role
  if (/\binvestor/.test(lower)) {
    const sectorWord = lower.replace(/investors?/g, "").replace(/show|me|all|the/g, " ").trim();
    let list = contacts.filter((c) => {
      const t = (c.contactType || "").toLowerCase();
      const title = (c.title || "").toLowerCase();
      return t === "vc" || /investor|partner|gp/.test(title);
    });
    if (sectorWord.length > 2) {
      list = list.filter(
        (c) =>
          norm(c.sector).includes(sectorWord) ||
          (c.areasOfInterest || []).some((a) => norm(a).includes(sectorWord)),
      );
    }
    return {
      summary: `Investors${sectorWord ? ` · ${sectorWord}` : ""} (${list.length})`,
      contactIds: list.map((c) => c.id),
      portcos: [],
      sector: list[0]?.sector,
    };
  }

  // Temperature shortcuts
  if (/\b(hot|council|warm)\b/.test(lower)) {
    const temp = /\bcouncil\b/.test(lower)
      ? "Council"
      : /\bhot\b/.test(lower)
        ? "Hot"
        : "Warm";
    const list = contacts.filter((c) => c.temperature === temp);
    return {
      summary: `${temp} relationships (${list.length})`,
      contactIds: list.map((c) => c.id),
      portcos: [],
    };
  }

  // Generic: name / company / portco / sector search
  const people = findContacts(contacts, q, 10);
  const portcos = findPortcos(portcoNames, q, 5);
  const sectorMatches = contacts.filter((c) => c.sector && scoreNameMatch(q, c.sector) >= 60);

  if (people.length || portcos.length || sectorMatches.length) {
    const ids = new Set([
      ...people.map((c) => c.id),
      ...sectorMatches.map((c) => c.id),
    ]);
    // If portco hit, include its orbit
    for (const p of portcos) {
      for (const c of contacts) {
        if ((c.portCoIntros || []).some((x) => norm(x) === norm(p))) ids.add(c.id);
      }
    }
    return {
      summary:
        portcos[0]
          ? `Focusing ${portcos[0]} and orbit`
          : people[0]
            ? `Found ${people[0].name}`
            : `Sector match · ${sectorMatches[0]?.sector}`,
      contactIds: [...ids],
      portcos,
      sector: sectorMatches[0]?.sector,
    };
  }

  return {
    summary: "No matches — try “bridges”, “cooling”, “connected to …”, or a name",
    contactIds: [],
    portcos: [],
  };
}
