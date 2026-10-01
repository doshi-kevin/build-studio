/**
 * Grading context builder (v4 — always-on similarity + per-question exclude).
 *
 * Default: put the WHOLE student submission into one generateObject call.
 * Fallback: when submission exceeds WHOLE_SUBMISSION_MAX_CHARS, retrieve
 * per-question text regions via cosine search over chunked passages.
 *
 * v4 changes vs v3:
 * - Reference vectors fetched UNCONDITIONALLY (not only for over-budget students).
 * - Every student's passages are chunked + embedded for similarity scoring.
 * - Questions with graded===false are entirely skipped in buildCriteriaRefs
 *   (no CriterionRef, no key, never in prompt, never unmapped).
 * - Per-criterion similarity = max cosine over all passage vectors.
 * - degraded is ONLY set for a regions-mode student whose embed failed;
 *   whole-mode embed failure keeps wholeText intact, similarity null, degraded=false.
 * - LLM-visible submission content is UNCHANGED — similarity is additive metadata.
 *
 * Note: embeddings are currently done per-student (one call per student). A future
 * optimization could batch all students' passages in a single embedTextsBatch call
 * with per-student offsets, but per-student calls are correct and acceptable at
 * typical class sizes.
 */
import 'server-only'

import { logger } from '@/lib/logger'
import { embedTextsBatch } from '@/lib/pinecone/embed'
import { fetchRubricReferenceVectors, type TenantScope } from '@/lib/pinecone/data'
import { checkKeywords } from './keywords'
import { chunkSubmission, chunkSentenceWindows } from './chunk'
import { flattenNotebookText } from './ingest'
import { isRubricQuestionGraded } from '@/lib/validations/assignment'
import {
  cosineSimilarity,
  WHOLE_SUBMISSION_MAX_CHARS,
  REGION_TOP_K,
  MAX_REGION_CHARS_PER_QUESTION,
  MAX_REGION_CHARS_TOTAL,
  type CriterionRef,
  type QuestionRegion,
  type GradingContext,
} from './types'
import type { ParsedNotebook } from '@/lib/assignments/notebook'
import type { AssignmentRubric } from '@/lib/validations/assignment'

import { aiGradingMode } from './mode'

/**
 * LLM-only mode (AI_GRADING_MODE=llm-only): strip the signal layer — no similarity,
 * no keyword results (so the grader's prompt carries no SIGNALS block and the
 * deterministic keyword cap never fires). Pure LLM judgment scored 80% per-question
 * vs 45% with signals on the HW2 eval (docs/designs/assignments-grading/ai-grading-eval-reports.md Report 4).
 * Region retrieval for over-budget submissions still works (it needs embeddings
 * for context assembly, which is not a grading signal). All other modes
 * (default, similarity-only, hybrid) need the signals computed here.
 */
function isLlmOnly(): boolean {
  return aiGradingMode() === 'llm-only'
}

/** v9 routes whole-mode students llm-only (no signals) but keeps the signal +
 *  region machinery for over-budget submissions (the hybrid review path). */
function isV9(): boolean {
  return aiGradingMode() === 'v9'
}

/**
 * Build a GradingContext for each student in the batch.
 *
 * Reference vectors are fetched ONCE for the whole batch (skipped in LLM-only
 * mode unless a student needs region retrieval).
 * Every student's passages are embedded for similarity scoring (advisory;
 * skipped in LLM-only mode for whole-mode students).
 * Only regions-mode students with a failed embed are marked degraded.
 */
export async function buildGradingContexts(input: {
  institutionId: string
  sectionId: string
  assignmentId: string
  rubric: AssignmentRubric
  students: { submissionId: string; text: string | null; notebooks: ParsedNotebook[] }[]
}): Promise<Map<string, GradingContext>> {
  const { institutionId, sectionId, assignmentId, rubric, students } = input
  const result = new Map<string, GradingContext>()

  if (students.length === 0) return result

  const v9 = isV9()
  const llmOnly = isLlmOnly()

  // ── 1. Compose whole text per student ──────────────────────────────────────
  interface StudentState {
    submissionId: string
    text: string | null
    notebooks: ParsedNotebook[]
    wholeText: string
    needsRegions: boolean
  }

  const studentStates: StudentState[] = students.map((s) => {
    const parts: string[] = []
    if (s.text) parts.push(s.text)
    for (const nb of s.notebooks) {
      const flat = flattenNotebookText(nb)
      if (flat) parts.push(flat)
    }
    const wholeText = parts.join('\n\n').trim()
    return {
      submissionId: s.submissionId,
      text: s.text,
      notebooks: s.notebooks,
      wholeText,
      needsRegions: wholeText.length > WHOLE_SUBMISSION_MAX_CHARS,
    }
  })

  // ── 2. Fetch reference vectors once per batch ───────────────────────────────
  // LLM-only mode needs them solely for region retrieval on over-budget students.
  const anyRegions = studentStates.some((s) => s.needsRegions)
  const scope: TenantScope = { institutionId, sectionId }
  let refVectors: Awaited<ReturnType<typeof fetchRubricReferenceVectors>> = []
  try {
    if ((!llmOnly && !v9) || anyRegions) {
      refVectors = await fetchRubricReferenceVectors(scope, assignmentId)
    }
  } catch (err) {
    // A tenant-mismatch throw is a cross-institution scoping bug, never a legitimate
    // fetch outcome — rethrow it so it aborts the batch loudly instead of being
    // degraded to "similarity null" (which would silently grade against the wrong
    // tenant's — or no — reference vectors). Every other failure (timeout, transient
    // Pinecone error) degrades: similarity null for all, regions-mode students degrade.
    if (err instanceof Error && err.message.includes('tenant mismatch')) throw err
    logger.warn('buildGradingContexts: fetchRubricReferenceVectors failed, similarity null for all', {
      source: 'signals.buildGradingContexts',
      assignmentId,
      err: String(err),
    })
  }

  // Build lookup: `${qIdx}:${cIdx}` → reference vector values.
  const refMap = new Map<string, number[]>()
  for (const rv of refVectors) {
    refMap.set(`${rv.questionIndex}:${rv.criterionIndex}`, rv.values)
  }

  /**
   * Build CriterionRefs for a student.
   *   - Skips questions with graded===false entirely (no key minted, no prompt entry).
   *   - Computes per-criterion similarity = max cosine over passageVectors (null when unavailable).
   */
  function buildCriteriaRefs(wholeText: string, passageVectors: number[][], stripSignals: boolean): CriterionRef[] {
    const refs: CriterionRef[] = []
    for (let qIdx = 0; qIdx < rubric.questions.length; qIdx++) {
      const q = rubric.questions[qIdx]
      // Phase 3: skip excluded questions entirely — no CriterionRef, no prompt entry.
      if (!isRubricQuestionGraded(q)) continue
      for (let cIdx = 0; cIdx < q.criteria.length; cIdx++) {
        const c = q.criteria[cIdx]
        const key = `${qIdx}:${cIdx}`
        const refVec = refMap.get(key) ?? null
        // Compute max cosine similarity over all passage vectors for this criterion.
        let similarity: number | null = null
        if (!stripSignals && refVec !== null && passageVectors.length > 0) {
          let maxSim = -Infinity
          for (const pv of passageVectors) {
            const sim = cosineSimilarity(pv, refVec)
            if (sim > maxSim) maxSim = sim
          }
          similarity = maxSim
        }
        refs.push({
          key,
          questionIndex: qIdx,
          questionLabel: q.label,
          criterionIndex: cIdx,
          description: c.description,
          points: c.points,
          referenceAnswer: c.referenceAnswer?.trim() ?? null,
          absoluteKeywords: c.absoluteKeywords ?? [],
          keywordAliases: c.keywordAliases ?? [],
          // LLM-only: null keywordResult so the deterministic cap never fires. Aliases fold into
          // the check so an equivalent surface form ("O(n lg n)") isn't scored a keyword miss.
          keywordResult: stripSignals
            ? null
            : checkKeywords(c.absoluteKeywords, wholeText || null, c.keywordAliases),
          similarity,
        })
      }
    }
    return refs
  }

  // ── 3. Per student: chunk, embed, build context ────────────────────────────
  for (const state of studentStates) {
    // Similarity v2: whole-mode students use fine sentence windows (better
    // per-claim discrimination, Report 3). Regions-mode students keep the
    // coarse passages — those chunks are also the retrieval units for the
    // LLM's context, and fine windows would hit MAX_PASSAGES on 60k+ docs.
    const { passages, truncated: passagesTruncated } = state.needsRegions
      ? chunkSubmission(state.text, state.notebooks)
      : chunkSentenceWindows(state.wholeText)

    // Embed this student's passages for similarity (skipped in LLM-only mode
    // for whole-mode students — regions-mode still needs vectors for retrieval).
    let passageVectors: number[][] = []
    let embeddingFailed = false

    if (passages.length > 0 && ((!llmOnly && !v9) || state.needsRegions)) {
      try {
        passageVectors = (await embedTextsBatch(passages.map((p) => p.text))).vectors
      } catch (err) {
        embeddingFailed = true
        logger.warn('buildGradingContexts: embedTextsBatch failed for student', {
          source: 'signals.buildGradingContexts',
          assignmentId,
          submissionId: state.submissionId,
          err: String(err),
        })
      }
    }

    // llm-only strips signals for everyone; v9 strips them only for whole-mode students.
    const signalsStripped = llmOnly || (v9 && !state.needsRegions)
    const criteria = buildCriteriaRefs(state.wholeText, passageVectors, signalsStripped)

    if (!state.needsRegions) {
      // Whole-submission mode: wholeText goes to LLM regardless of embed result.
      // E11: a signals-using mode that expected reference vectors but got none (empty
      // Pinecone fetch) OR whose passage embed failed has no similarity to steer it —
      // degrade rather than present a signal-blind grade as high confidence. Both leave
      // every criterion's similarity null, so a signals-using grader would tick/reject
      // blind. llm-only / v9-whole grade from the answer-key text, not the vectors, so
      // they stay clean (signalsStripped short-circuits both).
      const signalBlind = !signalsStripped && (refMap.size === 0 || embeddingFailed)
      result.set(state.submissionId, {
        mode: 'whole',
        criteria,
        wholeText: state.wholeText,
        regions: null,
        submissionText: state.wholeText,
        degraded: signalBlind,
      })
      continue
    }

    // Regions mode (over-budget submission).

    if (passages.length === 0) {
      // Empty submission after chunking — no regions, but not degraded (just empty).
      result.set(state.submissionId, {
        mode: 'regions',
        criteria,
        wholeText: null,
        regions: [],
        submissionText: state.wholeText,
        degraded: false,
      })
      continue
    }

    if (embeddingFailed) {
      // Regions-mode student whose embed failed — context is actually starved.
      result.set(state.submissionId, {
        mode: 'regions',
        criteria,
        wholeText: null,
        regions: [],
        submissionText: state.wholeText,
        degraded: true,
      })
      continue
    }

    // Per question: union top-K passages by cosine across all of that question's
    // criterion reference vectors, deduplicate, restore document order, cap per-question.
    const regions: QuestionRegion[] = []
    let totalRegionChars = 0
    // A capped region means the LLM only sees PART of the answer; grading a half-seen
    // answer at high confidence is a silent-error path, so any truncation degrades.
    // Seed with chunk-level truncation: if chunkSubmission hit MAX_PASSAGES the retrieval
    // pool itself is missing passages, so the region view is already partial.
    let truncated = passagesTruncated

    for (let qIdx = 0; qIdx < rubric.questions.length; qIdx++) {
      if (totalRegionChars >= MAX_REGION_CHARS_TOTAL) break

      const q = rubric.questions[qIdx]
      // Skip excluded questions in region retrieval too.
      if (!isRubricQuestionGraded(q)) continue

      // Collect reference vectors for this question's criteria.
      const qRefVectors: number[][] = []
      for (let cIdx = 0; cIdx < q.criteria.length; cIdx++) {
        const rv = refMap.get(`${qIdx}:${cIdx}`)
        if (rv) qRefVectors.push(rv)
      }

      if (qRefVectors.length === 0) {
        // No reference vectors for this question — skip region retrieval.
        continue
      }

      // For each reference vector, find top-K passage indices by cosine.
      const candidateIndexes = new Set<number>()
      for (const refVec of qRefVectors) {
        const scored = passageVectors.map((vec, pi) => ({
          pi,
          score: cosineSimilarity(vec, refVec),
        }))
        scored.sort((a, b) => b.score - a.score)
        for (const { pi } of scored.slice(0, REGION_TOP_K)) {
          candidateIndexes.add(pi)
        }
      }

      // Restore document order and join.
      const sortedIndexes = Array.from(candidateIndexes).sort((a, b) => a - b)
      let regionText = sortedIndexes.map((pi) => passages[pi].text).join('\n\n')

      // Cap per-question.
      if (regionText.length > MAX_REGION_CHARS_PER_QUESTION) {
        regionText = regionText.slice(0, MAX_REGION_CHARS_PER_QUESTION)
        truncated = true
      }

      // Cap total.
      const remaining = MAX_REGION_CHARS_TOTAL - totalRegionChars
      if (regionText.length > remaining) {
        regionText = regionText.slice(0, remaining)
        truncated = true
      }

      if (regionText.trim()) {
        regions.push({ questionIndex: qIdx, questionLabel: q.label, text: regionText })
        totalRegionChars += regionText.length
      }
    }

    result.set(state.submissionId, {
      mode: 'regions',
      criteria,
      wholeText: null,
      regions,
      submissionText: state.wholeText,
      degraded: truncated,
    })
  }

  return result
}
