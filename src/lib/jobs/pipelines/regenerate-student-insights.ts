// regenerate_student_insights — refreshes the whole roster's dossier
// insights (facts snapshot + AI narrative) for one section, triggered by the
// refresh button on the roadmap's student dossier card.
//
// Cost discipline: the section-wide inputs (mastery maps, node refs) load
// ONCE for the roster, and each student goes through the shared hash-guarded
// write path (`refreshStudentInsight`) — a student whose signals haven't
// changed costs zero model calls.
//
// NOTE: the 24h LLM-spend cooldown lives ONLY in refreshClassInsights (the
// enqueueing action) — enqueueJob's dedup blocks a second PENDING job, not a
// re-enqueue after completion. Any future enqueue path for this type (a
// sweep, a retry, another action) must apply its own cooldown or reuse
// classRefreshState, or it bypasses the spend cap.
//
// Tenant scope (institution_id / section_id) comes from the JOB ROW, written
// by the enqueueing action from a verified section — never from params.

import 'server-only'

import { logger } from '@/lib/logger'
import { emitEvent } from '@/lib/events/emit'
import { loadSectionInsightShared, refreshStudentInsight } from '@/lib/roadmap/dossier-facts'
import { ON_ROSTER_STATUSES } from '@/lib/validations/enrollment'
import type { BackgroundPipeline, PipelineContext, PipelineResult } from '../types'

export const REGENERATE_STUDENT_INSIGHTS_JOB_TYPE = 'regenerate_student_insights'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)

async function run(
  _params: Record<string, unknown>,
  ctx: PipelineContext,
): Promise<PipelineResult> {
  const { job } = ctx
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = ctx.adminDb as any
  const sectionId = job.section_id
  if (!sectionId) throw new Error('regenerate_student_insights: job carries no section')

  const [{ data: enrollments }, { data: section }] = await Promise.all([
    db
      .from('enrollments')
      .select('student_id, student:profiles(name)')
      .eq('section_id', sectionId)
      .in('status', ON_ROSTER_STATUSES),
    db
      .from('course_sections')
      .select('course:courses(title)')
      .eq('id', sectionId)
      .single(),
  ])
  const courseTitle = (resolveJoin(section?.course)?.title as string) || 'this course'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const roster = ((enrollments || []) as any[]).map((e) => ({
    studentId: e.student_id as string,
    name: (resolveJoin(e.student)?.name as string) || 'Unknown',
  }))

  const shared = await loadSectionInsightShared(db, sectionId)

  let regenerated = 0
  let unchanged = 0
  let failed = 0
  for (const s of roster) {
    if (ctx.signal.aborted) break
    const startedAt = new Date().toISOString()
    await ctx.reportProgress({ label: s.name, status: 'running', startedAt })
    try {
      const r = await refreshStudentInsight(db, {
        sectionId,
        studentId: s.studentId,
        studentName: s.name,
        courseTitle,
        institutionId: job.institution_id,
        userId: job.created_by,
        shared,
      })
      if (r.regenerated) regenerated += 1
      else unchanged += 1
      await ctx.reportProgress({ label: s.name, status: 'done', startedAt })
    } catch (error) {
      failed += 1
      logger.error('regenerateStudentInsights: student failed', error, { sectionId, studentId: s.studentId })
      await ctx.reportProgress({ label: s.name, status: 'error', startedAt })
    }
  }

  const aborted = ctx.signal.aborted && regenerated + unchanged + failed < roster.length
  const summary = roster.length === 0
    ? 'No students enrolled — nothing to refresh.'
    : `${regenerated} summar${regenerated === 1 ? 'y' : 'ies'} rewritten, ${unchanged} already current${failed ? `, ${failed} failed` : ''}.`

  // A run where EVERY student errored must land as a failed job — and must
  // not bell the professor with a green-sounding "refreshed" title first.
  // (Failed runs don't consume the cooldown, so the button comes back.)
  if (failed > 0 && failed === roster.length) {
    throw new Error(`all ${failed} students failed`)
  }

  // The "it's done" nudge — reaches the professor wherever they are (the
  // bell toasts feed_items inserts in realtime). Notice, not a to-do.
  if (job.created_by && !aborted) {
    await emitEvent({
      type: 'class_insights_refreshed',
      sectionId,
      actorId: null,
      audience: [job.created_by],
      entity: { type: 'section', id: sectionId },
      title: 'Class insights refreshed',
      body: summary,
      linkUrl: `/professor/courses/${sectionId}/roadmap`,
      onDuplicate: 'refresh',
    })
  }

  return { result: { regenerated, unchanged, failed, total: roster.length }, summary }
}

export const regenerateStudentInsightsPipeline: BackgroundPipeline = {
  type: REGENERATE_STUDENT_INSIGHTS_JOB_TYPE,
  run,
}
