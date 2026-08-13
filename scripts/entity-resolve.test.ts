// Phase 1 — entity resolve ladder fixtures.
// Run: npx tsx scripts/entity-resolve.test.ts

import {
  resolveEntity,
  fuzzyCandidates,
  autoAliases,
  type EntityRegistry,
} from "../src/lib/entity-resolve";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const registry: EntityRegistry = {
  entities: [
    {
      entityId: "e-mercury-fin",
      canonicalName: "Mercury",
      primaryDomain: "mercury.com",
      aliases: ["Mercury Banking", "Mercury Technologies"],
      sector: "fintech",
      xref: { ats: "greenhouse:mercury" },
    },
    {
      entityId: "e-mercury-robot",
      canonicalName: "Mercury Robotics",
      primaryDomain: "mercuryrobotics.io",
      aliases: ["Mercury", "Mercury Robot"],
      sector: "robotics",
    },
    {
      entityId: "e-scaleai",
      canonicalName: "Scale AI",
      primaryDomain: "scale.com",
      aliases: ["Scale"],
    },
    {
      entityId: "e-scaled-agile",
      canonicalName: "Scaled Agile",
      primaryDomain: "scaledagile.com",
      aliases: ["Scaled Agile Inc"],
    },
    {
      entityId: "e-meta",
      canonicalName: "Meta Platforms",
      primaryDomain: "meta.com",
      aliases: ["Meta", "Facebook"],
      xref: { cik: "0001326801" },
    },
    {
      entityId: "e-stripe",
      canonicalName: "Stripe",
      primaryDomain: "stripe.com",
      aliases: ["Stripe Inc"],
      xref: { ats: "greenhouse:stripe", github: "stripe" },
    },
  ],
};

// Domain beats name
{
  const r = resolveEntity({ name: "Totally Wrong", domain: "stripe.com" }, registry);
  assert(r.rung === "domain" && r.entityId === "e-stripe", `domain rung: ${JSON.stringify(r)}`);
}

// Registry key
{
  const r = resolveEntity({ atsRef: "greenhouse:stripe" }, registry);
  assert(r.rung === "registry_key" && r.entityId === "e-stripe", `ats key: ${JSON.stringify(r)}`);
  const c = resolveEntity({ cik: "0001326801" }, registry);
  assert(c.rung === "registry_key" && c.entityId === "e-meta", `cik: ${JSON.stringify(c)}`);
}

// Alias exact unique
{
  const r = resolveEntity({ name: "Stripe Inc" }, registry);
  assert(r.rung === "alias_exact" && r.entityId === "e-stripe", `alias: ${JSON.stringify(r)}`);
}

// Two Mercurys + fintech context → resolves; no context → ambiguous
{
  const withCtx = resolveEntity(
    { name: "Mercury", context: { sector: "fintech" } },
    registry,
  );
  assert(
    withCtx.rung === "fuzzy_corroborated" && withCtx.entityId === "e-mercury-fin",
    `mercury+fintech: ${JSON.stringify(withCtx)}`,
  );

  const noCtx = resolveEntity({ name: "Mercury" }, registry);
  assert(noCtx.rung === "ambiguous", `mercury no ctx: ${noCtx.rung}`);
  assert((noCtx.candidates || []).length === 2, "two mercury candidates");
}

// Scale vs Scaled Agile — "Scale" should not silently become Scaled Agile
{
  const hits = fuzzyCandidates("Scale", registry);
  const ids = hits.map((h) => h.entityId);
  assert(ids.includes("e-scaleai"), "Scale should hit Scale AI");
  // Containment into Scaled Agile should be rejected via leftover conflict when Scale AI exists
  const scaledOnly = resolveEntity({ name: "Scale" }, registry);
  assert(
    scaledOnly.rung === "alias_exact" && scaledOnly.entityId === "e-scaleai",
    `Scale → Scale AI via alias: ${JSON.stringify(scaledOnly)}`,
  );
}

// Meta vs Meta Platforms
{
  const r = resolveEntity({ name: "Meta" }, registry);
  assert(r.rung === "alias_exact" && r.entityId === "e-meta", `Meta: ${JSON.stringify(r)}`);
}

// Suffix auto-aliases
{
  const a = autoAliases("Acme Technologies, Inc.");
  assert(a.some((x) => /acme/i.test(x)), `autoAliases: ${a.join("|")}`);
}

// Unknown industry name
{
  const r = resolveEntity({ name: "Completely Unknown Startup XYZ" }, registry);
  assert(r.rung === "unknown", `unknown: ${r.rung}`);
}

console.log("entity-resolve.test.ts: all assertions passed");
