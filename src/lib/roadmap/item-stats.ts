/**
 * item-stats — the professor "Q5 discriminates poorly" (P6) signal's data layer.
 * Computes empirical point-biserial discrimination per (quiz, question) from
 * quiz_attempts + quiz_answers, caches it in quiz_item_stats, and returns the
 * poorly-discriminating items. Server-only: takes an admin client (quiz tables
 * are RLS-deny-all) — callers must verify section ownership first.
 *
 * Lazy refresh: a quiz is recomputed only when its cached rows are missing or
 * older than the TTL, so repeated page loads don't re-scan the answer table.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import { pointBiserialByQuestion } from './aggregates'
import { readAllPages } from '@/lib/supabase/paged-read'

const TTL_MS = 12 * 3600 * 1000 // analytics staleness tolerance
const MIN_ATTEMPTS = 10 // below this, discrimination is noise — don't flag
const POOR_DISCRIMINATION = 0.15 // point-biserial floor for "discriminates poorly"
const MAX_POOR = 3 // cap what we surface (the triage budget caps again downstream)

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Recompute + cache one quiz's item stats. Always stamps computed_at (even with
 *  too few attempts) so we don't rescan every load. Idempotent upsert → races are fine. */
async function refreshQuiz(admin: SupabaseClient, sectionId: string, quizId: string): Promise<void> {
  const [attemptRows, assignRows] = await Promise.all([
    readAllPages<any>(
      () => admin.from('quiz_attempts').select('id, score').eq('quiz_id', quizId).eq('status', 'submitted').not('score', 'is', null),
      'id',
      'item-stats.quizAttempts',
    ),
    readAllPages<any>(
      () => admin.from('quiz_question_assignments').select('question_id').eq('quiz_id', quizId),
      'question_id',
      'item-stats.assignments',
    ),
  ])
  const attempts = attemptRows.map((a) => ({ id: a.id as string, score: Number(a.score) }))
  const questionIds = assignRows.map((a) => a.question_id as string)
  if (!questionIds.length) return

  let stats = new Map<string, { discrimination: number | null; difficulty: number; n: number }>()
  if (attempts.length >= MIN_ATTEMPTS) {
    const attemptIds = attempts.map((a) => a.id)
    const answers = await readAllPages<any>(
      () => admin.from('quiz_answers').select('attempt_id, question_id, is_correct').in('attempt_id', attemptIds),
      'attempt_id',
      'item-stats.quizAnswers',
    )
    stats = pointBiserialByQuestion(
      attempts,
      answers.map((x) => ({ attemptId: x.attempt_id, questionId: x.question_id, isCorrect: x.is_correct })),
    )
  }

  const computedAt = new Date().toISOString()
  const rows = questionIds.map((qid) => {
    const s = stats.get(qid)
    return {
      quiz_id: quizId, question_id: qid, section_id: sectionId,
      discrimination: s?.discrimination ?? null, difficulty: s?.difficulty ?? null,
      n_attempts: s?.n ?? attempts.length, computed_at: computedAt,
    }
  })
  await admin.from('quiz_item_stats').upsert(rows, { onConflict: 'quiz_id,question_id' })
}

/** Poorly-discriminating items across the section's published quizzes, labelled "Q<n>". */
export async function getPoorQuizItems(
  admin: SupabaseClient,
  sectionId: string,
  /** Who is loading the page — logged when this read triggers a cache refresh,
   *  which is a real DB write (and cost) that rendering a page shouldn't do
   *  unaudited. Omitted on paths with no user (nothing to attribute). */
  opts?: { userId?: string },
): Promise<{ quizTitle: string; questionLabel: string }[]> {
  try {
    const { data: quizzes } = await admin.from('quizzes').select('id, title').eq('section_id', sectionId).eq('status', 'published').order('created_at', { ascending: true }).limit(500)
    const qz = ((quizzes ?? []) as any[]).map((q) => ({ id: q.id as string, title: q.title as string }))
    if (!qz.length) return []
    const quizIds = qz.map((q) => q.id)
    const titleById = new Map(qz.map((q) => [q.id, q.title]))

    // Which quizzes are stale (oldest cached row past TTL, or never computed)?
    const existing = await readAllPages<any>(
      () => admin.from('quiz_item_stats').select('quiz_id, computed_at').in('quiz_id', quizIds),
      'quiz_id',
    )
    const now = Date.now()
    const oldestByQuiz = new Map<string, number>()
    for (const r of existing) {
      const t = new Date(r.computed_at).getTime()
      const cur = oldestByQuiz.get(r.quiz_id)
      if (cur == null || t < cur) oldestByQuiz.set(r.quiz_id, t)
    }
    const stale = quizIds.filter((id) => {
      const t = oldestByQuiz.get(id)
      return t == null || now - t > TTL_MS
    })
    /* Each refresh is independent (scoped to its own quiz, upserted on
       quiz_id+question_id), so they run concurrently rather than one per
       round-trip. Bounded because a section can have dozens of published
       quizzes and each refresh is itself 2-3 queries. */
    const REFRESH_CONCURRENCY = 5
    for (let i = 0; i < stale.length; i += REFRESH_CONCURRENCY) {
      await Promise.all(
        stale.slice(i, i + REFRESH_CONCURRENCY).map((quizId) => refreshQuiz(admin, sectionId, quizId)),
      )
    }
    /* Audit the write. Rendering the professor roadmap past the TTL rescans up to
       500 published quizzes (three paged reads each) and upserts the results — a
       real DB cost and a surprising side effect of loading a page, previously with
       no record that it happened at all. Logged only when work was actually done,
       so a warm cache stays silent. */
    if (stale.length > 0 && opts?.userId) {
      await logEvent({
        userId: opts.userId,
        eventType: 'quiz_item_stats.refreshed',
        eventCategory: 'professor',
        sectionId,
        metadata: { quizzesRefreshed: stale.length },
      })
    }

    // Read (now-fresh) stats and pick the poorest.
    /* Paged, not capped: this picks the WORST items, so a truncated read would
       silently hide the very questions the signal exists to surface. */
    const stats = await readAllPages<any>(
      () => admin.from('quiz_item_stats').select('quiz_id, question_id, discrimination, n_attempts').in('quiz_id', quizIds),
      'quiz_id',
    )
    const poor = stats
      .filter((s) => s.discrimination != null && Number(s.discrimination) < POOR_DISCRIMINATION && s.n_attempts >= MIN_ATTEMPTS)
      .sort((a, b) => Number(a.discrimination) - Number(b.discrimination))
      .slice(0, MAX_POOR)
    if (!poor.length) return []

    // Label questions "Q<position+1>" from their slot in the quiz.
    const assigns = await readAllPages<any>(
      () => admin.from('quiz_question_assignments').select('quiz_id, question_id, position').in('quiz_id', quizIds),
      'quiz_id',
    )
    const posByKey = new Map<string, number>()
    for (const a of assigns) posByKey.set(`${a.quiz_id}:${a.question_id}`, a.position)

    return poor
      .map((s) => {
        const pos = posByKey.get(`${s.quiz_id}:${s.question_id}`)
        return { quizTitle: titleById.get(s.quiz_id) ?? '', questionLabel: pos != null ? `Q${pos + 1}` : 'a question' }
      })
      .filter((p) => p.quizTitle)
  } catch (error) {
    logger.error('getPoorQuizItems', error, { sectionId })
    return []
  }
}
