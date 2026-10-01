// Orchestration tests for runReengagementSweep — the regressible product behavior:
// re-engagement-hour scoping, tier computation, bulk claim-then-send dedup (the
// idempotency contract that makes the 5-min cron safe), and dryRun being read-only.
// Mirrors digest-sweep.test.ts (mocked service client + email/emit).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const sendReengagementEmailMock = vi.fn()
const emitEventMock = vi.fn()
vi.mock('@/lib/email', () => ({
  sendReengagementEmail: (...a: unknown[]) => sendReengagementEmailMock(...a),
}))
vi.mock('@/lib/events/emit', () => ({ emitEvent: (...a: unknown[]) => emitEventMock(...a) }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runReengagementSweep: any
beforeEach(async () => {
  vi.resetModules()
  sendReengagementEmailMock.mockReset().mockResolvedValue(true)
  emitEventMock.mockReset().mockResolvedValue(undefined)
  runReengagementSweep = (await import('@/lib/notifications/re-engagement')).runReengagementSweep
})

// Thenable query builder: every chained method returns `this`; awaiting resolves to
// `result`. Each method is a vi.fn so the args (filters, upsert rows) are inspectable.
function chain(result: unknown) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'in', 'eq', 'lt', 'order', 'limit', 'upsert']) c[m] = vi.fn(() => c)
  ;(c as { then: unknown }).then = (f: (v: unknown) => unknown) => Promise.resolve(f(result))
  return c
}

// `claimed` = the (recipient, tier) pairs the bulk reengagement_logs upsert inserts
// (ON CONFLICT DO NOTHING → already-nudged pairs are absent).
function buildAdminDb(o: {
  institutions: unknown
  candidates: unknown
  claimed?: Array<{ id: string; tier: number }>
}) {
  const chains: Record<string, ReturnType<typeof chain>> = {
    institutions: chain({ data: o.institutions, error: null }),
    enrollments: chain({ data: o.candidates, error: null }),
    reengagement_logs: chain({
      data: (o.claimed ?? []).map((c) => ({ recipient_id: c.id, tier: c.tier })),
      error: null,
    }),
  }
  const from = vi.fn((t: string) => chains[t] ?? chain({ data: [], error: null }))
  return { from, _chains: chains }
}

const NOW = new Date('2026-07-09T14:00:00Z') // NY = 10:00 (re-engagement hour), UTC = 14:00 (not)
const DAY = 24 * 60 * 60 * 1000
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString()

function studentRow(o: {
  id: string
  days: number
  inst?: string
  course?: string
  muted?: boolean
}) {
  return {
    student: {
      id: o.id,
      email: `${o.id}@x.edu`,
      name: 'Dormant Student',
      last_login_at: daysAgo(o.days),
      institution_id: o.inst ?? 'inst-ny',
      role: 'student',
      settings: o.muted ? { notifications: { mutedTypes: ['re_engagement'] } } : null,
    },
    section: { status: 'active', course: { code: o.course ?? 'CS201', title: 'Data Structures' } },
  }
}

describe('runReengagementSweep', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  const institutions = [
    { id: 'inst-ny', timezone: 'America/New_York' },
    { id: 'inst-utc', timezone: 'UTC' },
  ]

  it('scopes candidates to institutions at their local re-engagement hour only', async () => {
    const db = buildAdminDb({
      institutions,
      candidates: [studentRow({ id: 's1', days: 10 })],
      claimed: [{ id: 's1', tier: 7 }],
    })
    await runReengagementSweep(db)
    // inst-ny is at 10:00 local; inst-utc is at 14:00 → excluded from the query.
    expect(db._chains.enrollments.in).toHaveBeenCalledWith('student.institution_id', ['inst-ny'])
  })

  it('sends only to (recipient, tier) pairs the bulk claim inserts (dedup)', async () => {
    const db = buildAdminDb({
      institutions,
      candidates: [studentRow({ id: 's1', days: 10 }), studentRow({ id: 's2', days: 10 })],
      claimed: [{ id: 's1', tier: 7 }], // s2 already nudged at tier 7 → not returned → not sent
    })
    const res = await runReengagementSweep(db)
    expect(sendReengagementEmailMock).toHaveBeenCalledTimes(1)
    expect(sendReengagementEmailMock).toHaveBeenCalledWith(
      's1@x.edu',
      expect.objectContaining({ title: expect.any(String), body: expect.any(String) }),
    )
    // In-app card is emitted for the same student (section-less, single recipient).
    expect(emitEventMock).toHaveBeenCalledTimes(1)
    expect(emitEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 're_engagement', audience: ['s1'] }),
    )
    expect(res.sent).toBe(1)
  })

  it('skips a student who muted the win-back reminder', async () => {
    const db = buildAdminDb({
      institutions,
      candidates: [
        studentRow({ id: 's1', days: 10, muted: true }),
        studentRow({ id: 's2', days: 10 }),
      ],
      claimed: [{ id: 's2', tier: 7 }], // s1 opted out → filtered before the claim; only s2 sends
    })
    const res = await runReengagementSweep(db)
    expect(sendReengagementEmailMock).toHaveBeenCalledTimes(1)
    expect(sendReengagementEmailMock).toHaveBeenCalledWith('s2@x.edu', expect.anything())
    expect(emitEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 're_engagement', audience: ['s2'] }),
    )
    expect(res.sent).toBe(1)
  })

  it('claims the highest tier crossed for the dormancy length', async () => {
    const db = buildAdminDb({
      institutions,
      candidates: [studentRow({ id: 's1', days: 20 })], // 20 days → tier 14
      claimed: [{ id: 's1', tier: 14 }],
    })
    await runReengagementSweep(db)
    const upsert = db._chains.reengagement_logs.upsert as ReturnType<typeof vi.fn>
    expect(upsert).toHaveBeenCalledWith(
      [{ recipient_id: 's1', tier: 14 }],
      expect.objectContaining({ onConflict: 'recipient_id,tier', ignoreDuplicates: true }),
    )
  })

  it('dryRun claims nothing, sends nothing, and previews recipients', async () => {
    const db = buildAdminDb({
      institutions,
      candidates: [studentRow({ id: 's1', days: 10 })], // 10 days → tier 7
    })
    const res = await runReengagementSweep(db, { dryRun: true })
    expect(db._chains.reengagement_logs.upsert).not.toHaveBeenCalled() // never claimed
    expect(sendReengagementEmailMock).not.toHaveBeenCalled()
    expect(emitEventMock).not.toHaveBeenCalled()
    expect(res.dryRun).toBe(true)
    expect(res.recipients).toHaveLength(1)
    expect(res.recipients[0].tier).toBe(7)
    expect(res.sent).toBe(0)
  })
})
