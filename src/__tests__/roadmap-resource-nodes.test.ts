// Tests for the course-resource roadmap layer: buildResourceNodes (status
// derivation, quiz topic union, session children), and assembleRoadmapData's
// resource passthrough + edge liveness for resource endpoints.

import { describe, it, expect } from 'vitest'
import {
  assembleRoadmapData,
  buildResourceNodes,
  type RawQuiz,
  type RawAssignment,
  type RawSession,
  type RawSessionChild,
} from '@/lib/roadmap/auto-roadmap-helpers'

const SECTION = 'sec-1'

function build(role: 'professor' | 'student', overrides: Partial<Parameters<typeof buildResourceNodes>[2]> = {}) {
  const input = {
    quizzes: [] as RawQuiz[],
    quizSkillNames: new Map<string, string[]>(),
    assignments: [] as RawAssignment[],
    sessions: [] as RawSession[],
    polls: [] as RawSessionChild[],
    liveQuizzes: [] as RawSessionChild[],
    ...overrides,
  }
  return buildResourceNodes(role, SECTION, input)
}

describe('buildResourceNodes — status derivation', () => {
  it('maps quiz status: draft → not_started; published open → in_progress; published past due → complete', () => {
    const nodes = build('professor', {
      quizzes: [
        { id: 'Q1', title: 'Midterm', status: 'published' },                                   // no due date → open
        { id: 'Q2', title: 'Draft quiz', status: 'draft' },                                     // draft → not started
        { id: 'Q3', title: 'Past quiz', status: 'published', due_date: '2000-01-01T00:00:00Z' }, // due passed → complete
        { id: 'Q4', title: 'Future quiz', status: 'published', due_date: '2999-01-01T00:00:00Z' }, // due ahead → open
        { id: 'Q5', title: 'Past draft', status: 'draft', due_date: '2000-01-01T00:00:00Z' },   // draft wins → not started
      ],
    })
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n.status]))
    expect(byId).toMatchObject({ Q1: 'in_progress', Q2: 'not_started', Q3: 'complete', Q4: 'in_progress', Q5: 'not_started' })
  })

  it('maps assignment status: closed/archived → complete, published → in_progress', () => {
    const nodes = build('professor', {
      assignments: [
        { id: 'A1', title: 'HW1', status: 'closed' },
        { id: 'A2', title: 'HW2', status: 'published' },
        { id: 'A3', title: 'HW3', status: 'archived' },
        { id: 'A4', title: 'HW4', status: 'draft' },
      ],
    })
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n.status]))
    expect(byId).toEqual({ A1: 'complete', A2: 'in_progress', A3: 'complete', A4: 'not_started' })
  })

  it('maps session status: ended → complete, live → in_progress, scheduled/cancelled → not_started', () => {
    const nodes = build('professor', {
      sessions: [
        { id: 'S1', title: 'Lecture 1', status: 'ended' },
        { id: 'S2', title: 'Lecture 2', status: 'live' },
        { id: 'S3', title: 'Lecture 3', status: 'scheduled' },
        { id: 'S4', title: 'Lecture 4', status: 'cancelled' },
      ],
    })
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n.status]))
    expect(byId).toEqual({ S1: 'complete', S2: 'in_progress', S3: 'not_started', S4: 'not_started' })
  })
})

describe('buildResourceNodes — hides unnamed placeholder resources', () => {
  it('skips quizzes/assignments with no name or the Untitled sentinel, keeps named ones (even drafts)', () => {
    const nodes = build('professor', {
      quizzes: [
        { id: 'Q1', title: 'Real Quiz', status: 'draft' }, // named draft → kept
        { id: 'Q2', title: 'Untitled quiz', status: 'draft' }, // sentinel → hidden
        { id: 'Q3', title: '', status: 'draft' }, // empty → hidden
        { id: 'Q4', title: null, status: 'draft' }, // null → hidden
        { id: 'Q5', title: '   ', status: 'published' }, // whitespace → hidden
      ],
      assignments: [
        { id: 'A1', title: 'Real HW', status: 'draft' }, // named → kept
        { id: 'A2', title: 'Untitled assignment', status: 'draft' }, // sentinel → hidden
        { id: 'A3', title: null, status: 'draft' }, // null → hidden
      ],
    })
    const ids = nodes.map((n) => n.id)
    expect(ids).toContain('Q1')
    expect(ids).toContain('A1')
    for (const hidden of ['Q2', 'Q3', 'Q4', 'Q5', 'A2', 'A3']) {
      expect(ids).not.toContain(hidden)
    }
  })
})

describe('buildResourceNodes — quiz skills (from activity_skills → skills)', () => {
  it('de-duplicates and trims canonical skill names mapped to the quiz', () => {
    const nodes = build('professor', {
      quizzes: [{ id: 'Q1', title: 'Quiz', status: 'published' }],
      quizSkillNames: new Map([['Q1', ['Laplace smoothing', ' Kneser-Ney ', 'Laplace smoothing', '']]]),
    })
    expect(nodes[0].topics).toEqual(['Laplace smoothing', 'Kneser-Ney'])
  })

  it('omits skills when the quiz maps to none', () => {
    const nodes = build('professor', {
      quizzes: [{ id: 'Q1', title: 'Quiz', status: 'published' }],
    })
    expect(nodes[0].topics).toBeUndefined()
  })
})

describe('buildResourceNodes — live session children & hrefs', () => {
  it('attaches polls and pop-quizzes as children with derived status', () => {
    const nodes = build('professor', {
      sessions: [{ id: 'S1', title: 'Class', status: 'ended' }],
      polls: [{ id: 'P1', session_id: 'S1', label: 'Quick poll', is_active: false, closed_at: '2026-07-01' }],
      liveQuizzes: [{ id: 'LQ1', session_id: 'S1', label: null, is_active: true, closed_at: null }],
    })
    const session = nodes.find((n) => n.id === 'S1')!
    expect(session.children).toHaveLength(2)
    const poll = session.children!.find((c) => c.kind === 'live_poll')!
    expect(poll).toMatchObject({ title: 'Quick poll', status: 'complete' })
    const lq = session.children!.find((c) => c.kind === 'live_quiz')!
    expect(lq).toMatchObject({ title: 'Pop quiz', status: 'in_progress' }) // null label → fallback
  })

  it('builds role-aware deep links', () => {
    const prof = build('professor', { quizzes: [{ id: 'Q1', title: 'Q', status: 'published' }] })
    const stud = build('student', { quizzes: [{ id: 'Q1', title: 'Q', status: 'published' }] })
    expect(prof[0].href).toBe(`/professor/courses/${SECTION}/quizzes/Q1`)
    expect(stud[0].href).toBe(`/student/courses/${SECTION}/quizzes/Q1`)
  })

  it('passes the attendee roster onto the session node (empty roster → undefined)', () => {
    const nodes = build('professor', {
      sessions: [
        { id: 'S1', title: 'Held', status: 'ended', attendees: ['Emily Chen', 'Marcus Johnson'] },
        { id: 'S2', title: 'Empty', status: 'ended', attendees: [] },
      ],
    })
    expect(nodes.find((n) => n.id === 'S1')!.attendees).toEqual(['Emily Chen', 'Marcus Johnson'])
    expect(nodes.find((n) => n.id === 'S2')!.attendees).toBeUndefined()
  })

  it('passes scheduledAt through for a scheduled room, else null (drives the calendar tile)', () => {
    const nodes = build('professor', {
      sessions: [
        { id: 'S1', title: 'Planned', status: 'scheduled', scheduledAt: '2026-08-01T15:00:00Z' },
        { id: 'S2', title: 'Held', status: 'ended' },
      ],
    })
    expect(nodes.find((n) => n.id === 'S1')!.scheduledAt).toBe('2026-08-01T15:00:00Z')
    expect(nodes.find((n) => n.id === 'S2')!.scheduledAt).toBeNull()
  })
})

describe('assembleRoadmapData — resource passthrough & edge liveness', () => {
  const resources = build('professor', {
    quizzes: [{ id: 'Q1', title: 'Quiz', status: 'published' }],
    assignments: [{ id: 'A1', title: 'HW', status: 'published' }],
  })

  it('returns the resource nodes on the DTO', () => {
    const data = assembleRoadmapData(SECTION, [], [], [], resources)
    expect(data.resources.map((r) => r.id).sort()).toEqual(['A1', 'Q1'])
  })

  it('keeps an edge to a live resource and drops one to a missing resource', () => {
    const edges = [
      { id: 'ok', from_node_type: 'quiz', from_node_id: 'Q1', to_node_type: 'assignment', to_node_id: 'A1' },
      { id: 'orphan', from_node_type: 'quiz', from_node_id: 'GHOST', to_node_type: 'assignment', to_node_id: 'A1' },
    ]
    const data = assembleRoadmapData(SECTION, [], [], edges, resources)
    expect(data.edges.map((e) => e.id)).toEqual(['ok'])
  })
})
