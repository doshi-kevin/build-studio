// Tests for roadmap-signals — the derivation that turns fetched data + the two
// activity queries into the triage engine's ProfSignals / StuSignals. We mock
// the query boundary (roadmapSignalQueries) and assert the load-bearing
// branches: grading-vs-all-graded, the missing-submissions guard, mastery
// bucketing, grade-posted suppression of due-soon, and content-edge filtering.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/supabase/queries', () => ({
  roadmapSignalQueries: { getProfessorActivitySignals: vi.fn() },
}))

import { buildProfessorSignals, buildStudentSignals } from '@/lib/roadmap/roadmap-signals'
import { roadmapSignalQueries } from '@/lib/supabase/queries'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AutoRoadmapData, RoadmapResourceNode } from '@/lib/validations/auto-roadmap'
import type { CourseModule } from '@/lib/roadmap/prototype-adapter'
import type { NodeJourney } from '@/lib/roadmap/journey-state'

const db = {} as unknown as SupabaseClient
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()

const resource = (o: Partial<RoadmapResourceNode> & { id: string; title: string }): RoadmapResourceNode => ({
  kind: 'quiz', status: 'not_started', stateLabel: 'Published', href: '', ...o,
})
const roadmap = (o: Partial<AutoRoadmapData> = {}): AutoRoadmapData => ({
  sectionId: 'sec', weeks: [], resources: [], edges: [], ...o,
})

describe('buildProfessorSignals', () => {
  it('separates grading queue, all-graded, drafts, due-soon and past-due missing', async () => {
    vi.mocked(roadmapSignalQueries.getProfessorActivitySignals).mockResolvedValue({
      enrolled: 10,
      assignments: [
        { id: 'a1', title: 'Essay', status: 'published', dueAt: inHours(-48) },
        { id: 'a2', title: 'HW1', status: 'published', dueAt: inHours(-72) },
        { id: 'a3', title: 'Lab', status: 'published', dueAt: inHours(-24) },
        { id: 'a4', title: 'Project', status: 'published', dueAt: inHours(30) },
      ],
      tallies: {
        a1: { draft: 2, submitted: 5, graded: 0, returned: 0, handedIn: 5 }, // submitted>0 → grading queue; draft>0 → drafts
        a2: { draft: 0, submitted: 0, graded: 4, returned: 0, handedIn: 4 }, // all graded
        // Past due with a row per enrolled student — but only 6 carry a submission
        // timestamp; the other 4 are the auto-zero cron's → 4 missing. Counted by
        // status ('graded': 10 of 10) this would report zero missing forever.
        a3: { draft: 0, submitted: 0, graded: 10, returned: 0, handedIn: 6 },
        a4: { draft: 0, submitted: 0, graded: 0, returned: 0, handedIn: 0 }, // future → due soon, not missing
      },
    })

    const s = await buildProfessorSignals(db, 'sec', {
      course: [], roadmapData: roadmap(), journeys: null, concepts: null,
    })

    expect(s.gradingQueue).toContainEqual({ title: 'Essay', awaiting: 5 })
    expect(s.gradingQueue.map((g) => g.title)).not.toContain('HW1')
    expect(s.allGraded.map((a) => a.title)).toContain('HW1')
    expect(s.draftsUnsubmitted).toContainEqual({ title: 'Essay', count: 2 })
    expect(s.missing).toContainEqual({ title: 'Lab', count: 4 })
    expect(s.missing.map((m) => m.title)).not.toContain('Project') // future deadline is not "missing"
    expect(s.dueSoon).toContainEqual({ title: 'Project', kind: 'assignment', hoursLeft: expect.any(Number) })
  })

  it('counts abandoned quiz attempts as drafts unsubmitted, alongside assignment drafts', async () => {
    vi.mocked(roadmapSignalQueries.getProfessorActivitySignals).mockResolvedValue({
      enrolled: 10,
      assignments: [{ id: 'a1', title: 'Essay', status: 'published', dueAt: inHours(200) }],
      tallies: { a1: { draft: 2, submitted: 0, graded: 0, returned: 0, handedIn: 0 } },
    })

    const s = await buildProfessorSignals(db, 'sec', {
      course: [], roadmapData: roadmap(), journeys: null, concepts: null,
      // quizzes reach the engine through the admin path, not the RLS-scoped query
      quizActivity: [
        { title: 'Week 8 Quiz', status: 'published', dueDate: null, inProgress: 3 },
        { title: 'Finished Quiz', status: 'published', dueDate: null, inProgress: 0 },
        { title: 'Closing Quiz', status: 'published', dueDate: inHours(30), inProgress: 0 },
      ],
    })

    expect(s.draftsUnsubmitted).toContainEqual({ title: 'Week 8 Quiz', count: 3 })
    expect(s.draftsUnsubmitted).toContainEqual({ title: 'Essay', count: 2 })
    expect(s.draftsUnsubmitted.map((d) => d.title)).not.toContain('Finished Quiz')
    // an unfinished attempt is not a submission waiting to be marked
    expect(s.gradingQueue.map((g) => g.title)).not.toContain('Week 8 Quiz')
    // same admin-supplied list also revives the quiz half of due-soon
    expect(s.dueSoon).toContainEqual({ title: 'Closing Quiz', kind: 'quiz', hoursLeft: expect.any(Number) })
  })

  it('stuck counts people, not (student × node) pairs', async () => {
    vi.mocked(roadmapSignalQueries.getProfessorActivitySignals).mockResolvedValue({
      enrolled: 3, assignments: [], tallies: {},
    })
    const j = (state: NodeJourney['state']) => ({ state }) as NodeJourney
    const s = await buildProfessorSignals(db, 'sec', {
      course: [], roadmapData: roadmap(), concepts: null,
      journeys: {
        weeks: [{ title: 'Wk1', nodeKeys: ['module_item:a', 'module_item:b'] }],
        // 3 students × 2 engaged nodes = 6 pooled pairs, 3 of them struggling
        students: [
          { nodes: { 'module_item:a': j('review_next'), 'module_item:b': j('in_progress') } },
          { nodes: { 'module_item:a': j('mastered'), 'module_item:b': j('review_next') } },
          { nodes: { 'module_item:a': j('mastered'), 'module_item:b': j('mastered') } },
        ],
      },
    })
    // head counts (2 of 3), never the pooled pairs (3 of 6) — M must not exceed the roster
    expect(s.stuck).toEqual([{ moduleTitle: 'Wk1', struggling: 2, engaged: 3 }])
  })

  it('surfaces unpublished drafts and content-only edges (drops module placement edges)', async () => {
    vi.mocked(roadmapSignalQueries.getProfessorActivitySignals).mockResolvedValue({
      enrolled: 0, assignments: [], tallies: {},
    })
    const data = roadmap({
      resources: [
        resource({ id: 'q1', title: 'Pop Quiz', stateLabel: 'Draft' }),
        resource({ id: 'q2', title: 'Final Quiz', stateLabel: 'Published' }),
      ],
      edges: [
        { id: 'e1', fromType: 'quiz', fromId: 'q1', toType: 'quiz', toId: 'q2', edgeType: 'prerequisite' },
        { id: 'e2', fromType: 'module', fromId: 'm1', toType: 'quiz', toId: 'q1', edgeType: 'prerequisite' }, // placement — dropped
      ],
    })

    const s = await buildProfessorSignals(db, 'sec', { course: [], roadmapData: data, journeys: null, concepts: null })

    expect(s.unpublishedDrafts).toEqual([{ title: 'Pop Quiz', createdAt: null, ageDays: 0 }])
    expect(s.edges).toEqual([{ from: 'Pop Quiz', to: 'Final Quiz', kind: 'prerequisite' }])
  })

  /* The count is enrolled − people with a submission timestamp, so it can never
     exceed the roster: a draft row has no timestamp (that student has started but
     not turned in) and the cron's auto-zero rows have none either. */
  it('leaves draft-holders to P7 so the two counts never overlap', async () => {
    vi.mocked(roadmapSignalQueries.getProfessorActivitySignals).mockResolvedValue({
      enrolled: 10,
      assignments: [{ id: 'a1', title: 'Lab', status: 'published', dueAt: inHours(-24) }],
      // 9 cron rows + 1 student draft, nobody handed anything in
      tallies: { a1: { draft: 1, submitted: 0, graded: 9, returned: 0, handedIn: 0 } },
    })

    const s = await buildProfessorSignals(db, 'sec', {
      course: [], roadmapData: roadmap(), journeys: null, concepts: null,
    })

    // 10 enrolled, 1 of them holding a draft → 9 with nothing at all, and that
    // draft-holder is counted once, by P7
    expect(s.missing).toEqual([{ title: 'Lab', count: 9 }])
    expect(s.draftsUnsubmitted).toContainEqual({ title: 'Lab', count: 1 })
  })

  /* Only an imminent class earns a note — every scheduled room already draws its
     own calendar tile, so a room days out would just be repeating the tile. */
  it('picks up only a class inside the 12h window, soonest first', async () => {
    vi.mocked(roadmapSignalQueries.getProfessorActivitySignals).mockResolvedValue({
      enrolled: 0, assignments: [], tallies: {},
    })
    const inHrs = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString()
    const data = roadmap({
      resources: [
        resource({ id: 's1', kind: 'live_session', title: 'Later today', status: 'not_started', scheduledAt: inHrs(9) }),
        resource({ id: 's2', kind: 'live_session', title: 'Very soon', status: 'not_started', scheduledAt: inHrs(2) }),
        resource({ id: 's3', kind: 'live_session', title: 'Next week', status: 'not_started', scheduledAt: inHrs(80) }),
        resource({ id: 's4', kind: 'live_session', title: 'Yesterday', status: 'complete', scheduledAt: inHrs(-20) }),
      ],
    })

    const s = await buildProfessorSignals(db, 'sec', { course: [], roadmapData: data, journeys: null, concepts: null })

    expect(s.sessionSoon.map((c) => c.title)).toEqual(['Very soon', 'Later today'])
  })

  /* A month-old draft is an unmade decision, not a work in progress — and since
     the clutter budget takes the head of this list, the stale ones must sort
     first or the note that matters is the one that gets dropped. */
  it('ages drafts and puts the stalest first', async () => {
    vi.mocked(roadmapSignalQueries.getProfessorActivitySignals).mockResolvedValue({
      enrolled: 0, assignments: [], tallies: {},
    })
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
    const data = roadmap({
      resources: [
        resource({ id: 'q1', title: 'Fresh', stateLabel: 'Draft', createdAt: daysAgo(3) }),
        resource({ id: 'q2', title: 'Abandoned', stateLabel: 'Draft', createdAt: daysAgo(70) }),
      ],
    })

    const s = await buildProfessorSignals(db, 'sec', { course: [], roadmapData: data, journeys: null, concepts: null })

    expect(s.unpublishedDrafts.map((d) => d.title)).toEqual(['Abandoned', 'Fresh'])
    expect(s.unpublishedDrafts[0].ageDays).toBeGreaterThanOrEqual(70)
    expect(s.unpublishedDrafts[1].ageDays).toBe(3)
  })

  it('resolves the mastery trend by skill_id onto its assessing node via concepts.sources', async () => {
    vi.mocked(roadmapSignalQueries.getProfessorActivitySignals).mockResolvedValue({
      enrolled: 0, assignments: [], tallies: {},
    })
    const s = await buildProfessorSignals(db, 'sec', {
      course: [], roadmapData: roadmap(), journeys: null,
      // sources is keyed by skill_id (not name); [0].title is the assessing node
      concepts: { sources: { sk1: [{ title: 'Attention Quiz' }] } },
      masteryTrend: [
        { skillId: 'sk1', from: 64, to: 52 }, // resolves
        { skillId: 'sk-unknown', from: 40, to: 30 }, // no source → dropped
      ],
    })
    expect(s.masteryTrend).toEqual([{ targetTitle: 'Attention Quiz', from: 64, to: 52 }])
  })
})

describe('buildStudentSignals', () => {
  it('posts grades, suppresses completed/graded from due-soon, and buckets mastery by tier', () => {
    const course: CourseModule[] = [
      { title: 'Wk1', pct: 0, phase: 'prog', materials: [
        { k: 'lecture', t: 'Big Reading', s: '', st: 'todo', pages: 80 },
        { k: 'lecture', t: 'Read Already', s: '', st: 'done', pages: 90 }, // done material → no note
      ], quizzes: [], assignments: [] },
      { title: 'Wk0', pct: 100, phase: 'done', materials: [{ k: 'lecture', t: 'Past Reading', s: '', st: 'todo', pages: 120 }], quizzes: [], assignments: [] }, // done module → no note
    ]
    const s = buildStudentSignals(
      {
        assignments: [
          { title: 'Essay', dueAt: inHours(20), mySubmission: 'graded' },
          { title: 'Lab', dueAt: inHours(20), mySubmission: null },
        ],
        quizzes: [
          { title: 'Quiz 1', dueDate: inHours(20), completed: true },
          { title: 'Quiz 2', dueDate: inHours(20), completed: false },
        ],
      },
      {
        course,
        roadmapData: roadmap(),
        concepts: { concepts: {
          attention: { score: 40, assessedBy: [{ title: 'Self-Attention Reading' }] },
          rnns: { score: 92, assessedBy: [{ title: 'Lecture RNN' }] },
        } },
      },
    )

    expect(s.gradePosted.map((g) => g.title).sort()).toEqual(['Essay', 'Quiz 1']) // graded assignment + completed quiz
    expect(s.dueSoon.map((d) => d.title).sort()).toEqual(['Lab', 'Quiz 2']) // completed/graded excluded
    expect(s.masteryLow).toContainEqual({ title: 'Self-Attention Reading', pct: 40 })
    expect(s.masteryHigh).toContainEqual({ title: 'Lecture RNN', pct: 92 })
    expect(s.longReads).toEqual([{ title: 'Big Reading', pages: 80 }]) // only undone reading in a live module
    expect(s.startHere).toEqual({ title: 'Big Reading' }) // first not-done material in a not-done module
  })

  it('S19: puts the weakest skill on the node that TEACHES it, one only, weakest wins', () => {
    // masteryLow already targets the node that ASSESSES a weak skill; this signal
    // is the other half — the lecture the student can go read about it.
    const course: CourseModule[] = [
      { title: 'Wk1', pct: 0, phase: 'prog', quizzes: [], assignments: [], materials: [
        { k: 'lecture', t: 'Lecture 5: Seq2Seq', s: '', st: 'todo', skills: [['Word alignment', 'weak'], ['Context vector', 'shaky']] },
        { k: 'lecture', t: 'Lecture 6: Transformers', s: '', st: 'todo', skills: [['Attention', 'weak']] },
      ] },
    ]
    const s = buildStudentSignals({ assignments: [], quizzes: [] }, {
      course,
      roadmapData: roadmap(),
      concepts: { concepts: {
        'word alignment': { score: 41, assessedBy: [{ title: 'Quiz 2' }] },
        'context vector': { score: 78, assessedBy: [{ title: 'Quiz 2' }] }, // shaky → not a candidate
        attention: { score: 55, assessedBy: [{ title: 'Quiz 3' }] },        // weak, but not the weakest
      } },
    })
    expect(s.studyWithTutor).toEqual({ targetTitle: 'Lecture 5: Seq2Seq', topic: 'Word alignment', pct: 41, tutorHref: undefined })
  })

  it('S19: links the note to Athena, topic-prefilled, only when the section has one', () => {
    const course: CourseModule[] = [
      { title: 'Wk1', pct: 0, phase: 'prog', quizzes: [], assignments: [], materials: [
        { k: 'lecture', t: 'Lecture 5', s: '', st: 'todo', skills: [['Word alignment', 'weak']] },
      ] },
    ]
    const ctx = { course, roadmapData: roadmap(), concepts: { concepts: { 'word alignment': { score: 41, assessedBy: [{ title: 'Quiz 2' }] } } } }
    const on = buildStudentSignals({ assignments: [], quizzes: [] }, { ...ctx, aiTutorHref: '/student/courses/s1/roadmap' })
    expect(on.studyWithTutor?.tutorHref).toBe('/student/courses/s1/roadmap?athena-topic=Word%20alignment')
    // Feature off → the note still names the skill, it just isn't a link.
    const off = buildStudentSignals({ assignments: [], quizzes: [] }, ctx)
    expect(off.studyWithTutor?.topic).toBe('Word alignment')
    expect(off.studyWithTutor?.tutorHref).toBeUndefined()
  })

  it('S19: stays absent when nothing taught on the map is weak', () => {
    const course: CourseModule[] = [
      { title: 'Wk1', pct: 0, phase: 'prog', quizzes: [], assignments: [], materials: [
        { k: 'lecture', t: 'Lecture 6', s: '', st: 'todo', skills: [['Attention', 'shaky']] },
      ] },
    ]
    const s = buildStudentSignals({ assignments: [], quizzes: [] }, {
      course,
      roadmapData: roadmap(),
      concepts: { concepts: { attention: { score: 78, assessedBy: [{ title: 'Quiz 3' }] } } },
    })
    expect(s.studyWithTutor).toBeUndefined()
  })

  it('passes aggregates through and resolves the mastery trend onto its assessing node', () => {
    const s = buildStudentSignals(
      { assignments: [], quizzes: [] },
      // concept key is the normalised skill name; assessedBy gives the node title
      { course: [], roadmapData: roadmap(), concepts: { concepts: { attention: { score: 78, assessedBy: [{ title: 'Self-Attention Quiz' }] } } } },
      {
        noImprovement: [{ title: 'Retake Quiz', attempts: 3 }],
        slowWrong: [{ title: 'Timed Quiz', skill: 'regularization' }],
        absenceGap: [{ sessionTitle: 'Lecture 5', topic: 'RNNs' }],
        masteryTrend: [{ skillName: 'Attention', from: 35, to: 78 }], // skill NAME → resolved via concepts
        newSinceVisit: [{ title: 'Lecture 8' }],
        youAreHere: { title: 'Lecture 4' },
      },
    )
    expect(s.noImprovement).toEqual([{ title: 'Retake Quiz', attempts: 3 }])
    expect(s.slowWrong).toEqual([{ title: 'Timed Quiz', skill: 'regularization' }])
    expect(s.absenceGap).toEqual([{ sessionTitle: 'Lecture 5', topic: 'RNNs' }])
    expect(s.masteryTrend).toEqual([{ targetTitle: 'Self-Attention Quiz', from: 35, to: 78 }])
    expect(s.newSinceVisit).toEqual([{ title: 'Lecture 8' }])
    expect(s.youAreHere).toEqual({ title: 'Lecture 4' })
  })
})

describe('buildProfessorSignals · slice-2 aggregates', () => {
  const noActivity = { enrolled: 0, assignments: [], tallies: {} }

  it('passes item quality through and attaches a booking spike to a scheduled session', async () => {
    vi.mocked(roadmapSignalQueries.getProfessorActivitySignals).mockResolvedValue(noActivity)
    const course: CourseModule[] = [
      { title: 'Wk1', pct: 0, materials: [], quizzes: [], assignments: [], sessions: [{ t: 'Deep Dive', s: '', sched: true }] },
    ]
    const hi = await buildProfessorSignals(db, 'sec', {
      course, roadmapData: roadmap(), journeys: null, concepts: null,
      itemQuality: [{ quizTitle: 'Midterm', questionLabel: 'Q5' }], bookingRecent: 5,
    })
    expect(hi.itemQuality).toEqual([{ quizTitle: 'Midterm', questionLabel: 'Q5' }])
    expect(hi.bookingDemand).toEqual({ targetTitle: 'session:Deep Dive', recent: 5 })
  })

  it('does not raise booking demand below the spike floor or with no session to attach to', async () => {
    vi.mocked(roadmapSignalQueries.getProfessorActivitySignals).mockResolvedValue(noActivity)
    const withSession: CourseModule[] = [
      { title: 'Wk1', pct: 0, materials: [], quizzes: [], assignments: [], sessions: [{ t: 'Deep Dive', s: '', sched: true }] },
    ]
    const belowFloor = await buildProfessorSignals(db, 'sec', { course: withSession, roadmapData: roadmap(), journeys: null, concepts: null, bookingRecent: 1 })
    expect(belowFloor.bookingDemand).toBeUndefined()
    const noSessionCourse: CourseModule[] = [{ title: 'Wk1', pct: 0, materials: [{ k: 'lecture', t: 'Lec', s: '', st: 'todo' }], quizzes: [], assignments: [] }]
    const noSession = await buildProfessorSignals(db, 'sec', { course: noSessionCourse, roadmapData: roadmap(), journeys: null, concepts: null, bookingRecent: 9 })
    expect(noSession.bookingDemand).toBeUndefined()
  })
})
