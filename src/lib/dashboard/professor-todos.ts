// Professor dashboard to-do list — turns raw course signals into a prioritised,
// bucketed triage list. The professor mirror of `todos.ts`, with two deliberate
// differences:
//
//   1. ONE ROW PER (course × kind), never per underlying record. A student has
//      ~20 open items; a professor can have 90 draft assignments and 50 unreported
//      classes. Per-record rows would produce a list nobody reads, so counts are
//      aggregated and the row links into the surface where the work happens.
//      When a kind has exactly ONE underlying entity we name it, because
//      "Project 1 — 3 to grade" is more useful than "3 to grade".
//
//   2. PER-KIND urgency, not one due-date function. Ungraded work has no due
//      date — its urgency is how long a student has been waiting. Gating every
//      item on an author-entered due date is what leaves Moodle's teacher
//      timeline permanently empty.
//
// Kept free of server-only imports so it's easy to unit-test with plain fixtures.

import { bucketFor, formatDueLabel, safeHref, type TodoGroup } from './todos'

/** What kind of work a row represents. Drives the icon and the sort order. */
export type ProfessorTodoKind =
  | 'grading' //       submitted work waiting on a grade
  | 'deadline' //      an assessment closing soon, with its turn-in rate
  | 'class_prep' //    a scheduled session whose slide render failed
  | 'class_report' //  a post-class report ready to read

/** A ready-to-render professor to-do. Shares TodoItem's shape so `TodoList`
 *  renders both dashboards through one component. */
export interface ProfessorTodoItem {
  id: string
  kind: ProfessorTodoKind
  title: string
  /** Secondary line — always leads with the course code. */
  description: string
  sectionId: string
  /** e.g. "22d waiting", "Blocking", "Fri", "This week". */
  dueLabel: string
  group: TodoGroup
  href: string
  /** How many underlying records this row stands for (drives sort). */
  count: number
}

// ── Inputs ──────────────────────────────────────────────────────────────────
// Deliberately pre-narrowed: the query layer filters at the DB (only ungraded
// submissions, only recently-ended rooms) so this module never sees the
// thousands of rows a busy professor's sections actually contain.

export interface ProfessorAssessment {
  id: string
  sectionId: string
  title: string
  /** ISO instant, or null when the professor never set one. */
  dueAt: string | null
  /** Distinguishes the route a row links to. */
  type: 'assignment' | 'quiz'
}

export interface UngradedSubmission {
  assignmentId: string
  /** ISO instant the student turned it in. */
  submittedAt: string | null
}

export interface FailedSlideRoom {
  id: string
  sectionId: string
  name: string | null
  scheduledAt: string | null
}

export interface ProfessorTodoSources {
  /** section_id → course code, for the row subtext. */
  courseCodeBySection: Record<string, string>
  /** Published assignments + quizzes across the professor's sections. */
  assessments: ProfessorAssessment[]
  /** Submissions awaiting a grade (DB-filtered to status='submitted'). */
  ungraded: UngradedSubmission[]
  /** assessment id → how many students have turned it in. */
  turnedInByAssessment: Record<string, number>
  /** section_id → enrolled headcount, the denominator for the turn-in rate. */
  enrolledBySection: Record<string, number>
  /** Scheduled sessions whose deck render failed. */
  failedSlideRooms: FailedSlideRoom[]
  /** section_id → post-class reports ready from recently-ended sessions. */
  recentReportsBySection: Record<string, number>
}

// ── Thresholds ──────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000
/** A student waiting 3+ days on a grade is the professor's problem now. */
const GRADING_ATTENTION_DAYS = 3
/** Anything turned in today is not yet late; 1–2 days is "get to it". */
const GRADING_UPCOMING_DAYS = 1
/** Only assessments closing inside this window are worth a row. */
const DEADLINE_HORIZON_MS = 7 * DAY_MS

/**
 * Sort order WITHIN a bucket. The bucket already encodes urgency, so this only
 * has to be stable and explainable: things that block a student first, then the
 * time-critical break, then the bulk of the work.
 *
 * Rare-but-blocking kinds sit above grading on purpose — in the common case
 * they're absent entirely, so grading leads the list as it should.
 */
const KIND_PRIORITY: Record<ProfessorTodoKind, number> = {
  class_prep: 0,
  grading: 1,
  deadline: 2,
  class_report: 3,
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Whole days elapsed since `iso`, floored at 0. Null dates read as 0 (today). */
function daysSince(iso: string | null, now: number): number {
  if (iso == null) return 0
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY_MS))
}

/** Earliest non-null ISO instant in a list, or null. */
function earliest(dates: Array<string | null>): string | null {
  let best: string | null = null
  for (const d of dates) {
    if (d == null) continue
    if (best == null || new Date(d).getTime() < new Date(best).getTime()) best = d
  }
  return best
}

/** Group a list into a Map keyed by section, preserving input order. */
function bySection<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const row of rows) {
    const k = key(row)
    const bucket = out.get(k)
    if (bucket) bucket.push(row)
    else out.set(k, [row])
  }
  return out
}

const coursePath = (sectionId: string) => `/professor/courses/${sectionId}`

// ── Builders, one per kind ──────────────────────────────────────────────────

/**
 * Ungraded submissions, one row per course. Urgency is the age of the OLDEST
 * thing waiting — a single 22-day-old submission matters more than ten from
 * this morning, and feedback loses its value as it ages.
 */
function buildGrading(src: ProfessorTodoSources, now: number): ProfessorTodoItem[] {
  const assessmentById = new Map(src.assessments.map((a) => [a.id, a]))

  // Only submissions whose parent assessment is in the professor's sections —
  // a defensive filter, since the query already scopes by assignment id.
  const scoped = src.ungraded.filter((u) => assessmentById.has(u.assignmentId))
  const grouped = bySection(scoped, (u) => assessmentById.get(u.assignmentId)!.sectionId)

  const items: ProfessorTodoItem[] = []
  for (const [sectionId, rows] of grouped) {
    const code = src.courseCodeBySection[sectionId] ?? ''
    const assessmentIds = [...new Set(rows.map((r) => r.assignmentId))]
    const oldestDays = Math.max(...rows.map((r) => daysSince(r.submittedAt, now)))
    const single = assessmentIds.length === 1 ? assessmentById.get(assessmentIds[0]) : undefined

    items.push({
      id: `grading-${sectionId}`,
      kind: 'grading',
      // "to grade" is a verb phrase, not a countable noun — never pluralise it.
      title: single
        ? `${single.title} — ${rows.length} to grade`
        : `${rows.length} to grade across ${plural(assessmentIds.length, 'assignment')}`,
      description: oldestDays >= 1
        ? `${code} · oldest waiting ${plural(oldestDays, 'day')}`
        : `${code} · submitted today`,
      sectionId,
      dueLabel: oldestDays >= 1 ? `${oldestDays}d waiting` : 'New',
      group:
        oldestDays >= GRADING_ATTENTION_DAYS ? 'attention'
        : oldestDays >= GRADING_UPCOMING_DAYS ? 'upcoming'
        : 'later',
      href: safeHref(
        single && single.type === 'assignment'
          ? `${coursePath(sectionId)}/assignments/${single.id}?tab=grading`
          : `${coursePath(sectionId)}/grades?tab=assignments`,
      ),
      count: rows.length,
    })
  }
  return items
}

/**
 * Assessments closing within the horizon. A bare countdown is not a professor's
 * task — they already authored and published it — so this row NEVER ships
 * without its turn-in rate, which is the part that supports an action (nudge
 * the students who haven't submitted).
 */
function buildDeadlines(src: ProfessorTodoSources, now: number): ProfessorTodoItem[] {
  const closing = src.assessments.filter((a) => {
    if (a.dueAt == null) return false
    const due = new Date(a.dueAt).getTime()
    return due >= now && due <= now + DEADLINE_HORIZON_MS
  })

  const items: ProfessorTodoItem[] = []
  for (const [sectionId, rows] of bySection(closing, (a) => a.sectionId)) {
    const code = src.courseCodeBySection[sectionId] ?? ''
    const enrolled = src.enrolledBySection[sectionId] ?? 0
    const turnedIn = rows.reduce((sum, a) => sum + (src.turnedInByAssessment[a.id] ?? 0), 0)
    const expected = enrolled * rows.length
    const earliestDue = earliest(rows.map((a) => a.dueAt))
    const single = rows.length === 1 ? rows[0] : undefined

    items.push({
      id: `deadline-${sectionId}`,
      kind: 'deadline',
      title: single
        ? `${single.title} — ${turnedIn} of ${enrolled} submitted`
        : `${rows.length} assessments closing — ${turnedIn} of ${expected} submitted`,
      // Not lowercased: inside the 7-day horizon the label is "Today",
      // "Tomorrow" or a weekday, and "Closes wed" reads like a typo.
      description: single
        ? `${code} · Closes ${formatDueLabel(earliestDue, now)}`
        : `${code} · Earliest closes ${formatDueLabel(earliestDue, now)}`,
      sectionId,
      dueLabel: formatDueLabel(earliestDue, now),
      group: bucketFor(earliestDue, now),
      href: safeHref(
        single
          ? `${coursePath(sectionId)}/${single.type === 'quiz' ? 'quizzes' : 'assignments'}/${single.id}`
          : `${coursePath(sectionId)}/assignments`,
      ),
      count: rows.length,
    })
  }
  return items
}

/**
 * Scheduled sessions whose slide render FAILED. Deliberately not "no deck
 * uploaded" — plenty of people teach from a whiteboard, and nagging them
 * forever is how a dashboard gets ignored. A failed render is unambiguous:
 * they uploaded something and it broke.
 */
function buildClassPrep(src: ProfessorTodoSources, now: number): ProfessorTodoItem[] {
  const items: ProfessorTodoItem[] = []
  for (const [sectionId, rooms] of bySection(src.failedSlideRooms, (r) => r.sectionId)) {
    const code = src.courseCodeBySection[sectionId] ?? ''
    const earliestAt = earliest(rooms.map((r) => r.scheduledAt))
    const single = rooms.length === 1 ? rooms[0] : undefined

    items.push({
      id: `class-prep-${sectionId}`,
      kind: 'class_prep',
      title: single
        ? `Slides failed for ${single.name?.trim() || 'your next class'}`
        : `${rooms.length} sessions have failed slides`,
      description: `${code} · Re-upload before class`,
      sectionId,
      dueLabel: formatDueLabel(earliestAt, now),
      group: bucketFor(earliestAt, now),
      href: safeHref(`${coursePath(sectionId)}/live-classroom`),
      count: rooms.length,
    })
  }
  return items
}

/**
 * Post-class reports from sessions that ended recently. Always `later` — it
 * blocks nobody. The query's recency window is what retires these rows, so the
 * list can't accumulate a permanent backlog of unread reports.
 */
function buildClassReports(src: ProfessorTodoSources): ProfessorTodoItem[] {
  const items: ProfessorTodoItem[] = []
  for (const [sectionId, ready] of Object.entries(src.recentReportsBySection)) {
    if (ready <= 0) continue
    const code = src.courseCodeBySection[sectionId] ?? ''
    items.push({
      id: `class-report-${sectionId}`,
      kind: 'class_report',
      title: `${plural(ready, 'class report')} ready to review`,
      description: `${code} · From sessions this week`,
      sectionId,
      dueLabel: 'This week',
      group: 'later',
      href: safeHref(`${coursePath(sectionId)}/live-classroom?tab=reports`),
      count: ready,
    })
  }
  return items
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Build the professor's to-do list: one row per (course × kind), sorted by
 * urgency bucket then by what blocks a student soonest.
 *
 * `now` (epoch ms) defaults to the current time but is injectable to keep the
 * bucketing deterministic and testable.
 */
export function buildProfessorTodoList(
  src: ProfessorTodoSources,
  now: number = Date.now(),
): ProfessorTodoItem[] {
  const groupRank: Record<TodoGroup, number> = { attention: 0, upcoming: 1, later: 2 }

  return [
    ...buildGrading(src, now),
    ...buildDeadlines(src, now),
    ...buildClassPrep(src, now),
    ...buildClassReports(src),
  ].sort((a, b) => {
    if (a.group !== b.group) return groupRank[a.group] - groupRank[b.group]
    if (a.kind !== b.kind) return KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]
    if (a.count !== b.count) return b.count - a.count
    return a.title.localeCompare(b.title)
  })
}

/**
 * Open to-do rows per section, for the dashboard's course cards. Built from the
 * same list the panel renders so a card's number always matches what's below it.
 */
export function countProfessorTodosBySection(items: ProfessorTodoItem[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) {
    counts.set(item.sectionId, (counts.get(item.sectionId) ?? 0) + 1)
  }
  return counts
}

// ── Grading queue card ──────────────────────────────────────────────────────

/**
 * One assignment with work waiting — a row in the grading-queue card.
 *
 * Grouped per ASSIGNMENT, not per course (which is how the to-do list groups).
 * That distinction is the whole point: a course's oldest wait and its biggest
 * pile can belong to two different assignments, so a per-course summary could
 * claim "oldest: 22 days" while linking to work submitted this morning. Keying
 * every field to one assignment makes that mismatch impossible to express, and
 * gives every row a real id to deep-link — so no row ever has to fall back to
 * the gradebook.
 */
export interface GradingQueueEntry {
  assessmentId: string
  sectionId: string
  /** The assignment's own title, e.g. "Essay 2 — Rhetoric". */
  title: string
  /** Course code for the row subtext; '' when the section has no code. */
  courseCode: string
  /** Ungraded submissions on this assignment. */
  waiting: number
  /** Whole days the oldest ungraded submission here has waited. */
  oldestDays: number
  /** Straight into this assignment's grading tab. */
  href: string
}

/** How the card's rows are ordered. The professor toggles this. */
export type GradingQueueSort = 'oldest' | 'most'

/**
 * Every assignment with ungraded submissions, longest-waiting first.
 *
 * Quizzes are absent by construction: `src.ungraded` comes from
 * assignment_submissions, and all four shipped question types auto-score, so no
 * quiz ever waits on a professor. Team projects ARE professor-graded and are a
 * known gap — tracked separately, because "when is a project gradeable" has no
 * answer yet.
 */
export function buildGradingQueue(
  src: ProfessorTodoSources,
  now: number = Date.now(),
): GradingQueueEntry[] {
  const assessmentById = new Map(src.assessments.map((a) => [a.id, a]))

  const grouped = new Map<string, UngradedSubmission[]>()
  for (const row of src.ungraded) {
    // Defensive: the query scopes by assignment id already, and only
    // assignments can carry submissions at all.
    const assessment = assessmentById.get(row.assignmentId)
    if (!assessment || assessment.type !== 'assignment') continue
    const bucket = grouped.get(row.assignmentId)
    if (bucket) bucket.push(row)
    else grouped.set(row.assignmentId, [row])
  }

  const entries: GradingQueueEntry[] = []
  for (const [assessmentId, rows] of grouped) {
    const assessment = assessmentById.get(assessmentId)!
    entries.push({
      assessmentId,
      sectionId: assessment.sectionId,
      // `||` not `??`: the query layer defaults a NULL title but lets an empty
      // string through, and a row is the professor's only handle on the work —
      // a blank one is unopenable.
      title: assessment.title?.trim() || 'Untitled assignment',
      courseCode: src.courseCodeBySection[assessment.sectionId] ?? '',
      waiting: rows.length,
      // A null submitted_at reads as 0 days (today) rather than dropping the
      // row — a missing timestamp must never hide real work.
      oldestDays: Math.max(...rows.map((r) => daysSince(r.submittedAt, now))),
      href: safeHref(`${coursePath(assessment.sectionId)}/assignments/${assessmentId}?tab=grading`),
    })
  }

  return sortGradingQueue(entries, 'oldest')
}

/**
 * Re-order the card's rows. Pure and total — returns a new array, and every
 * comparison falls through to the title, so ties can't reshuffle between
 * renders.
 *
 * `oldest` leads by default because feedback loses its value as it ages, the
 * same reasoning behind the to-do list's 3-day escalation.
 */
export function sortGradingQueue(
  entries: GradingQueueEntry[],
  sort: GradingQueueSort,
): GradingQueueEntry[] {
  return [...entries].sort((a, b) => {
    if (sort === 'most') {
      if (a.waiting !== b.waiting) return b.waiting - a.waiting
      if (a.oldestDays !== b.oldestDays) return b.oldestDays - a.oldestDays
    } else {
      if (a.oldestDays !== b.oldestDays) return b.oldestDays - a.oldestDays
      if (a.waiting !== b.waiting) return b.waiting - a.waiting
    }
    return a.title.localeCompare(b.title)
  })
}
