// Tests for the professor end-of-day submissions summary sweep. Covers the two things
// most likely to break: aggregating counts across the three submission sources per
// section, and the claim-then-emit dedup (only newly-claimed sections get a summary, so
// the every-5-minute cron never double-emits). Hour-gating is exercised via `force`.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockEmitEvent = vi.fn()
vi.mock('@/lib/events/emit', () => ({ emitEvent: (...a: unknown[]) => mockEmitEvent(...a) }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { runSubmissionSummarySweep } from '@/lib/notifications/submission-summary-sweep'

// A thenable query chain whose every builder method returns itself and which resolves to
// a preset { data, error } when awaited — enough for the sweep's `await db.from(t)...` reads
// and the `upsert(...).select()` claim.
function routed(results: Record<string, { data: unknown; error: unknown }>) {
  return {
    from: vi.fn((table: string) => {
      const result = results[table] ?? { data: [], error: null }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {}
      for (const m of ['select', 'in', 'eq', 'gte', 'lte', 'order', 'limit', 'upsert']) {
        chain[m] = () => chain
      }
      chain.then = (resolve: (v: unknown) => unknown) => resolve(result)
      return chain
    }),
  }
}

const INSTS = { data: [{ id: 'inst-1', timezone: 'UTC' }], error: null }
const SECTIONS = {
  data: [
    { id: 'sec-A', professor_id: 'prof-A', institution_id: 'inst-1' },
    { id: 'sec-B', professor_id: 'prof-B', institution_id: 'inst-1' },
  ],
  error: null,
}
// Enrolled-student rows → the "X of N" denominator (sec-A: 5 students, sec-B: 4).
const ENROLLMENTS = {
  data: [
    ...Array.from({ length: 5 }, () => ({ section_id: 'sec-A' })),
    ...Array.from({ length: 4 }, () => ({ section_id: 'sec-B' })),
  ],
  error: null,
}

beforeEach(() => {
  mockEmitEvent.mockReset()
})

describe('runSubmissionSummarySweep', () => {
  it('names each assessment and its count per section, emitting once per section', async () => {
    const admin = routed({
      institutions: INSTS,
      course_sections: SECTIONS,
      enrollments: ENROLLMENTS,
      assignment_submissions: {
        // two submissions to the SAME assignment → one named entry, count 2
        data: [
          { assignment: { id: 'a1', section_id: 'sec-A', title: 'Homework 3' } },
          { assignment: { id: 'a1', section_id: 'sec-A', title: 'Homework 3' } },
        ],
        error: null,
      },
      quiz_attempts: { data: [{ section_id: 'sec-A', quiz: { id: 'q1', title: 'Quiz 2' } }], error: null },
      project_teams: {
        data: [{ project: { id: 'p1', section_id: 'sec-B', title: 'Final Project' } }],
        error: null,
      },
      // Both sections newly claimed for today.
      submission_summary_logs: { data: [{ section_id: 'sec-A' }, { section_id: 'sec-B' }], error: null },
    })

    const res = await runSubmissionSummarySweep(admin, { force: true })

    expect(res.emitted).toBe(2)
    expect(mockEmitEvent).toHaveBeenCalledTimes(2)

    const bySection = Object.fromEntries(
      mockEmitEvent.mock.calls.map((c) => [c[0].entity.id, c[0]]),
    )
    // Section A (5 enrolled): Homework 3 (2 submissions) + Quiz 2 (1) = 3 total; body names
    // each as "X of N", sorted by count desc. Refresh + section entity for the daily row.
    expect(bySection['sec-A']).toMatchObject({
      type: 'submissions_summary',
      audience: ['prof-A'],
      onDuplicate: 'refresh',
      title: '3 new submissions today',
      body: 'Homework 3: 2 of 5 · Quiz 2: 1 of 5',
      linkUrl: '/professor/courses/sec-A',
    })
    // Section B (4 enrolled): one project, singular title wording.
    expect(bySection['sec-B']).toMatchObject({
      audience: ['prof-B'],
      title: '1 new submission today',
      body: 'Final Project: 1 of 4',
    })
  })

  it('caps the named assessments and collapses the tail into "+N more"', async () => {
    // 7 distinct assignments, one submission each → 6 named + "+1 more", total 7.
    const seven = Array.from({ length: 7 }, (_, i) => ({
      assignment: { id: `a${i}`, section_id: 'sec-A', title: `HW ${i}` },
    }))
    const admin = routed({
      institutions: INSTS,
      course_sections: SECTIONS,
      enrollments: ENROLLMENTS,
      assignment_submissions: { data: seven, error: null },
      submission_summary_logs: { data: [{ section_id: 'sec-A' }], error: null },
    })

    const res = await runSubmissionSummarySweep(admin, { force: true })

    expect(res.emitted).toBe(1)
    const emitted = mockEmitEvent.mock.calls[0][0]
    expect(emitted.title).toBe('7 new submissions today')
    expect(emitted.body).toContain('+1 more')
    expect((emitted.body as string).split(' · ')).toHaveLength(7) // 6 named + the "+1 more" tail
  })

  it('only emits for sections the claim actually created (dedup against the 5-min cadence)', async () => {
    const admin = routed({
      institutions: INSTS,
      course_sections: SECTIONS,
      enrollments: ENROLLMENTS,
      assignment_submissions: {
        data: [{ assignment: { id: 'a1', section_id: 'sec-A', title: 'HW1' } }],
        error: null,
      },
      project_teams: { data: [{ project: { id: 'p1', section_id: 'sec-B', title: 'Proj' } }], error: null },
      // sec-B already summarized today → claim returns only sec-A.
      submission_summary_logs: { data: [{ section_id: 'sec-A' }], error: null },
    })

    const res = await runSubmissionSummarySweep(admin, { force: true })

    expect(res.emitted).toBe(1)
    expect(mockEmitEvent).toHaveBeenCalledTimes(1)
    expect(mockEmitEvent.mock.calls[0][0].entity.id).toBe('sec-A')
  })

  it('emits nothing when there were no submissions in the window', async () => {
    const admin = routed({
      institutions: INSTS,
      course_sections: SECTIONS,
      // all submission sources empty
    })

    const res = await runSubmissionSummarySweep(admin, { force: true })

    expect(res.emitted).toBe(0)
    expect(res.skipped).toBe('no submissions')
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })

  it('skips sections with no professor assigned', async () => {
    const admin = routed({
      institutions: INSTS,
      course_sections: { data: [{ id: 'sec-X', professor_id: null, institution_id: 'inst-1' }], error: null },
      assignment_submissions: { data: [{ assignment: { id: 'a1', section_id: 'sec-X', title: 'HW' } }], error: null },
      submission_summary_logs: { data: [], error: null },
    })

    const res = await runSubmissionSummarySweep(admin, { force: true })

    // sec-X has no professor → not in sectionMeta → its submission is not counted.
    expect(res.emitted).toBe(0)
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })
})
