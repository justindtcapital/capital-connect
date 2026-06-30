// Heuristic classification of a person's title into a Seniority level and a
// Department. Used for client-side filtering of Contacts/Targets (which only
// store a free-text title) and to seed Sumble people-search facets (job_levels /
// job_functions) in the Network Search dialog.

export type Seniority = "C-Suite" | "SVP" | "VP" | "Director" | "Manager" | "Senior" | "Individual";

// Ordered most-senior → least so the first match wins.
export const SENIORITY_LEVELS: Seniority[] = ["C-Suite", "SVP", "VP", "Director", "Manager", "Senior", "Individual"];

export function seniorityOf(title?: string): Seniority | "" {
  const t = (title || "").toLowerCase();
  if (!t) return "";
  if (/\b(c[eofitm]o|ciso|cdo|cro|cpo|cso|chief|founder|co-?founder|owner|president|managing partner|general partner)\b/.test(t))
    return "C-Suite";
  if (/\b(svp|s\.?v\.?p|senior vice president|evp|executive vice president)\b/.test(t)) return "SVP";
  if (/\b(vp|v\.?p|vice president|head of|global head|head,)\b/.test(t)) return "VP";
  if (/\bdirector\b/.test(t)) return "Director";
  if (/\b(manager|mgr)\b/.test(t)) return "Manager";
  if (/\b(senior|sr\.?|staff|principal|lead|architect)\b/.test(t)) return "Senior";
  return "Individual";
}

export type Department =
  | "Executive"
  | "Engineering"
  | "Security"
  | "Data & AI"
  | "IT"
  | "Product"
  | "Design"
  | "Sales"
  | "Marketing"
  | "Finance"
  | "Operations"
  | "People/HR"
  | "Legal"
  | "Other";

export const DEPARTMENTS: Department[] = [
  "Executive", "Engineering", "Security", "Data & AI", "IT", "Product", "Design",
  "Sales", "Marketing", "Finance", "Operations", "People/HR", "Legal", "Other",
];

// Ordered so more-specific functions win over generic ones (e.g. "Security
// Engineer" → Security, "Data Engineer" → Data & AI, before plain Engineering).
export function departmentOf(title?: string): Department | "" {
  const t = (title || "").toLowerCase();
  if (!t) return "";
  if (/\b(ceo|founder|co-?founder|owner|president|chief executive)\b/.test(t)) return "Executive";
  if (/\b(security|ciso|infosec|appsec|cyber|soc analyst|threat)\b/.test(t)) return "Security";
  if (/\b(data|analytics|machine learning|\bml\b|\bai\b|scientist|cdo)\b/.test(t)) return "Data & AI";
  if (/\b(product manager|product owner|\bproduct\b|\bcpo\b)\b/.test(t)) return "Product";
  if (/\b(design|\bux\b|\bui\b|user experience)\b/.test(t)) return "Design";
  if (/\b(engineer|engineering|developer|\bswe\b|devops|\bsre\b|software|platform|infrastructure|architect)\b/.test(t))
    return "Engineering";
  if (/\b(information technology|\bit\b|sysadmin|system administrator|helpdesk|service desk|\bcio\b)\b/.test(t)) return "IT";
  if (/\b(sales|account executive|\bae\b|business development|\bbd\b|revenue|\bcro\b|partnerships)\b/.test(t)) return "Sales";
  if (/\b(marketing|growth|demand gen|brand|communications|\bpr\b|content|\bcmo\b)\b/.test(t)) return "Marketing";
  if (/\b(finance|accounting|controller|\bcfo\b|treasur|fp&a|procurement)\b/.test(t)) return "Finance";
  if (/\b(human resources|\bhr\b|people|talent|recruit|chro)\b/.test(t)) return "People/HR";
  if (/\b(legal|counsel|compliance|attorney|general counsel|privacy)\b/.test(t)) return "Legal";
  if (/\b(operations|\bops\b|supply chain|logistics|\bcoo\b)\b/.test(t)) return "Operations";
  return "Other";
}
