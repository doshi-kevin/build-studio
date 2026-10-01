// One student's journey state over every openable node on a section's roadmap.
//
// Extracted from `buildStudyFocus`, which used to own this read privately. Two
// callers now need it and they need OPPOSITE slices: "what should I study next"
// wants the unmastered tail, ranked and truncated; the knowledge map wants every
// node, because a prerequisite the student has already mastered is still a stop
// on the path to the thing they asked about. Sharing the loader is what keeps
// them from disagreeing about what a node is or what it's worth — and stops a
// second per-student mastery reader from appearing (§13.2's perf note).

import { journeyFromTopicAccuracy, type JourneyNodeInput, type NodeJourney } from '@/lib/roadmap/journey-state'
import { OPENABLE_ITEM_TYPES } from '@/lib/roadmap/prototype-adapter'
import { openModuleFilter } from '@/lib/modules/unlock'
import { buildStudentMastery } from '@/lib/skills/roadmap-mastery'

export interface RoadmapNodeRef {
  /** Canvas key `module_item:<id>` — what `?node=` on the roadmap takes. */
  key: string
  title: string
  topics: string[]
  /** The module band the node sits in — an artifact anchored to this node's
   *  subject belongs to the same week. */
  moduleId: string
}

export interface NodeJourneys {
  /** Every openable node, in course order. */
  nodes: RoadmapNodeRef[]
  /** key → the student's journey on that node. */
  journeys: Record<string, NodeJourney>
  /** Node IDS (not keys) the student ticked off themselves. */
  checkedOff: Set<string>
  /** The student's course-wide mastery (mean of their main-topic roll-ups), or
   *  null ONLY when they have no aggregate at all. Surfaced here because the
   *  mastery read below already computes it — the alternative is a second
   *  whole-section read on a chat path just to restate a number we were about to
   *  discard. A course with nothing openable still reports a real figure: null
   *  means "unassessed", never "nothing to open". */
  overall: number | null
}

/** The id half of a `type:id` canvas key — split on the FIRST colon, as
 *  `parseNodeKey` does, since the id is a uuid and the type may contain none. */
export const nodeIdOf = (key: string) => key.slice(key.indexOf(':') + 1)

export async function buildNodeJourneys(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  sectionId: string,
  userId: string,
): Promise<NodeJourneys> {
  // Published AND already open. A locked (not-yet-open) week must not surface —
  // matching every other student-facing reader of `modules`. The filter keeps a
  // locked module out of `moduleIds`, so its items can't reach either caller.
  const { data: modules } = await adminDb
    .from('modules')
    .select('id')
    .eq('section_id', sectionId)
    .eq('is_published', true)
    .or(openModuleFilter())
  const moduleIds = ((modules ?? []) as { id: string }[]).map((m) => m.id)

  const [itemsRes, progressRes] = await Promise.all([
    moduleIds.length > 0
      ? adminDb
          .from('module_items')
          .select('id, module_id, title, item_type, content')
          .in('module_id', moduleIds)
          .eq('is_visible', true)
      : Promise.resolve({ data: [] }),
    adminDb
      .from('roadmap_progress')
      .select('progress')
      .eq('section_id', sectionId)
      .eq('student_id', userId)
      .maybeSingle(),
  ])

  const asTopics = (raw: unknown): string[] =>
    Array.isArray(raw) ? (raw as unknown[]).filter((t): t is string => typeof t === 'string' && !!t.trim()) : []

  const nodes: RoadmapNodeRef[] = []
  const refs: JourneyNodeInput[] = []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const it of ((itemsRes.data ?? []) as any[])) {
    // Only material the canvas can actually OPEN. A note or a legacy assignment
    // item has no card to land on, so ranking or mapping one would have Athena
    // claim she opened something the roadmap answers "couldn't find that" to.
    if (!OPENABLE_ITEM_TYPES.has(it.item_type)) continue
    const topics = asTopics((it.content || {}).topics)
    const key = `module_item:${it.id}`
    refs.push({ key, topics })
    nodes.push({ key, title: it.title || 'Untitled material', topics, moduleId: it.module_id })
  }

  const nodeProgress = (progressRes.data?.progress?.nodeProgress ?? {}) as Record<string, { checkedOff?: boolean }>
  const checkedOff = new Set(
    Object.entries(nodeProgress)
      .filter(([, p]) => p?.checkedOff)
      .map(([id]) => id),
  )

  /* One narrowed read for this student only — buildStudentMastery's `studentId`
     form, not the section-wide aggregate.

     Runs BEFORE the no-nodes return on purpose. Mastery is scored against the
     course's TOPICS, which outlive whether any node is currently openable — a
     student can be fully assessed on a week that is now locked, or on a course
     whose material carries no topic labels. Returning null there would have
     Athena tell an assessed student that nothing has been assessed yet, so null
     is reserved for "no aggregate exists", not "nothing to open right now". */
  const scores = await buildStudentMastery(adminDb, sectionId, userId)
  const overall = scores.overallByStudent.get(userId) ?? null

  if (refs.length === 0) return { nodes, journeys: {}, checkedOff, overall }

  const topicAccuracy = scores.scoresByStudent.get(userId) ?? new Map<string, number>()

  const { nodes: journeys } = journeyFromTopicAccuracy(refs, topicAccuracy, checkedOff)
  return { nodes, journeys, checkedOff, overall }
}
