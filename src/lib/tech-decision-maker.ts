import { departmentOf, seniorityOf, type Department, type Seniority } from "@/lib/people-classify";

export type TechDecisionLevel = "primary" | "influencer" | "unlikely" | "unknown";

export interface TechDecisionAssessment {
  /** True when the person likely chooses or heavily influences stack decisions. */
  isDecisionMaker: boolean;
  level: TechDecisionLevel;
  reason: string;
  seniority: Seniority | "";
  department: Department | "";
}

const PRIMARY_TITLE =
  /\b(cio|cto|ciso|cdo|cpo|chief\s+(information|technology|digital|data|product|security)\s+officer|chief\s+(information|technology|digital|data|product|security)|vp\s+(of\s+)?(engineering|technology|it|infrastructure|platform|security|data|ai|cloud)|vice\s+president\s+(of\s+)?(engineering|technology|it|infrastructure|platform|security|data)|head\s+of\s+(engineering|technology|it|infrastructure|platform|security|data|ai|cloud|product)|global\s+head\s+of\s+(engineering|technology|it|security))\b/i;

const INFLUENCER_TITLE =
  /\b(director\s+(of\s+)?(engineering|technology|it|infrastructure|platform|security|data|ai|architecture)|engineering\s+director|it\s+director|principal\s+(engineer|architect)|staff\s+architect|enterprise\s+architect|solutions?\s+architect|manager\s+(of\s+)?(engineering|it|infrastructure|platform|security))\b/i;

const TECH_BUYING_DEPTS: Department[] = [
  "Executive",
  "Engineering",
  "Security",
  "Data & AI",
  "IT",
  "Product",
];

const BUYING_SENIORITY: Seniority[] = ["C-Suite", "SVP", "VP", "Director"];

/**
 * Heuristic: is this contact likely a decision maker (or strong influencer)
 * on which technologies their company adopts?
 */
export function assessTechDecisionMaker(title?: string): TechDecisionAssessment {
  const t = (title || "").trim();
  if (!t) {
    return {
      isDecisionMaker: false,
      level: "unknown",
      reason: "No title on file — can't assess technology buying authority.",
      seniority: "",
      department: "",
    };
  }

  const seniority = seniorityOf(t);
  const department = departmentOf(t);

  if (PRIMARY_TITLE.test(t)) {
    return {
      isDecisionMaker: true,
      level: "primary",
      reason: `Title "${t}" indicates primary authority over technology selection.`,
      seniority,
      department,
    };
  }

  if (INFLUENCER_TITLE.test(t)) {
    return {
      isDecisionMaker: true,
      level: "influencer",
      reason: `Title "${t}" typically influences or owns stack decisions.`,
      seniority,
      department,
    };
  }

  // Senior leaders in tech-buying departments even without exact CIO/CTO phrasing.
  if (
    BUYING_SENIORITY.includes(seniority as Seniority) &&
    TECH_BUYING_DEPTS.includes(department as Department)
  ) {
    return {
      isDecisionMaker: true,
      level: seniority === "Director" ? "influencer" : "primary",
      reason: `${seniority} in ${department} — likely involved in technology purchase decisions.`,
      seniority,
      department,
    };
  }

  if (TECH_BUYING_DEPTS.includes(department as Department) && seniority === "Manager") {
    return {
      isDecisionMaker: false,
      level: "influencer",
      reason: `Manager in ${department} — may influence tools, rarely the final stack decision-maker.`,
      seniority,
      department,
    };
  }

  if (department === "Sales" || department === "Marketing" || department === "People/HR") {
    return {
      isDecisionMaker: false,
      level: "unlikely",
      reason: `${department} roles rarely choose the company's technology stack.`,
      seniority,
      department,
    };
  }

  if (seniority === "Individual" || seniority === "Senior") {
    return {
      isDecisionMaker: false,
      level: "unlikely",
      reason: `Individual-contributor level (${seniority || "IC"}) — typically uses stack, does not select it.`,
      seniority,
      department,
    };
  }

  return {
    isDecisionMaker: false,
    level: "unlikely",
    reason: `Based on "${t}", this contact is unlikely to own technology selection.`,
    seniority,
    department,
  };
}
