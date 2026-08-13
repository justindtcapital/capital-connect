// Phase 3 — Stage A caps + Stage B subject validation fixtures.
// Run: npx tsx scripts/signal-extract.test.ts

import {
  applyRetrievalCaps,
  dedupeRetrievalDocs,
  retrievalFromArticle,
  type RetrievalDocument,
} from "../src/lib/signal-document";
import {
  validateSubjectClaim,
  validateExtract,
  categoryFromEventType,
} from "../src/lib/signal-extract";
import {
  auditEvidenceCompleteness,
  collectWhyGaps,
} from "../src/lib/evidence-completeness";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// ── Stage A caps ─────────────────────────────────────────────────
{
  const docs: RetrievalDocument[] = [];
  for (let i = 0; i < 20; i++) {
    docs.push(
      retrievalFromArticle({
        company: "Robotics",
        title: `Topic story ${i}`,
        description: `Body about warehouse robotics number ${i} with enough text.`,
        url: `https://news.example.com/topic/${i}`,
        source: "Example",
        publishedAt: "2026-07-01",
      }, { kind: "topic_search" })!,
    );
  }
  for (let i = 0; i < 40; i++) {
    docs.push(
      retrievalFromArticle({
        company: "Acme",
        title: `Acme news ${i}`,
        description: `Acme did something interesting ${i}.`,
        url: `https://tech.example.com/acme/${i}`,
        source: "Tech",
        publishedAt: "2026-07-01",
      })!,
    );
  }
  const { kept, overflow } = applyRetrievalCaps(docs, ["Robotics"], {
    articleCap: 36,
    topicArtCap: 16,
    emailLinkCap: 20,
    docCap: 8,
  });
  const topics = kept.filter((d) => d.kind === "topic_search");
  const companies = kept.filter((d) => d.kind === "article");
  assert(topics.length === 16, `topic cap 16 got ${topics.length}`);
  assert(companies.length === 20, `company fill to 36 total: got ${companies.length}`);
  assert(kept.length === 36, `article cap total ${kept.length}`);
  assert(overflow.length > 0, "overflow recorded");
}

{
  const a = retrievalFromArticle({
    company: "Acme",
    title: "Same",
    description: "x",
    url: "https://www.example.com/a?utm_source=x",
    source: "Ex",
    publishedAt: "2026-01-01",
  })!;
  const b = retrievalFromArticle({
    company: "Acme",
    title: "Same",
    description: "x",
    url: "https://example.com/a",
    source: "Ex",
    publishedAt: "2026-01-01",
  })!;
  const d = dedupeRetrievalDocs([a, b]);
  assert(d.length === 1, "utm variants collapse");
}

// ── Subject validation (quote-or-discard) ────────────────────────
{
  const grounded =
    "Acme Robotics announced today it has raised $20M in Series B funding led by Foo Ventures. Competitors like Globex were mentioned.";
  const ok = validateSubjectClaim(
    { name: "Acme Robotics", quote: "Acme Robotics announced today it has raised $20M" },
    grounded,
  );
  assert(ok?.name === "Acme Robotics", "subject quote persists");

  const invented = validateSubjectClaim(
    { name: "Completely Fake Co", quote: "Completely Fake Co raised billions" },
    grounded,
  );
  assert(invented === null, "invented subject discarded");

  const mentionAsSubject = validateSubjectClaim(
    { name: "Globex", quote: "Competitors like Globex were mentioned" },
    grounded,
  );
  // Quote is real — validator allows it; Stage B prompt + mentioned_companies
  // is the soft distinction. Structural rule is quote-backed.
  assert(mentionAsSubject?.name === "Globex", "quote-backed name accepted");
}

{
  const grounded =
    "Acme Robotics announced today it has raised $20M in Series B funding led by Foo Ventures.";
  const extract = validateExtract(
    {
      subject_companies: [
        { name: "Acme Robotics", quote: "Acme Robotics announced today it has raised $20M" },
      ],
      mentioned_companies: ["Foo Ventures", "Acme Robotics"],
      event_type: "funding_round",
      magnitude: { value: 20_000_000, unit: "usd", quote: "$20M" },
      people: [],
      summary: "Acme raised a Series B.",
      published_claim_date: "2026-07-01",
    },
    grounded,
  );
  assert(extract?.subjectCompany === "Acme Robotics", "primary subject");
  assert(extract?.eventType === "funding_round", "event type");
  assert(extract?.magnitude?.value === 20_000_000, "magnitude validated");
  assert(
    !extract?.mentionedCompanies.includes("Acme Robotics"),
    "subject not duplicated in mentioned",
  );
  assert(categoryFromEventType("funding_round") === "Funding/M&A", "category map");
}

{
  const grounded = "Short blurb with no money.";
  const bad = validateExtract(
    {
      subject_companies: [{ name: "Ghost Inc", quote: "Ghost Inc raised $9B" }],
      event_type: "funding_round",
    },
    grounded,
  );
  assert(bad === null, "no valid subject → null extract");
}

// ── Evidence completeness ────────────────────────────────────────
{
  const gaps = collectWhyGaps({
    parts: [{ name: "prior", value: 7, why: "funding prior" }, { name: "broken", value: 1, why: "" }],
  });
  assert(gaps.some((g) => g.includes("parts[1].why")), `gaps: ${gaps.join(",")}`);

  const audit = auditEvidenceCompleteness([
    {
      id: "s1",
      rankScore: 40,
      scoreBreakdown: JSON.stringify({
        gate: { outcome: "pass", reasons: ["cleared"] },
        parts: [{ name: "prior", value: 7, why: "funding prior" }],
      }),
    },
    {
      id: "s2",
      rankScore: 50,
      scoreBreakdown: "not-json",
    },
  ]);
  assert(audit.checked === 2, "checked both");
  assert(audit.incomplete >= 1, "unparseable flagged");
}

console.log("signal-extract.test.ts: all assertions passed");
