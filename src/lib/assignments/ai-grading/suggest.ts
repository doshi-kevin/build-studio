/**
 * Phase 4 orchestrators: build and persist AI grade suggestions (v3).
 *
 * Two entry points:
 *  - buildAndSaveSuggestion: single-student (used by suggestGrades action).
 *  - buildAndSaveSuggestionsForAssignment: whole-class batch (used by the
 *    streaming route; accepts an onSuggestion callback for per-student push).
 *
 * v3 pipeline: whole-submission default (no embeddings for <=60k chars),
 * retrieval fallback for larger submissions. System prompt built once per batch
 * to maximize Gemini prompt-cache hits. Concurrency 4.
 *
 * Server-only: calls adminDb, Pinecone, and Gemini.
 */
import 'server-only'

import { logger } from '@/lib/logger'
import {
  parseRubric,
  mergeRubricAi,
  rubricHasReferences,
  parseAiGradingState,
  gradedRubricTotal,
} from '@/lib/validations/assignment'
import type { SubmissionFile } from '@/lib/validations/assignment'
import { loadAnswerKeyText, loadRubricAi } from './answer-key'
import { loadExemplarBlock } from './exemplars'
import { ingestSubmission } from './ingest'
import { buildGradingContexts } from './signals'
import { buildGraderSystemPrompt, suggestGradeFromContext } from './grader'
import { suggestGradeFromSignals } from './similarity-grader'
import { suggestGradeHybrid } from './hybrid-grader'
import { aiGradingMode } from './mode'
import type { GradingContext, AiGradeSuggestion } from './types'
import type { createAdminClient } from '@/lib/supabase/admin'

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * E5/E6: persist a suggestion through the version-guarded RPC. The draft is written ONLY
 * if the submission is still 'submitted' and unchanged since grading began — otherwise a
 * grade committed or a resubmit that landed mid-LLM-call would be silently overwritten with
 * a stale draft. Returns { written:false } when the submission moved on (caller treats it as
 * a skip), or an { error } on a DB failure.
 *
 * On success the RPC returns the exact `updated_at` it stamped on the row — the draft
 * version the client must echo back on grade save so correction capture can prove the
 * professor reviewed THIS draft (ghost-diff guard). Returned atomically from inside the
 * function because a read-back after the upsert could race a concurrent re-suggest.
 */
async function saveSuggestionGuarded(
  adminDb: AdminClient,
  ids: {
    submissionId: string
    submissionVersion: string
    /** aiGrading.embeddedAt captured at grading start; the RPC rejects if the rubric was
     *  re-saved since. null when the rubric carried no embed stamp. */
    rubricVersion: string | null
  },
  suggestion: AiGradeSuggestion,
): Promise<{ written: boolean; version?: string; error?: string }> {
  // Tenant ids (institution/section/assignment/student) are DERIVED inside the RPC from the
  // locked submission row, not sent from here — p_row carries only the grade payload.
  const { data, error } = await adminDb.rpc('upsert_ai_grade_suggestion_if_current', {
    p_submission_id: ids.submissionId,
    p_expected_version: ids.submissionVersion,
    p_expected_rubric_version: ids.rubricVersion,
    p_row: {
      suggested_rubric_scores: suggestion.suggestedRubricScores,
      suggested_score: suggestion.suggestedScore,
      rationale: suggestion.criteria,
      feedback: suggestion.feedback,
      confidence: suggestion.confidence,
      flagged_count: suggestion.flaggedCount,
      unmapped_questions: suggestion.unmappedQuestionIndexes,
      model: suggestion.model,
    },
  })
  if (error) return { written: false, error: error.message }
  // RPC returns the stamped updated_at (timestamptz) on success, NULL when stale.
  return data ? { written: true, version: data as string } : { written: false }
}

/** Max parallel Gemini grading calls (rate-limit courtesy). */
const GRADE_CONCURRENCY = 4

/** Append the full answer key to a grading system prompt (shared, byte-identical
 *  across the batch — Gemini's implicit caching bills it once at full rate,
 *  then at 10% for every other student). */
function withAnswerKey(systemPrompt: string, keyText: string | null): string {
  if (!keyText) return systemPrompt
  return (
    systemPrompt +
    `\n\nFULL ANSWER KEY (authoritative model answers for every question — use it to judge correctness precisely):\n"""\n${keyText}\n"""`
  )
}

/** Append the instructor-graded exemplar block (calibration flywheel). Rides the same
 *  shared byte-identical prefix as the answer key, so prefix caching still applies. */
function withExemplars(systemPrompt: string, exemplarBlock: string): string {
  if (!exemplarBlock) return systemPrompt
  return systemPrompt + `\n\n${exemplarBlock}`
}

/** Dispatch one student's context to the grader for the active pipeline mode.
 *  systemPrompt already carries the answer key + exemplars when attached (v9/llm paths). */
async function gradeContext(input: {
  context: GradingContext
  maxScore: number
  systemPrompt: string
  keyText: string | null
  exemplarBlock: string
  attribution: { institutionId: string; sectionId: string; userId: string }
}): Promise<AiGradeSuggestion | null> {
  switch (aiGradingMode()) {
    case 'similarity-only':
      return suggestGradeFromSignals(input.context, input.maxScore)
    case 'hybrid':
      return suggestGradeHybrid({
        context: input.context,
        maxScore: input.maxScore,
        keyText: input.keyText,
        exemplarBlock: input.exemplarBlock,
        attribution: input.attribution,
      })
    case 'v9':
      // Length router (FINAL pipeline): whole-mode → llm-only with the key in the
      // cached prefix; over-budget (regions) → hybrid region review, also key-armed.
      return input.context.mode === 'whole'
        ? suggestGradeFromContext(input)
        : suggestGradeHybrid({
            context: input.context,
            maxScore: input.maxScore,
            keyText: input.keyText,
            exemplarBlock: input.exemplarBlock,
            attribution: input.attribution,
          })
    default:
      // 'default' (v4 signals) and 'llm-only' (signals stripped upstream in signals.ts).
      return suggestGradeFromContext(input)
  }
}

export async function buildAndSaveSuggestion(input: {
  adminDb: AdminClient
  institutionId: string
  sectionId: string
  assignment: { id: string; points: number; settings: unknown }
  submission: {
    id: string
    student_id: string
    text_content: string | null
    files: SubmissionFile[]
    /** assignment_submissions.updated_at — the version this draft is guarded against (E5/E6). */
    updated_at: string
  }
  userId: string
}): Promise<{ suggestion: AiGradeSuggestion; suggestionUpdatedAt: string } | { error: string }> {
  const { adminDb, institutionId, sectionId, assignment, submission, userId } = input

  // 1. Parse and validate rubric. The public rubric lives in settings.rubric; the answer-key
  // AI fields (reference answers, keywords, scoring rules) live in the staff-only
  // assignment_answer_keys.rubric_ai and are grafted back on here for grading (BLOCKER #1).
  const publicRubric = parseRubric(assignment.settings)
  if (!publicRubric) {
    return { error: 'Save a rubric with an answer key first.' }
  }
  const rubric = mergeRubricAi(publicRubric, (await loadRubricAi(adminDb, assignment.id)).approved)
  if (
    !rubricHasReferences(rubric) &&
    parseAiGradingState(assignment.settings).status !== 'ready'
  ) {
    return {
      error:
        'This rubric has no AI answer key yet. Add reference answers in the rubric editor first.',
    }
  }

  // 2. Ingest the submission content.
  const { text, notebooks } = await ingestSubmission(adminDb as AdminClient, {
    id: submission.id,
    text_content: submission.text_content,
    files: submission.files,
  })
  if (text === null && notebooks.length === 0) {
    return {
      error: 'This submission has no text or notebook content to grade automatically.',
    }
  }

  // 3. Build grading context (whole-submission or regions fallback).
  const contextMap = await buildGradingContexts({
    institutionId,
    sectionId,
    assignmentId: assignment.id,
    rubric,
    students: [{ submissionId: submission.id, text, notebooks }],
  })
  const context = contextMap.get(submission.id)
  if (!context) {
    return { error: 'Could not assemble grading context. Grade manually or try again.' }
  }

  // 4. Grade via the active pipeline mode (see mode.ts). The answer key loads
  // once per assignment (process cache) and joins the shared prompt prefix.
  // maxScore = graded rubric total when available, else the assignment's own points.
  const maxScore = gradedRubricTotal(rubric) ?? assignment.points
  // Answer key + instructor-graded exemplars are independent reads — load in parallel.
  const [keyText, exemplarBlock] = await Promise.all([
    loadAnswerKeyText(adminDb, {
      id: assignment.id,
      institutionId,
      sectionId,
    }),
    loadExemplarBlock(adminDb, { assignmentId: assignment.id, institutionId, rubric }),
  ])
  const suggestion = await gradeContext({
    context,
    maxScore,
    systemPrompt: withExemplars(
      withAnswerKey(buildGraderSystemPrompt(rubric, context.criteria), keyText),
      exemplarBlock,
    ),
    keyText,
    exemplarBlock,
    attribution: { institutionId, sectionId, userId },
  })
  if (!suggestion) {
    return {
      error: 'Could not generate a suggestion. Grade manually or try again.',
    }
  }

  // 5. Persist through the version-guarded RPC (E5/E6): rejected if the submission was graded
  // or resubmitted during the LLM call, so a stale draft can't overwrite a committed grade.
  const saved = await saveSuggestionGuarded(
    adminDb,
    {
      submissionId: submission.id,
      submissionVersion: submission.updated_at,
      rubricVersion: parseAiGradingState(assignment.settings).embeddedAt ?? null,
    },
    suggestion,
  )
  if (saved.error) {
    logger.error('buildAndSaveSuggestion: guarded upsert failed', new Error(saved.error), {
      source: 'suggest.buildAndSaveSuggestion',
      submissionId: submission.id,
    })
    return { error: 'Could not save the suggestion. Please try again.' }
  }
  if (!saved.written || !saved.version) {
    return { error: 'This submission changed while grading (it was graded or resubmitted). Try again.' }
  }

  return { suggestion, suggestionUpdatedAt: saved.version }
}

/**
 * Build and persist AI grade suggestions for ALL submitted submissions of an assignment.
 *
 * Steps:
 *  1. Load all submissions with status='submitted'.
 *  2. Ingest each submission (download files, parse notebooks).
 *  3. Build grading contexts for the whole class (embeds only students over 60k chars).
 *  4. Build the system prompt ONCE from the rubric (cached prefix for all students).
 *  5. Run suggestGradeFromContext per student with bounded concurrency (4).
 *  6. Upsert non-null suggestions; call onSuggestion after each upsert (persist-then-emit).
 *
 * Returns { count } of suggestions written, or { error }.
 */
export async function buildAndSaveSuggestionsForAssignment(input: {
  adminDb: AdminClient
  institutionId: string
  sectionId: string
  assignment: { id: string; points: number; settings: unknown }
  userId: string
  onSuggestion?: (
    submissionId: string,
    suggestion: AiGradeSuggestion,
    /** The draft version stamped by the guarded upsert — echoed back on grade save (correction capture). */
    suggestionUpdatedAt: string,
  ) => void | Promise<void>
  /** E9: fired when a student is dropped (no gradable content, LLM/Pinecone failure, or
   *  a save error) so the caller can surface it instead of silently under-counting. */
  onSkipped?: (submissionId: string, reason: string) => void | Promise<void>
}): Promise<{ count: number } | { error: string }> {
  const { adminDb, institutionId, sectionId, assignment, userId, onSuggestion, onSkipped } = input

  // 1. Parse and validate rubric. Graft the staff-only answer-key AI fields (rubric_ai)
  // back onto the public settings.rubric for grading (BLOCKER #1).
  const rubricOrNull = parseRubric(assignment.settings)
  if (!rubricOrNull) {
    return { error: 'Save a rubric with an answer key first.' }
  }
  const rubric = mergeRubricAi(rubricOrNull, (await loadRubricAi(adminDb, assignment.id)).approved)
  if (
    !rubricHasReferences(rubric) &&
    parseAiGradingState(assignment.settings).status !== 'ready'
  ) {
    return {
      error:
        'This rubric has no AI answer key yet. Add reference answers in the rubric editor first.',
    }
  }

  // 2. Load all submitted submissions for this assignment.
  const { data: submissionRows, error: fetchErr } = await adminDb
    .from('assignment_submissions')
    .select('id, student_id, text_content, files, updated_at')
    .eq('assignment_id', assignment.id)
    .eq('status', 'submitted')

  if (fetchErr) {
    logger.error('buildAndSaveSuggestionsForAssignment: failed to fetch submissions', fetchErr, {
      source: 'suggest.buildAndSaveSuggestionsForAssignment',
      assignmentId: assignment.id,
    })
    return { error: 'Could not load submissions. Please try again.' }
  }

  const submissions = (submissionRows ?? []) as {
    id: string
    student_id: string
    text_content: string | null
    files: unknown
    updated_at: string
  }[]

  if (submissions.length === 0) {
    return { count: 0 }
  }

  // 3. Ingest each submission — sequentially to avoid Storage rate limits.
  interface IngestedStudent {
    submissionId: string
    studentId: string
    submissionVersion: string
    text: string | null
    notebooks: Awaited<ReturnType<typeof ingestSubmission>>['notebooks']
  }

  const ingested: IngestedStudent[] = []
  for (const sub of submissions) {
    try {
      const { text, notebooks } = await ingestSubmission(adminDb as AdminClient, {
        id: sub.id,
        text_content: sub.text_content,
        files: (sub.files ?? []) as SubmissionFile[],
      })
      // Skip students with no extractable content — but report the drop (E9) so the bulk
      // stream count doesn't silently under-report unsupported / empty submissions.
      if (text === null && notebooks.length === 0) {
        await onSkipped?.(sub.id, 'no text or supported files to grade')
        continue
      }
      ingested.push({ submissionId: sub.id, studentId: sub.student_id, submissionVersion: sub.updated_at, text, notebooks })
    } catch (err) {
      logger.warn('buildAndSaveSuggestionsForAssignment: ingest failed for submission, skipping', {
        source: 'suggest.buildAndSaveSuggestionsForAssignment',
        submissionId: sub.id,
        err: String(err),
      })
      await onSkipped?.(sub.id, 'could not read the submission files')
    }
  }

  if (ingested.length === 0) {
    return { count: 0 }
  }

  // 4. Build grading contexts for all students (batch — only embeds over-budget students).
  const contextMap = await buildGradingContexts({
    institutionId,
    sectionId,
    assignmentId: assignment.id,
    rubric,
    students: ingested.map((s) => ({
      submissionId: s.submissionId,
      text: s.text,
      notebooks: s.notebooks,
    })),
  })

  // Build the system prompt ONCE from the rubric. All students in this batch share
  // this system block — Gemini caches it across the concurrent calls.
  // We derive criteria shape from the first context (all share the same rubric structure).
  const firstContext = contextMap.values().next().value
  if (!firstContext) {
    return { count: 0 }
  }
  // Answer key + exemplars load ONCE for the whole batch; the shared byte-identical
  // prefix means Gemini bills them at the cached rate for students 2..N.
  const [keyText, exemplarBlock] = await Promise.all([
    loadAnswerKeyText(adminDb, {
      id: assignment.id,
      institutionId,
      sectionId,
    }),
    loadExemplarBlock(adminDb, { assignmentId: assignment.id, institutionId, rubric }),
  ])
  const systemPrompt = withExemplars(
    withAnswerKey(buildGraderSystemPrompt(rubric, firstContext.criteria), keyText),
    exemplarBlock,
  )
  // maxScore = graded rubric total when available, else the assignment's own points.
  const maxScore = gradedRubricTotal(rubric) ?? assignment.points
  // Rubric version captured once for the batch — the RPC rejects any draft if the rubric
  // is re-saved mid-run (embeddedAt changes on save).
  const rubricVersion = parseAiGradingState(assignment.settings).embeddedAt ?? null

  // 5. Grade per student with bounded concurrency.
  let count = 0

  async function processOne(student: IngestedStudent) {
    const context = contextMap.get(student.submissionId)
    if (!context || context.criteria.length === 0) {
      await onSkipped?.(student.submissionId, 'no gradable content')
      return
    }

    const suggestion = await gradeContext({
      context,
      maxScore,
      systemPrompt,
      keyText,
      exemplarBlock,
      attribution: { institutionId, sectionId, userId },
    })
    if (!suggestion) {
      await onSkipped?.(student.submissionId, 'AI grading failed')
      return
    }

    // Version-guarded persist (E5/E6): drop the draft if the submission was graded or
    // resubmitted during the LLM call rather than overwrite the newer state.
    const saved = await saveSuggestionGuarded(
      adminDb,
      {
        submissionId: student.submissionId,
        submissionVersion: student.submissionVersion,
        rubricVersion,
      },
      suggestion,
    )
    if (saved.error) {
      logger.error('buildAndSaveSuggestionsForAssignment: guarded upsert failed', new Error(saved.error), {
        source: 'suggest.buildAndSaveSuggestionsForAssignment',
        submissionId: student.submissionId,
      })
      await onSkipped?.(student.submissionId, 'could not save the draft')
      return
    }
    if (!saved.written || !saved.version) {
      await onSkipped?.(student.submissionId, 'graded or resubmitted while grading')
      return
    }

    count++

    // Persist-then-emit: call onSuggestion AFTER the upsert so the streaming route
    // only pushes rows that are safely persisted.
    if (onSuggestion) {
      await onSuggestion(student.submissionId, suggestion, saved.version)
    }
  }

  // Process in batches of GRADE_CONCURRENCY.
  for (let i = 0; i < ingested.length; i += GRADE_CONCURRENCY) {
    const batch = ingested.slice(i, i + GRADE_CONCURRENCY)
    await Promise.all(batch.map(processOne))
  }

  return { count }
}
