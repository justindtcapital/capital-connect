// Client-side export of saved Platform Content rows.
//
// One HTML builder feeds both formats, dependency-free:
// - Word: HTML blob saved as .doc (Word opens HTML documents natively).
// - PDF: a print-styled popup + window.print(), so the browser's
//   "Save as PDF" destination does the rendering.

import {
  CONTENT_TYPE_LABELS,
  type BoardArticlePayload,
  type DiligencePayload,
  type ExecBriefPayload,
  type MgmtQuestionsPayload,
  type PlatformContentRow,
} from "@/lib/platform-content";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Minimal markdown → HTML for the prose fields (bold/italic/paragraphs).
function prose(s: string): string {
  const safe = esc(s ?? "");
  return safe
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p>${p
          .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
          .replace(/\*([^*]+)\*/g, "<em>$1</em>")
          .replace(/\n/g, "<br/>")}</p>`,
    )
    .join("");
}

function link(url: string): string {
  return `<a href="${esc(url)}">${esc(url)}</a>`;
}

type SourceMeta = { url: string; title: string; domain: string };
type MetaMap = Map<string, SourceMeta>;

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

/** A readable citation label: "Publisher · domain", or just the domain. */
function citeLabel(url: string, meta?: MetaMap): string {
  const m = meta?.get(url);
  const domain = m?.domain || hostnameOf(url);
  const title = (m?.title || "").trim();
  return title && title.toLowerCase() !== domain.toLowerCase() ? `${title} · ${domain}` : domain;
}

/** A source link labelled with the publisher rather than the raw URL. */
function citeLink(url: string, meta?: MetaMap): string {
  return `<a href="${esc(url)}">${esc(citeLabel(url, meta))}</a>`;
}

function metaMap(rows?: SourceMeta[]): MetaMap {
  return new Map((rows ?? []).map((m) => [m.url, m] as [string, SourceMeta]));
}

function sourcesSection(urls: string[], meta?: MetaMap): string {
  if (!urls?.length) return "";
  return `<h2>Sources</h2><ul>${urls
    .map((u) => `<li><strong>${esc(citeLabel(u, meta))}</strong> — ${link(u)}</li>`)
    .join("")}</ul>`;
}

function questionsSection(
  questions: { area: string; question: string; why: string }[],
  heading: string,
): string {
  if (!questions?.length) return "";
  const areas = [...new Set(questions.map((q) => q.area || "General"))];
  const body = areas
    .map(
      (area) =>
        `<h3>${esc(area)}</h3><ul>${questions
          .filter((q) => (q.area || "General") === area)
          .map(
            (q) =>
              `<li><strong>${esc(q.question)}</strong>${q.why ? `<br/><span class="why">Why: ${esc(q.why)}</span>` : ""}</li>`,
          )
          .join("")}</ul>`,
    )
    .join("");
  return `<h2>${esc(heading)}</h2>${body}`;
}

function landscapeTierRows(
  label: string,
  players?: { company: string; note: string; sourceUrl?: string }[],
  meta?: MetaMap,
): string {
  if (!players?.length) return "";
  return `<h3>${esc(label)}</h3><ul>${players
    .map(
      (x) =>
        `<li><strong>${esc(x.company)}</strong>${x.note ? ` — ${esc(x.note)}` : ""}${x.sourceUrl ? ` (${citeLink(x.sourceUrl, meta)})` : ""}</li>`,
    )
    .join("")}</ul>`;
}

function stars(n: number, max = 5): string {
  const filled = Math.max(0, Math.min(max, Math.round(n)));
  return "★".repeat(filled) + "☆".repeat(max - filled);
}

function execBriefBody(p: ExecBriefPayload): string {
  const meta = metaMap(p.sourceMeta);
  const src = (u?: string) => (u ? ` (${citeLink(u, meta)})` : "");
  let html = "";

  // Investment thesis
  if (p.thesis || p.tldr) html += `<h2>Investment thesis</h2>${prose(p.thesis || p.tldr)}`;

  // At a glance
  const g = p.atAGlance;
  if (
    g &&
    (g.convictionScore != null ||
      g.stageAttractiveness != null ||
      g.marketMaturity ||
      g.capitalIntensity ||
      g.competitiveDensity ||
      g.exitWindow)
  ) {
    const rows: [string, string][] = [];
    if (g.convictionScore != null)
      rows.push(["Overall VC conviction", `${g.convictionScore.toFixed(1)} / 10`]);
    if (g.stageAttractiveness != null)
      rows.push(["Stage attractiveness", stars(g.stageAttractiveness)]);
    if (g.marketMaturity) rows.push(["Market maturity", g.marketMaturity]);
    if (g.capitalIntensity) rows.push(["Capital intensity", g.capitalIntensity]);
    if (g.competitiveDensity) rows.push(["Competitive density", g.competitiveDensity]);
    if (g.exitWindow) rows.push(["Exit window", g.exitWindow]);
    html += `<h2>At a glance</h2><table>${rows
      .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
      .join("")}</table>`;
  }

  // Investment scorecard
  if (p.scorecard?.length) {
    html += `<h2>Investment scorecard</h2><p class="why">10 = most attractive to an investor.</p><table><tr><th>Category</th><th>Score</th><th>Note</th></tr>${p.scorecard
      .map(
        (s) =>
          `<tr><td>${esc(s.category)}</td><td>${esc(String(s.score))}/10</td><td>${esc(s.note ?? "")}</td></tr>`,
      )
      .join("")}</table>`;
  }

  // Why now
  if (p.whyNow?.length) {
    html += `<h2>Why now</h2><ul>${p.whyNow
      .map(
        (w) =>
          `<li><strong>${esc(w.driver)}</strong>${w.detail ? ` — ${esc(w.detail)}` : ""}${src(w.sourceUrl)}</li>`,
      )
      .join("")}</ul>`;
  }

  // Market dynamics
  const dyn = p.marketDynamics;
  if (dyn && (dyn.narrative || dyn.budgetOwners || dyn.buyingCycle || dyn.unitEconomics)) {
    html += `<h2>Market dynamics</h2>`;
    if (dyn.narrative) html += prose(dyn.narrative);
    const dr: [string, string | undefined][] = [
      ["Budget owners", dyn.budgetOwners],
      ["Buying cycle", dyn.buyingCycle],
      ["Existing spend", dyn.existingSpend],
      ["New spend", dyn.newSpend],
      ["Adoption curve", dyn.adoptionCurve],
      ["Procurement friction", dyn.procurementFriction],
      ["Replacement vs. net-new", dyn.replacementVsNetNew],
      ["Unit economics", dyn.unitEconomics],
      ["Purchasing drivers", dyn.purchasingDrivers],
    ];
    const drRows = dr.filter(([, v]) => v);
    if (drRows.length)
      html += `<table>${drRows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v as string)}</td></tr>`).join("")}</table>`;
  }

  // Market sizing
  if (p.marketSizing && (p.marketSizing.narrative || p.marketSizing.figures?.length)) {
    html += `<h2>Market sizing &amp; study</h2>`;
    if (p.marketSizing.narrative) html += prose(p.marketSizing.narrative);
    if (p.marketSizing.figures?.length) {
      html += `<table><tr><th>Metric</th><th>Value</th><th>Source</th></tr>${p.marketSizing.figures
        .map(
          (f) =>
            `<tr><td>${esc(f.label)}</td><td>${esc(f.value)}</td><td>${f.sourceUrl ? citeLink(f.sourceUrl, meta) : ""}</td></tr>`,
        )
        .join("")}</table>`;
    }
  }

  // Competitive landscape (grouped)
  if (p.competitiveLandscape?.length) {
    html += `<h2>Competitive landscape</h2>`;
    html += p.competitiveLandscape
      .map(
        (grp) =>
          `<h3>${esc(grp.category)}</h3><ul>${grp.companies
            .map(
              (c) =>
                `<li><strong>${esc(c.company)}</strong>${c.tier ? ` [${esc(c.tier)}]` : ""}${c.note ? ` — ${esc(c.note)}` : ""}${src(c.sourceUrl)}</li>`,
            )
            .join("")}</ul>`,
      )
      .join("");
  } else {
    const land = p.marketLandscape;
    if (land && (land.incumbents?.length || land.upstarts?.length || land.emerging?.length)) {
      html += `<h2>Market landscape</h2>`;
      html += landscapeTierRows("Large incumbents", land.incumbents, meta);
      html += landscapeTierRows("Mid-size upstarts", land.upstarts, meta);
      html += landscapeTierRows("Emerging startups", land.emerging, meta);
    }
  }

  // Funding landscape
  const fund = p.fundingLandscape;
  if (fund && (fund.summary || fund.largestRounds?.length || fund.benchmarks?.length)) {
    html += `<h2>Funding landscape</h2>`;
    if (fund.summary) html += prose(fund.summary);
    if (fund.benchmarks?.length)
      html += `<table><tr><th>Benchmark</th><th>Value</th></tr>${fund.benchmarks
        .map((b) => `<tr><td>${esc(b.label)}</td><td>${esc(b.value)}</td></tr>`)
        .join("")}</table>`;
    if (fund.largestRounds?.length)
      html += `<table><tr><th>Company</th><th>Amount</th><th>Stage</th><th>Investors</th></tr>${fund.largestRounds
        .map(
          (r) =>
            `<tr><td><strong>${esc(r.company)}</strong>${r.sourceUrl ? `<br/>${citeLink(r.sourceUrl, meta)}` : ""}</td><td>${esc(r.amount)}</td><td>${esc(r.stage)}</td><td>${esc(r.investors ?? "")}</td></tr>`,
        )
        .join("")}</table>`;
    if (fund.activeInvestors?.length)
      html += `<p><strong>Most active investors:</strong> ${esc(fund.activeInvestors.join(", "))}</p>`;
    if (fund.recentAcquisitions?.length)
      html += `<p><strong>Recent acquisitions</strong></p><ul>${fund.recentAcquisitions
        .map((a) => `<li>${esc(a.detail)}${src(a.sourceUrl)}</li>`)
        .join("")}</ul>`;
  } else if (p.capitalFlows && (p.capitalFlows.summary || p.capitalFlows.hotspots?.length)) {
    html += `<h2>Where the VC dollars are flowing</h2>`;
    if (p.capitalFlows.summary) html += prose(p.capitalFlows.summary);
    if (p.capitalFlows.hotspots?.length)
      html += `<ul>${p.capitalFlows.hotspots
        .map(
          (h) =>
            `<li><strong>${esc(h.area)}</strong>${h.detail ? ` — ${esc(h.detail)}` : ""}${src(h.sourceUrl)}</li>`,
        )
        .join("")}</ul>`;
  }

  // Founder map
  if (p.founderMap?.length) {
    html += `<h2>Founder map</h2><table><tr><th>Company</th><th>Founders</th><th>Background</th><th>Backers</th></tr>${p.founderMap
      .map(
        (f) =>
          `<tr><td><strong>${esc(f.company)}</strong>${f.location ? `<br/>${esc(f.location)}` : ""}${f.sourceUrl ? `<br/>${citeLink(f.sourceUrl, meta)}` : ""}</td><td>${esc(f.founders)}</td><td>${esc(f.background)}</td><td>${esc(f.investors ?? "")}</td></tr>`,
      )
      .join("")}</table>`;
  }

  // Value chain
  if (p.valueChain?.length) {
    html += `<h2>Ecosystem &amp; value chain</h2><ul>${p.valueChain
      .map(
        (l) =>
          `<li><strong>${esc(l.layer)}</strong>${l.players ? ` — ${esc(l.players)}` : ""}${l.description ? `<br/><span class="why">${esc(l.description)}</span>` : ""}</li>`,
      )
      .join("")}</ul>`;
  }

  // White space
  if (p.whiteSpace?.length) {
    html += `<h2>White space — what doesn't exist yet</h2><ul>${p.whiteSpace
      .map(
        (w) =>
          `<li><strong>${esc(w.opportunity)}</strong>${w.category ? ` [${esc(w.category)}]` : ""}${w.confidence ? ` (${esc(w.confidence)} confidence)` : ""}${w.rationale ? `<br/>${esc(w.rationale)}` : ""}</li>`,
      )
      .join("")}</ul>`;
  }

  // Where we would invest
  if (p.investHere?.length) {
    html += `<h2>Where we would invest</h2><ul>${[...p.investHere]
      .sort((a, b) => b.conviction - a.conviction)
      .map(
        (iv) =>
          `<li>${stars(iv.conviction)} <strong>${esc(iv.area)}</strong>${iv.rationale ? ` — ${esc(iv.rationale)}` : ""}</li>`,
      )
      .join("")}</ul>`;
  }

  // Where we wouldn't invest
  if (p.avoidHere?.length) {
    html += `<h2>Where we wouldn't invest</h2><ul>${p.avoidHere
      .map(
        (a) => `<li><strong>${esc(a.area)}</strong>${a.reason ? ` — ${esc(a.reason)}` : ""}</li>`,
      )
      .join("")}</ul>`;
  }

  // Bull / base / bear
  if (p.scenarios && (p.scenarios.bull || p.scenarios.base || p.scenarios.bear)) {
    html += `<h2>Bull · base · bear</h2>`;
    if (p.scenarios.bull) html += `<h3>Bull</h3>${prose(p.scenarios.bull)}`;
    if (p.scenarios.base) html += `<h3>Base</h3>${prose(p.scenarios.base)}`;
    if (p.scenarios.bear) html += `<h3>Bear</h3>${prose(p.scenarios.bear)}`;
  }

  // Risks
  const riskBlock = (title: string, items?: string[]) =>
    items?.length
      ? `<h3>${esc(title)}</h3><ul>${items.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
      : "";
  if (p.technicalRisks?.length || p.commercialRisks?.length || p.regulatoryRisks?.length) {
    html += `<h2>Risks</h2>`;
    html += riskBlock("Technical", p.technicalRisks);
    html += riskBlock("Commercial", p.commercialRisks);
    html += riskBlock("Regulatory", p.regulatoryRisks);
  }

  // Recent developments
  if (p.keyDevelopments?.length) {
    html += `<h2>Recent developments</h2><ul>${p.keyDevelopments
      .map(
        (d) =>
          `<li><strong>${esc(d.point)}</strong>${d.detail ? `<br/>${esc(d.detail)}` : ""}${d.sourceUrl ? `<br/>${citeLink(d.sourceUrl, meta)}` : ""}</li>`,
      )
      .join("")}</ul>`;
  }

  // Emerging startups
  if (p.prospectiveCompanies?.length) {
    html += `<h2>Emerging startups to explore (Seed–Series B)</h2>
<table><tr><th>Company</th><th>Stage</th><th>What they do</th><th>Why it fits the thesis</th></tr>${p.prospectiveCompanies
      .map(
        (c) =>
          `<tr><td><strong>${esc(c.company)}</strong>${c.sourceUrl ? `<br/>${citeLink(c.sourceUrl, meta)}` : ""}</td><td>${esc(c.stage)}</td><td>${esc(c.whatTheyDo)}</td><td>${esc(c.whyFits)}</td></tr>`,
      )
      .join("")}</table>`;
  }

  // Open source
  if (p.openSource?.length) {
    html += `<h2>Open-source &amp; research traction</h2><ul>${p.openSource
      .map(
        (o) =>
          `<li><strong>${esc(o.project)}</strong>${o.detail ? ` — ${esc(o.detail)}` : ""}${src(o.sourceUrl)}</li>`,
      )
      .join("")}</ul>`;
  }

  // Exit landscape
  const exit = p.exitLandscape;
  if (
    exit &&
    (exit.note ||
      exit.likelyAcquirers?.length ||
      exit.ipoCandidates?.length ||
      exit.recentDeals?.length)
  ) {
    html += `<h2>Exit landscape</h2>`;
    if (exit.note) html += prose(exit.note);
    if (exit.likelyAcquirers?.length)
      html += `<p><strong>Likely acquirers:</strong> ${esc(exit.likelyAcquirers.join(", "))}</p>`;
    if (exit.ipoCandidates?.length)
      html += `<p><strong>IPO candidates:</strong> ${esc(exit.ipoCandidates.join(", "))}</p>`;
    if (exit.recentDeals?.length)
      html += `<ul>${exit.recentDeals.map((d) => `<li>${esc(d.detail)}${src(d.sourceUrl)}</li>`).join("")}</ul>`;
  }

  // Enterprise angle
  if (p.enterpriseAngle?.length) {
    html += `<h2>Enterprise perspective</h2><ul>${p.enterpriseAngle
      .map(
        (e) =>
          `<li><strong>${esc(e.area)}</strong>${e.whyItMatters ? ` — ${esc(e.whyItMatters)}` : ""}</li>`,
      )
      .join("")}</ul>`;
  }

  // Portfolio implications
  if (p.portfolioImplications?.length) {
    html += `<h2>Portfolio implications</h2><ul>${p.portfolioImplications
      .map((x) => `<li><strong>${esc(x.company)}:</strong> ${esc(x.implication)}</li>`)
      .join("")}</ul>`;
  }

  // Metrics to watch
  if (p.metricsToWatch?.length) {
    html += `<h2>Key metrics to watch</h2><ul>${p.metricsToWatch.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>`;
  }

  // Recommended actions
  if (p.recommendedActions?.length) {
    html += `<h2>Recommended next actions</h2><ul>${p.recommendedActions
      .map(
        (a) =>
          `<li>${a.category ? `<strong>[${esc(a.category)}]</strong> ` : ""}${esc(a.action)}${a.entities?.length ? ` <span class="why">(${esc(a.entities.join(", "))})</span>` : ""}</li>`,
      )
      .join("")}</ul>`;
  }

  // Watchlist suggestions
  if (p.watchlistSuggestions?.length) {
    html += `<h2>Watchlist suggestions</h2><ul>${p.watchlistSuggestions.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`;
  }

  return html + sourcesSection(p.sources ?? [], meta);
}

function boardArticlesBody(p: BoardArticlePayload): string {
  let html = "";
  if (p.digest) html += `<h2>Digest</h2>${prose(p.digest)}`;
  if (p.articles?.length) {
    html += `<h2>Reading list</h2><ul>${p.articles
      .map(
        (a) =>
          `<li><strong>${esc(a.title)}</strong><br/>${link(a.url)}${a.whyRead ? `<br/><span class="why">${esc(a.whyRead)}</span>` : ""}</li>`,
      )
      .join("")}</ul>`;
  }
  return html;
}

function diligenceBody(p: DiligencePayload): string {
  let html = `<h2>Thesis fit: ${esc(String(p.score || "—"))} / 10</h2>`;
  if (p.dimensions?.length) {
    html += `<table><tr><th>Dimension</th><th>Score</th><th>Note</th></tr>${p.dimensions
      .map(
        (d) =>
          `<tr><td>${esc(d.name)}</td><td>${esc(String(d.score))}/10</td><td>${esc(d.note ?? "")}</td></tr>`,
      )
      .join("")}</table>`;
  }
  if (p.rationale) html += `<h2>Rationale</h2>${prose(p.rationale)}`;
  html += questionsSection(p.questions ?? [], "Questions for management");
  if (p.signalsUsed?.length) {
    html += `<h2>Internal signals used</h2><ul>${p.signalsUsed.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`;
  }
  return html + sourcesSection(p.sources ?? []);
}

export function contentToHtml(row: PlatformContentRow): string {
  let body = "";
  switch (row.type) {
    case "exec_brief":
      body = execBriefBody(row.payload as ExecBriefPayload);
      break;
    case "board_article":
      body = boardArticlesBody(row.payload as BoardArticlePayload);
      break;
    case "mgmt_questions":
      body = questionsSection(
        (row.payload as MgmtQuestionsPayload).questions ?? [],
        "Questions for management",
      );
      break;
    case "diligence":
      body = diligenceBody(row.payload as DiligencePayload);
      break;
  }
  const generated = row.generatedAt ? new Date(row.generatedAt).toLocaleString() : "";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>${esc(row.title || row.subject)}</title>
<style>
  body { font-family: Calibri, Arial, sans-serif; color: #1a1a2e; max-width: 760px; margin: 32px auto; line-height: 1.45; }
  h1 { font-size: 22px; margin-bottom: 2px; }
  h2 { font-size: 15px; margin-top: 22px; border-bottom: 1px solid #d0d5dd; padding-bottom: 3px; color: #16437e; }
  h3 { font-size: 13px; margin-top: 14px; color: #344054; }
  p, li, td, th { font-size: 12px; }
  .meta { color: #667085; font-size: 11px; margin-bottom: 18px; }
  .why { color: #667085; }
  table { border-collapse: collapse; width: 100%; margin-top: 6px; }
  th, td { border: 1px solid #d0d5dd; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #f2f4f7; }
  a { color: #175cd3; word-break: break-all; }
  ul { padding-left: 18px; }
  li { margin-bottom: 6px; }
  @media print { body { margin: 12mm; } }
</style>
</head>
<body>
<h1>${esc(row.title || row.subject)}</h1>
<div class="meta">${esc(CONTENT_TYPE_LABELS[row.type])} · ${esc(row.subject)}${generated ? ` · ${esc(generated)}` : ""}${row.generatedBy ? ` · ${esc(row.generatedBy)}` : ""} · VenturePulse</div>
${body}
</body>
</html>`;
}

function fileSlug(row: PlatformContentRow): string {
  return (row.title || row.subject || "platform-content")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Save the row as a .doc file (HTML payload — opens natively in Word). */
export function downloadWordDoc(row: PlatformContentRow): void {
  // Leading BOM keeps Word's charset detection honest.
  const blob = new Blob(["﻿", contentToHtml(row)], { type: "application/msword" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${fileSlug(row)}.doc`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Open a print-styled window and trigger the print dialog — choose
 * "Save as PDF" as the destination. Returns false if a popup blocker won.
 */
export function printContentPdf(row: PlatformContentRow): boolean {
  const w = window.open("", "_blank", "width=900,height=1000");
  if (!w) return false;
  w.document.write(contentToHtml(row));
  w.document.close();
  w.focus();
  // Give the new document a beat to lay out before the print dialog grabs it.
  setTimeout(() => w.print(), 350);
  return true;
}
