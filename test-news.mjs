// Quick Event Registry (NewsAPI.ai) connectivity check. Reads NEWSAPI_KEY from
// .env and runs one getArticles query, printing the result count + a sample URL.
//
// Usage:  node test-news.mjs

import { readFileSync } from "node:fs";

function readEnv() {
  const text = readFileSync(new URL("./.env", import.meta.url), "utf8");
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const key = readEnv().NEWSAPI_KEY;
if (!key) {
  console.error("NEWSAPI_KEY missing from .env");
  process.exit(1);
}

const dateStart = new Date(Date.now() - 14 * 86400000).toISOString().split("T")[0];
console.log(`Querying Event Registry (from ${dateStart})…\n`);

const res = await fetch("https://eventregistry.org/api/v1/article/getArticles", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    action: "getArticles",
    keyword: ["OpenAI", "Nvidia"],
    keywordOper: "or",
    lang: "eng",
    dateStart,
    articlesSortBy: "date",
    articlesCount: 5,
    resultType: "articles",
    includeArticleImage: false,
    apiKey: key,
  }),
});

const data = await res.json().catch(() => ({}));
console.log(`HTTP ${res.status} ${res.statusText}`);
if (data.error) {
  console.log(`error: ${data.error}`);
} else {
  const results = data.articles?.results || [];
  console.log(`totalResults: ${data.articles?.totalResults ?? "-"}  ·  returned: ${results.length}`);
  if (results[0]) {
    console.log(`\nSample: ${results[0].title}`);
    console.log(results[0].url);
  }
}
