// Shared configuration constants for AI features (tutor chatbot,
// quiz generation, etc.). Centralizes limits and model settings.

/**
 * Maximum characters of course content to include in the AI Tutor
 * system prompt. Gemini 3 Flash supports 1M token context (~4M chars).
 * We set a generous limit while still reserving room for system prompt,
 * conversation history, and response generation.
 */
export const AI_TUTOR_MAX_CONTENT_CHARS = 500_000

/**
 * Gemini model used for the AI Tutor chatbot streaming responses.
 */
export const AI_TUTOR_MODEL = 'gemini-3-flash-preview'

/**
 * Higher-capability model for Athena (the professor assistant). This is the
 * DEFAULT model professors land on; they can switch to Flash in the composer's
 * model picker for faster, cheaper everyday drafting. Pro costs more and is
 * slower per token — a deliberate quality-over-cost default.
 */
export const PROFESSOR_ASSISTANT_PRO_MODEL = 'gemini-3.1-pro-preview'

/**
 * Gemini model used for quiz question generation.
 * Flash is fast and cheap — ideal for structured JSON generation.
 */
export const QUIZ_GENERATION_MODEL = 'gemini-3-flash-preview'

/**
 * Gemini model used for extracting key topics from lecture content.
 * Flash is fast and cheap — ideal for short structured output (string array).
 */
export const TOPIC_EXTRACTION_MODEL = 'gemini-3-flash-preview'

/**
 * Model for the quiz pipeline's ANALYSIS stages — concept extraction (upload
 * time + runtime fallback) and the answerability / topic-consistency audits.
 * Kept separate from QUIZ_GENERATION_MODEL so a cheaper tier is a one-line
 * swap (design §11d: gemini-3.1-flash-lite-preview is ~2× cheaper but saves
 * only ~1.5%/quiz — flip ONLY after a §6-style quality spot-check, since
 * concept granularity visibly differs between models).
 */
export const QUIZ_ANALYSIS_MODEL = 'gemini-3-flash-preview'

/**
 * Roadmap node checks (docs/designs/roadmap-mastery/roadmap-engine.md §14) — the short
 * "did you actually go through this paper" nudge on supplementary material.
 *
 * The cheapest tier, and the one place flash-lite is clearly right: this is
 * explicitly NOT an assessment (fixed questions, unlimited retries, never
 * graded, never fed into mastery), so the quality bar keeping
 * QUIZ_GENERATION_MODEL on Flash doesn't apply. Input is the already-distilled
 * `content.concepts` written at upload, not raw pages, so one call is a few
 * hundred tokens — no re-extraction, no vision, no embedding.
 */
export const NODE_CHECK_MODEL = 'gemini-3.1-flash-lite-preview'

/** Questions generated per item, then dealt 5 at a time, fixed per student (§14.2). */
export const NODE_CHECK_POOL_SIZE = 15
export const NODE_CHECK_DEAL = 5
/** Get this many of the five right to pass. */
export const NODE_CHECK_PASS = 4

/**
 * Hard cap on the characters of distilled source sent. Concepts are already
 * summaries so this is generous — it exists only so one enormous document
 * can't turn a fraction-of-a-cent call into a large one.
 */
export const NODE_CHECK_MAX_INPUT_CHARS = 6_000

/**
 * Gemini model used for AI project phase generation.
 * Flash is fast and cheap — ideal for structured JSON generation.
 */
export const PHASE_GENERATION_MODEL = 'gemini-3-flash-preview'

/**
 * Gemini model used to extract LaTeX formulas from rendered lecture
 * page images. Flash produced clean LaTeX on every math-heavy page
 * tested in the doc-extraction lab (experiment 14 in
 * the extraction cost benchmarks) at ~$0.0017/page.
 */
export const FORMULA_EXTRACTION_MODEL = 'gemini-3-flash-preview'

/**
 * Gemini model for drafting a Gradescope-style grading rubric from an assignment PDF.
 * One call per assignment (not per student); the professor reviews/edits the output.
 */
export const RUBRIC_GENERATION_MODEL = 'gemini-3-flash-preview'

/**
 * Gemini model for on-demand live classroom quiz generation.
 * Uses transcription + slide content to generate comprehension MCQs.
 */
export const LIVE_QUIZ_GENERATION_MODEL = 'gemini-3-flash-preview'

/**
 * Maximum combined chars (slide text + transcription) sent to the
 * live quiz generator. Generous limit within Gemini Flash's 1M context.
 */
export const LIVE_QUIZ_MAX_CONTEXT_CHARS = 100_000

/**
 * Gemini model for the CCAT (adaptive quiz v2) free-text grader and the
 * Socratic / walkthrough tutor turns. Flash is fast and cheap — node-coverage
 * grades are ~800 in / ~150 out tokens. See docs/designs/quizzes/ccat-system-design.md §5.
 */
export const QUIZ_GRADER_MODEL = 'gemini-3-flash-preview'

/**
 * Gemini model for AI-assisted assignment grading (Phase 3). Produces per-criterion
 * tick + suggestedPoints + rationale from pre-assembled similarity/keyword signals.
 * Flash is sufficient — input is structured signals, not raw content; output is
 * short structured JSON. Already priced in cost.ts.
 */
export const ASSIGNMENT_AI_GRADING_MODEL = 'gemini-3-flash-preview'

/**
 * Gemini model for the student "Catch me up" live lecture summary.
 * Same transcript+slides context as live quiz generation.
 */
export const LECTURE_SUMMARY_MODEL = 'gemini-3-flash-preview'

/**
 * Gemini model for the professor's post-session report narrative.
 * One call per ended room (report is computed once and stored).
 */
export const SESSION_REPORT_MODEL = 'gemini-3-flash-preview'

/**
 * Gemini model for Class Insights student study materials (flashcards +
 * practice quiz), generated once when a live class ends.
 */
export const CLASS_INSIGHTS_MODEL = 'gemini-3-flash-preview'

/**
 * Gemini model for the Pre-Class Primer script — a short spoken "advance
 * organizer" written from a lecture's module/deck content. Flash is ideal:
 * this is summarization-style writing, not deep reasoning.
 */
export const PRECLASS_PRIMER_MODEL = 'gemini-3-flash-preview'

/**
 * Gemini model for the "Rewrite with Athena" action on announcements — polishes
 * the professor's draft prose. Short, single-shot rewriting, not deep reasoning,
 * so Flash is ideal.
 */
export const ANNOUNCEMENT_REWRITE_MODEL = 'gemini-3-flash-preview'

/**
 * Gemini model for the roadmap student dossier's AI summary — a ~90-word
 * professor-facing narrative written from an already-computed facts snapshot
 * (mastery, lates, fumbled questions). Cached per (section, student) by
 * signal hash, so it only runs when the underlying signals change.
 * Summarizing supplied numbers is Flash-grade writing, not reasoning.
 */
export const STUDENT_INSIGHT_MODEL = 'gemini-3-flash-preview'

/**
 * Gemini model for the Class analytics drawer's AI summary — the whole-class
 * sibling of the dossier narrative, written from the same kind of pre-computed
 * facts snapshot (class mastery, standing split, weakest skills, who is
 * furthest behind). Cached per section by signal hash, so it only runs when
 * the class numbers actually move.
 */
export const CLASS_INSIGHT_MODEL = 'gemini-3-flash-preview'

/**
 * Max chars of lecture source content fed to the primer script generator.
 * A primer is a brief orienting overview, not a full recap — it needs the
 * gist, not every slide — so this is far tighter than the live-quiz budget.
 */
export const PRECLASS_PRIMER_MAX_CONTEXT_CHARS = 20_000

/**
 * Target spoken length for a primer, from the pre-lecture-priming research
 * (Mayer's pre-training principle; Seery & Donnelly's ≤5-min pre-lecture
 * resources; Guo et al. on engagement dropping past ~6 min). 450–600 words at
 * a ~150 wpm TTS delivery lands at ~3–4 minutes, inside the 5-minute cap.
 */
export const PRECLASS_PRIMER_TARGET_WORDS_MIN = 450
export const PRECLASS_PRIMER_TARGET_WORDS_MAX = 600

/**
 * Hard character ceiling on the script actually sent to TTS, to bound
 * ElevenLabs spend regardless of what the model returns. ~4500 chars ≈ 700
 * words ≈ 4.7 min — just under the 5-min cap. generate.ts truncates at a
 * sentence boundary before this so audio never cuts off mid-word.
 */
export const PRECLASS_PRIMER_MAX_TTS_CHARS = 4_500

/** Words-per-minute used to estimate a primer's audio duration for display. */
export const PRECLASS_PRIMER_WPM = 150

/* The pgvector embedding layer's constants lived here — model, dimension,
   chunk size, and the skill→page cosine threshold. All gone with
   content_embeddings (#435): the reference rail now matches topics against the
   Pinecone index, whose own pinned model and knobs live in
   src/lib/pinecone/config.ts and src/lib/pinecone/topic-pages.ts. */

/**
 * Marks a /api/chat response body as a sentence written FOR the student (quiz
 * lock, no materials yet, tutor unavailable) rather than an error string. The
 * AI SDK surfaces a failed response's body as `error.message`, which the chat
 * would otherwise have to either show raw — leaking technical text into the UI —
 * or bury under a generic "something went wrong" that contradicts the real
 * reason. The client strips the prefix and shows what follows; anything without
 * it stays generic.
 */
export const ATHENA_NOTICE_PREFIX = 'athena-notice: '
