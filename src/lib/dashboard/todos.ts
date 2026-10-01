// Student dashboard "Up next" to-do list — turns the shared event feed into a
// prioritised, bucketed list. Inclusion ("is this still a to-do?") is decided by the
// shared layer via feed_items.is_actionable / is_done; this module owns only the
// dashboard surface: ordering, urgency bucketing, and due-label formatting.
//
// Kept free of server-only imports so it's easy to unit-test with plain fixtures.

import type { FeedItem } from '@/lib/events/types'

export type TodoKind = 'assignment' | 'quiz' | 'project'

/**
 * A project deliverable — a `project_phases` row that carries a due date. Unlike
 * assignments/quizzes (which flow through the shared feed), deliverables are
 * fetched by a direct query, so this shape carries everything the to-do list
 * needs. `status` is the phase's own status; 'completed' means it's done and
 * drops off the list. `dueAt` is an ISO instant (date-only phase due dates are
 * normalized to end-of-day upstream so "due today" isn't treated as past-due).
 */
export interface ProjectDeliverableInput {
  phaseId: string
  projectId: string
  projectTitle: string
  phaseTitle: string
  sectionId: string | null
  dueAt: string | null
  status: string
  /** The assignment this phase was copied from, if any — used to collapse the
   *  duplicate on the calendar (phase + assignment are the same deliverable). */
  assignmentId: string | null
}

/** Urgency bucket — matches the existing TodoList component's three groups. */
export type TodoGroup = 'attention' | 'upcoming' | 'later'

/** A ready-to-render to-do. The component maps `kind` → icon and `group` → styling. */
export interface TodoItem {
  id: string
  kind: TodoKind
  title: string
  /** Secondary line (course context when the feed carries it; empty otherwise). */
  description: string
  /** Owning section, for tagging the row with its course code. */
  sectionId: string | null
  /** e.g. "Overdue 1d", "Today", "Tomorrow", "Fri", "Jul 14". */
  dueLabel: string
  group: TodoGroup
  /** Link to where the student acts on the item. */
  href: string
}

const DAY_MS = 86_400_000
const DUE_SOON_MS = 48 * 3_600_000 // 48h → "Needs Attention"
const THIS_WEEK_MS = 7 * DAY_MS //    2–7d → "Coming Up"

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Which urgency bucket an item belongs in, by due date. Shared with the
 *  professor to-do engine so both dashboards agree on what "due soon" means. */
export function bucketFor(dueDate: string | null, now: number): TodoGroup {
  if (dueDate == null) return 'later'
  const due = new Date(dueDate).getTime()
  if (due <= now + DUE_SOON_MS) return 'attention' // overdue or within 48h
  if (due <= now + THIS_WEEK_MS) return 'upcoming' // 2–7 days
  return 'later' // 8+ days
}

/**
 * Short, human due label. Uses UTC day boundaries so output is deterministic and
 * timezone-independent (per-student timezones are out of scope for Part 1).
 */
export function formatDueLabel(dueDate: string | null, now: number): string {
  if (dueDate == null) return 'No due date'
  const dueMs = new Date(dueDate).getTime()
  const dayDiff = Math.floor(dueMs / DAY_MS) - Math.floor(now / DAY_MS)
  // Retained for the future `closed_at` work: buildTodoList currently filters past-due
  // items out, so this branch is unreachable today, but it's the correct label once
  // overdue-but-still-open items are surfaced again.
  if (dueMs < now) {
    const daysOver = -dayDiff
    return daysOver >= 1 ? `Overdue ${daysOver}d` : 'Overdue'
  }
  if (dayDiff === 0) return 'Today'
  if (dayDiff === 1) return 'Tomorrow'
  const due = new Date(dueMs)
  if (dayDiff <= 6) return WEEKDAYS[due.getUTCDay()]
  return `${MONTHS[due.getUTCMonth()]} ${due.getUTCDate()}`
}

function kindOf(entityType: string | null): TodoKind {
  return entityType === 'quiz' ? 'quiz' : 'assignment'
}

/**
 * Only trust in-app absolute paths for the row link. Feed `link_url`s are all
 * server-constructed relative paths today, but this guards against a `javascript:`/
 * `data:` URI becoming a click-to-execute link, or a protocol-relative `//host`
 * (open redirect / off-site), if the feed ever carries a user-authored URL.
 * Accept only "/path"; reject "//host" and the "/\host" variant browsers also
 * treat as protocol-relative. Anything else falls back to a no-op "#".
 */
export function safeHref(url: string | null): string {
  return url && url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\')
    ? url
    : '#'
}

/** A deliverable is done — and drops off the list — when its phase is completed. */
function isDeliverableDone(d: ProjectDeliverableInput): boolean {
  return d.status === 'completed'
}

/** Deliverable row title: "Project — Phase" (falls back to the phase alone). */
function deliverableTitle(d: ProjectDeliverableInput): string {
  return d.projectTitle ? `${d.projectTitle} — ${d.phaseTitle}` : d.phaseTitle
}

/** Deliverables link to their project's student detail page. */
function deliverableHref(d: ProjectDeliverableInput): string {
  return d.sectionId && d.projectId
    ? safeHref(`/student/courses/${d.sectionId}/projects/${d.projectId}`)
    : '#'
}

/** Normalized shape both feed items and deliverables collapse to before sorting. */
interface NormalizedTodo {
  id: string
  kind: TodoKind
  title: string
  description: string
  sectionId: string | null
  dueAt: string | null
  href: string
}

/**
 * Turn open to-dos into the ordered, bucketed list the dashboard renders: keep only
 * open items, sort soonest-due first (no-due items last, ties by title), and tag each
 * with its urgency bucket.
 *
 * Two sources are merged: actionable feed items (assignments/quizzes) and project
 * deliverables (fetched directly, not via the feed). Feed items are defensively
 * filtered `is_actionable && !is_done`; deliverables drop when their phase is
 * completed. `now` (epoch ms) defaults to the current time but is injectable to keep
 * the logic deterministic and testable.
 */
/**
 * Which product a to-do belongs to, when it belongs to one. Used to drop
 * to-dos the viewer's institution can no longer act on.
 */
function featureOf(entityType: string | null): string | null {
  if (entityType === 'quiz') return 'quizzes'
  if (entityType === 'assignment') return 'assignments'
  return null
}

export function buildTodoList(
  items: FeedItem[],
  now: number = Date.now(),
  deliverables: ProjectDeliverableInput[] = [],
  /**
   * Products the institution no longer has. Their to-dos are dropped, because a
   * to-do is a call to action and the route behind it now dead-ends. The
   * underlying notification is untouched and stays readable in the bell — the
   * history survives, only the demand goes.
   */
  unentitledFeatures: string[] = [],
): TodoItem[] {
  const fromFeed: NormalizedTodo[] = items
    .filter((f) => f.is_actionable && !f.is_done)
    .filter((f) => {
      const feature = featureOf(f.entity_type)
      return !feature || !unentitledFeatures.includes(feature)
    })
    .map((f) => ({
      id: f.id,
      kind: kindOf(f.entity_type),
      title: f.title,
      description: f.body ?? '',
      sectionId: f.section_id,
      dueAt: f.due_at,
      href: safeHref(f.link_url),
    }))

  // Deliverables are the Projects product's to-do source; same rule as the feed.
  const projectsDropped = unentitledFeatures.includes('projects')
  const fromDeliverables: NormalizedTodo[] = (projectsDropped ? [] : deliverables)
    .filter((d) => !isDeliverableDone(d))
    .map((d) => ({
      id: `phase-${d.phaseId}`,
      kind: 'project',
      title: deliverableTitle(d),
      description: '',
      sectionId: d.sectionId,
      dueAt: d.dueAt,
      href: deliverableHref(d),
    }))

  return [...fromFeed, ...fromDeliverables]
    // Temporary: drop items whose due date has passed. Neither assignments/quizzes
    // nor deliverables yet have a separate "submissions close" date, so once the due
    // date passes there's nothing left to submit — no point keeping it on the list.
    // Once a `closed_at` is added, past-due-but-still-open items will surface again,
    // which is why the "Overdue" label + bucket handling above is deliberately retained.
    .filter((t) => t.dueAt == null || new Date(t.dueAt).getTime() >= now)
    .sort((a, b) => {
      const ax = a.dueAt == null ? Infinity : new Date(a.dueAt).getTime()
      const bx = b.dueAt == null ? Infinity : new Date(b.dueAt).getTime()
      if (ax !== bx) return ax - bx
      return a.title.localeCompare(b.title)
    })
    .map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      description: t.description,
      sectionId: t.sectionId,
      dueLabel: formatDueLabel(t.dueAt, now),
      group: bucketFor(t.dueAt, now),
      href: t.href,
    }))
}

/**
 * Count still-open to-dos per section, for the dashboard "My Courses" cards.
 * Counts both feed items (assignments/quizzes) and project deliverables, applying
 * the same "open, not past due" filter as buildTodoList so each card's number
 * matches the list below it. `now` (epoch ms) is injectable to keep it deterministic
 * and testable.
 */
export function countOpenTodosBySection(
  items: FeedItem[],
  now: number = Date.now(),
  deliverables: ProjectDeliverableInput[] = [],
  /**
   * MUST match what buildTodoList is given. These two are called from adjacent
   * lines on the same inputs and render on the same screen, so filtering one
   * and not the other makes the dashboard contradict itself: "you're all caught
   * up" above a course card reading "1 due".
   */
  unentitledFeatures: string[] = [],
): Map<string, number> {
  const counts = new Map<string, number>()
  const bump = (sectionId: string | null) => {
    if (!sectionId) return
    counts.set(sectionId, (counts.get(sectionId) ?? 0) + 1)
  }
  const projectsDropped = unentitledFeatures.includes('projects')
  for (const f of items) {
    if (!f.section_id || !f.is_actionable || f.is_done) continue
    const feature = featureOf(f.entity_type)
    if (feature && unentitledFeatures.includes(feature)) continue
    if (f.due_at != null && new Date(f.due_at).getTime() < now) continue
    bump(f.section_id)
  }
  for (const d of projectsDropped ? [] : deliverables) {
    if (isDeliverableDone(d)) continue
    if (d.dueAt != null && new Date(d.dueAt).getTime() < now) continue
    bump(d.sectionId)
  }
  return counts
}

/**
 * Weekly-completion contribution from project deliverables, added to the feed-based
 * assignment/quiz totals in `getWeeklyCompletion`. Counts deliverables DUE within
 * [weekStartMs, weekEndMs) (epoch ms, end exclusive); done = phase completed. Mirrors
 * getWeeklyCompletion's window semantics — a deliverable due earlier this week still
 * counts toward the week's total, done or not.
 */
export function countWeeklyDeliverableCompletion(
  deliverables: ProjectDeliverableInput[],
  weekStartMs: number,
  weekEndMs: number,
): { done: number; total: number } {
  let done = 0
  let total = 0
  for (const d of deliverables) {
    if (d.dueAt == null) continue
    const due = new Date(d.dueAt).getTime()
    if (due < weekStartMs || due >= weekEndMs) continue
    total++
    if (isDeliverableDone(d)) done++
  }
  return { done, total }
}

/** Auto-collapse order: lowest priority first. `attention` is never collapsed. */
const COLLAPSE_ORDER: TodoGroup[] = ['later', 'upcoming']

/**
 * Decide which to-do groups to auto-collapse so the list fits its container.
 *
 * Pure core of `TodoList`'s auto-fit: the component measures the DOM (available
 * height, per-group body/header heights) and hands the numbers here; this decides
 * the collapse set without touching the DOM, so it's unit-testable (jsdom can't
 * measure layout). If everything fits, collapses nothing. Otherwise collapses the
 * lowest-priority groups first (`later`, then `upcoming`), never `attention`, and
 * never a group the student has explicitly toggled (`overrides[key]` set).
 *
 * A group contributes 0 body height when collapsed — whether the student collapsed
 * it (`overrides[key] === true`) or auto-fit is collapsing it. Counting a
 * student-collapsed group's body while the hugging container has already shrunk to
 * exclude it is what made collapsing one group cascade into the groups below it.
 *
 * @param available   container height in px (feed.clientHeight)
 * @param chrome      total height of the always-visible group headers
 * @param bodyHeights natural (expanded) body height per present group
 * @param present     groups currently rendered, in display order
 * @param overrides   student's explicit toggles: true = collapsed, false = expanded
 */
export function computeAutoCollapse({
  available,
  chrome,
  bodyHeights,
  present,
  overrides,
}: {
  available: number
  chrome: number
  bodyHeights: Partial<Record<TodoGroup, number>>
  present: TodoGroup[]
  overrides: Partial<Record<TodoGroup, boolean>>
}): Set<TodoGroup> {
  const neededWith = (autoSet: Set<TodoGroup>) =>
    chrome +
    present.reduce((sum, k) => {
      const collapsed = overrides[k] === true || autoSet.has(k)
      return sum + (collapsed ? 0 : bodyHeights[k] ?? 0)
    }, 0)

  const collapsed = new Set<TodoGroup>()
  if (neededWith(collapsed) <= available) return collapsed

  for (const key of COLLAPSE_ORDER) {
    // Only auto-collapse groups the student hasn't explicitly toggled.
    if (present.includes(key) && overrides[key] === undefined) {
      collapsed.add(key)
      if (neededWith(collapsed) <= available) break
    }
  }
  return collapsed
}
