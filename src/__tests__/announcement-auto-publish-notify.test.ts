// A scheduled announcement went live and NOBODY was told.
//
// There is no cron for announcements: the scheduled → published flip happens on
// page load, and it happened in three separate places — the professor page, the
// student page, and getAnnouncements — each a bare UPDATE with no emitEvent.
// Whichever surface loaded first silently consumed the transition, and the
// student page was the likeliest. Meanwhile createAnnouncement's own comment
// promises the opposite: "not for drafts or scheduled ones — those notify when
// they actually publish."
//
// The regression is invisible by nature: nothing errors, the announcement really
// does publish, and only the notification is missing. So the assertion that
// earns its keep is "emitEvent fired once per row that THIS call flipped".
//
// The claim shape matters as much as the emit. `.eq('status','scheduled')` makes
// the UPDATE an atomic per-row claim so `.select()` returns only the rows this
// caller won — without it, three racing page loads would each notify for rows
// someone else published. Mirrors autoPublishScheduledQuizzes.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockEmitEvent = vi.fn()
vi.mock('@/lib/events/emit', () => ({ emitEvent: (...a: unknown[]) => mockEmitEvent(...a) }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { autoPublishScheduledAnnouncements } from '@/lib/notifications/announcement-auto-publish'

const SECTION = 'sec-1'

/** Records the table, the write payload and the filter chain. */
function buildDb(result: { data: unknown; error: unknown }) {
  const calls: Record<string, unknown[]> = {}
  const chain: Record<string, unknown> = {}
  const rec = (name: string) =>
    vi.fn((...args: unknown[]) => {
      calls[name] = args
      return chain
    })
  chain.update = rec('update')
  chain.eq = vi.fn((col: string, val: unknown) => {
    calls[`eq:${col}`] = [val]
    return chain
  })
  chain.lte = vi.fn((col: string, val: unknown) => {
    calls.lte = [col, val]
    return chain
  })
  chain.select = vi.fn((...args: unknown[]) => {
    calls.select = args
    return Promise.resolve(result)
  })
  /* announcement_mentions is a SECOND, different read on this path now: the notify
     audience is resolved from the announcement's own targeting rather than the roster
     (#665). It needs its own terminal shape — `select().eq()` resolving to rows —
     because the claim chain above ends at `.select()`. */
  let mentions: string[] = []
  const from = vi.fn((table: string) => {
    // Only the claim's table is recorded: `calls.from` backs the assertion about which
    // table was claimed, and the audience lookups below are secondary reads that would
    // otherwise overwrite it.
    if (table === 'announcements') calls.from = [table]
    if (table === 'announcement_mentions') {
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: mentions.map((student_id) => ({ student_id })) }),
        }),
      }
    }
    if (table === 'enrollments') {
      return {
        select: () => ({
          eq: () => ({ in: () => Promise.resolve({ data: [{ student_id: 'r1' }, { student_id: 'r2' }] }) }),
        }),
      }
    }
    return chain
  })
  return { db: { from }, calls, setMentions: (ids: string[]) => { mentions = ids } }
}

const row = (id: string, title: string, important = false) => ({
  id,
  title,
  is_important: important,
})

describe('autoPublishScheduledAnnouncements', () => {
  beforeEach(() => {
    mockEmitEvent.mockClear()
    mockEmitEvent.mockResolvedValue(undefined)
  })

  it('notifies once per announcement it just published', async () => {
    const { db } = buildDb({
      data: [row('a1', 'Midterm moved'), row('a2', 'Room change')],
      error: null,
    })

    await autoPublishScheduledAnnouncements(db, SECTION)

    expect(mockEmitEvent).toHaveBeenCalledTimes(2)
    const titles = mockEmitEvent.mock.calls.map((c) => (c[0] as { title: string }).title)
    expect(titles).toEqual(['New announcement: Midterm moved', 'New announcement: Room change'])
  })

  it('notifies ONLY the targeted students when a scheduled announcement is targeted', async () => {
    /* The gap this path had entirely: it never read `visibility`, so a scheduled
       announcement aimed at one student notified the whole roster the moment it went
       live — the same leak as the manual publish, just on a timer (#665). */
    const { db, setMentions } = buildDb({
      data: [{ ...row('a1', 'Accommodation arrangements', false), visibility: 'mentioned_only' }],
      error: null,
    })
    setMentions(['s3'])

    await autoPublishScheduledAnnouncements(db, SECTION)

    expect(mockEmitEvent).toHaveBeenCalledTimes(1)
    const arg = mockEmitEvent.mock.calls[0][0] as { audience: string[]; title: string }
    expect(arg.audience).toEqual(['s3'])
    // The roster fallback must not appear — those students cannot open it, and the
    // title is the sensitive part.
    expect(arg.audience).not.toContain('r1')
  })

  it('emits the same shape as a manual publish, with no actor', async () => {
    const { db } = buildDb({ data: [row('a1', 'Midterm moved', true)], error: null })

    await autoPublishScheduledAnnouncements(db, SECTION)

    expect(mockEmitEvent).toHaveBeenCalledWith({
      type: 'announcement_posted',
      sectionId: SECTION,
      // Time-based publish — there is no professor in the request.
      actorId: null,
      // Explicit audience, not the implicit roster fanout: a scheduled announcement can
      // be targeted, and this path used to notify everyone regardless (#665).
      audience: ['r1', 'r2'],
      entity: { type: 'announcement', id: 'a1' },
      title: 'New announcement: Midterm moved',
      /* The specific announcement, matching the manual-publish path — this used to link to
         the LIST with no id, so the same notification type sent people to two different
         places depending on how it was published (#694). */
      linkUrl: `/student/courses/${SECTION}/announcements/a1`,
      metadata: { important: true },
    })
  })

  it('omits the important flag when the announcement is not important', async () => {
    const { db } = buildDb({ data: [row('a1', 'Reading posted', false)], error: null })

    await autoPublishScheduledAnnouncements(db, SECTION)

    expect(mockEmitEvent.mock.calls[0][0]).toMatchObject({ metadata: undefined })
  })

  it('actually publishes: flips status on the announcements table', async () => {
    // Without this the suite passed even against a helper that wrote to the
    // wrong table and never set status — the notification assertions alone
    // cannot see whether anything was published.
    const { db, calls } = buildDb({ data: [row('a1', 'x')], error: null })

    await autoPublishScheduledAnnouncements(db, SECTION)

    expect(calls.from).toEqual(['announcements'])
    const payload = calls.update?.[0] as { status: string; published_at: string }
    expect(payload.status).toBe('published')
    expect(payload.published_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('claims rows atomically — scoped by section, status and due time', async () => {
    const { db, calls } = buildDb({ data: [row('a1', 'x')], error: null })

    await autoPublishScheduledAnnouncements(db, SECTION)

    // The status filter is what makes .select() return only OUR rows.
    expect(calls['eq:status']).toEqual(['scheduled'])
    expect(calls['eq:section_id']).toEqual([SECTION])
    // Due-time cutoff must be the SAME instant stamped as published_at —
    // comparing against a second `now` would open a drift window.
    const payload = calls.update?.[0] as { published_at: string }
    expect(calls.lte).toEqual(['scheduled_at', payload.published_at])
    // The returned columns must carry everything the notification needs.
    // `visibility` joined the projection so the notify audience can honour per-student
    // targeting — this path previously did not read it at all (#665).
    expect(calls.select?.[0]).toBe('id, title, is_important, visibility')
  })

  it('notifies nobody when nothing was due', async () => {
    const { db } = buildDb({ data: [], error: null })

    await autoPublishScheduledAnnouncements(db, SECTION)

    expect(mockEmitEvent).not.toHaveBeenCalled()
  })

  it('does not throw or notify when the update fails', async () => {
    // Rendering the page must not depend on this succeeding.
    const { db } = buildDb({ data: null, error: { message: 'boom' } })

    await expect(autoPublishScheduledAnnouncements(db, SECTION)).resolves.toBeUndefined()
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })
})
