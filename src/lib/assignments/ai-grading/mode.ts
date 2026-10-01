/**
 * Experimental pipeline mode selector (replaces the AI_GRADING_SIMILARITY_ONLY /
 * AI_GRADING_LLM_ONLY booleans). Set AI_GRADING_MODE in the environment:
 *
 *   'default'          — v4 production: signals computed + fed to the LLM grader.
 *   'similarity-only'  — no LLM call; threshold rule on similarity + keywords.
 *   'llm-only'         — LLM grader with the signal layer stripped (Report 4).
 *   'hybrid'           — similarity certifies criteria at ≥ HYBRID threshold;
 *                        only rejected criteria go to an LLM review (Report 5).
 *   'v9'               — FINAL length-routed pipeline (reports FINAL section):
 *                        whole-mode submissions (≤60k chars) grade llm-only with
 *                        the FULL answer key in the cached prompt prefix (96%,
 *                        Report 10); over-budget submissions go through the
 *                        hybrid region review, also key-armed.
 *
 * Eval history for each mode: docs/designs/assignments-grading/ai-grading-eval-reports.md.
 */
export type AiGradingMode = 'default' | 'similarity-only' | 'llm-only' | 'hybrid' | 'v9'

const MODES: readonly AiGradingMode[] = ['default', 'similarity-only', 'llm-only', 'hybrid', 'v9']

/**
 * Unset → `'v9'`, the shipping pipeline (docs/designs/assignments-grading/ai-grading-eval-reports.md § FINAL,
 * which states the intended contract as "AI_GRADING_MODE unset → 'v9'").
 *
 * This previously fell back to `'default'` — the v4 pipeline — so an environment
 * without the var silently graded on a superseded, less accurate pipeline while
 * the docs claimed v9 was live. `AI_GRADING_MODE` is not set on prod Cloud Run,
 * so that was the behaviour in production. The older modes remain selectable by
 * name for eval comparisons; only the fallback changed.
 */
export function aiGradingMode(): AiGradingMode {
  const m = process.env.AI_GRADING_MODE as AiGradingMode | undefined
  return m && MODES.includes(m) ? m : 'v9'
}
