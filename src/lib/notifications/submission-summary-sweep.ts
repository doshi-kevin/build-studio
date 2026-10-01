/**
 * Professor end-of-day submissions summary (Scholera Pulse — professor side).
 *
 * Runs from /api/notifications/cron (every 5 min). Once per institution-local day — at
 * SUBMISSION_SUMMARY_HOUR — it rolls up the last 24h of student submissions (assignments,
 * quizzes, projects) per section and emits ONE in-app summary to that section's professor,
 * instead of a ping per submission (a 60-student class would otherwise mean 60 pings). The
 * body names each assessment as "X of N submitted" ("Homework 3: 6 of 30 · Quiz 2: 3 of 30"),
 * so the professor sees WHICH assignment and how many are still outstanding.
 *
 * Idempotent (claim-then-emit, per .claude/rules/data-access.md): a per-(professor,
 * section, day) row in submission_summary_logs is claimed via upsert(ignoreDuplicates)
 * BEFORE emitting, so the 5-minute cadence and retries never double-emit. The feed item
 * uses entity_id = section_id with onDuplicate:'refresh', so a section's summary is a
 * single row that re-surfaces with fresh counts each day rather than piling up.
 *
 * Rolling 24h window (mirrors the digest) — consecutive days tile with no gap/overlap
 * because the sweep fires once per local day. `force` ignores the hour gate (local testing).
 */

import { logger } from '@/lib/logger'
import { emitEvent } from '@/lib/events/emit'
import { localHour, localDate } from '@/lib/notifications/digest'

/** Institution-local hour at which the summary goes out (18:00 = end of the class day). */
export const SUBMISSION_SUMMARY_HOUR = 18

/** Hard cap per submission-source read, so an unbounded query never silently truncates
 *  at PostgREST's implicit 1000-row limit. Logged if hit (add pagination if it fires). */
const SWEEP_MAX_ROWS = 5000

export interface SubmissionSummaryResult {
  institutionsAtHour: number
  emitted: number
  skipped?: string
}

/** Per section: assessment id → { display label, submission count }. */
type SectionTally = Map<string, { label: string; count: number }>

/** How many assessments to name in the body before collapsing the tail into "+N more". */
const MAX_NAMED = 6

/**
 * Emit the end-of-day submissions summary for every section that had submissions in the
 * last 24h, in institutions at their local summary hour. Best-effort; never throws.
 *
 * @param adminDb service-role Supabase client (bypasses RLS)
 * @param opts.force ignore the hour gate (local testing)
 */
export async function runSubmissionSummarySweep(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  opts: { force?: boolean } = {},
): Promise<SubmissionSummaryResult> {
  const now = new Date()

  // 1. Institutions at their local summary hour (all, if forced).
  const { data: institutions, error: instErr } = await adminDb
    .from('institutions')
    .select('id, timezone')
  if (instErr) {
    logger.error('runSubmissionSummarySweep: institutions query failed', instErr)
    return { institutionsAtHour: 0, emitted: 0 }
  }
  const insts = (institutions ?? []) as Array<{ id: string; timezone: string | null }>
  const dueInsts = insts.filter(
    (i) => opts.force || localHour(i.timezone || 'UTC', now) === SUBMISSION_SUMMARY_HOUR,
  )
  if (dueInsts.length === 0) {
    return { institutionsAtHour: 0, emitted: 0, skipped: 'no institutions at summary hour' }
  }
  const dueInstIds = dueInsts.map((i) => i.id)
  const tzByInst = new Map(dueInsts.map((i) => [i.id, i.timezone || 'UTC']))

  // 2. Sections (that have a professor) in those institutions → per-section metadata.
  const { data: sectionRows } = await adminDb
    .from('course_sections')
    .select('id, professor_id, institution_id, course:courses(code, title)')
    .in('institution_id', dueInstIds)
  const sectionMeta = new Map<
    string,
    { professorId: string; institutionId: string }
  >()
  for (const s of (sectionRows ?? []) as Array<{
    id: string
    professor_id: string | null
    institution_id: string
  }>) {
    if (!s.professor_id) continue // a section with no professor has no one to notify
    sectionMeta.set(s.id, { professorId: s.professor_id, institutionId: s.institution_id })
  }
  if (sectionMeta.size === 0) {
    return { institutionsAtHour: dueInsts.length, emitted: 0, skipped: 'no sections' }
  }
  const sectionIds = Array.from(sectionMeta.keys())

  // Enrolled-student count per section — the denominator for "X of N submitted", so the
  // professor sees how many students still haven't turned each assessment in.
  const { data: enrollRows } = await adminDb
    .from('enrollments')
    .select('section_id')
    .in('section_id', sectionIds)
    .in('status', ['enrolled', 'active', 'completed'])
    .limit(SWEEP_MAX_ROWS)
  const enrolledBySection = new Map<string, number>()
  for (const e of (enrollRows ?? []) as Array<{ section_id: string }>) {
    enrolledBySection.set(e.section_id, (enrolledBySection.get(e.section_id) ?? 0) + 1)
  }

  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()

  // 3. Tally submissions per section over the trailing 24h, grouped by individual
  //    assessment (so the summary can name each one, not just "N assignments").
  const bySection = new Map<string, SectionTally>()
  const bump = (
    sectionId: string | null | undefined,
    fallbackLabel: string,
    assessmentId: string | null | undefined,
    title: string | null | undefined,
  ) => {
    if (!sectionId || !assessmentId || !sectionMeta.has(sectionId)) return
    const tally = bySection.get(sectionId) ?? (new Map() as SectionTally)
    const entry = tally.get(assessmentId) ?? { label: title?.trim() || fallbackLabel, count: 0 }
    entry.count += 1
    tally.set(assessmentId, entry)
    bySection.set(sectionId, tally)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolveOne = (v: any) => (Array.isArray(v) ? v[0] : v)

  // 3a. Assignment submissions — scoped by institution (has institution_id directly),
  //     assessment + section via the assignment join.
  const { data: aSubs } = await adminDb
    .from('assignment_submissions')
    .select('assignment:assignments!inner(id, section_id, title)')
    .in('institution_id', dueInstIds)
    .in('status', ['submitted', 'graded'])
    .gte('submitted_at', since)
    .limit(SWEEP_MAX_ROWS)
  const aRows = (aSubs ?? []) as Array<{ assignment: unknown }>
  if (aRows.length === SWEEP_MAX_ROWS) {
    logger.warn('runSubmissionSummarySweep: assignment read hit row cap', { cap: SWEEP_MAX_ROWS })
  }
  for (const r of aRows) {
    const a = resolveOne(r.assignment)
    bump(a?.section_id, 'Assignment', a?.id, a?.title)
  }

  // 3b. Quiz attempts — section_id is direct; graded (not practice), submitted only.
  const { data: qAtt } = await adminDb
    .from('quiz_attempts')
    .select('section_id, quiz:quizzes(id, title)')
    .in('section_id', sectionIds)
    .eq('status', 'submitted')
    .eq('mode', 'graded')
    .gte('submitted_at', since)
    .limit(SWEEP_MAX_ROWS)
  for (const r of (qAtt ?? []) as Array<{ section_id: string | null; quiz: unknown }>) {
    const q = resolveOne(r.quiz)
    bump(r.section_id, 'Quiz', q?.id, q?.title)
  }

  // 3c. Project submissions — a JSONB blob on project_teams; assessment + section via the
  //     project join. One submission per team. ISO-8601 UTC strings sort lexically.
  //     Scoped to the due sections via the embedded filter (project_teams carries no
  //     section_id directly), so other institutions' rows can't eat the row cap and
  //     silently under-count a section — matching the assignment/quiz reads above.
  const { data: pSubs } = await adminDb
    .from('project_teams')
    .select('project:projects!inner(id, section_id, title)')
    .in('project.section_id', sectionIds)
    .eq('submission->>status', 'submitted')
    .gte('submission->>submitted_at', since)
    .limit(SWEEP_MAX_ROWS)
  const pRows = (pSubs ?? []) as Array<{ project: unknown }>
  if (pRows.length === SWEEP_MAX_ROWS) {
    logger.warn('runSubmissionSummarySweep: project read hit row cap', { cap: SWEEP_MAX_ROWS })
  }
  for (const r of pRows) {
    const p = resolveOne(r.project)
    bump(p?.section_id, 'Project', p?.id, p?.title)
  }

  // 4. Sections with at least one submission → claim (professor, section, local day).
  const active = Array.from(bySection.entries())
  if (active.length === 0) {
    return { institutionsAtHour: dueInsts.length, emitted: 0, skipped: 'no submissions' }
  }

  const claimRows = active.map(([sectionId]) => {
    const meta = sectionMeta.get(sectionId)!
    return {
      professor_id: meta.professorId,
      section_id: sectionId,
      institution_id: meta.institutionId,
      summary_date: localDate(tzByInst.get(meta.institutionId) || 'UTC', now),
    }
  })
  const { data: claimed, error: claimErr } = await adminDb
    .from('submission_summary_logs')
    .upsert(claimRows, {
      onConflict: 'professor_id,section_id,summary_date',
      ignoreDuplicates: true,
    })
    .select('section_id')
  if (claimErr) {
    logger.error('runSubmissionSummarySweep: claim failed', claimErr)
    return { institutionsAtHour: dueInsts.length, emitted: 0 }
  }
  const claimedSections = new Set(
    ((claimed ?? []) as Array<{ section_id: string }>).map((c) => c.section_id),
  )

  // 5. Emit one summary per newly-claimed section. onDuplicate:'refresh' keeps a single
  //    evolving row per section. emitEvent drops professors who muted the summary kind.
  let emitted = 0
  for (const [sectionId, tally] of active) {
    if (!claimedSections.has(sectionId)) continue
    const meta = sectionMeta.get(sectionId)!
    const entries = Array.from(tally.values()).sort((a, b) => b.count - a.count)
    const total = entries.reduce((sum, e) => sum + e.count, 0)
    // Name each assessment as "X of N submitted" (N = enrolled students), so the professor
    // sees how many are still outstanding; collapse a long tail so the body stays scannable.
    const enrolled = enrolledBySection.get(sectionId) ?? 0
    const named = entries
      .slice(0, MAX_NAMED)
      .map((e) => (enrolled > 0 ? `${e.label}: ${e.count} of ${enrolled}` : `${e.label}: ${e.count}`))
    if (entries.length > MAX_NAMED) named.push(`+${entries.length - MAX_NAMED} more`)
    await emitEvent({
      type: 'submissions_summary',
      sectionId,
      institutionId: meta.institutionId,
      actorId: null, // system/time-based — never dropped as a self-notify
      audience: [meta.professorId],
      entity: { type: 'section', id: sectionId },
      onDuplicate: 'refresh',
      title: `${total} new submission${total === 1 ? '' : 's'} today`,
      body: named.join(' · '),
      linkUrl: `/professor/courses/${sectionId}`,
      actionable: false,
    })
    emitted += 1
  }

  logger.info('runSubmissionSummarySweep: emitted', {
    emitted,
    institutionsAtHour: dueInsts.length,
  })
  return { institutionsAtHour: dueInsts.length, emitted }
}
