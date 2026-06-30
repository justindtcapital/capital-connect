import { callGeminiJSON, type GeminiJSONResult } from "../gemini.server";
import type { Gem, GemKnowledge } from "./types";

// Run a Gem as a JSON completion: compose its instruction (persona + playbook +
// output contract) as the system prompt, and append the per-call KNOWLEDGE to the
// user prompt under a clearly-fenced section. The Gem's instruction tells the
// model to treat that section as ground truth and not invent beyond it.
//
// This delegates to `callGeminiJSON`, so it inherits the existing JSON
// extraction/repair, token budgeting, and error-code handling for free.
export async function runGemJSON<T>(
  gem: Gem,
  userPrompt: string,
  knowledge: GemKnowledge[] = [],
): Promise<GeminiJSONResult<T>> {
  const blocks = knowledge.filter((k) => k.content.trim());
  const grounding = blocks.length
    ? "\n\n=== KNOWLEDGE (ground truth — use it; do not invent beyond it) ===\n" +
      blocks.map((k) => `# ${k.label}\n${k.content.trim()}`).join("\n\n")
    : "";
  return callGeminiJSON<T>(gem.instruction, `${userPrompt}${grounding}`, gem.answerTokens ?? 1000);
}
