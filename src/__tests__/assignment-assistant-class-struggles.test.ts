// `loadClassStruggles` is the context Athena brainstorms an assignment from, and
// it is deliberately BLIND TO INDIVIDUALS: it composes loaders that DO carry
// student names (at-risk lists, live-quiz non-responders) and must drop every one
// of them. That was previously guaranteed only by a comment — this pins it, which
// matters now that a third source feeds the same payload.
//
// The second property: the curated topic-mastery digest is what a remediation
// assignment should target, so it has to actually arrive.

import { describe, it, expect, vi } from 'vitest'

const AT_RISK_STUDENT = 'Marcus Johnson'
const NON_RESPONDER = 'Emily Chen'

/** Call counters, so the per-request memo below is a measured claim rather than
 *  a comment. Hoisted because `vi.mock` factories run before module init. */
const spies = vi.hoisted(() => ({
  loadTopicMastery: 0,
  loadCourseSnapshot: 0,
  /** Set by the recovery test to blow up exactly one mastery read. */
  failMasteryOnce: false,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/lib/ai/professor-assistant/context', () => ({
  // Both upstream loaders carry names on purpose — that is the point of the test.
  loadCourseSnapshot: async () => ((spies.loadCourseSnapshot += 1), {
    courseTitle: 'NLP',
    courseCode: '506',
    rosterCount: 7,
    modules: [],
    quizzes: [],
    publishedAnnouncementCount: 0,
    classAverage: 62,
    quizPerformance: [{ title: 'Quiz 3', attempts: 6, avgScore: 62, belowPass: 2 }],
    atRiskStudents: [{ name: AT_RISK_STUDENT, avgScore: 44, flaggedFor: 'below pass on 2 quizzes' }],
  }),
  loadLiveClassReport: async () => ({
    found: true,
    overallAccuracy: 0.55,
    weakestConcepts: ['Attention'],
    concepts: [{ concept: 'Attention', correctRate: 0.4 }],
    nonResponders: [NON_RESPONDER],
  }),
  loadTopicMastery: async () => {
    spies.loadTopicMastery += 1
    if (spies.failMasteryOnce) {
      spies.failMasteryOnce = false
      throw new Error('mastery read failed')
    }
    return {
      tracked: true,
      metric: 'median',
      totalTopics: 3,
      scoredTopics: 2,
      topics: [
        { topic: 'Hypothesis testing', score: 41, tier: 'weak', atRiskPct: 57 },
        { topic: 'Tokenization', score: 78, tier: 'shaky', atRiskPct: 0 },
      ],
      truncated: false,
    }
  },
}))

const { loadClassStruggles } = await import('@/lib/ai/assignment-assistant/context')
const { buildAssignmentAssistantTools } = await import('@/lib/ai/assignment-assistant/tools')

describe('loadClassStruggles — what Athena may see when brainstorming', () => {
  it('carries the curated topic mastery, weakest first, with the metric it used', async () => {
    const struggles = await loadClassStruggles({}, 'sec-1')

    expect(struggles.topicMastery.tracked).toBe(true)
    expect(struggles.topicMastery.metric).toBe('median')
    expect(struggles.topicMastery.topics[0]).toMatchObject({ topic: 'Hypothesis testing', score: 41 })
  })

  it('still carries the narrower live-class and quiz signals alongside it', async () => {
    const struggles = await loadClassStruggles({}, 'sec-1')

    // Topic mastery is cumulative and course-wide; the live-class report is one
    // session. Neither subsumes the other, so adding the first must not quietly
    // retire the second.
    expect(struggles.liveClass).toMatchObject({ found: true })
    expect(struggles.quizGaps.classAverage).toBe(62)
  })

  it('drops every student name before Athena can see it', async () => {
    const struggles = await loadClassStruggles({}, 'sec-1')
    const serialized = JSON.stringify(struggles)

    expect(serialized).not.toContain(AT_RISK_STUDENT)
    expect(serialized).not.toContain(NON_RESPONDER)
    expect('atRiskStudents' in struggles).toBe(false)
  })
})

// Runtime QA caught the model calling this zero-argument tool 55 times for one
// prompt (6 executions per request, and the panel auto-resubmits when a stream
// ends on `finishReason: 'tool-calls'`). Every execution re-ran the whole-section
// mastery read for a byte-identical answer. `MAX_AGENT_STEPS` does not help —
// it bounds one request, not the resubmit chain.
describe('get_class_struggles — one read per request, however often it is called', () => {
  const buildTool = () => {
    const tools = buildAssignmentAssistantTools({
      adminDb: {},
      sectionId: 'sec-1',
      institutionId: 'inst-1',
      userId: 'user-1',
      surface: 'authoring',
      kind: 'files',
    }) as unknown as Record<string, { execute: (...args: unknown[]) => Promise<unknown> }>
    return tools.get_class_struggles
  }

  it('runs the underlying loaders once no matter how many times the model asks', async () => {
    spies.loadTopicMastery = 0
    spies.loadCourseSnapshot = 0
    const tool = buildTool()

    const results = await Promise.all([tool.execute({}), tool.execute({}), tool.execute({})])

    expect(spies.loadTopicMastery).toBe(1)
    expect(spies.loadCourseSnapshot).toBe(1)
    // Memoised on the PROMISE, so concurrent calls in one agent step share it
    // and every caller still gets the full answer.
    for (const r of results) {
      expect((r as { topicMastery: { topics: unknown[] } }).topicMastery.topics).toHaveLength(2)
    }
  })

  it('does not share the read across requests — tools are rebuilt per request', async () => {
    spies.loadTopicMastery = 0
    await buildTool().execute({})
    await buildTool().execute({})

    // A later request must see fresh data; the memo is scoped to one tool set.
    expect(spies.loadTopicMastery).toBe(2)
  })

  it('a failed read does not poison the rest of the request', async () => {
    // Memoising the PROMISE means a rejected one, left in place, is replayed to
    // every later call in the same request — the model would then be told the
    // class data is unavailable for the whole turn because of one blip. The
    // clear-on-error is what makes the retry possible, and it is exactly the
    // kind of line a refactor drops.
    spies.loadTopicMastery = 0
    spies.failMasteryOnce = true
    const tool = buildTool()

    const failed = await tool.execute({})
    expect(failed).toEqual({ error: 'Could not load class performance right now.' })

    const retried = (await tool.execute({})) as { topicMastery: { topics: unknown[] } }
    expect(retried.topicMastery.topics).toHaveLength(2)
    expect(spies.loadTopicMastery).toBe(2)
  })
})
