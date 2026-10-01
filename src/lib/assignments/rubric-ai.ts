/**
 * AI rubric generation — drafts a Gradescope-style grading rubric from an assignment's
 * PDF text. SERVER-ONLY: imports the Gemini provider (reads GOOGLE_GENERATIVE_AI_API_KEY).
 *
 * One call per assignment (not per student), and the AI never sees student work — it only
 * proposes a rubric the professor then reviews/edits. Output is schema-validated by the
 * `ai` SDK against a generation-time rubric schema, so callers get typed data (or null on failure).
 */

import { z } from 'zod'
import { generateObject, NoObjectGeneratedError } from 'ai'
import { google } from '@ai-sdk/google'
import { RUBRIC_GENERATION_MODEL } from '@/lib/ai/config'
import { rubricCriterionSchema, rubricQuestionSchema } from '@/lib/validations/assignment'
import { logger } from '@/lib/logger'
import { recordAiUsage, type AiAttribution } from '@/lib/ai/usage'

const SYSTEM_PROMPT = `You are an expert teaching assistant building a grading rubric, Gradescope-style.

You are given the text of an assignment (the questions students must answer). Produce a
rubric that an instructor can grade against:
- One entry per gradable item. If a question has subparts, make a SEPARATE entry per
  subpart (label them like "Q2(a)", "Q2(b)"); otherwise one entry per question ("Q1").
- For each entry set "points" to that item's total marks (infer from the text, e.g.
  "(10 points)"; if unstated, distribute the assignment's total sensibly).
- Break each entry into concrete "criteria" — the specific things worth credit
  (e.g. "Correct algorithm", "Handles empty input", "Clear explanation"). Keep the points
  per criterion SMALL and fine-grained: prefer 1 point each, and use 2 (occasionally 3)
  only for a step that clearly carries more weight. Do NOT use large chunks like 5 or 10.
  Use as many criteria as needed so their points are all positive and sum to the entry's
  "points".
- Keep descriptions short and specific enough to grade consistently.
- The points of ALL entries together must sum EXACTLY to the assignment's total points.
  When marks stated in the text disagree with that total, scale your distribution to the
  total — it is the instructor's chosen maximum score.

Base everything on the actual assignment text — do not invent questions that aren't there.`

// Internal schema for answer-key rubric generation (includes reference answers and keywords).
// Not exported — the AI only fills these when given an answer key; callers use AssignmentRubric.
// PASS 1 (structure). Deliberately NOT the full field set: asking one call to derive questions,
// split criteria, write references, invent paraphrases + distractors, mine keywords, classify
// checkMode AND tag skills overloads it — observed output was 17 questions with each one emitted
// twice (once carrying skills, once carrying criteria), plus intermittent schema failures.
// Retrieval assets are a separate, per-question pass below.
const answerKeyCriterionSchema = rubricCriterionSchema.extend({
  referenceAnswer: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      'A correct answer to this ONE claim, written the way a STUDENT would write it: plain declarative prose, 1-3 sentences, ~150-400 chars, reason included. Never grader voice.',
    ),
})

const answerKeyQuestionSchema = z.object({
  label: z.string().min(1).max(120).describe('Question or subquestion label, e.g. "Q1" or "Q2(a)"'),
  points: z.number().nonnegative().describe('Total points for this question'),
  criteria: z.array(answerKeyCriterionSchema).default([]),
  graded: z
    .boolean()
    .optional()
    .describe('false when the key marks this item ungraded (e.g. under an "Ungraded problems" heading)'),
  scoringRules: z
    .array(z.string().min(1).max(500))
    .max(10)
    .default([])
    .describe('Partial-credit branches quoted from the key. NOT criteria.'),
  antiCriteria: z
    .array(z.string().min(1).max(500))
    .max(10)
    .default([])
    .describe('What the key explicitly says NOT to penalize. NOT criteria.'),
})

// ── PASS 2 (retrieval assets) ────────────────────────────────────────────────
// One focused call per QUESTION. Small output, one job, and a failure degrades that
// question to reference-only instead of nulling the whole rubric.
const enrichedCriterionSchema = z.object({
  // Echoed back so we can assert alignment rather than trust array position.
  description: z.string().describe('Copy the criterion description you were given, verbatim'),
  paraphrases: z
    .array(z.string().min(1).max(1000))
    .min(2)
    .max(5)
    .describe('At least 2 genuinely different correct phrasings. Synonym swaps are useless.'),
  distractors: z
    .array(z.string().min(1).max(1000))
    .min(2)
    .max(4)
    .describe('At least 2 on-topic answers a real student would give that are WRONG.'),
  absoluteKeywords: z
    .array(z.string().max(80))
    .max(8)
    .describe('Only terms similarity cannot see. Must appear verbatim in the key. [] when none.'),
  keywordAliases: z
    .array(z.object({ term: z.string().min(1).max(80), aliases: z.array(z.string().min(1).max(80)).max(8) }))
    .max(12)
    .describe('Equivalent surface forms per keyword, e.g. term "O(n log n)" aliases ["O(n lg n)"]. [] when none.'),
  checkMode: z.enum(['deterministic', 'similarity', 'open']),
})
const enrichmentSchema = z.object({
  criteria: z.array(enrichedCriterionSchema).describe('EXACTLY one entry per criterion given, same order'),
})

const ENRICHMENT_SYSTEM_PROMPT = `You write the retrieval assets an automated grader uses to match a rubric criterion against STUDENT prose. You are given one question's criteria, each with a reference answer, plus the relevant answer-key text.

Return EXACTLY one entry per criterion you were given, in the same order, echoing each "description" verbatim.

Everything you write is compared to what students actually write, so use student voice: plain declarative prose, never "Student correctly identifies…" or "Demonstrates…". Strip question numbers, point values and marking notes.

paraphrases (2-5) — genuinely DIFFERENT correct phrasings of that criterion's claim. Vary vocabulary, register and form (symbolic vs prose, terse vs verbose). This is what lets a correct answer worded unlike the key still match, so near-duplicates are worthless.

distractors (2-4) — answers a real student would plausibly give that are WRONG: on-topic, confidently stated, the sign flip, the missing case, the loose bound, the swapped quantifier. An absurd wrong answer is useless because nothing ever matches it. These matter more than the reference: a wrong-but-on-topic answer sits as close to the correct reference as a right one, so the only thing that separates them is whether the student's text is nearer a correct phrasing or a wrong one. MINE THE KEY FIRST — its partial-credit rules name the common mistakes outright.

absoluteKeywords + keywordAliases — only for what similarity CANNOT see: negation, direction, sign, a specific constant, a named theorem. Never topic words. Every keyword must appear VERBATIM in the answer-key text; if it does not, leave it out. Whenever a keyword has equivalent surface forms, add a keywordAliases entry so notation variance is not a miss (a student writing "O(n lg n)" or "depth-first search" must not be zeroed for it).

checkMode — "deterministic" when a literal or parseable answer settles it (a True/False claim, a complexity bound, an ordering, a specific counterexample); "similarity" when reference + paraphrases + distractors can decide it; "open" when correct forms are unbounded. Use "open" whenever you cannot write two paraphrases that are both clearly correct and clearly different — an honest "open" routes to a human, a wrong "similarity" silently mis-grades.`

const answerKeyRubricSchema = z.object({
  questions: z.array(answerKeyQuestionSchema).default([]),
})

// Tagging variant: questions also carry skill NAMES (the caller resolves names to
// section skill ids, minting genuinely new ones) — same contract as rubricGenSchema.
const answerKeyGenQuestionSchema = answerKeyQuestionSchema.extend({
  skills: z.array(z.string().min(1).max(200)).max(3).default([])
    .describe('Course skills this question assesses: copied exactly from the provided list, or one new concise name when nothing listed fits'),
})
const answerKeyGenSchema = z.object({ questions: z.array(answerKeyGenQuestionSchema).default([]) })

const ANSWER_KEY_SYSTEM_PROMPT = `You are building both a grading rubric AND the retrieval assets an automated grader will use, from a DETAILED ANSWER KEY (model answers, not the questions).

TWO AUDIENCES read your output, and they need opposite styles.
- "description" is read by the professor. Rubric voice is fine.
- "referenceAnswer", "paraphrases" and "distractors" are matched by a vector search engine against STUDENT prose. They must be written the way a student writes, never the way a grader writes. Grader voice here silently destroys matching.

STRUCTURE
- One entry per gradable item. Separate entry per subpart, labelled "Q2(a)", "Q2(b)"; otherwise "Q1".
- Set "points" from the key's own rubric (e.g. "Rubric (10 pts)"). If unstated, distribute the assignment total sensibly.
- POINT BUDGET, check this before you answer: each entry's criteria points must sum to that entry's "points", and the "points" of all GRADED entries must sum to exactly the assignment total given in the prompt. Ungraded entries get 0. Do not let a partial-credit branch add points on top of the criteria.
- If the key marks items as ungraded (e.g. a heading "Ungraded problems"), still emit them but set "graded": false.
- Mirror the key's own rubric bullets where it has them — they are the professor's real criteria.

ONE CLAIM PER CRITERION. This is the most important structural rule.
- A criterion asserts exactly ONE checkable thing. If a key bullet covers several ("1 point for correctly placing each of the 7 functions"), emit one criterion PER item.
- If a description needs "and" to join two assertions, split it. A criterion covering three claims produces a reference vector that averages three directions and matches none of them.

FINE-GRAINED POINTS — this is where partial credit comes from.
- Keep points per criterion SMALL: prefer 1-3 points each. NEVER emit a single criterion worth 5 or more — split it into smaller criteria. Grading ticks each criterion all-or-nothing, so a 12-point subpart written as ONE criterion can only score 0 or 12: a student who gets it half right is scored as if they wrote nothing.
- When the key allocates points to distinct parts of an answer ("4 pt for the recurrence, 3 pt for a correct base case, 3 pt for the O(n log n) bound"), emit ONE criterion per part with those exact points. That positive breakdown IS the criteria — mirror it line for line. (Only genuinely conditional branches — mutually exclusive score levels for the same claim, e.g. "full if optimal, half if O(n^2)" — belong in scoringRules, never criteria.)
- You are dividing a subpart's total into gradeable pieces, not adding points: the criteria still sum to that subpart's points.

WRITING referenceAnswer — treat it as a search query, not a rubric line.
- Plain declarative prose a student would actually write. 1 to 3 sentences, roughly 150-400 characters.
- Include the REASON, not only the conclusion. Students write "because".
- NEVER write "Student correctly identifies…", "Demonstrates…", "Provides a correct…". Those words appear in no student answer and pull the vector away from every one of them.
- Strip all non-answer content: question numbers, point values, "Solution:", "Rubric:", marking notes, LaTeX wrappers. Shared boilerplate across criteria pulls all their vectors together and makes them indistinguishable.
- Stay grounded in the key's content. Do not invent claims the key does not make.

scoringRules and antiCriteria are NOT criteria, and you must never mint a criterion from either.
- "scoringRules": partial-credit branches, quoted from the key.
- "antiCriteria": anything the key explicitly says not to penalize, e.g. "No penalty for not mentioning the disconnected case". Putting it here is what prevents an instruction to IGNORE something from becoming something students lose points for.

Base everything on the actual answer key text. Do not invent questions, answers, or criteria.`

/**
 * Generate a rubric with reference answers from an answer key PDF's text. Returns null on any
 * failure. The AI never sees student work. When `candidateSkills` (the tagged modules' skill
 * pool) is non-empty, the SAME pass also tags each question with 1-3 skills by exact name
 * (minting rules in SKILL_TAGGING_PROMPT); the caller resolves names to section skill ids.
 * Note: the 20k-char slice may truncate very long answer keys — acceptable trade-off for v1.
 */
export async function generateRubricFromAnswerKey(
  keyText: string,
  totalPoints: number,
  attribution?: AiAttribution,
  candidateSkills: string[] = [],
): Promise<RubricDraftWithSkillNames | null> {
  const text = keyText.trim()
  if (!text) return null
  const tagging = candidateSkills.length > 0
  try {
    const { object, usage } = await generateObject({
      model: google(RUBRIC_GENERATION_MODEL),
      schema: tagging ? answerKeyGenSchema : answerKeyRubricSchema,
      system: tagging ? ANSWER_KEY_SYSTEM_PROMPT + SKILL_TAGGING_PROMPT : ANSWER_KEY_SYSTEM_PROMPT,
      // Truncate long keys — acceptable, see note above.
      prompt:
        `Assignment total points: ${totalPoints}\n\n` +
        (tagging ? `Course skills (for tagging):\n${candidateSkills.map((s) => `- ${s}`).join('\n')}\n\n` : '') +
        `Answer key text:\n${text.slice(0, 20000)}`,
      temperature: 0.3,
      // Fine-grained criteria give the model far more to reason about. Without a thinking
      // cap gemini-3 spent the whole budget reasoning and truncated the JSON (finishReason
      // 'length', 65k output tokens on an incomplete object). 'low' keeps enough reasoning
      // for the point-budget while leaving room for the larger structured output.
      maxOutputTokens: 24000,
      providerOptions: { google: { thinkingConfig: { thinkingLevel: 'low' } } },
    })
    void recordAiUsage({ feature: 'rubric_generation', model: RUBRIC_GENERATION_MODEL, ...attribution, usage })
    // Normalize to the skill-name draft shape (plain schema has no skills field).
    const structured = normalizeGeneratedStructure(
      object.questions.map((q) => ({
        ...q,
        skills: 'skills' in q && Array.isArray(q.skills) ? (q.skills as string[]) : [],
      })),
    )
    return { questions: await enrichQuestions(structured, text, attribution) }
  } catch (error) {
    logger.error('generateRubricFromAnswerKey', error, describeObjectFailure(error))
    return null
  }
}

/** Max enrichment calls in flight. Wall time is what the professor waits on, and the calls are
 *  small, so this runs wider than the grading batch's 4. */
const ENRICH_CONCURRENCY = 8

type StructuredQuestion = RubricDraftWithSkillNames['questions'][number]

/**
 * Deterministic cleanup of pass-1 output. On the tagging path the model intermittently emits a
 * question TWICE — once as an empty stub carrying only the skill tags, once with the real
 * criteria — which duplicates it in the editor and inflates the point budget (observed 50 on a
 * 46-point key). Prompt wording did not fix it; dropping it in code always does.
 *
 * Collapse duplicate labels keeping the entry that actually has criteria (union the skills),
 * then drop GRADED questions with no criteria, since those add points nothing can earn. An
 * UNGRADED question with no criteria is legitimate (the key's "Ungraded problems" section).
 */
export function normalizeGeneratedStructure(questions: StructuredQuestion[]): StructuredQuestion[] {
  const byLabel = new Map<string, StructuredQuestion>()
  for (const q of questions) {
    const key = q.label.trim().toLowerCase()
    const prev = byLabel.get(key)
    if (!prev) {
      byLabel.set(key, q)
      continue
    }
    const [keep, drop] = q.criteria.length > prev.criteria.length ? [q, prev] : [prev, q]
    byLabel.set(key, {
      ...keep,
      skills: Array.from(new Set([...(keep.skills ?? []), ...(drop.skills ?? [])])).slice(0, 3),
    })
  }
  return [...byLabel.values()].filter((q) => q.graded === false || q.criteria.length > 0)
}

/**
 * PASS 2: add retrieval assets to each question's criteria, one focused call per question.
 *
 * Degrades per question, never globally: if a call fails or comes back misaligned, that
 * question keeps its reference answers and loses only the extras. Alignment is asserted on
 * BOTH count and echoed description, because silent positional drift would attach one
 * criterion's distractors to another and quietly invert its grade.
 */
async function enrichQuestions(
  questions: StructuredQuestion[],
  keyText: string,
  attribution?: AiAttribution,
): Promise<StructuredQuestion[]> {
  const out = [...questions]
  const targets = questions
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => q.graded !== false && q.criteria.length > 0)

  let cursor = 0
  async function worker() {
    while (cursor < targets.length) {
      const { q, i } = targets[cursor++]
      const enriched = await enrichOneQuestion(q, keyText, attribution)
      if (enriched) out[i] = enriched
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(ENRICH_CONCURRENCY, targets.length) }, worker),
  )
  return out
}

async function enrichOneQuestion(
  q: StructuredQuestion,
  keyText: string,
  attribution?: AiAttribution,
): Promise<StructuredQuestion | null> {
  try {
    const { object, usage } = await generateObject({
      model: google(RUBRIC_GENERATION_MODEL),
      schema: enrichmentSchema,
      // Key text goes in the SYSTEM prompt, not the user prompt: it is byte-identical across
      // every question's call, so it becomes a shared cached prefix instead of being re-sent
      // (and re-billed at full rate) once per question.
      system: `${ENRICHMENT_SYSTEM_PROMPT}\n\nANSWER KEY (ground keywords in this text, and mine it for the common mistakes):\n${keyText.slice(0, 20000)}`,
      prompt:
        `Question ${q.label} (${q.points} pts). Produce exactly ${q.criteria.length} entries.\n\n` +
        q.criteria
          .map(
            (c, n) =>
              `${n + 1}. description: ${c.description}\n   reference answer: ${c.referenceAnswer ?? '(none)'}`,
          )
          .join('\n'),
      temperature: 0.4,
      maxOutputTokens: 4000,
      // Writing paraphrases and distractors is a generative task, not a reasoning one. Left at
      // the default thinking budget this pass ran 60-100s per call; the grader already uses
      // 'minimal' for the same reason.
      providerOptions: { google: { thinkingConfig: { thinkingLevel: 'minimal' } } },
    })
    void recordAiUsage({ feature: 'rubric_generation', model: RUBRIC_GENERATION_MODEL, ...attribution, usage })

    if (object.criteria.length !== q.criteria.length) {
      logger.warn('enrichOneQuestion: count mismatch, keeping references only', {
        source: 'rubric-ai.enrichOneQuestion',
        label: q.label,
        expected: q.criteria.length,
        got: object.criteria.length,
      })
      return null
    }
    const haystack = keyText.toLowerCase()
    return {
      ...q,
      criteria: q.criteria.map((c, n) => {
        const e = object.criteria[n]
        // Echo check: a drifted description means the model re-ordered, so drop that one
        // criterion's extras rather than attach another criterion's distractors to it.
        if (normalizeEcho(e.description) !== normalizeEcho(c.description)) {
          logger.warn('enrichOneQuestion: description drift, skipping criterion', {
            source: 'rubric-ai.enrichOneQuestion',
            label: q.label,
            index: n,
          })
          return c
        }
        // Keyword grounding is enforced here, not trusted to the prompt. An AI-minted keyword
        // absent from the key hard-zeroes a criterion the professor never meant to gate
        // (Report: such keywords forced every submission to low confidence). Cheap to check.
        const keywords = e.absoluteKeywords.filter((k) => haystack.includes(k.toLowerCase()))
        return {
          ...c,
          paraphrases: e.paraphrases,
          distractors: e.distractors,
          absoluteKeywords: keywords,
          keywordAliases: e.keywordAliases.filter((a) => keywords.includes(a.term)),
          checkMode: e.checkMode,
        }
      }),
    }
  } catch (error) {
    logger.error('enrichOneQuestion', error, {
      label: q.label,
      ...describeObjectFailure(error),
    })
    return null
  }
}

const normalizeEcho = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Unpack a generateObject failure into something actionable. "response did not match schema"
 * alone can't distinguish a truncated response (finishReason 'length') from genuinely wrong
 * output, and the two need opposite fixes — raise the output budget vs relax the schema.
 */
function describeObjectFailure(error: unknown): Record<string, unknown> {
  if (!NoObjectGeneratedError.isInstance(error)) return {}
  const issues = error.cause instanceof z.ZodError ? error.cause.issues : []
  return {
    finishReason: error.finishReason,
    outputTokens: error.usage?.outputTokens,
    textLength: error.text?.length ?? 0,
    issueCount: issues.length,
    // Paths are the diagnosis: "questions.3.criteria.1.distractors" names the exact field.
    issues: issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`),
  }
}

const SKILL_TAGGING_PROMPT = `

Additionally, tag each QUESTION entry with the course skills it assesses:
- "skills" holds 1–3 skill names. PREFER names from the provided course-skill list, copied
  exactly as written there.
- Only when the question clearly assesses a concept that is NOT covered by any listed skill,
  add ONE new skill name for it: a short noun phrase (1–4 words) naming the concept, the way
  the listed skills are named. Never rephrase or duplicate a listed skill.
- Tag the question as a whole — never individual criteria.
- Leave "skills" empty if the question doesn't assess a nameable skill.`

// Generation-time shapes. The stored rubricQuestionSchema carries {id, name} skill tags —
// the model must never see (or invent) skill ids, so generation uses its own schemas: one
// without skills at all, one tagging questions with skill NAMES from the provided list
// (the caller resolves names to section skill ids). Criteria carry no skills.
const rubricGenPlainSchema = z.object({
  questions: z.array(rubricQuestionSchema.omit({ skills: true })).default([]),
})
const rubricGenQuestionSchema = rubricQuestionSchema.omit({ skills: true }).extend({
  skills: z.array(z.string().min(1).max(200)).max(3).default([])
    .describe('Course skills this question assesses, copied exactly from the provided list'),
})
const rubricGenSchema = z.object({ questions: z.array(rubricGenQuestionSchema).default([]) })

/** A drafted rubric whose questions carry skill NAMES (not yet resolved to ids). */
export type RubricDraftWithSkillNames = z.infer<typeof rubricGenSchema>

/**
 * Generate a rubric from extracted assignment-PDF text. Returns null on any failure
 * (the caller surfaces a friendly error). `totalPoints` anchors point distribution.
 * When `candidateSkills` (the tagged modules' skill pool) is non-empty, the model also
 * tags each question with 1–3 of those skills, by exact name.
 */
export async function generateRubricFromText(
  pdfText: string,
  totalPoints: number,
  attribution?: AiAttribution,
  candidateSkills: string[] = [],
): Promise<RubricDraftWithSkillNames | null> {
  const text = pdfText.trim()
  if (!text) return null
  const tagging = candidateSkills.length > 0
  try {
    const { object, usage } = await generateObject({
      model: google(RUBRIC_GENERATION_MODEL),
      schema: tagging ? rubricGenSchema : rubricGenPlainSchema,
      system: tagging ? SYSTEM_PROMPT + SKILL_TAGGING_PROMPT : SYSTEM_PROMPT,
      prompt:
        `Assignment total points: ${totalPoints}\n\n` +
        (tagging ? `Course skills (for tagging):\n${candidateSkills.map((s) => `- ${s}`).join('\n')}\n\n` : '') +
        `Assignment text:\n${text.slice(0, 20000)}`,
      temperature: 0.3,
    })
    void recordAiUsage({ feature: 'rubric_generation', model: RUBRIC_GENERATION_MODEL, ...attribution, usage })
    // The plain schema parses questions without a skills field — normalize to [].
    return { questions: object.questions.map((q) => ({ ...q, skills: 'skills' in q && Array.isArray(q.skills) ? (q.skills as string[]) : [] })) }
  } catch (error) {
    logger.error('generateRubricFromText', error)
    return null
  }
}
