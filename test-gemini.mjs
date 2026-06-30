// Quick Vertex AI Gemini connectivity check. Reads GOOGLE_CLOUD_PROJECT /
// GEMINI_LOCATION from .env, obtains a Google Cloud access token via Application
// Default Credentials, and makes one generateContent call — printing the HTTP
// status + body so the exact error (auth / API disabled / billing) is visible.
//
// Prereq: either `gcloud auth application-default login`, or set
// GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON key (Vertex AI User).
//
// Usage:  node test-gemini.mjs

import { readFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";

const MODEL = "gemini-2.5-flash";

function readEnv() {
  const text = readFileSync(new URL("./.env", import.meta.url), "utf8");
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = readEnv();
const project = env.GOOGLE_CLOUD_PROJECT;
const location = env.GEMINI_LOCATION || "us-central1";
// Let GoogleAuth find a service-account key if one is configured in .env.
if (env.GOOGLE_APPLICATION_CREDENTIALS) process.env.GOOGLE_APPLICATION_CREDENTIALS = env.GOOGLE_APPLICATION_CREDENTIALS;

if (!project) {
  console.error("GOOGLE_CLOUD_PROJECT missing from .env");
  process.exit(1);
}

console.log(`Project: ${project}  ·  Location: ${location}  ·  Model: ${MODEL}`);

let token;
try {
  const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
  token = await auth.getAccessToken();
  console.log("Got Google Cloud access token ✔\n");
} catch (e) {
  console.error("\nFailed to get an access token. Run `gcloud auth application-default login`");
  console.error("or set GOOGLE_APPLICATION_CREDENTIALS to a service-account key.\n");
  console.error(e.message);
  process.exit(1);
}

const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${MODEL}:generateContent`;

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    contents: [{ role: "user", parts: [{ text: "Reply with the single word: ok" }] }],
    generationConfig: { maxOutputTokens: 16 + 256, thinkingConfig: { thinkingBudget: 256 } },
  }),
});

const body = await res.text();
console.log(`HTTP ${res.status} ${res.statusText}\n`);
console.log(body);
