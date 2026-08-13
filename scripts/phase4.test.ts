// Phase 4 — composites, trajectory, movement, ecosystem fixtures.
// Run: npx tsx scripts/phase4.test.ts

import {
  detectComposites,
  type EvidenceChange,
} from "../src/lib/composite-events";
import { computeTrajectory, trajectorySurpriseMult } from "../src/lib/trajectory";
import {
  detectExtractMovements,
  detectCrmMovements,
} from "../src/lib/exec-movement";
import {
  proposeRadarEntities,
  matchThesisKeywords,
} from "../src/lib/ecosystem-discovery";
import { subjectAgreementRate } from "../src/utils/signal-v3.server";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// ── Composites ───────────────────────────────────────────────────
{
  const changes: EvidenceChange[] = [
    {
      id: "1",
      entityId: "e1",
      company: "Acme",
      family: "hiring",
      metric: "ats_gtm_roles",
      dateIso: "2026-08-03",
      label: "+14 sales roles",
    },
    {
      id: "2",
      entityId: "e1",
      company: "Acme",
      family: "commercial",
      metric: "site_has_pricing",
      dateIso: "2026-07-28",
      label: "pricing page appeared",
    },
    {
      id: "3",
      entityId: "e1",
      company: "Acme",
      family: "commercial",
      metric: "site_has_enterprise",
      dateIso: "2026-08-01",
      label: "enterprise page appeared",
    },
  ];
  const { hits, stamped } = detectComposites(changes, "2026-08-12");
  assert(hits.some((h) => h.rule === "gtm_expansion"), "gtm_expansion fires");
  const gtm = hits.find((h) => h.rule === "gtm_expansion")!;
  assert(
    gtm.why.includes("sales roles") &&
      (gtm.why.toLowerCase().includes("pricing") || gtm.why.toLowerCase().includes("enterprise")),
    gtm.why,
  );
  assert(
    stamped.filter((c) => c.composedInto).length >= 2,
    "constituents stamped composedInto",
  );
}

{
  const onlyHiring: EvidenceChange[] = [
    {
      id: "1",
      entityId: "e2",
      company: "Beta",
      family: "hiring",
      metric: "ats_open_roles",
      dateIso: "2026-08-01",
      label: "+5 open roles",
    },
  ];
  const { hits } = detectComposites(onlyHiring, "2026-08-12");
  assert(hits.length === 0, "single family does not fire composite");
}

// ── Trajectory ───────────────────────────────────────────────────
{
  const pts = [
    { dateIso: "2026-04-01", value: 10 },
    { dateIso: "2026-05-01", value: 12 },
    { dateIso: "2026-06-01", value: 18 },
    { dateIso: "2026-07-01", value: 31 },
    { dateIso: "2026-08-01", value: 20 },
  ];
  const t = computeTrajectory(pts);
  assert(t.slope90d != null, "90d slope");
  assert(t.sparkline.length > 0, "sparkline");
  // Growth then drop → possible reversal
  const mult = trajectorySurpriseMult(t);
  assert(mult.value > 0, `surprise mult ${mult.value}`);
}

// ── Movement ─────────────────────────────────────────────────────
{
  const hits = detectExtractMovements(
    [
      {
        name: "Jane Founder",
        roleChange: "left Acme as co-founder to start new venture",
        quote: "Jane Founder left Acme as co-founder",
        storyCompany: "NewCo",
      },
    ],
    [{ name: "Jane Founder", company: "Acme", title: "Co-Founder & CEO" }],
  );
  assert(hits.some((h) => h.kind === "founder_movement"), "founder movement");
}

{
  const hits = detectCrmMovements(
    [{ name: "Bob Exec", email: "bob@x.com", company: "NewCo", title: "VP Sales" }],
    [{ name: "Bob Exec", email: "bob@x.com", company: "OldCo", title: "VP Sales" }],
  );
  assert(hits.length === 1 && hits[0].origin === "crm", "crm company drift");
}

// ── Ecosystem ────────────────────────────────────────────────────
{
  assert(
    matchThesisKeywords("Acme ships autonomous robotics for warehouses").includes("robotics"),
    "thesis keywords",
  );
  const props = proposeRadarEntities(
    [
      {
        name: "Quantum Widgets Inc",
        evidenceText: "quantum computing semiconductor startup",
        source: "form_d",
      },
      {
        name: "Acme",
        evidenceText: "robotics",
        source: "extract",
      },
    ],
    new Set(["acme"]),
  );
  assert(props.some((p) => p.name.includes("Quantum")), "new entity proposed");
  assert(!props.some((p) => p.name === "Acme"), "roster excluded");
}

// ── V3 shadow agreement ──────────────────────────────────────────
{
  const agr = subjectAgreementRate(
    [
      {
        doc: {
          urlKey: "x",
          url: "https://x.com/1",
          title: "t",
          text: "t",
          publishedAt: "",
          sourceHost: "x.com",
          sourceName: "x",
          kind: "article",
        },
        extract: {
          subjectCompany: "Acme",
          subjectQuote: "Acme",
          mentionedCompanies: [],
          eventType: "funding_round",
          eventTypeValid: true,
          magnitude: null,
          people: [],
          summary: "",
          publishedClaimDate: "",
          discarded: [],
        },
      },
    ],
    ["Acme", "Globex"],
  );
  assert(agr.rate === 1, `agreement ${agr.rate}`);
}

console.log("phase4.test.ts: all assertions passed");
