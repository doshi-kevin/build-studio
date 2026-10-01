// Tests for runDigestSweep's orchestration — the regressible product behavior the
// pure-helper tests in digest.test.ts don't cover: digest-hour scoping, course label
// resolved from section_id (the feature), bulk claim-then-send dedup (the idempotency
// contract that makes the 5-min cron safe), group-by-recipient, and dryRun being fully
// read-only. Mirrors publish-sweep.test.ts (mocked service client).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const sendDailyDigestMock = vi.fn()
vi.mock('@/lib/email', () => ({ sendDailyDigest: (...a: unknown[]) => sendDailyDigestMock(...a) }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runDigestSweep: any
beforeEach(async () => {
  vi.resetModules()
  sendDailyDigestMock.mockReset().mockResolvedValue(true)
  runDigestSweep = (await import('@/lib/notifications/digest')).runDigestSweep
})

// A thenable query builder: every chained method returns `this`; awaiting resolves to
// `result`. Each method is a vi.fn so the args passed (filters, upsert rows) are inspectable.
function chain(result: unknown) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'in', 'eq', 'gte', 'order', 'limit', 'upsert']) c[m] = vi.fn(() => c)
  ;(c as { then: unknown }).then = (f: (v: unknown) => unknown) => Promise.resolve(f(result))
  return c
}

// 1h before the fake "now" (2026-07-07T11:00Z) → inside every frequency window. Feed
// fixtures that don't set created_at default to this so the per-recipient window filter
// keeps them; tests that need an OLD item pass created_at explicitly (it wins via spread).
const RECENT_ISO = '2026-07-07T10:00:00Z'

// `claimed` = the recipient ids the bulk email_digest_logs upsert actually inserts
// (ON CONFLICT DO NOTHING → already-digested recipients are absent).
function buildAdminDb(o: {
  institutions: unknown
  feed: unknown
  profiles: unknown
  sections?: unknown
  claimed?: string[]
}) {
  const chains: Record<string, ReturnType<typeof chain>> = {
    institutions: chain({ data: o.institutions, error: null }),
    feed_items: chain({
      data: Array.isArray(o.feed)
        ? (o.feed as Record<string, unknown>[]).map((f) => ({ created_at: RECENT_ISO, ...f }))
        : o.feed,
      error: null,
    }),
    profiles: chain({ data: o.profiles, error: null }),
    course_sections: chain({ data: o.sections ?? [], error: null }),
    email_digest_logs: chain({
      data: (o.claimed ?? []).map((id) => ({ recipient_id: id })),
      error: null,
    }),
  }
  const from = vi.fn((t: string) => chains[t] ?? chain({ data: [], error: null }))
  return { from, _chains: chains }
}

describe('runDigestSweep', () => {
  // 2026-07-07 11:00Z → New York = 07:00 (digest hour), UTC = 11:00 (not).
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-07T11:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  const institutions = [
    { id: 'inst-ny', timezone: 'America/New_York' },
    { id: 'inst-utc', timezone: 'UTC' },
  ]

  it('sends only to students whose institution is at their (default) digest hour', async () => {
    const db = buildAdminDb({
      institutions,
      feed: [
        { recipient_id: 's1', institution_id: 'inst-ny', section_id: null, type: 'assignment_published', title: 'HW1', link_url: '/a' },
        { recipient_id: 's2', institution_id: 'inst-utc', section_id: null, type: 'assignment_published', title: 'HW2', link_url: '/b' },
      ],
      profiles: [
        { id: 's1', email: 's1@x.edu', name: 'Ann' },
        { id: 's2', email: 's2@x.edu', name: 'Ben' },
      ],
      claimed: ['s1', 's2'],
    })
    const res = await runDigestSweep(db)
    // inst-ny is at 07:00 (the default digest hour) → Ann; inst-utc is at 11:00 → Ben is
    // gated out by the per-student hour check (default 7 AM).
    expect(sendDailyDigestMock).toHaveBeenCalledTimes(1)
    expect(sendDailyDigestMock).toHaveBeenCalledWith('s1@x.edu', 'Ann', expect.anything())
    expect(res.sent).toBe(1)
  })

  it("omits a recipient's muted kinds from their digest", async () => {
    const db = buildAdminDb({
      institutions,
      feed: [
        { recipient_id: 's1', institution_id: 'inst-ny', section_id: null, type: 'announcement_posted', title: 'Announcement', link_url: '/a' },
        { recipient_id: 's1', institution_id: 'inst-ny', section_id: null, type: 'assignment_published', title: 'HW1', link_url: '/b' },
      ],
      profiles: [
        {
          id: 's1',
          email: 's1@x.edu',
          name: 'Ann',
          settings: { notifications: { mutedTypes: ['announcement_posted'] } },
        },
      ],
      claimed: ['s1'],
    })
    await runDigestSweep(db)
    expect(sendDailyDigestMock).toHaveBeenCalledTimes(1)
    const items = sendDailyDigestMock.mock.calls[0][2].items
    // The muted announcement is dropped; only the (unmuted) assignment survives.
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('HW1')
  })

  it('sends only to recipients the bulk claim actually inserts (dedup)', async () => {
    const db = buildAdminDb({
      institutions,
      feed: [
        { recipient_id: 's1', institution_id: 'inst-ny', section_id: null, title: 'HW1', link_url: '/a' },
        { recipient_id: 's2', institution_id: 'inst-ny', section_id: null, title: 'HW2', link_url: '/b' },
      ],
      profiles: [
        { id: 's1', email: 's1@x.edu', name: 'Ann' },
        { id: 's2', email: 's2@x.edu', name: 'Ben' },
      ],
      claimed: ['s1'], // s2 already digested today → not returned by the upsert → not sent
    })
    const res = await runDigestSweep(db)
    expect(sendDailyDigestMock).toHaveBeenCalledTimes(1)
    expect(sendDailyDigestMock).toHaveBeenCalledWith('s1@x.edu', 'Ann', expect.anything())
    expect(res.sent).toBe(1)
  })

  it("groups a recipient's items into a single email", async () => {
    const db = buildAdminDb({
      institutions,
      feed: [
        { recipient_id: 's1', institution_id: 'inst-ny', section_id: null, title: 'HW1', link_url: '/a' },
        { recipient_id: 's1', institution_id: 'inst-ny', section_id: null, title: 'HW2', link_url: '/b' },
      ],
      profiles: [{ id: 's1', email: 's1@x.edu', name: 'Ann' }],
      claimed: ['s1'],
    })
    await runDigestSweep(db)
    expect(sendDailyDigestMock).toHaveBeenCalledTimes(1)
    expect(sendDailyDigestMock.mock.calls[0][2].items).toHaveLength(2)
  })

  it('labels items by course resolved from section_id (not metadata)', async () => {
    const db = buildAdminDb({
      institutions,
      feed: [
        { recipient_id: 's1', institution_id: 'inst-ny', section_id: 'sec-201', title: 'HW1', link_url: '/a' },
      ],
      profiles: [{ id: 's1', email: 's1@x.edu', name: 'Ann' }],
      sections: [{ id: 'sec-201', course: { code: 'CS201', title: 'Data Structures' } }],
      claimed: ['s1'],
    })
    await runDigestSweep(db)
    // course_sections is queried for the distinct section ids, and the label lands on the item.
    expect(db._chains.course_sections.in).toHaveBeenCalledWith('id', ['sec-201'])
    expect(sendDailyDigestMock.mock.calls[0][2].items[0].courseLabel).toBe('CS201')
  })

  it('routes a professor recipient to the professor dashboard CTA', async () => {
    const db = buildAdminDb({
      institutions,
      feed: [
        {
          recipient_id: 'p1',
          institution_id: 'inst-ny',
          section_id: 'sec-201',
          type: 'submissions_summary',
          title: '3 new submissions today',
          link_url: '/professor/courses/sec-201',
        },
      ],
      profiles: [{ id: 'p1', email: 'p1@x.edu', name: 'Dr. Lee', role: 'professor' }],
      sections: [{ id: 'sec-201', course: { code: 'CS201', title: 'Data Structures' } }],
      claimed: ['p1'],
    })
    await runDigestSweep(db)
    expect(sendDailyDigestMock).toHaveBeenCalledTimes(1)
    // A student would get '/student/courses'; the professor's "Open Scholera" button
    // must land in the professor dashboard.
    const opts = sendDailyDigestMock.mock.calls[0][2]
    expect(opts.ctaPath).toBe('/professor/courses')
    expect(opts.items[0].title).toBe('3 new submissions today')
  })

  it('weekly recipient: includes items older than a day and claims the week bucket', async () => {
    const db = buildAdminDb({
      institutions,
      feed: [
        // 3 days old — outside the 24h daily window, inside the 7-day weekly window.
        { recipient_id: 's1', institution_id: 'inst-ny', section_id: null, type: 'assignment_published', title: 'HW1', link_url: '/a', created_at: '2026-07-04T10:00:00Z' },
      ],
      profiles: [
        { id: 's1', email: 's1@x.edu', name: 'Ann', settings: { notifications: { digestFrequency: 'weekly' } } },
      ],
      claimed: ['s1'],
    })
    await runDigestSweep(db)
    expect(sendDailyDigestMock).toHaveBeenCalledTimes(1)
    const opts = sendDailyDigestMock.mock.calls[0][2]
    expect(opts.frequency).toBe('weekly')
    expect(opts.items).toHaveLength(1) // the 3-day-old item is inside the weekly window
    // Dedup key is the week's Monday (2026-07-07 is a Tue) → claims once per week, not per day.
    const upsert = db._chains.email_digest_logs.upsert as unknown as ReturnType<typeof vi.fn>
    expect(upsert.mock.calls[0][0]).toEqual([{ recipient_id: 's1', digest_date: '2026-07-06' }])
  })

  it('daily recipient: excludes items older than 24h', async () => {
    const db = buildAdminDb({
      institutions,
      feed: [
        { recipient_id: 's1', institution_id: 'inst-ny', section_id: null, type: 'assignment_published', title: 'Old', link_url: '/a', created_at: '2026-07-04T10:00:00Z' },
      ],
      profiles: [{ id: 's1', email: 's1@x.edu', name: 'Ann' }], // no frequency → daily default
      claimed: ['s1'],
    })
    const res = await runDigestSweep(db)
    // The only item is 3 days old; a daily digest's window is 24h → nothing to send.
    expect(sendDailyDigestMock).not.toHaveBeenCalled()
    expect(res.sent).toBe(0)
  })

  it('dryRun claims nothing, sends nothing, and previews recipients', async () => {
    const db = buildAdminDb({
      institutions,
      feed: [{ recipient_id: 's1', institution_id: 'inst-ny', section_id: null, title: 'HW1', link_url: '/a' }],
      profiles: [{ id: 's1', email: 's1@x.edu', name: 'Ann' }],
    })
    const res = await runDigestSweep(db, { dryRun: true })
    expect(db._chains.email_digest_logs.upsert).not.toHaveBeenCalled() // never claimed
    expect(sendDailyDigestMock).not.toHaveBeenCalled()
    expect(res.dryRun).toBe(true)
    expect(res.recipients).toHaveLength(1)
    expect(res.sent).toBe(0)
  })
})
