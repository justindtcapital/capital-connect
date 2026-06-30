// ── Gems ──────────────────────────────────────────────────────────
// A "Gem" is a reusable, named assistant configuration — our code-side equivalent
// of a Gemini-app Gem. It bundles a persona/instruction (the rules + an editable
// playbook + the exact output contract) with generation settings. Real, per-call
// KNOWLEDGE is supplied at run time so the model grounds on actual CRM data
// instead of guessing.
//
// NOTE: Gems are NOT a Google API feature — you can't invoke a Gem you built in
// the Gemini app from code. This is a lightweight, in-app implementation layered
// on top of the Vertex Gemini client in `gemini.server.ts`.

/** A single block of grounding context handed to a Gem for one call. */
export interface GemKnowledge {
  /** Short heading the model sees, e.g. "DTC PORTFOLIO (sector matches)". */
  label: string;
  /** The grounding text. Keep it compact — every call re-spends these tokens. */
  content: string;
}

/** A reusable assistant configuration. */
export interface Gem {
  /** Stable id (also handy if Gems are later stored in a Sheet tab for editing). */
  id: string;
  /** Human name shown in any picker / UI. */
  name: string;
  /** One-line description of what this Gem does. */
  description: string;
  /**
   * The system instruction: persona + rules + the (editable) playbook + the exact
   * output contract. This is the "soul" of the Gem and the main thing you tune.
   */
  instruction: string;
  /** Visible-answer token budget (passed through to gemini.server's genConfig). */
  answerTokens?: number;
}
