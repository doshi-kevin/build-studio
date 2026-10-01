// logEvent's piggybacked `profiles.last_active_at` stamp.
//
// This runs on the hottest path in the app — every mutating server action calls
// logEvent — under the RLS-bypassing admin client, and every one of its failure
// modes is silent (logEvent swallows everything by design):
//
//   - An UPDATE that loses its `id` filter rewrites the activity stamp of EVERY
//     profile in every institution. Nothing downstream would complain.
//   - A throttle that stops throttling turns one write per user per 10 minutes
//     into a write per action, on every action, forever.
//   - A cron/system event (userId null) must not stamp anybody as "active".
//
// Nothing else in the suite exercises the real event-logger — the other ~56
// action tests mock it away — so these are the only assertions standing over it.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildFullChain, createTableRouter } from './helpers/mock-supabase'

const mockAdminClient = vi.fn()

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { logEvent } from '@/lib/supabase/event-logger'

const USER = 'user-1'
/** Keep in step with ACTIVITY_TOUCH_MINUTES in the event logger. */
const TOUCH_MINUTES = 10

function dbFor(opts: { touchError?: { message: string } } = {}) {
  const events = buildFullChain({ data: null, error: null })
  const profiles = buildFullChain({ data: null, error: opts.touchError ?? null })
  mockAdminClient.mockReturnValue(createTableRouter({ events, profiles }))
  return { events, profiles }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('logEvent — the activity stamp', () => {
  it('stamps only the acting user, never a bare table-wide update', async () => {
    const { events, profiles } = dbFor()

    await logEvent({ userId: USER, eventType: 'roadmap.dossier_opened', sectionId: 'sec-1' })

    // The audit row is still the primary job.
    expect(events.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: USER, event_type: 'roadmap.dossier_opened', section_id: 'sec-1' }),
    )
    // The stamp is scoped to one row by primary key.
    expect(profiles.eq).toHaveBeenCalledWith('id', USER)
    expect(profiles.update).toHaveBeenCalledTimes(1)
    const patch = profiles.update.mock.calls[0][0] as { last_active_at: string }
    expect(Object.keys(patch)).toEqual(['last_active_at'])
    expect(Math.abs(Date.now() - new Date(patch.last_active_at).getTime())).toBeLessThan(5_000)
  })

  it('throttles to one write per user per 10 minutes, and always stamps a user who has none', async () => {
    // The throttle lives in the WHERE clause, so the filter IS the policy: a
    // stamp fresher than the window makes the UPDATE match zero rows.
    const { profiles } = dbFor()

    await logEvent({ userId: USER, eventType: 'quiz.submitted' })

    const filter = profiles.or.mock.calls[0][0] as string
    expect(filter).toContain('last_active_at.is.null')
    const cutoff = new Date(filter.match(/last_active_at\.lt\.(\S+)$/)![1]).getTime()
    expect(Date.now() - cutoff).toBeGreaterThan(TOUCH_MINUTES * 60_000 - 5_000)
    expect(Date.now() - cutoff).toBeLessThan(TOUCH_MINUTES * 60_000 + 5_000)
  })

  it('does not stamp anyone for an actorless system event', async () => {
    // Cron/sweep events pass userId null deliberately (the audit row still
    // exists). There is no human to mark active.
    const { events, profiles } = dbFor()

    await logEvent({ userId: null, eventType: 'sweep.submissions_summary' })

    expect(events.insert).toHaveBeenCalledTimes(1)
    expect(profiles.update).not.toHaveBeenCalled()
  })

  it('resolves even when the stamp write fails — the caller must never notice', async () => {
    // logEvent is fire-and-forget: a bad stamp cannot be allowed to reject into
    // an awaiting server action and turn a successful mutation into an error.
    const { events } = dbFor({ touchError: { message: 'deadlock detected' } })

    await expect(
      logEvent({ userId: USER, eventType: 'assignment.graded' }),
    ).resolves.toBeUndefined()
    expect(events.insert).toHaveBeenCalledTimes(1)
  })
})
