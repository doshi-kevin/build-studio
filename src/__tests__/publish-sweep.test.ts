// Tests for the deferred-publish notification sweep. Covers the atomic-claim
// contract: emit only for rows the claim UPDATE returned, no-op when nothing is
// claimed, and return 0 (no emit) if the claim query errors.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const emitEventMock = vi.fn()
vi.mock('@/lib/events/emit', () => ({
  emitEvent: (...args: unknown[]) => emitEventMock(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

/* eslint-disable @typescript-eslint/no-explicit-any */
let sweepAssignmentPublishNotifications: any
let sweepQuizPublishNotifications: any
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(async () => {
  vi.resetModules()
  emitEventMock.mockReset().mockResolvedValue(undefined)
  const mod = await import('@/lib/notifications/publish-sweep')
  sweepAssignmentPublishNotifications = mod.sweepAssignmentPublishNotifications
  sweepQuizPublishNotifications = mod.sweepQuizPublishNotifications
})

// adminDb whose assignments.update(...).eq(...).is(...).select(...) resolves to `claimed`.
function buildAdminDb(claimed: unknown, error: unknown = null) {
  const chain = {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    select: vi.fn().mockResolvedValue({ data: claimed, error }),
  }
  return { from: vi.fn(() => chain), _chain: chain }
}

describe('sweepAssignmentPublishNotifications', () => {
  it('emits assignment_published for each claimed assignment', async () => {
    const adminDb = buildAdminDb([
      { id: 'a1', section_id: 'sec1', title: 'HW1', due_at: null },
      { id: 'a2', section_id: 'sec1', title: 'HW2', due_at: '2026-07-10T00:00:00Z' },
    ])

    const result = await sweepAssignmentPublishNotifications(adminDb)

    expect(result.claimed).toBe(2)
    expect(emitEventMock).toHaveBeenCalledTimes(2)
    expect(emitEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'assignment_published',
        sectionId: 'sec1',
        entity: { type: 'assignment', id: 'a1' },
        actionable: true,
      }),
    )
  })

  it('claims via status=published AND publish_notified_at IS NULL (atomic claim)', async () => {
    const adminDb = buildAdminDb([{ id: 'a1', section_id: 'sec1', title: 'HW1', due_at: null }])
    await sweepAssignmentPublishNotifications(adminDb)
    expect(adminDb._chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ publish_notified_at: expect.any(String) }),
    )
    expect(adminDb._chain.eq).toHaveBeenCalledWith('status', 'published')
    expect(adminDb._chain.is).toHaveBeenCalledWith('publish_notified_at', null)
  })

  it('is a no-op when nothing is claimed', async () => {
    const result = await sweepAssignmentPublishNotifications(buildAdminDb([]))
    expect(result.claimed).toBe(0)
    expect(emitEventMock).not.toHaveBeenCalled()
  })

  it('returns 0 and does not emit if the claim query errors', async () => {
    const result = await sweepAssignmentPublishNotifications(buildAdminDb(null, { message: 'boom' }))
    expect(result.claimed).toBe(0)
    expect(emitEventMock).not.toHaveBeenCalled()
  })
})

describe('sweepQuizPublishNotifications', () => {
  it('emits quiz_published for each claimed quiz (fixes pg_cron-published quizzes never notifying)', async () => {
    const adminDb = buildAdminDb([
      { id: 'q1', section_id: 'sec1', title: 'Quiz 1', due_date: null },
      { id: 'q2', section_id: 'sec1', title: 'Quiz 2', due_date: '2026-07-10T00:00:00Z' },
    ])

    const result = await sweepQuizPublishNotifications(adminDb)

    expect(result.claimed).toBe(2)
    expect(emitEventMock).toHaveBeenCalledTimes(2)
    expect(emitEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'quiz_published',
        sectionId: 'sec1',
        entity: { type: 'quiz', id: 'q1' },
        actionable: true,
      }),
    )
  })

  it('claims via status=published AND publish_notified_at IS NULL (atomic claim)', async () => {
    const adminDb = buildAdminDb([{ id: 'q1', section_id: 'sec1', title: 'Quiz 1', due_date: null }])
    await sweepQuizPublishNotifications(adminDb)
    expect(adminDb._chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ publish_notified_at: expect.any(String) }),
    )
    expect(adminDb._chain.eq).toHaveBeenCalledWith('status', 'published')
    expect(adminDb._chain.is).toHaveBeenCalledWith('publish_notified_at', null)
  })

  it('is a no-op when nothing is claimed', async () => {
    const result = await sweepQuizPublishNotifications(buildAdminDb([]))
    expect(result.claimed).toBe(0)
    expect(emitEventMock).not.toHaveBeenCalled()
  })

  it('returns 0 and does not emit if the claim query errors', async () => {
    const result = await sweepQuizPublishNotifications(buildAdminDb(null, { message: 'boom' }))
    expect(result.claimed).toBe(0)
    expect(emitEventMock).not.toHaveBeenCalled()
  })
})
