// Soft-gate, digest headline, and Source Type URL heuristics.
// Run: npx tsx scripts/signal-quality.test.ts   (exit 0 = all pass)

import { DEFAULT_SIGNAL_CONFIG } from "../src/lib/signal-config";
import {
  awarenessRelevanceProxy,
  digestHeadline,
  isUsableDigestSnippet,
  passesAwarenessQualityGate,
} from "../src/lib/signal-quality";
import { newsSourceType, sourceUrlLane } from "../src/lib/signal-feed";

const cfg = DEFAULT_SIGNAL_CONFIG;

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("— soft gate —");
check(
  "recommendation always passes",
  passesAwarenessQualityGate({ type: "recommendation", relevance: 0, materiality: 0 }, cfg),
);
check(
  "cold + low mat drops",
  !passesAwarenessQualityGate({ type: "awareness", relevance: 3, materiality: 1.9 }, cfg),
);
check(
  "networked proxy (rel 5) passes",
  passesAwarenessQualityGate({ type: "awareness", relevance: 5, materiality: 1.9 }, cfg),
);
check(
  "high mat cold passes",
  passesAwarenessQualityGate({ type: "awareness", relevance: 3, materiality: 6.7 }, cfg),
);
check(
  "cambodia-like mat 5.8 cold drops",
  !passesAwarenessQualityGate({ type: "awareness", relevance: 3, materiality: 5.8 }, cfg),
);
check(
  "portco proxy (rel 9) passes with low mat",
  passesAwarenessQualityGate({ type: "awareness", relevance: 9, materiality: 2 }, cfg),
);

console.log("— awareness relevance proxy —");
check(
  "portco → 9",
  awarenessRelevanceProxy({ isPortco: true, isWatch: false, networkContactCount: 0 }, cfg) === 9,
);
check(
  "watch → 7",
  awarenessRelevanceProxy({ isPortco: false, isWatch: true, networkContactCount: 0 }, cfg) === 7,
);
check(
  "networked → 5",
  awarenessRelevanceProxy({ isPortco: false, isWatch: false, networkContactCount: 2 }, cfg) === 5,
);
check(
  "cold base → 3",
  awarenessRelevanceProxy({ isPortco: false, isWatch: false, networkContactCount: 0 }, cfg) === 3,
);

console.log("— digest headline fallback —");
check("garbage 'AI' not usable", !isUsableDigestSnippet("AI"));
check("garbage 'We' not usable", !isUsableDigestSnippet("We"));
check("short fragment not usable", !isUsableDigestSnippet("approx. $1."));
check(
  "real sentence usable",
  isUsableDigestSnippet(
    "Stale context makes AI agents fail even when retrieval works across production systems.",
  ),
);
check(
  "short snippet falls back to title",
  digestHeadline("AI", "Can We Build the AI Infrastructure We Keep Promising?") ===
    "Can We Build the AI Infrastructure We Keep Promising?",
);
check(
  "usable snippet kept",
  digestHeadline(
    "Stale context makes AI agents fail even when retrieval works across production systems.",
    "Some Title",
  ).startsWith("Stale context"),
);
check(
  "empty snippet uses title",
  digestHeadline("", "Cartesia | Introducing Ink-2") === "Cartesia | Introducing Ink-2",
);

console.log("— newsSourceType URL heuristics —");
check(
  "portco blog path → PortCo Blogs",
  newsSourceType("Product/Milestone", true, "https://redis.io/blog/vector-embeddings") ===
    "PortCo Blogs",
);
check(
  "non-portco blog path → Industry Reports",
  newsSourceType("Thought Leadership", false, "https://www.netskope.com/blog/four-numbers") ===
    "Industry Reports",
);
check(
  "portco press path → PortCo News (overrides Thought Leadership)",
  newsSourceType(
    "Thought Leadership",
    true,
    "https://tetrate.io/press/tetrate-adds-token-brokering",
  ) === "PortCo News",
);
check(
  "reuters host → Industry News",
  newsSourceType("Other", false, "https://www.reuters.com/sports/soccer/celtic-sign") ===
    "Industry News",
);
check(
  "category fallback without URL",
  newsSourceType("Thought Leadership", true) === "PortCo Blogs" &&
    newsSourceType("Funding/M&A", false) === "Industry News",
);
check("blog subdomain lane", sourceUrlLane("https://blog.cloud66.com/the-leverage") === "blog");
check("insights path lane", sourceUrlLane("https://www.exotec.com/insights/foo") === "blog");
check("learn path lane", sourceUrlLane("https://www.endorlabs.com/learn/bar") === "blog");

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
