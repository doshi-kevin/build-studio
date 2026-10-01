import 'server-only'

/**
 * Coverage loader — verify, read, derive. Called straight from the roadmap
 * pages' server components (docs/designs/roadmap-mastery/roadmap-engine.md §13).
 *
 * Deliberately NOT a server action. The raw signals include class-wide counts
 * (how many students submitted each quiz, the roster size), which a student
 * must never receive — §8. As a plain server module there is no RPC endpoint to
 * invoke from a browser: only the derived per-node statuses leave this file,
 * and they reach the client as part of the already-public roadmap shape.
 * The `server-only` import above makes that a build error rather than a
 * convention — this module reaches SUPABASE_SERVICE_ROLE_KEY.
 *
 * Returns null on any failure or denial, and every caller renders the map
 * unchanged in that case — coverage is an enhancement, never a gate.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { computeCoverage, type CoverageResult, type StudentCoverage } from './coverage'
import { getCoverageSignals } from './coverage-signals'
import { ON_ROSTER_STATUSES } from '@/lib/validations/enrollment'
import { getPassedNodeChecks } from './node-check'
import type { AutoRoadmapData } from '@/lib/validations/auto-roadmap'

async function canRead(
  sectionId: string,
  userId: string,
  audience: 'professor' | 'student',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
): Promise<boolean> {
  if (audience === 'professor') {
    const { data } = await adminDb
      .from('course_sections')
      .select('id')
      .eq('id', sectionId)
      .eq('professor_id', userId)
      .maybeSingle()
    return !!data
  }
  const { data } = await adminDb
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', userId)
    .in('status', ON_ROSTER_STATUSES)
    .maybeSingle()
  return !!data
}

/**
 * Derive coverage for a section's roadmap, or null if the caller may not see it.
 *
 * The professor and student paths read the SAME class-wide delivery signals:
 * "how much of this course has actually been taught" is the question the map
 * answers for both, and it's the ceiling on a student's own coverage
 * (§11 decision 10). The student's own layer — node checks and check-offs —
 * arrives in slice 2.
 */
export async function loadRoadmapCoverage(
  sectionId: string,
  userId: string,
  audience: 'professor' | 'student',
  data: AutoRoadmapData,
): Promise<CoverageResult | null> {
  try {
    const adminDb = createAdminClient()
    if (!(await canRead(sectionId, userId, audience, adminDb))) return null

    const [signals, student] = await Promise.all([
      getCoverageSignals(adminDb, sectionId),
      audience === 'student' ? getStudentCoverage(adminDb, sectionId, userId) : Promise.resolve(undefined),
    ])
    return computeCoverage(data, signals, student)
  } catch (error) {
    logger.error('loadRoadmapCoverage', error, { sectionId, audience })
    return null
  }
}

/**
 * The student's own completed extras, from the check-offs `roadmap_progress`
 * already stores (§14.1) — no new table. Slice 2b adds passed node checks to
 * the same set.
 */
async function getStudentCoverage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  sectionId: string,
  studentId: string,
): Promise<StudentCoverage> {
  const { data } = await adminDb
    .from('roadmap_progress')
    .select('progress')
    .eq('section_id', sectionId)
    .eq('student_id', studentId)
    .maybeSingle()

  const nodeProgress = (data?.progress?.nodeProgress ?? {}) as Record<string, { checkedOff?: boolean }>
  const completedExtras = new Set<string>()
  for (const [nodeKey, p] of Object.entries(nodeProgress)) {
    if (p?.checkedOff) completedExtras.add(nodeKey)
  }
  // A passed node check counts the same as a self check-off — both mean "this
  // student went through it" (§14). Material we can read gets the check; the
  // rest keeps the tick.
  for (const itemId of await getPassedNodeChecks(adminDb, sectionId, studentId)) {
    completedExtras.add(itemId)
  }
  return { completedExtras }
}
