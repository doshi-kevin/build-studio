/**
 * Project grading engine — phase-weighted, team + individual.
 *
 * A student's project grade is computed on read as Σ (earned/possible × weight)
 * over the rubric items that apply to them. Team-grained items contribute the
 * same value to every member; individual items are personal. Ungraded items are
 * dropped from that student's denominator (never scored 0). Only manual and
 * level-pick results are persisted (project_item_scores); assignment, quiz and
 * attendance are read live from their sources.
 *
 * The pure core (itemContribution, computeProjectGrades) has no I/O so it is
 * unit-testable; fetchProjectRubric / fetchGradeSources do the batched reads.
 *
 * v1 choices (see docs/designs/project-grading-engine.md): weights are points
 * (project total = Σ resolved weights); a contribution is clamped to [0, weight]
 * (no per-item extra credit); auto-pulled items (assignment/quiz/attendance) are
 * resolved per student — team grain applies to manual and level items, where the
 * professor enters one shared value.
 */

import { areGradesPublished } from '@/lib/validations/assignment'

// ── Types ────────────────────────────────────────────────────────

export type ItemType = 'assignment' | 'quiz' | 'attendance' | 'manual'
export type Grain = 'team' | 'individual'
export type ScoringMode = 'numeric' | 'levels'

export interface RubricLevel {
  id: string
  label: string
  points: number
}

export interface RubricItem {
  id: string // phase_item_id
  itemType: ItemType
  title: string
  weight: number
  grain: Grain
  scoringMode: ScoringMode
  levels: RubricLevel[]
  assignmentId: string | null
  quizId: string | null
  manualMax: number | null
  phaseId: string | null
  phaseName: string | null
  phaseStart: string | null
  phaseEnd: string | null
}

export interface RosterEntry {
  studentId: string
  teamId: string
}

export interface GradeSources {
  /** `${assignmentId}:${studentId}` → submission */
  assignmentSubs: Map<string, { status: string; score: number | null }>
  /** assignmentId → points (denominator) */
  assignmentPoints: Map<string, number>
  /** `${quizId}:${studentId}` → best attempt (carries its own denominator) */
  quizAttempts: Map<string, { score: number | null }>
  /** `${phaseItemId}:${studentId}` → attendance within that item's phase window */
  attendance: Map<string, { present: number; total: number }>
  /** team: `${phaseItemId}:team:${teamId}` · individual: `${phaseItemId}:stu:${studentId}` */
  itemScores: Map<string, { earned: number | null; levelId: string | null }>
}

export interface ItemResult {
  itemId: string
  itemType: ItemType
  title: string
  weight: number
  grain: Grain
  contribution: number | null // null = ungraded (excluded from denominator)
  graded: boolean
  detail: string // human label for the raw source state, e.g. "Graded 88/100"
}

export interface StudentGrade {
  studentId: string
  earned: number
  total: number // Σ weights of resolved items
  gradedCount: number
  itemCount: number
  items: ItemResult[]
}

// ── Pure core ────────────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100

function clampContribution(value: number, weight: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(value, weight))
}

function scoreKey(itemId: string, grain: Grain, studentId: string, teamId: string): string {
  return grain === 'team' ? `${itemId}:team:${teamId}` : `${itemId}:stu:${studentId}`
}

/**
 * Contribution of one item to one student, or null when the item is ungraded
 * for that student (so the caller can drop it from the denominator).
 */
export function itemContribution(
  item: RubricItem,
  studentId: string,
  teamId: string,
  sources: GradeSources,
): number | null {
  // Level-scored: the picked level's points are already on the 0…weight scale.
  if (item.scoringMode === 'levels') {
    const pick = sources.itemScores.get(scoreKey(item.id, item.grain, studentId, teamId))
    if (!pick || !pick.levelId) return null
    const level = item.levels.find((l) => l.id === pick.levelId)
    if (!level) return null
    return clampContribution(level.points, item.weight)
  }

  // Numeric: resolve raw earned + possible from the item's source.
  let earned: number | null = null
  let possible = 0

  if (item.itemType === 'manual') {
    const pick = sources.itemScores.get(scoreKey(item.id, item.grain, studentId, teamId))
    earned = pick?.earned ?? null
    possible = item.manualMax ?? 0
  } else if (item.itemType === 'attendance') {
    const a = sources.attendance.get(`${item.id}:${studentId}`)
    if (!a || a.total <= 0) return null // no attendance data → excluded
    earned = a.present
    possible = a.total
  } else if (item.itemType === 'assignment' && item.assignmentId) {
    const sub = sources.assignmentSubs.get(`${item.assignmentId}:${studentId}`)
    if (!sub || (sub.status !== 'graded' && sub.status !== 'returned')) return null
    earned = sub.score
    possible = sources.assignmentPoints.get(item.assignmentId) ?? 0
  } else if (item.itemType === 'quiz' && item.quizId) {
    const att = sources.quizAttempts.get(`${item.quizId}:${studentId}`)
    if (!att || att.score == null) return null
    // quiz_attempts.score is a 0-100 percentage (lib/quiz/scoring.ts), not raw
    // points — the item contributes that percentage of its weight.
    earned = att.score
    possible = 100
  }

  if (earned == null || possible <= 0) return null
  return clampContribution((earned / possible) * item.weight, item.weight)
}

/** Human label for an item's raw source state (independent of the weight). */
export function itemDetail(
  item: RubricItem,
  studentId: string,
  teamId: string,
  sources: GradeSources,
): string {
  if (item.scoringMode === 'levels') {
    const pick = sources.itemScores.get(scoreKey(item.id, item.grain, studentId, teamId))
    const level = pick?.levelId ? item.levels.find((l) => l.id === pick.levelId) : undefined
    return level ? level.label : 'Not graded'
  }
  if (item.itemType === 'manual') {
    const pick = sources.itemScores.get(scoreKey(item.id, item.grain, studentId, teamId))
    return pick?.earned != null ? `${pick.earned}/${item.manualMax ?? 0}` : 'Not entered'
  }
  if (item.itemType === 'attendance') {
    const a = sources.attendance.get(`${item.id}:${studentId}`)
    return a && a.total > 0 ? `${a.present}/${a.total} present` : 'No data'
  }
  if (item.itemType === 'assignment' && item.assignmentId) {
    const sub = sources.assignmentSubs.get(`${item.assignmentId}:${studentId}`)
    if (!sub || sub.status === 'draft') return 'Not submitted'
    if (sub.status !== 'graded' && sub.status !== 'returned') return 'Submitted'
    return `Graded ${sub.score}/${sources.assignmentPoints.get(item.assignmentId) ?? 0}`
  }
  if (item.itemType === 'quiz' && item.quizId) {
    const att = sources.quizAttempts.get(`${item.quizId}:${studentId}`)
    return att && att.score != null ? `Score ${att.score}%` : 'Not taken'
  }
  return 'Not graded'
}

/** Compute every roster student's project grade from the rubric + sources. */
export function computeProjectGrades(
  items: RubricItem[],
  roster: RosterEntry[],
  sources: GradeSources,
): Map<string, StudentGrade> {
  const out = new Map<string, StudentGrade>()
  for (const { studentId, teamId } of roster) {
    const results: ItemResult[] = []
    let earned = 0
    let total = 0
    let gradedCount = 0
    for (const item of items) {
      const contribution = itemContribution(item, studentId, teamId, sources)
      if (contribution != null) {
        earned += contribution
        total += item.weight
        gradedCount++
      }
      results.push({
        itemId: item.id,
        itemType: item.itemType,
        title: item.title,
        weight: item.weight,
        grain: item.grain,
        contribution,
        graded: contribution != null,
        detail: itemDetail(item, studentId, teamId, sources),
      })
    }
    out.set(studentId, {
      studentId,
      earned: round2(earned),
      total: round2(total),
      gradedCount,
      itemCount: items.length,
      items: results,
    })
  }
  return out
}

/** Percent (0–100) for a computed grade, or null when nothing is graded yet. */
export function gradePercent(g: StudentGrade): number | null {
  if (g.total <= 0) return null
  return round2((g.earned / g.total) * 100)
}

// ── Batched reads (impure) ───────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)

/** Assemble the rubric (items + resolved titles + phase windows) for a project. */
export async function fetchProjectRubric(adminDb: any, projectId: string): Promise<RubricItem[]> {
  const { data: rows } = await adminDb
    .from('project_phase_items')
    .select('id, item_type, assignment_id, quiz_id, weight, grain, scoring_mode, levels, manual_title, manual_max, position, phase:project_master_phases(id, name, start_date, end_date)')
    .eq('project_id', projectId)
    .order('position')
    .order('created_at') // stable tiebreaker when two concurrent adds share a position

  const items = (rows ?? []) as any[]
  const assignmentIds = [...new Set(items.filter((r) => r.item_type === 'assignment' && r.assignment_id).map((r) => r.assignment_id as string))]
  const quizIds = [...new Set(items.filter((r) => r.item_type === 'quiz' && r.quiz_id).map((r) => r.quiz_id as string))]

  const [assnMeta, quizMeta] = await Promise.all([
    assignmentIds.length ? adminDb.from('assignments').select('id, title').in('id', assignmentIds) : Promise.resolve({ data: [] }),
    quizIds.length ? adminDb.from('quizzes').select('id, title').in('id', quizIds) : Promise.resolve({ data: [] }),
  ])
  const assnTitle = new Map<string, string>()
  for (const a of (assnMeta.data ?? []) as any[]) assnTitle.set(a.id, a.title)
  const quizTitle = new Map<string, string>()
  for (const q of (quizMeta.data ?? []) as any[]) quizTitle.set(q.id, q.title)

  return items.map((r) => {
    const phase = resolveJoin(r.phase)
    const title =
      r.item_type === 'manual'
        ? r.manual_title || 'Manual item'
        : r.item_type === 'attendance'
          ? r.manual_title || 'Attendance'
          : r.item_type === 'assignment'
            ? assnTitle.get(r.assignment_id) ?? 'Assignment'
            : quizTitle.get(r.quiz_id) ?? 'Quiz'
    return {
      id: r.id,
      itemType: r.item_type,
      title,
      weight: Number(r.weight) || 0,
      grain: r.grain,
      scoringMode: r.scoring_mode,
      levels: Array.isArray(r.levels) ? (r.levels as RubricLevel[]) : [],
      assignmentId: r.assignment_id,
      quizId: r.quiz_id,
      manualMax: r.manual_max == null ? null : Number(r.manual_max),
      phaseId: phase?.id ?? null,
      phaseName: phase?.name ?? null,
      phaseStart: phase?.start_date ?? null,
      phaseEnd: phase?.end_date ?? null,
    }
  })
}

export type ScoreEntry = { earned: number | null; levelId: string | null }

/**
 * Split persisted score rows into prefill maps for one team's grade page. The
 * query returns EVERY team's rows for the project, so team-grained entries must
 * be scoped to `teamId` — a bare item-id key would prefill this team's input
 * with another team's score (and a save would silently overwrite it).
 * Returns team scores keyed by item id, individual scores keyed by `item:student`.
 */
export function partitionItemScores(
  rows: Array<{ phase_item_id: string; team_id: string | null; student_id: string | null; earned: number | string | null; level_id: string | null }>,
  teamId: string,
): { teamScores: Record<string, ScoreEntry>; studentScores: Record<string, ScoreEntry> } {
  const teamScores: Record<string, ScoreEntry> = {}
  const studentScores: Record<string, ScoreEntry> = {}
  for (const s of rows) {
    const entry: ScoreEntry = { earned: s.earned == null ? null : Number(s.earned), levelId: s.level_id ?? null }
    if (s.student_id) studentScores[`${s.phase_item_id}:${s.student_id}`] = entry
    else if (s.team_id === teamId) teamScores[s.phase_item_id] = entry
  }
  return { teamScores, studentScores }
}

/** Paginate a filtered read so >1000 rows never silently truncate (PostgREST max_rows). */
export async function fetchAllPages(build: () => any): Promise<any[]> {
  const PAGE = 1000
  const out: any[] = []
  let from = 0
  for (;;) {
    const { data } = await build().range(from, from + PAGE - 1)
    const rows = (data ?? []) as any[]
    out.push(...rows)
    if (rows.length < PAGE) break
    from += PAGE
  }
  return out
}

/**
 * Batch-read every score source the rubric needs for this roster. All roster-scoped
 * reads are paginated so a section over 1000 rows can't silently drop students.
 * `respectAssignmentPublish` (student paths) treats an unpublished assignment grade
 * as ungraded, so an unreleased score never leaks into the project total.
 */
export async function fetchGradeSources(
  adminDb: any,
  sectionId: string,
  items: RubricItem[],
  roster: RosterEntry[],
  opts?: { respectAssignmentPublish?: boolean },
): Promise<GradeSources> {
  const respectPublish = opts?.respectAssignmentPublish ?? false
  const studentIds = [...new Set(roster.map((r) => r.studentId))]
  const itemIds = items.map((i) => i.id)
  const assignmentIds = [...new Set(items.filter((i) => i.itemType === 'assignment' && i.assignmentId).map((i) => i.assignmentId as string))]
  const quizIds = [...new Set(items.filter((i) => i.itemType === 'quiz' && i.quizId).map((i) => i.quizId as string))]
  const attendanceItems = items.filter((i) => i.itemType === 'attendance')

  const [subs, assnRes, attempts, scores, roomsRes] = await Promise.all([
    assignmentIds.length && studentIds.length
      ? fetchAllPages(() => adminDb.from('assignment_submissions').select('id, assignment_id, student_id, status, score').in('assignment_id', assignmentIds).in('student_id', studentIds).order('id'))
      : Promise.resolve([]),
    assignmentIds.length ? adminDb.from('assignments').select('id, points, settings').in('id', assignmentIds) : Promise.resolve({ data: [] }),
    quizIds.length && studentIds.length
      ? fetchAllPages(() => adminDb.from('quiz_attempts').select('id, quiz_id, student_id, score').in('quiz_id', quizIds).in('student_id', studentIds).eq('status', 'submitted').order('id'))
      : Promise.resolve([]),
    itemIds.length ? fetchAllPages(() => adminDb.from('project_item_scores').select('id, phase_item_id, team_id, student_id, earned, level_id').in('phase_item_id', itemIds).order('id')) : Promise.resolve([]),
    attendanceItems.length ? adminDb.from('lc_rooms').select('id, created_at').eq('section_id', sectionId) : Promise.resolve({ data: [] }),
  ])

  // Assignment points + which assignments have grades published.
  const assignmentPoints = new Map<string, number>()
  const publishedAssignments = new Set<string>()
  for (const a of (((assnRes as { data?: any[] }).data) ?? []) as any[]) {
    assignmentPoints.set(a.id, Number(a.points) || 0)
    if (areGradesPublished(a.settings)) publishedAssignments.add(a.id)
  }

  const assignmentSubs = new Map<string, { status: string; score: number | null }>()
  for (const s of subs as any[]) {
    // Student paths: an unpublished assignment grade isn't visible yet → treat as ungraded.
    if (respectPublish && !publishedAssignments.has(s.assignment_id)) continue
    assignmentSubs.set(`${s.assignment_id}:${s.student_id}`, { status: s.status, score: s.score == null ? null : Number(s.score) })
  }

  // Best submitted attempt per (quiz, student). score is a 0-100 percentage.
  const quizAttempts = new Map<string, { score: number | null }>()
  for (const t of attempts as any[]) {
    const key = `${t.quiz_id}:${t.student_id}`
    const score = t.score == null ? null : Number(t.score)
    const prev = quizAttempts.get(key)
    if (!prev || (score ?? -1) > (prev.score ?? -1)) {
      quizAttempts.set(key, { score })
    }
  }

  const itemScores = new Map<string, { earned: number | null; levelId: string | null }>()
  for (const s of scores as any[]) {
    const key = s.student_id ? `${s.phase_item_id}:stu:${s.student_id}` : `${s.phase_item_id}:team:${s.team_id}`
    itemScores.set(key, { earned: s.earned == null ? null : Number(s.earned), levelId: s.level_id ?? null })
  }

  // Attendance: present/total per attendance item × student, windowed by phase.
  const attendance = new Map<string, { present: number; total: number }>()
  if (attendanceItems.length) {
    const rooms = (((roomsRes as { data?: any[] }).data) ?? []) as any[]
    const roomIds = rooms.map((r) => r.id)
    const attRows =
      roomIds.length && studentIds.length
        ? await fetchAllPages(() => adminDb.from('lc_attendance').select('room_id, student_id').in('room_id', roomIds).in('student_id', studentIds).order('room_id').order('student_id'))
        : []
    const attended = new Set<string>()
    for (const a of attRows as any[]) attended.add(`${a.room_id}:${a.student_id}`)

    for (const item of attendanceItems) {
      const windowRooms = rooms.filter((r) => {
        if (!item.phaseStart && !item.phaseEnd) return true
        const t = new Date(r.created_at).getTime()
        if (item.phaseStart && t < new Date(item.phaseStart).getTime()) return false
        if (item.phaseEnd && t > new Date(item.phaseEnd).getTime() + 86400000) return false // inclusive end-of-day
        return true
      })
      for (const sid of studentIds) {
        const present = windowRooms.reduce((n, r) => n + (attended.has(`${r.id}:${sid}`) ? 1 : 0), 0)
        attendance.set(`${item.id}:${sid}`, { present, total: windowRooms.length })
      }
    }
  }

  return { assignmentSubs, assignmentPoints, quizAttempts, attendance, itemScores }
}
