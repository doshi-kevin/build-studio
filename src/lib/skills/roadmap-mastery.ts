// Bridge: curated Topic Mastery → roadmap node colouring.
//
// Builds per-student topic-score maps from `skill_mastery` so the roadmap's
// journey engine (src/lib/roadmap/journey-state.ts) can colour each node by the
// student's real mastery instead of quiz-tag string-matching. A roadmap node's
// free-text topic labels join to curated topics by normalised name; a node whose
// labels match nothing in `topics` simply has no signal (stays "not started").
//
// Server-side (takes an admin client) — never reaches the browser.

import 'server-only'
import { aggregateStudentMastery, type MasteryDatum } from '@/lib/skills/aggregate'
import { readAllPages } from '@/lib/supabase/paged-read'
import { normalizeTopicKey } from '@/lib/roadmap/journey-state'
import type { SkillRow } from '@/lib/validations/skill'

export interface StudentMasteryMaps {
  /** Per student: `Map<normalisedTopicName, score 0–100>` (mains + subs) — the
   *  journey engine's node-colouring input. */
  scoresByStudent: Map<string, Map<string, number>>
  /** Per student: their overall mastery — the mean of their MAIN-topic
   *  roll-ups (subs fold into their main, so nothing double-counts). Reads the
   *  curated skill scores DIRECTLY, not via roadmap-node topic labels, so it
   *  exists whenever scores exist — even on a course whose module items carry
   *  no topic labels (#493). ONE definition shared by the professor's roster
   *  and the student's own figure, so the two roles always agree. */
  overallByStudent: Map<string, number>
}

/**
 * Build every enrolled student's mastery views from `skill_mastery`: the
 * per-topic score map (a subtopic uses its own score; a main topic the
 * roll-up of its subtopics, so node labels can match either level) and the
 * overall roll-up. Students with no mastery rows are simply absent.
 *
 * `studentId` narrows the read to one student. The professor views want the whole
 * section; a student-facing caller wants exactly their own row set, and one of
 * those callers (Athena's study-focus tool) is reachable from a chat box — no
 * reason to aggregate the class on every question.
 */
export async function buildStudentMastery(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  sectionId: string,
  studentId?: string,
): Promise<StudentMasteryMaps> {
  const out: StudentMasteryMaps = { scoresByStudent: new Map(), overallByStudent: new Map() }

  const { data: topicRows } = await adminDb.from('skills').select('*').eq('section_id', sectionId)
  // Same filter as concept analytics (getConceptAnalytics): a topic the
  // professor excluded — or the pipeline suppressed — must not colour nodes or
  // count toward the overall %, even if stale skill_mastery rows survive it
  // (nothing deletes them). Without this the roadmap headline disagrees with
  // Class analytics on the same page — the exact mismatch #493 closed.
  const topics = ((topicRows ?? []) as SkillRow[]).filter((t) => !t.excluded && !t.suppressed)
  if (topics.length === 0) return out

  /* Paged, because the section-wide form (no `studentId`) feeds the professor's
     roster figures: PostgREST silently caps a bare select at 1000 rows, and at
     ~10+ mastery rows per student a ~90-student course crosses it — which would
     not blank a student's overall %, it would quietly compute the wrong one.
     `id` is selected as well as ordered on: paging needs a UNIQUE sort key, and
     every other column here repeats. The narrowed per-student form is one page. */
  const masteryRows = await readAllPages<{
    student_id: string
    skill_id: string
    score: number | null
    state: { n?: number; w?: number } | null
  }>(
    () => {
      const q = adminDb
        .from('skill_mastery')
        .select('id, student_id, skill_id, score, state')
        .eq('section_id', sectionId)
      return studentId ? q.eq('student_id', studentId) : q
    },
    'id',
    'buildStudentMastery',
  )

  // Group mastery rows by student.
  const byStudent = new Map<string, MasteryDatum[]>()
  for (const r of (masteryRows ?? []) as Array<{
    student_id: string
    skill_id: string
    score: number | null
    state: { n?: number; w?: number } | null
  }>) {
    const datum: MasteryDatum = {
      student_id: r.student_id,
      skill_id: r.skill_id,
      score: r.score == null ? null : Number(r.score),
      n: typeof r.state?.n === 'number' ? r.state.n : r.score != null ? 1 : 0,
      w: typeof r.state?.w === 'number' ? r.state.w : null,
    }
    const list = byStudent.get(r.student_id) ?? []
    list.push(datum)
    byStudent.set(r.student_id, list)
  }

  for (const [studentId, rows] of byStudent) {
    const map = new Map<string, number>()
    const mains: number[] = []
    for (const main of aggregateStudentMastery(topics, rows)) {
      if (main.classScore != null) {
        map.set(normalizeTopicKey(main.name), main.classScore)
        mains.push(main.classScore)
      }
      for (const sub of main.subtopics) {
        if (sub.score != null) map.set(normalizeTopicKey(sub.name), sub.score)
      }
    }
    if (map.size > 0) out.scoresByStudent.set(studentId, map)
    if (mains.length > 0) {
      out.overallByStudent.set(studentId, Math.round(mains.reduce((a, b) => a + b, 0) / mains.length))
    }
  }
  return out
}

/** A roadmap node the journey engine scores, with its week grouping. */
export interface JourneyNodeRef {
  /** Node key: `module_item:${id}`. */
  key: string
  /** Owning module group key (`module:${id}`). */
  groupKey: string
  topics: string[]
}

export interface JourneyWeekGroup {
  key: string
  label: string
  title: string
  nodeKeys: string[]
}

/**
 * The section's journey node universe: every module item with its topic
 * labels, grouped by module ("week"). Professor-only today (the roster's
 * per-node journeys in getStudentJourneys) — the student's overall figure
 * reads buildStudentMastery's roll-up directly and never needs the node set.
 */
export async function buildSectionJourneyRefs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  sectionId: string,
): Promise<{ weeks: JourneyWeekGroup[]; nodeRefs: JourneyNodeRef[] }> {
  const { data: modules } = await adminDb
    .from('modules')
    .select('id, title, week_number, position')
    .eq('section_id', sectionId)
    .order('position', { ascending: true })

  const moduleIds = (modules || []).map((m: { id: string }) => m.id)

  const itemsResult = moduleIds.length > 0
    ? await adminDb
        .from('module_items')
        .select('id, module_id, item_type, content')
        .in('module_id', moduleIds)
        .order('position', { ascending: true })
    : { data: [], error: null }

  const weeks: JourneyWeekGroup[] = []
  const nodeRefs: JourneyNodeRef[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allItems = (itemsResult.data || []) as any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const m of (modules || []) as any[]) {
    const groupKey = `module:${m.id}`
    const items = allItems.filter((it) => it.module_id === m.id && it.item_type !== 'section_divider')
    const nodeKeys: string[] = []
    for (const it of items) {
      const content = (it.content || {}) as Record<string, unknown>
      const rawTopics = content.topics
      const topics = Array.isArray(rawTopics)
        ? (rawTopics as unknown[]).filter((t): t is string => typeof t === 'string' && !!t.trim())
        : []
      const key = `module_item:${it.id}`
      nodeRefs.push({ key, groupKey, topics })
      nodeKeys.push(key)
    }
    weeks.push({
      key: groupKey,
      label: m.week_number ? `Week ${m.week_number}` : 'Module',
      title: m.title || '',
      nodeKeys,
    })
  }
  return { weeks, nodeRefs }
}

/** A student's explicit check-offs, parsed from their roadmap_progress JSONB. */
export function checkedOffSetFrom(progress: unknown): Set<string> {
  const nodeProgress = ((progress as { nodeProgress?: Record<string, { checkedOff?: boolean }> } | null)
    ?.nodeProgress) || {}
  const set = new Set<string>()
  for (const [nodeId, p] of Object.entries(nodeProgress)) {
    if (p?.checkedOff) set.add(nodeId)
  }
  return set
}
