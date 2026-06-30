// Rule-based inference of a contact's interest domains from their title, company,
// and sector. Used to auto-populate "Areas of Interest" when the sheet has no
// manual value, and by the "Suggest" action. Deterministic and free (no API).
//
// The taxonomy is intentionally broad — a venture network is mostly executives,
// investors, and GTM/finance leaders whose titles rarely contain narrow tech
// terms, so we also key off function words and the sector field.

// domain label → keyword fragments. Tokens ≤3 chars are matched on word
// boundaries (so "ai" hits "AI Lead" but not "email"); longer ones are matched
// as substrings (so "data" still hits "database").
const DOMAIN_KEYWORDS: { domain: string; keywords: string[] }[] = [
  { domain: "Security", keywords: ["security", "ciso", "infosec", "cyber", "threat", "identity", "iam", "zero trust", "siem", "endpoint", "appsec", "soc", "fraud"] },
  { domain: "AI", keywords: ["ai", "artificial intelligence", "machine learning", "ml", "llm", "genai", "gen ai", "deep learning", "nlp", "computer vision", "data scien"] },
  { domain: "Data", keywords: ["data", "analytics", "database", "warehouse", "snowflake", "etl", "business intelligence", "bi", "governance", "dataops"] },
  { domain: "Cloud", keywords: ["cloud", "devops", "kubernetes", "sre", "platform", "infrastructure", "aws", "azure", "gcp", "container", "site reliability"] },
  { domain: "Engineering", keywords: ["engineer", "software", "developer", "architect", "technical", "cto", "technology"] },
  { domain: "Product", keywords: ["product", "ux", "user experience", "design"] },
  { domain: "Sales", keywords: ["sales", "account executive", "revenue", "cro", "gtm", "go-to-market", "business development", "partnerships", "account manager", "account director"] },
  { domain: "Marketing", keywords: ["marketing", "brand", "demand gen", "growth", "cmo", "communications", "comms"] },
  { domain: "Finance", keywords: ["finance", "cfo", "accounting", "controller", "treasury", "fp&a", "audit"] },
  { domain: "Operations", keywords: ["operations", "coo", "ops", "chief of staff", "program manager"] },
  { domain: "Supply Chain", keywords: ["supply chain", "procurement", "sourcing", "inventory", "manufacturing"] },
  { domain: "Logistics", keywords: ["logistics", "fulfillment", "transportation", "freight", "delivery", "shipping", "fleet"] },
  { domain: "People", keywords: ["human resources", "hr", "people", "talent", "recruiting", "chro"] },
  { domain: "Legal", keywords: ["legal", "counsel", "compliance", "regulatory", "privacy"] },
  { domain: "Healthcare", keywords: ["health", "clinical", "medical", "biotech", "pharma", "life science"] },
  { domain: "Fintech", keywords: ["fintech", "payments", "banking", "bank", "lending", "insurance", "capital markets", "wealth"] },
  { domain: "Public Sector", keywords: ["government", "defense", "public sector", "federal", "military", "gov", "intelligence community"] },
  { domain: "Silicon", keywords: ["silicon", "semiconductor", "chip", "hardware", "fpga", "asic", "embedded", "firmware"] },
  { domain: "Energy", keywords: ["energy", "utilities", "renewable", "grid", "oil", "gas", "climate"] },
  { domain: "Investing", keywords: ["investor", "venture", "partner", "principal", "managing director", "capital", "private equity", "fund", "vc"] },
];

function matches(hay: string, keyword: string): boolean {
  if (keyword.length <= 3) {
    // Word-boundary match for short, ambiguous tokens.
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(hay);
  }
  return hay.includes(keyword);
}

// Infer interest domains from a title + company + (optional) sector. Returns a
// de-duplicated list in taxonomy order. Empty when nothing matches.
export function inferInterestAreas(title: string, company: string, sector = ""): string[] {
  const hay = ` ${(title || "").toLowerCase()} ${(company || "").toLowerCase()} ${(sector || "").toLowerCase()} `;
  const out: string[] = [];
  for (const { domain, keywords } of DOMAIN_KEYWORDS) {
    if (keywords.some((k) => matches(hay, k))) out.push(domain);
  }
  return out;
}
