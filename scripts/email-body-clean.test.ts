// Run: npx tsx scripts/email-body-clean.test.ts

import {
  cleanForwardedResearchBody,
  decodeBasicEntities,
  excerptForEntity,
  fixMailtoArtifacts,
  isEmailChromeText,
  isWeakResearchSnippet,
  researchCardCopy,
} from "../src/lib/email-body-clean";
import { buildFeed } from "../src/lib/signal-feed";
import type { GmailSignal } from "../src/utils/gmail.functions";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("— decode / mailto —");
check("decodes lt/gt", decodeBasicEntities("a&lt;b&gt;c") === "a<b>c");
check(
  "fixes emailmailto:email",
  fixMailtoArtifacts("Scott.Darling@dell.commailto:Scott.Darling@dell.com") ===
    "Scott.Darling@dell.com",
);

console.log("— chrome detection —");
check(
  "internal banner is chrome",
  isEmailChromeText("Internal Use - Confidential From: Portillo, Becky"),
);
  check("real blurb is not chrome", !isEmailChromeText("Siemens expands industrial AI."));
  check(
    "covered-in placeholder is weak",
    isWeakResearchSnippet("Siemens covered in 451 Research (2026-08-10)."),
  );
  check(
    "real finding is not weak",
    !isWeakResearchSnippet(
      "Siemens is doubling down on factory-floor AI copilots for discrete manufacturers.",
    ),
  );

function sampleForward(opts: {
  publisher: string;
  fromEmail: string;
  sections: Array<{ name: string; blurb: string }>;
}): string {
  const body = opts.sections.map((s) => `${s.name}: ${s.blurb}`).join("\n\n");
  return `
Internal Use - Confidential
From: Forwarder, Alex <alex@employer.com&gt;
Sent: Monday, August 10, 2026 9:12 AM
To: Colleague, Sam <sam@employer.commailto:sam@employer.com>
Subject: RE: ${opts.publisher}: ${opts.sections.map((s) => s.name).join(", ")}

FYI team — worth a look.

-----Original Message-----
From: ${opts.publisher} <${opts.fromEmail}>
Sent: Monday, August 10, 2026 8:04:46 AM
To: news@example.com
Subject: ${opts.publisher}: ${opts.sections.map((s) => s.name).join(", ")}

${body}
`.trim();
}

console.log("— cleanForwardedResearchBody (publisher-agnostic) —");
{
  const raw = sampleForward({
    publisher: "451 Research",
    fromEmail: "451daily@451research.com",
    sections: [
      { name: "Siemens AG", blurb: "The industrial giant is doubling down on factory-floor AI copilots." },
      { name: "EnergyHub", blurb: "The DER orchestration vendor closed a growth round." },
    ],
  });
  const cleaned = cleanForwardedResearchBody(raw, { publisherHint: "451 Research" });
  check("drops forwarder From banner", !/Forwarder|Alex/i.test(cleaned), cleaned.slice(0, 120));
  check("keeps research blurb", /factory-floor AI/i.test(cleaned), cleaned.slice(0, 200));
  check("no mailto junk", !/mailto:/i.test(cleaned), cleaned.slice(0, 120));
  check("no raw entities", !/&lt;|&gt;/.test(cleaned), cleaned.slice(0, 120));
}
{
  // No publisher hint — still peel Original Message stack.
  const raw = sampleForward({
    publisher: "Gartner",
    fromEmail: "alerts@gartner.com",
    sections: [{ name: "Snowflake", blurb: "Gartner notes expanding data-cloud consolidation among enterprises." }],
  });
  const cleaned = cleanForwardedResearchBody(raw);
  check("separator peel without hint", /data-cloud consolidation/i.test(cleaned), cleaned.slice(0, 200));
  check("separator drops forwarder", !/Forwarder, Alex/i.test(cleaned), cleaned.slice(0, 120));
}

console.log("— excerptForEntity —");
{
  const cleaned = cleanForwardedResearchBody(
    sampleForward({
      publisher: "Forrester",
      fromEmail: "research@forrester.com",
      sections: [
        { name: "Acme Corp", blurb: "Acme Corp launched a new zero-trust edge fabric for mid-market." },
        { name: "Beta Systems", blurb: "Beta Systems extended its SAP practice into AI ops." },
      ],
    }),
    { publisherHint: "Forrester" },
  );
  const acme = excerptForEntity(cleaned, "Acme Corp");
  check("Acme excerpt mentions Acme", /Acme/i.test(acme), acme);
  check("Acme excerpt not Beta-led", !/^Beta Systems/i.test(acme.trim()), acme);
}

console.log("— researchCardCopy —");
{
  const copy = researchCardCopy({
    rawBody: sampleForward({
      publisher: "IDC",
      fromEmail: "news@idc.com",
      sections: [
        { name: "VendorOne", blurb: "VendorOne is shipping an agentic SOC workflow to MSSPs." },
      ],
    }),
    gmailSnippet: "Internal Use - Confidential From: Forwarder, Alex",
    entity: "VendorOne",
    publisherName: "IDC",
    dateLabel: "2026-08-10",
  });
  check("snippet not chrome", !isEmailChromeText(copy.snippet), copy.snippet);
  check("body has research text", /agentic SOC|VendorOne/i.test(copy.body), copy.body.slice(0, 180));
}

console.log("— feed dedupe is company-scoped (any shared URL) —");
{
  const permalink = "https://mail.google.com/mail/u/0/#all/abc123";
  const entities = ["Alpha", "Beta", "Gamma"];
  const emails: GmailSignal[] = entities.map((company, i) => ({
    id: `msg-r${i}`,
    subject: `${company} — Gartner`,
    fromName: "x",
    fromEmail: "news@x.com",
    company,
    snippet: `${company} covered in Gartner.`,
    body: `${company} covered in Gartner.`,
    date: Date.now(),
    dateLabel: "2026-08-10",
    permalink,
    digestSubject: "FW: Gartner: Alpha, Beta, Gamma",
    sourceHint: "Industry Reports",
  }));
  // Same URL + same company from a second lane still collapses to one.
  emails.push({
    ...emails[0],
    id: "msg-dup",
    snippet: "Alpha covered in Gartner (dup lane).",
  });
  const feed = buildFeed({
    recommendations: [],
    otherSignals: [],
    linkedinPosts: [],
    driveDocs: [],
    emails,
    portfolio: [],
    contacts: [],
  });
  const names = feed.map((c) => c.company).sort().join(",");
  check("three companies survive shared Gmail URL", names === "Alpha,Beta,Gamma", names);
  check(
    "same-company lanes still merge",
    (feed.find((c) => c.company === "Alpha")?.sourceCount || 1) >= 2,
    String(feed.find((c) => c.company === "Alpha")?.sourceCount),
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll email-body-clean checks passed.");
