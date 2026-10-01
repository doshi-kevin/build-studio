// Server-side data layer for the weighted gradebook. Reads a section's grading scheme and every
// member item's score for a set of students, then shapes them into the ItemScore grid that
// compute.ts consumes. SERVER-ONLY: takes the admin client (service_role) — never import into a
// client component.
//
// Score normalization (so mixed item types combine cleanly):
//   • assignment — possible = assignment.points, earned = submission.score, released = gradesPublished flag
//   • quiz       — possible = 100, earned = best attempt's percentage score, released = true (visible once submitted)
//   • project    — possible = 100, earned = team's project grade, released = true (visible once graded)
//
// Every member item appears in every student's grid (defaulting to ungraded) so the grade math has a
// complete picture of the scheme. `released` here is the *actual* student-visible state;
// professorScores() flips it to true so staff always see graded work counted.
//
// DEFERRED (#464): the read functions (fetchGradingScheme / fetchSectionGradeData / professorScores)
// are currently reachable only from tests — their live callers were removed from PR #469 as dead
// code, resurrected by the #464 follow-up. `removeItemFromScheme` below is the ONE exception: it is
// live, called by the delete-assignment / delete-project / delete-quiz actions to clean up scheme
// rows on delete, so it (and the scheme tables) must stay.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { resolveJoin } from '@/lib/supabase/resolve-join'
import { areGradesPublished } from '@/lib/validations/assignment'
import {
  itemKey,
  type ItemScore,
  type ItemType,
  type SchemeCategory,
  type LetterCutoff,
  DEFAULT_LETTER_CUTOFFS,
} from './compute'

type AdminDb = SupabaseClient<Database>

export interface GradeItemMeta {
  itemType: ItemType
  itemId: string
  title: string
  possible: number
  dueAt: string | null
}

export interface SchemeData {
  schemeId: string
  cutoffs: LetterCutoff[]
  categories: SchemeCategory[]
}

export interface SectionGradeData {
  scheme: SchemeData | null
  itemsMeta: Record<string, GradeItemMeta> // keyed by itemKey
  scoresByStudent: Record<string, Record<string, ItemScore>> // studentId → itemKey → score
}

/** Load a section's scheme (categories + member items + letter cutoffs), or null if none exists. */
export async function fetchGradingScheme(adminDb: AdminDb, sectionId: string): Promise<SchemeData | null> {
  const { data: scheme } = await adminDb
    .from('grading_schemes')
    .select('id, letter_cutoffs')
    .eq('section_id', sectionId)
    .maybeSingle()

  if (!scheme) return null

  const [{ data: catRows }, { data: itemRows }] = await Promise.all([
    adminDb
      .from('grade_categories')
      .select('id, name, weight, aggregation, keep_n, score_mode, is_extra_credit, position')
      .eq('scheme_id', scheme.id)
      .order('position', { ascending: true }),
    adminDb
      .from('grade_category_items')
      .select('category_id, item_type, item_id, is_extra_credit')
      .eq('section_id', sectionId),
  ])

  const itemsByCat = new Map<string, SchemeCategory['items']>()
  for (const it of (itemRows || []) as Array<{ category_id: string; item_type: ItemType; item_id: string; is_extra_credit: boolean }>) {
    const list = itemsByCat.get(it.category_id) ?? []
    list.push({ itemType: it.item_type, itemId: it.item_id, isExtraCredit: it.is_extra_credit })
    itemsByCat.set(it.category_id, list)
  }

  const categories: SchemeCategory[] = ((catRows || []) as Array<Record<string, unknown>>).map((c) => ({
    id: c.id as string,
    name: c.name as string,
    weight: Number(c.weight) || 0,
    aggregation: c.aggregation as SchemeCategory['aggregation'],
    keepN: c.keep_n == null ? null : Number(c.keep_n),
    scoreMode: c.score_mode as SchemeCategory['scoreMode'],
    isExtraCredit: Boolean(c.is_extra_credit),
    position: Number(c.position) || 0,
    items: itemsByCat.get(c.id as string) ?? [],
  }))

  const cutoffs = Array.isArray(scheme.letter_cutoffs) && scheme.letter_cutoffs.length > 0
    ? (scheme.letter_cutoffs as unknown as LetterCutoff[])
    : DEFAULT_LETTER_CUTOFFS

  return { schemeId: scheme.id, cutoffs, categories }
}

/**
 * Build the full ItemScore grid for a scheme's member items across the given students.
 * Every (student, member item) pair gets an entry so the grade math sees the whole scheme, with
 * ungraded work represented explicitly.
 */
export async function fetchSectionGradeData(
  adminDb: AdminDb,
  sectionId: string,
  studentIds: string[],
): Promise<SectionGradeData> {
  const scheme = await fetchGradingScheme(adminDb, sectionId)
  if (!scheme || studentIds.length === 0) {
    return { scheme, itemsMeta: {}, scoresByStudent: {} }
  }

  // Collect member item ids by type.
  const assignmentIds: string[] = []
  const quizIds: string[] = []
  const projectIds: string[] = []
  for (const cat of scheme.categories) {
    for (const it of cat.items) {
      if (it.itemType === 'assignment') assignmentIds.push(it.itemId)
      else if (it.itemType === 'quiz') quizIds.push(it.itemId)
      else if (it.itemType === 'project') projectIds.push(it.itemId)
    }
  }

  // ── Item metadata + raw scores, fetched in parallel per type ──
  const [
    { data: assignments },
    { data: submissions },
    { data: quizzes },
    { data: attempts },
    { data: projects },
    { data: teams },
    { data: members },
    { data: exceptions },
  ] = await Promise.all([
    assignmentIds.length
      ? adminDb.from('assignments').select('id, title, points, due_at, settings').eq('section_id', sectionId).in('id', assignmentIds)
      : Promise.resolve({ data: [] }),
    assignmentIds.length
      ? adminDb
          .from('assignment_submissions')
          .select('assignment_id, student_id, score')
          .in('assignment_id', assignmentIds)
          .in('student_id', studentIds)
      : Promise.resolve({ data: [] }),
    quizIds.length
      ? adminDb.from('quizzes').select('id, title, due_date').eq('section_id', sectionId).in('id', quizIds)
      : Promise.resolve({ data: [] }),
    quizIds.length
      ? adminDb
          .from('quiz_attempts')
          .select('quiz_id, student_id, score, status')
          .in('quiz_id', quizIds)
          .in('student_id', studentIds)
          .eq('status', 'submitted')
      : Promise.resolve({ data: [] }),
    projectIds.length
      ? adminDb.from('projects').select('id, title, due_date').eq('section_id', sectionId).in('id', projectIds)
      : Promise.resolve({ data: [] }),
    projectIds.length
      ? adminDb.from('project_teams').select('id, project_id, project_grades(score)').in('project_id', projectIds)
      : Promise.resolve({ data: [] }),
    projectIds.length
      ? adminDb.from('project_members').select('user_id, team_id').in('user_id', studentIds)
      : Promise.resolve({ data: [] }),
    adminDb
      .from('grade_exceptions')
      .select('student_id, item_type, item_id')
      .eq('section_id', sectionId)
      .in('student_id', studentIds),
  ])

  // Metadata + per-assignment release flag.
  const itemsMeta: Record<string, GradeItemMeta> = {}
  const assignmentPossible = new Map<string, number>()
  const assignmentReleased = new Map<string, boolean>()
  for (const a of (assignments || []) as Array<{ id: string; title: string; points: number; due_at: string | null; settings: unknown }>) {
    const possible = Number(a.points) || 0
    assignmentPossible.set(a.id, possible)
    assignmentReleased.set(a.id, areGradesPublished(a.settings))
    itemsMeta[itemKey('assignment', a.id)] = { itemType: 'assignment', itemId: a.id, title: a.title, possible, dueAt: a.due_at }
  }
  for (const q of (quizzes || []) as Array<{ id: string; title: string; due_date: string | null }>) {
    itemsMeta[itemKey('quiz', q.id)] = { itemType: 'quiz', itemId: q.id, title: q.title, possible: 100, dueAt: q.due_date }
  }
  for (const p of (projects || []) as Array<{ id: string; title: string; due_date: string | null }>) {
    itemsMeta[itemKey('project', p.id)] = { itemType: 'project', itemId: p.id, title: p.title, possible: 100, dueAt: p.due_date }
  }

  // Assignment submission scores: (assignment, student) → score.
  const subScore = new Map<string, number | null>()
  for (const s of (submissions || []) as Array<{ assignment_id: string; student_id: string; score: number | null }>) {
    subScore.set(`${s.assignment_id}:${s.student_id}`, s.score)
  }

  // Best quiz attempt per (quiz, student).
  const quizBest = new Map<string, number | null>()
  for (const a of (attempts || []) as Array<{ quiz_id: string; student_id: string; score: number | null }>) {
    const key = `${a.quiz_id}:${a.student_id}`
    const prev = quizBest.get(key)
    if (prev == null || (a.score ?? -1) > (prev ?? -1)) quizBest.set(key, a.score)
  }

  // Project grade per (project, student) via the student's team.
  const teamGrade = new Map<string, number | null>() // teamId → score
  const teamProject = new Map<string, string>() // teamId → projectId
  for (const t of (teams || []) as Array<{ id: string; project_id: string; project_grades: unknown }>) {
    teamProject.set(t.id, t.project_id)
    const g = resolveJoin(t.project_grades as { score: number | null } | { score: number | null }[])
    teamGrade.set(t.id, g?.score ?? null)
  }
  const projectStudentScore = new Map<string, number | null>() // `${projectId}:${studentId}` → score
  for (const m of (members || []) as Array<{ user_id: string; team_id: string }>) {
    const projectId = teamProject.get(m.team_id)
    if (!projectId) continue
    projectStudentScore.set(`${projectId}:${m.user_id}`, teamGrade.get(m.team_id) ?? null)
  }

  const excusedSet = new Set<string>()
  for (const e of (exceptions || []) as Array<{ student_id: string; item_type: ItemType; item_id: string }>) {
    excusedSet.add(`${e.student_id}:${itemKey(e.item_type, e.item_id)}`)
  }

  // ── Build the grid: every student × every member item ──
  const scoresByStudent: Record<string, Record<string, ItemScore>> = {}
  for (const studentId of studentIds) {
    const row: Record<string, ItemScore> = {}
    for (const cat of scheme.categories) {
      for (const it of cat.items) {
        const meta = itemsMeta[itemKey(it.itemType, it.itemId)]
        if (!meta) continue // orphaned membership (item deleted)
        const key = itemKey(it.itemType, it.itemId)
        let earned: number | null = null
        let released = true
        if (it.itemType === 'assignment') {
          earned = subScore.get(`${it.itemId}:${studentId}`) ?? null
          released = assignmentReleased.get(it.itemId) ?? false
        } else if (it.itemType === 'quiz') {
          earned = quizBest.get(`${it.itemId}:${studentId}`) ?? null
        } else {
          earned = projectStudentScore.get(`${it.itemId}:${studentId}`) ?? null
        }
        row[key] = {
          earned,
          possible: meta.possible,
          graded: earned != null,
          released,
          excused: excusedSet.has(`${studentId}:${key}`),
        }
      }
    }
    scoresByStudent[studentId] = row
  }

  return { scheme, itemsMeta, scoresByStudent }
}

/** Flip release state to true for every entry — staff see all graded work counted regardless of release. */
export function professorScores(scores: Record<string, ItemScore>): Record<string, ItemScore> {
  const out: Record<string, ItemScore> = {}
  for (const k of Object.keys(scores)) out[k] = { ...scores[k], released: true }
  return out
}

/**
 * Remove a deleted assignment/quiz/project from any grading-scheme membership and clear its
 * per-student excuse rows. Category memberships are polymorphic (no FK to cascade), so item delete
 * actions call this to avoid leaving orphaned rows. Best-effort — failures are logged, not thrown.
 */
export async function removeItemFromScheme(
  adminDb: AdminDb,
  sectionId: string,
  itemType: ItemType,
  itemId: string,
): Promise<void> {
  await Promise.all([
    adminDb.from('grade_category_items').delete().eq('section_id', sectionId).eq('item_type', itemType).eq('item_id', itemId),
    adminDb.from('grade_exceptions').delete().eq('section_id', sectionId).eq('item_type', itemType).eq('item_id', itemId),
  ])
}
