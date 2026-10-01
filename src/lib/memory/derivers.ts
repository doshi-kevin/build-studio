/**
 * The derivers: what memory knows about a user that nobody had to tell it.
 *
 * None of this is stored. Every deriver reads the table that already owns the
 * fact, so a re-grade or a skills recompute changes the next read with nothing
 * to invalidate. They are batch-shaped on purpose — each takes a LIST of user
 * ids and issues a fixed number of queries regardless of list length, so the
 * 5-minute nudge sweep costs the same as one chat turn.
 *
 * Every deriver degrades to an empty result rather than throwing. A missing
 * signal must never break a chat turn (the house rule in lib/supabase/queries.ts).
 */

import 'server-only'
import { logger } from '@/lib/logger'
import { fence } from '@/lib/ai/prompt-fence'
import { rollUpScore, MASTERY_THRESHOLDS } from '@/lib/skills/mastery'
import { resolveJoin } from '@/lib/supabase/resolve-join'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

/** Skills with fewer completed activities than this are not claims, they are
 *  noise. Measured, not guessed: on the richest student in the database the
 *  correct count tops out at 4, so a higher floor returns almost nothing, while
 *  at 1 a single quiz tagged with five skills reads as five separate findings.
 *  See docs/designs/athena/memory-prototype-findings.md. */
export const MIN_COMPLETED_ACTIVITIES = 2

/** A skill last assessed longer ago than this is dropped: a stale weakness is
 *  worse than no weakness, because the student has probably moved on. */
const STALE_AFTER_DAYS = 60

/** How far ahead "due soon" looks. */
const DUE_WITHIN_DAYS = 7

/* Skill names, assignment titles and quiz titles are FREE TEXT: professors type
   them and the extraction pipeline mints them from uploaded files. They end up
   inside a system prompt, so a name containing `</instruction>` would be
   indistinguishable from the prompt's own markup. Fenced here, at the edge of
   the layer, so every consumer is safe rather than each having to remember —
   and because these are read live there is no write moment to fence at. */
const LABEL_MAX = 120

export interface WeakSkill {
  skill: string
  score: number
  /** Distinct activities THIS student actually completed that touch the skill
   *  group. Carried so a renderer can write "across 2 quizzes" and a reader can
   *  tell a real finding from a thin one. */
  completedActivities: number
}

export interface DueItem {
  title: string
  kind: 'assignment' | 'quiz'
  dueAt: string
}

export interface RecentClass {
  endedAt: string
  attended: boolean
  hasRecap: boolean
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

/** Words too generic to make two skill names "the same topic". */
const STOPWORDS = new Set(['and', 'the', 'of', 'a', 'an', 'to', 'in', 'for', 'with', 'structures', 'techniques'])

const significantTokens = (name: string): Set<string> =>
  new Set(
    name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  )

/**
 * Collapse findings that are the same finding wearing different names.
 *
 * Sections accumulate near-synonyms — one real course carries "Softmax
 * Function", "softmax classifier" and "softmax" as three separate scored
 * skills, plus "avl trees", "balanced bst" and "Binary Search Trees and
 * Balanced Tree Structures". Rolling up to `skills.parent_id` only helps where
 * a parent exists, and these have none, so without this the top three lines of
 * the prompt are three names for one topic.
 *
 * Two signals, neither of them a guess at meaning:
 *
 *  1. IDENTICAL EVIDENCE. Same score, assessed by exactly the same set of
 *     completed activities. That is not similarity, it is the same measurement
 *     reported twice, so one of them is redundant by construction.
 *  2. NAME OVERLAP. A candidate sharing a significant word with something
 *     already kept ("softmax") is dropped. Cheap, lexical, and deliberately not
 *     semantic: catching "avl trees" against "balanced bst" would need
 *     embeddings, which this layer does not have and does not want.
 *
 * The list arrives weakest-first, so the survivor of any collapse is the
 * lowest-scoring member, which is the one worth raising. Among equals the
 * longer name wins, because "Binary Search Trees and Balanced Tree Structures"
 * tells a student more than "avl trees".
 */
export function dedupeFindings<T extends WeakSkill & { evidenceKey: string }>(ranked: T[]): WeakSkill[] {
  const byEvidence = new Map<string, T>()
  for (const f of ranked) {
    const held = byEvidence.get(f.evidenceKey)
    if (!held || f.skill.length > held.skill.length) byEvidence.set(f.evidenceKey, f)
  }
  // Map preserves insertion order, which is still weakest-first.
  const collapsed = [...byEvidence.values()].sort(
    (a, b) => a.score - b.score || b.completedActivities - a.completedActivities,
  )

  const kept: WeakSkill[] = []
  const claimed = new Set<string>()
  for (const f of collapsed) {
    const tokens = significantTokens(f.skill)
    if ([...tokens].some((t) => claimed.has(t))) continue
    for (const t of tokens) claimed.add(t)
    kept.push({ skill: f.skill, score: f.score, completedActivities: f.completedActivities })
  }
  return kept
}

/** Empty map with an entry per requested user, so callers never branch on undefined. */
function seed<T>(userIds: string[], make: () => T): Map<string, T> {
  return new Map(userIds.map((id) => [id, make()]))
}

/**
 * Weakest skill GROUPS per student.
 *
 * Three corrections live in here, each of which produced visibly wrong output
 * before it was made:
 *
 *  1. Rank PARENT skills, not leaves. Sections carry near-synonyms ("Softmax
 *     Function" and "softmax classifier" both exist), so a leaf ranking fills
 *     the top three slots with three names for one concept.
 *  2. Do not trust `skill_mastery.state.n`. It counts skill-tag pairs, so one
 *     quiz tagged with five skills gives all five n=5 and an identical
 *     updated_at — one quiz wearing five hats.
 *  3. Do not trust `activity_skills` alone either. It has no student column: it
 *     maps the COURSE's activities to skills, so counting it tells you what the
 *     course covers, not what this student did. It has to be intersected with
 *     the student's own submissions.
 */
export async function deriveWeakSkills(
  db: AdminDb,
  { userIds, sectionId }: { userIds: string[]; sectionId: string },
): Promise<Map<string, WeakSkill[]>> {
  const out = seed<WeakSkill[]>(userIds, () => [])
  if (userIds.length === 0) return out

  try {
    const { data: mastery, error: masteryError } = await db
      .from('skill_mastery')
      .select('student_id, skill_id, score, updated_at, skills(id, name, parent_id, excluded, suppressed)')
      .eq('section_id', sectionId)
      .in('student_id', userIds)
      .lt('score', MASTERY_THRESHOLDS.strong)
      .gte('updated_at', daysAgo(STALE_AFTER_DAYS))

    // Read the error, not just the data. A rejected request and a student with
    // no mastery rows are indistinguishable otherwise, and the first one is the
    // failure mode that reached production.
    if (masteryError) throw masteryError
    const rows = (mastery ?? []) as Array<{
      student_id: string
      skill_id: string
      score: number | null
      skills: unknown
    }>
    if (rows.length === 0) return out

    // Leaf -> the group it rolls into, and a fallback name for that group.
    const groupOf = new Map<string, string>()
    const fallbackName = new Map<string, string>()
    /* Groups formed by rolling children UP. Their real label is the parent's own
       name and has to be fetched, because a parent is only present in `rows`
       when it happens to be scored itself. Tracking them separately matters: an
       earlier version let whichever child loaded first name the group, so a
       finding about "Regularization Techniques" was reported to the student as
       "L1 regularization" — narrower than the evidence supports, and wrong
       whenever the sibling was the weaker one. Found by tmp/sim/churn.ts. */
    const rolledUp = new Set<string>()

    for (const r of rows) {
      const s = resolveJoin(r.skills) as
        | { id: string; name: string; parent_id: string | null; excluded: boolean; suppressed: boolean }
        | null
      if (!s || s.excluded || s.suppressed) continue
      const grp = s.parent_id ?? s.id
      groupOf.set(r.skill_id, grp)
      if (s.parent_id) {
        rolledUp.add(grp)
        if (!fallbackName.has(grp)) fallbackName.set(grp, s.name)
      } else {
        // A skill standing on its own always names itself.
        fallbackName.set(grp, s.name)
        rolledUp.delete(grp)
      }
    }
    const skillIds = [...groupOf.keys()]
    if (skillIds.length === 0) return out

    const groupName = new Map(fallbackName)
    if (rolledUp.size > 0) {
      const { data: parents } = await db.from('skills').select('id, name').in('id', [...rolledUp])
      for (const p of (parents ?? []) as Array<{ id: string; name: string }>) {
        groupName.set(p.id, p.name)
      }
    }

    // Which course activities touch each group.
    const { data: links } = await db
      .from('activity_skills')
      .select('skill_id, activity_id, activity_type')
      .in('skill_id', skillIds)

    const linkRows = (links ?? []) as Array<{ skill_id: string; activity_id: string; activity_type: string }>
    const byType = { quiz: new Set<string>(), assignment: new Set<string>(), live_quiz: new Set<string>() }
    for (const l of linkRows) {
      const bucket = byType[l.activity_type as keyof typeof byType]
      if (bucket) bucket.add(l.activity_id)
    }

    // Which of those each student actually completed. `activity_id` points at
    // quizzes.id, assignments.id and lc_interactions.id respectively.
    const completed = new Map<string, Set<string>>(userIds.map((id) => [id, new Set<string>()]))
    const mark = (studentId: string, activityId: string) => completed.get(studentId)?.add(activityId)

    const [quizDone, asgDone, liveDone] = await Promise.all([
      byType.quiz.size
        ? db.from('quiz_attempts').select('student_id, quiz_id')
            .in('student_id', userIds).in('quiz_id', [...byType.quiz]).eq('status', 'submitted')
        : Promise.resolve({ data: [] }),
      byType.assignment.size
        ? db.from('assignment_submissions').select('student_id, assignment_id')
            .in('student_id', userIds).in('assignment_id', [...byType.assignment])
            .in('status', ['submitted', 'graded', 'returned'])
        : Promise.resolve({ data: [] }),
      byType.live_quiz.size
        ? db.from('lc_responses').select('student_id, interaction_id')
            .in('student_id', userIds).in('interaction_id', [...byType.live_quiz])
        : Promise.resolve({ data: [] }),
    ])
    for (const r of (quizDone.data ?? []) as Array<{ student_id: string; quiz_id: string }>) mark(r.student_id, r.quiz_id)
    for (const r of (asgDone.data ?? []) as Array<{ student_id: string; assignment_id: string }>) mark(r.student_id, r.assignment_id)
    for (const r of (liveDone.data ?? []) as Array<{ student_id: string; interaction_id: string }>) mark(r.student_id, r.interaction_id)

    // Which activities each group is reachable through, for the intersection.
    const groupActivities = new Map<string, Set<string>>()
    for (const l of linkRows) {
      const grp = groupOf.get(l.skill_id)
      if (!grp) continue
      if (!groupActivities.has(grp)) groupActivities.set(grp, new Set())
      groupActivities.get(grp)!.add(l.activity_id)
    }

    // Roll each student's leaves into groups, weighted by evidence.
    for (const userId of userIds) {
      const leaves = new Map<string, Array<{ score: number | null; n: number }>>()
      for (const r of rows) {
        if (r.student_id !== userId) continue
        const grp = groupOf.get(r.skill_id)
        if (!grp) continue
        if (!leaves.has(grp)) leaves.set(grp, [])
        // Weight by 1 per leaf: `state.n` is the inflated count (correction 2),
        // and an unweighted mean over leaves is the honest roll-up here.
        leaves.get(grp)!.push({ score: r.score, n: 1 })
      }

      const done = completed.get(userId) ?? new Set<string>()
      const scored: Array<WeakSkill & { evidenceKey: string }> = []
      for (const [grp, children] of leaves) {
        const score = rollUpScore(children)
        if (score == null) continue
        const hits: string[] = []
        for (const activityId of groupActivities.get(grp) ?? []) if (done.has(activityId)) hits.push(activityId)
        if (hits.length < MIN_COMPLETED_ACTIVITIES) continue
        const name = groupName.get(grp)
        if (!name) continue
        scored.push({
          skill: fence(name, LABEL_MAX),
          score: Math.round(score),
          completedActivities: hits.length,
          // Two skills assessed by exactly the same work, at the same score, are
          // one finding under two names. See dedupe below.
          evidenceKey: `${Math.round(score)}|${hits.sort().join(',')}`,
        })
      }
      scored.sort((a, b) => a.score - b.score || b.completedActivities - a.completedActivities)
      out.set(userId, dedupeFindings(scored))
    }
    return out
  } catch (error) {
    logger.error('deriveWeakSkills: failed', error, { source: 'memory.deriveWeakSkills', sectionId })
    return out
  }
}

/**
 * What is due in the next week, read from the tables that own due dates rather
 * than from `feed_items` (which carries one on roughly a tenth of its rows).
 * Section-wide, so every student in the section gets the same list.
 */
export async function deriveUpcoming(
  db: AdminDb,
  { userIds, sectionId }: { userIds: string[]; sectionId: string },
): Promise<Map<string, DueItem[]>> {
  const out = seed<DueItem[]>(userIds, () => [])
  if (userIds.length === 0) return out

  try {
    const now = new Date().toISOString()
    const until = new Date(Date.now() + DUE_WITHIN_DAYS * 86_400_000).toISOString()
    const [assignments, quizzes] = await Promise.all([
      db.from('assignments').select('title, due_at').eq('section_id', sectionId)
        .eq('status', 'published').gt('due_at', now).lte('due_at', until),
      db.from('quizzes').select('title, due_date').eq('section_id', sectionId)
        .eq('status', 'published').gt('due_date', now).lte('due_date', until),
    ])

    if (assignments.error) throw assignments.error
    if (quizzes.error) throw quizzes.error
    const items: DueItem[] = [
      ...((assignments.data ?? []) as Array<{ title: string; due_at: string }>).map(
        (a): DueItem => ({ title: fence(a.title, LABEL_MAX), kind: 'assignment', dueAt: a.due_at }),
      ),
      ...((quizzes.data ?? []) as Array<{ title: string; due_date: string }>).map(
        (q): DueItem => ({ title: fence(q.title, LABEL_MAX), kind: 'quiz', dueAt: q.due_date }),
      ),
    ].sort((a, b) => a.dueAt.localeCompare(b.dueAt))

    for (const id of userIds) out.set(id, items)
    return out
  } catch (error) {
    logger.error('deriveUpcoming: failed', error, { source: 'memory.deriveUpcoming', sectionId })
    return out
  }
}

/**
 * The section's most recent ended live class, and whether this student was
 * there. The best-performing signal on real data: "since you missed Tuesday's
 * class" is what makes an opening line read as personal.
 */
export async function deriveRecentClass(
  db: AdminDb,
  { userIds, sectionId }: { userIds: string[]; sectionId: string },
): Promise<Map<string, RecentClass | null>> {
  const out = seed<RecentClass | null>(userIds, () => null)
  if (userIds.length === 0) return out

  try {
    const { data: rooms, error: roomsError } = await db
      .from('lc_rooms')
      .select('id, ended_at')
      .eq('section_id', sectionId)
      .not('ended_at', 'is', null)
      .order('ended_at', { ascending: false })
      .limit(1)

    if (roomsError) throw roomsError
    const room = ((rooms ?? []) as Array<{ id: string; ended_at: string }>)[0]
    if (!room) return out

    const [attendance, report] = await Promise.all([
      db.from('lc_attendance').select('student_id').eq('room_id', room.id).in('student_id', userIds),
      db.from('lc_session_reports').select('room_id').eq('room_id', room.id).maybeSingle(),
    ])
    if (attendance.error) throw attendance.error
    const present = new Set(
      ((attendance.data ?? []) as Array<{ student_id: string }>).map((a) => a.student_id),
    )
    const hasRecap = !!report.data

    /* "You missed the last class" is only a fact about someone who attends
       classes. Without this gate every id handed in comes back as an absentee,
       including a user who is not enrolled, has never opened a live session, or
       does not exist — the first run of this deriver cheerfully told a random
       uuid it had missed a lecture. Requiring some attendance history in the
       section makes absence meaningful: they come to class, and not to this one.
       A student who never attends live gets silence, which is correct, because
       we have nothing to say about their attendance either way. */
    const everAttended = new Set(
      ((
        (
          await db
            .from('lc_attendance')
            .select('student_id, lc_rooms!inner(section_id)')
            .eq('lc_rooms.section_id', sectionId)
            .in('student_id', userIds)
        ).data ?? []
      ) as Array<{ student_id: string }>).map((a) => a.student_id),
    )

    for (const id of userIds) {
      if (!everAttended.has(id)) continue
      out.set(id, { endedAt: room.ended_at, attended: present.has(id), hasRecap })
    }
    return out
  } catch (error) {
    logger.error('deriveRecentClass: failed', error, { source: 'memory.deriveRecentClass', sectionId })
    return out
  }
}
