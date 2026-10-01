// Tests for the student dashboard "Up next" to-do logic (buildTodoList).
// Inclusion ("is this still a to-do?") is owned by the shared feed layer
// (feed_items.is_actionable / is_done); buildTodoList owns the dashboard surface:
// the defensive open-to-do filter, urgency bucketing, sorting, and due labels.

import { describe, it, expect } from 'vitest'
import {
  buildTodoList,
  computeAutoCollapse,
  countOpenTodosBySection,
  countWeeklyDeliverableCompletion,
  type ProjectDeliverableInput,
} from '@/lib/dashboard/todos'
import type { FeedItem } from '@/lib/events/types'

// 2026-06-29T12:00:00Z — a Monday (matches the wireframe). Fixed so tests are deterministic.
const NOW = Date.UTC(2026, 5, 29, 12, 0, 0)
const HOUR = 3_600_000
const DAY = 86_400_000

/** ISO timestamp `offsetMs` away from NOW. */
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

function feedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'f1',
    recipient_id: 'stu1',
    actor_id: null,
    institution_id: 'inst1',
    section_id: 'sec1',
    type: 'assignment_published',
    title: 'Problem Set 6',
    body: 'CS 546 · Distributed Systems',
    link_url: '/student/courses/sec1/assignments/a1',
    entity_type: 'assignment',
    entity_id: 'a1',
    is_read: false,
    read_at: null,
    is_actionable: true,
    is_done: false,
    done_at: null,
    due_at: at(DAY),
    metadata: {},
    created_at: at(-DAY),
    ...overrides,
  }
}

const idsOf = (items: FeedItem[]) => buildTodoList(items, NOW).map((i) => i.id)
const isIncluded = (f: FeedItem) => buildTodoList([f], NOW).length === 1

describe('buildTodoList — open-to-do filter (inclusion owned by the feed)', () => {
  it.each([
    ['actionable + not done', { is_actionable: true, is_done: false }, true],
    ['actionable + done', { is_actionable: true, is_done: true }, false],
    ['not actionable (a notice)', { is_actionable: false, is_done: false }, false],
  ])('%s → included=%s', (_label, patch, included) => {
    expect(isIncluded(feedItem(patch))).toBe(included)
  })
})

describe('buildTodoList — past-due exclusion (temporary, until closed_at exists)', () => {
  it.each([
    ['past-due assignment', { entity_type: 'assignment' as const, due_at: at(-HOUR) }, false],
    ['past-due quiz', { entity_type: 'quiz' as const, due_at: at(-DAY) }, false],
    ['due later today (not yet past)', { due_at: at(5 * HOUR) }, true],
    ['no due date', { due_at: null }, true],
  ])('%s → included=%s', (_label, patch, included) => {
    expect(isIncluded(feedItem(patch))).toBe(included)
  })
})

describe('buildTodoList — urgency buckets', () => {
  it.each([
    ['due in 5h', 5 * HOUR, 'attention'],
    ['due in 47h (≤48h)', 47 * HOUR, 'attention'],
    ['due in exactly 48h', 48 * HOUR, 'attention'], // pins the DUE_SOON_MS boundary
    ['due in 3 days', 3 * DAY, 'upcoming'],
    ['due in 7 days', 7 * DAY, 'upcoming'],
    ['due in 10 days', 10 * DAY, 'later'],
  ])('%s → %s', (_label, offset, group) => {
    const [item] = buildTodoList([feedItem({ due_at: at(offset) })], NOW)
    expect(item.group).toBe(group)
  })

  it('puts items with no due date in "later"', () => {
    const [item] = buildTodoList([feedItem({ due_at: null })], NOW)
    expect(item.group).toBe('later')
  })
})

describe('buildTodoList — sorting', () => {
  it('orders soonest-due first, with no-due-date items last', () => {
    const items = [
      feedItem({ id: 'far', due_at: at(10 * DAY) }),
      feedItem({ id: 'none', due_at: null }),
      feedItem({ id: 'soon', due_at: at(2 * HOUR) }),
      feedItem({ id: 'mid', due_at: at(3 * DAY) }),
    ]
    expect(idsOf(items)).toEqual(['soon', 'mid', 'far', 'none'])
  })

  it('breaks ties on the same due date by title', () => {
    const items = [
      feedItem({ id: 'b', title: 'Beta', due_at: at(DAY) }),
      feedItem({ id: 'a', title: 'Alpha', due_at: at(DAY) }),
    ]
    expect(idsOf(items)).toEqual(['a', 'b'])
  })
})

describe('buildTodoList — due labels', () => {
  it.each([
    ['later today', 5 * HOUR, 'Today'],
    ['tomorrow', DAY, 'Tomorrow'],
    ['this week → weekday', 3 * DAY, 'Thu'], // NOW is Mon Jun 29 → +3d = Thu Jul 2
    ['next week → date', 10 * DAY, 'Jul 9'],
  ])('%s → "%s"', (_label, offset, label) => {
    const [item] = buildTodoList([feedItem({ due_at: at(offset) })], NOW)
    expect(item.dueLabel).toBe(label)
  })

  it('labels a missing due date', () => {
    const [item] = buildTodoList([feedItem({ due_at: null })], NOW)
    expect(item.dueLabel).toBe('No due date')
  })
})

describe('buildTodoList — mapping from feed items', () => {
  it('maps id, kind (from entity_type), title, description (body), and href (link_url)', () => {
    const [a] = buildTodoList([feedItem({ id: 'x', entity_type: 'assignment' })], NOW)
    expect(a).toMatchObject({
      id: 'x',
      kind: 'assignment',
      title: 'Problem Set 6',
      description: 'CS 546 · Distributed Systems',
      href: '/student/courses/sec1/assignments/a1',
    })

    const [q] = buildTodoList(
      [feedItem({ entity_type: 'quiz', link_url: '/student/courses/sec1/quizzes/q9' })],
      NOW,
    )
    expect(q.kind).toBe('quiz')
    expect(q.href).toBe('/student/courses/sec1/quizzes/q9')
  })

  it('falls back to empty description and "#" href when the feed omits them', () => {
    const [item] = buildTodoList([feedItem({ body: null, link_url: null })], NOW)
    expect(item.description).toBe('')
    expect(item.href).toBe('#')
  })

  it('drops a non-relative link_url to "#" (no javascript:/external hrefs)', () => {
    const [evil] = buildTodoList([feedItem({ link_url: 'javascript:alert(1)' })], NOW)
    expect(evil.href).toBe('#')
    const [ext] = buildTodoList([feedItem({ link_url: 'https://evil.example/x' })], NOW)
    expect(ext.href).toBe('#')
    // Protocol-relative URLs resolve off-site despite the leading "/".
    const [protoRel] = buildTodoList([feedItem({ link_url: '//evil.example/x' })], NOW)
    expect(protoRel.href).toBe('#')
    const [backslash] = buildTodoList([feedItem({ link_url: '/\\evil.example/x' })], NOW)
    expect(backslash.href).toBe('#')
  })

  it('returns an empty list when nothing is actionable', () => {
    expect(buildTodoList([feedItem({ is_done: true })], NOW)).toEqual([])
  })
})

// Project deliverables (project_phases) are merged in alongside feed items. dueAt is
// pre-normalized to an ISO instant (end-of-day) by the query, so tests pass instants.
function deliverable(overrides: Partial<ProjectDeliverableInput> = {}): ProjectDeliverableInput {
  return {
    phaseId: 'ph1',
    projectId: 'proj1',
    projectTitle: 'Capstone',
    phaseTitle: 'Phase 2',
    sectionId: 'sec1',
    dueAt: at(DAY),
    status: 'in_progress',
    assignmentId: null,
    ...overrides,
  }
}

describe('buildTodoList — project deliverables', () => {
  it('includes an open deliverable as a project to-do, id/title/href composed', () => {
    const [item] = buildTodoList([], NOW, [deliverable()])
    expect(item).toMatchObject({
      id: 'phase-ph1',
      kind: 'project',
      title: 'Capstone — Phase 2',
      href: '/student/courses/sec1/projects/proj1',
    })
  })

  it('drops a completed deliverable (its phase is done)', () => {
    expect(buildTodoList([], NOW, [deliverable({ status: 'completed' })])).toEqual([])
  })

  it('drops a past-due deliverable but keeps one due later today', () => {
    // dueAt is end-of-day, so a phase "due today" is not past even after midnight.
    expect(buildTodoList([], NOW, [deliverable({ dueAt: at(-DAY) })])).toEqual([])
    expect(buildTodoList([], NOW, [deliverable({ dueAt: at(5 * HOUR) })])).toHaveLength(1)
  })

  it('merges + sorts deliverables and feed items by due date into one list', () => {
    const items = [feedItem({ id: 'a-soon', due_at: at(2 * HOUR) })]
    const delivs = [deliverable({ phaseId: 'p-mid', dueAt: at(3 * DAY) })]
    expect(buildTodoList(items, NOW, delivs).map((i) => i.id)).toEqual(['a-soon', 'phase-p-mid'])
  })

  it('falls back to a "#" href when the deliverable has no section', () => {
    const [item] = buildTodoList([], NOW, [deliverable({ sectionId: null })])
    expect(item.href).toBe('#')
  })
})

describe('countOpenTodosBySection — feed items + deliverables', () => {
  it('counts open deliverables per section alongside feed items, skipping done/past-due', () => {
    const items = [feedItem({ section_id: 'sec1', due_at: at(DAY) })]
    const delivs = [
      deliverable({ sectionId: 'sec1', dueAt: at(2 * DAY) }), // counts
      deliverable({ sectionId: 'sec2', status: 'completed' }), // done → skip
      deliverable({ sectionId: 'sec2', dueAt: at(-DAY) }), //     past-due → skip
    ]
    const counts = countOpenTodosBySection(items, NOW, delivs)
    expect(counts.get('sec1')).toBe(2)
    expect(counts.get('sec2')).toBeUndefined()
  })
})

describe('countWeeklyDeliverableCompletion — weekly tracker contribution', () => {
  // A 7-day window with NOW in the middle (start Mon of this week, end exclusive).
  const weekStart = NOW - 2 * DAY
  const weekEnd = NOW + 5 * DAY

  it('counts deliverables due within the week; done = completed phase', () => {
    const delivs = [
      deliverable({ dueAt: at(DAY), status: 'completed' }), //     in week, done
      deliverable({ dueAt: at(3 * DAY), status: 'in_progress' }), // in week, not done
      deliverable({ dueAt: at(10 * DAY) }), //                     outside week → ignored
    ]
    expect(countWeeklyDeliverableCompletion(delivs, weekStart, weekEnd)).toEqual({ done: 1, total: 2 })
  })

  it('counts a deliverable due earlier this week toward the total regardless of done', () => {
    // The week window is inclusive of past-this-week days (unlike the list's past-due drop).
    const delivs = [deliverable({ dueAt: at(-DAY), status: 'in_progress' })]
    expect(countWeeklyDeliverableCompletion(delivs, weekStart, weekEnd)).toEqual({ done: 0, total: 1 })
  })
})

// Pure auto-fit decision, extracted from TodoList so it can be tested without a
// real DOM (jsdom can't measure layout). Heights are arbitrary px; only their
// relation to `available` matters. Each group body is 100px, header 20px here.
describe('computeAutoCollapse — auto-fit decision', () => {
  const BODY = 100
  const HEADER = 20
  const allPresent = ['attention', 'upcoming', 'later'] as const
  const bodyHeights = { attention: BODY, upcoming: BODY, later: BODY }
  // chrome = one header per present group
  const chromeFor = (present: readonly string[]) => present.length * HEADER

  const collapse = (available: number, overrides = {}) =>
    computeAutoCollapse({
      available,
      chrome: chromeFor(allPresent),
      bodyHeights,
      present: [...allPresent],
      overrides,
    })

  const asArray = (s: Set<string>) => [...s].sort()

  it('collapses nothing when everything fits', () => {
    // 3×100 body + 3×20 chrome = 360; give it room to spare
    expect(asArray(collapse(400))).toEqual([])
  })

  it('collapses "later" first when that alone makes it fit', () => {
    // Need to shed one 100px body: 360 → 260. Fits at 300.
    expect(asArray(collapse(300))).toEqual(['later'])
  })

  it('collapses "later" then "upcoming" when one is not enough', () => {
    // Fits only after shedding two bodies: 360 → 160. Fits at 200.
    expect(asArray(collapse(200))).toEqual(['later', 'upcoming'])
  })

  it('never collapses "attention", even when it cannot fit', () => {
    // Even both collapsible groups gone leaves attention(100)+chrome(60)=160 > 120.
    expect(asArray(collapse(120))).toEqual(['later', 'upcoming'])
  })

  it('skips a student-expanded group (override=false) and collapses the next one', () => {
    // "later" is force-expanded, so auto-fit must collapse "upcoming" instead.
    expect(asArray(collapse(300, { later: false }))).toEqual(['upcoming'])
  })

  it('counts a student-collapsed group (override=true) as 0 without re-adding it — the cascade bug', () => {
    // Student already collapsed "later": remaining = attention(100)+upcoming(100)+chrome(60)=260.
    // That fits at 300, so auto-fit must collapse NOTHING (not cascade into "upcoming").
    expect(asArray(collapse(300, { later: true }))).toEqual([])
  })

  it('ignores groups that are not present', () => {
    // Only "attention" rendered: body 100 + chrome 20 = 120, fits at 150 → nothing.
    const only = computeAutoCollapse({
      available: 150,
      chrome: HEADER,
      bodyHeights: { attention: BODY },
      present: ['attention'],
      overrides: {},
    })
    expect(asArray(only)).toEqual([])
  })
})

describe('to-dos for a product the school no longer has', () => {
  /**
   * Found by the customer rehearsal: a student's home said "New quiz: ..." at a
   * school whose plan no longer included quizzes, and clicking it dead-ended. A
   * to-do is a call to action; one that cannot be actioned reads as data loss.
   *
   * The notification row itself is untouched and stays readable in the bell.
   * Only the demand to act on it goes.
   */
  it('drops quiz to-dos when quizzes are revoked', () => {
    const items = [
      feedItem({ id: 'q1', entity_type: 'quiz', due_at: at(DAY) }),
      feedItem({ id: 'a1', entity_type: 'assignment', due_at: at(DAY) }),
    ]
    const kept = buildTodoList(items, NOW, [], ['quizzes'])
    expect(kept.map((t) => t.id)).toEqual(['a1'])
  })

  it('drops assignment to-dos when assignments are revoked', () => {
    const items = [
      feedItem({ id: 'q1', entity_type: 'quiz', due_at: at(DAY) }),
      feedItem({ id: 'a1', entity_type: 'assignment', due_at: at(DAY) }),
    ]
    const kept = buildTodoList(items, NOW, [], ['assignments'])
    expect(kept.map((t) => t.id)).toEqual(['q1'])
  })

  it('keeps everything when the school has everything, which is the default', () => {
    const items = [
      feedItem({ id: 'q1', entity_type: 'quiz', due_at: at(DAY) }),
      feedItem({ id: 'a1', entity_type: 'assignment', due_at: at(DAY) }),
    ]
    // Both the explicit-empty and the omitted-argument forms, since the second
    // is what every existing caller uses.
    expect(buildTodoList(items, NOW, [], []).length).toBe(2)
    expect(buildTodoList(items, NOW, []).length).toBe(2)
  })

  it('drops project deliverables when projects are revoked', () => {
    const deliverable = {
      phaseId: 'p1',
      projectId: 'proj1',
      projectTitle: 'Capstone',
      phaseTitle: 'Phase 1',
      sectionId: 'sec1',
      dueAt: at(DAY),
      status: 'in_progress',
      assignmentId: null,
    }
    expect(buildTodoList([], NOW, [deliverable]).length).toBe(1)
    expect(buildTodoList([], NOW, [deliverable], ['projects']).length).toBe(0)
  })

  it('revoking one product does not disturb the others', () => {
    const items = [
      feedItem({ id: 'q1', entity_type: 'quiz', due_at: at(DAY) }),
      feedItem({ id: 'a1', entity_type: 'assignment', due_at: at(DAY) }),
    ]
    const deliverable = {
      phaseId: 'p1',
      projectId: 'proj1',
      projectTitle: 'Capstone',
      phaseTitle: 'Phase 1',
      sectionId: 'sec1',
      dueAt: at(DAY),
      status: 'in_progress',
      assignmentId: null,
    }
    const kept = buildTodoList(items, NOW, [deliverable], ['quizzes'])
    expect(kept.map((t) => t.kind).sort()).toEqual(['assignment', 'project'])
  })
})

describe('the per-course counts agree with the list', () => {
  /**
   * Regression from the four-commit sweep. buildTodoList gained an
   * unentitledFeatures parameter and countOpenTodosBySection, called from the
   * adjacent line on the same inputs, did not. With quizzes revoked the list
   * read "You're all caught up" while the course card above it said "1 due".
   *
   * These two render on one screen, so the invariant worth pinning is not what
   * either returns on its own, but that they agree.
   */
  const items = [
    feedItem({ id: 'q1', entity_type: 'quiz', section_id: 'sec1', due_at: at(DAY) }),
    feedItem({ id: 'a1', entity_type: 'assignment', section_id: 'sec1', due_at: at(DAY) }),
  ]
  const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)

  it('agree when everything is entitled', () => {
    expect(total(countOpenTodosBySection(items, NOW, []))).toBe(buildTodoList(items, NOW, []).length)
  })

  it('agree when a product is revoked', () => {
    const off = ['quizzes']
    expect(total(countOpenTodosBySection(items, NOW, [], off))).toBe(
      buildTodoList(items, NOW, [], off).length,
    )
  })

  it('and the revoked one is actually gone, so the agreement is not two zeroes', () => {
    expect(total(countOpenTodosBySection(items, NOW, [], ['quizzes']))).toBe(1)
    expect(total(countOpenTodosBySection(items, NOW, []))).toBe(2)
  })

  it('agree on project deliverables too', () => {
    const deliverable = {
      phaseId: 'p1',
      projectId: 'proj1',
      projectTitle: 'Capstone',
      phaseTitle: 'Phase 1',
      sectionId: 'sec1',
      dueAt: at(DAY),
      status: 'in_progress',
      assignmentId: null,
    }
    const off = ['projects']
    expect(total(countOpenTodosBySection([], NOW, [deliverable], off))).toBe(
      buildTodoList([], NOW, [deliverable], off).length,
    )
    expect(total(countOpenTodosBySection([], NOW, [deliverable], off))).toBe(0)
  })
})

