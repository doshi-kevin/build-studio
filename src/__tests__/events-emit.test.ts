// Tests for the shared event layer's emit core: emitEvent (fanout + dedup + self-notify
// + never-throws) and markFeedItemDone (completion). These are the critical shared bits
// both surfaces rely on.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture the feed_items writes.
const upsertMock = vi.fn()
const updateEqMock = vi.fn()

// Build an admin client whose feed_items.upsert resolves, and whose
// feed_items.update(...).eq().eq()... resolves. course_sections lookup returns a tenant.
function makeAdminDb(
  sectionData: Record<string, unknown> = { institution_id: 'inst-1' },
  profilesData: unknown[] = [],
) {
  const updateChain: Record<string, unknown> = {}
  updateChain.eq = vi.fn(() => updateChain)
  ;(updateChain as { then: unknown }).then = (onF: (v: unknown) => unknown) =>
    Promise.resolve(updateEqMock()).then(onF)

  return {
    from: vi.fn((table: string) => {
      if (table === 'feed_items') {
        return {
          upsert: (...args: unknown[]) => {
            upsertMock(...args)
            return Promise.resolve({ error: null })
          },
          update: vi.fn(() => updateChain),
        }
      }
      if (table === 'course_sections') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: sectionData }),
        }
      }
      if (table === 'profiles') {
        // Preference lookup for the mute filter (optional types only). Default: no rows
        // → nobody has muted anything, so every recipient passes.
        return {
          select: vi.fn().mockReturnThis(),
          in: vi.fn().mockResolvedValue({ data: profilesData }),
        }
      }
      return {}
    }),
  }
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeAdminDb() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let emitEvent: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let markFeedItemDone: any

beforeEach(async () => {
  vi.resetModules()
  upsertMock.mockReset()
  updateEqMock.mockReset().mockReturnValue({ error: null })
  const mod = await import('@/lib/events/emit')
  emitEvent = mod.emitEvent
  markFeedItemDone = mod.markFeedItemDone
})

describe('emitEvent', () => {
  it('fans out one feed_items row per recipient with the right shape', async () => {
    await emitEvent({
      type: 'assignment_published',
      sectionId: 'sec-1',
      institutionId: 'inst-1',
      actorId: 'prof',
      audience: ['s1', 's2'],
      entity: { type: 'assignment', id: 'a-1' },
      title: 'New assignment: HW1',
      linkUrl: '/x',
      actionable: true,
      dueAt: '2026-07-10T00:00:00Z',
    })

    const [rows, opts] = upsertMock.mock.calls[0]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      recipient_id: 's1',
      type: 'assignment_published',
      title: 'New assignment: HW1',
      entity_type: 'assignment',
      entity_id: 'a-1',
      is_actionable: true,
      section_id: 'sec-1',
      institution_id: 'inst-1',
    })
    // Idempotent upsert on the dedup key.
    expect(opts).toMatchObject({ onConflict: 'recipient_id,type,entity_id', ignoreDuplicates: true })
  })

  it('refresh re-emit re-surfaces the notice: unread + un-dismissed, UPDATEs on conflict', async () => {
    await emitEvent({
      type: 'assignment_published',
      sectionId: 'sec-1',
      institutionId: 'inst-1',
      audience: ['s1'],
      entity: { type: 'assignment', id: 'a-1' },
      title: 'New assignment: HW1',
      onDuplicate: 'refresh',
    })
    const [rows, opts] = upsertMock.mock.calls[0]
    // Clearing dismissed_at is what brings a previously-dismissed notice back to the bell;
    // is_read:false re-notifies (e.g. an assignment/module unpublish → republish).
    expect(rows[0]).toMatchObject({ is_read: false, read_at: null, dismissed_at: null })
    // refresh UPDATEs the existing row on conflict (not ignoreDuplicates), so the re-emit lands.
    expect(opts).toMatchObject({ onConflict: 'recipient_id,type,entity_id' })
    expect(opts.ignoreDuplicates).toBeFalsy()
  })

  it('drops the actor and de-duplicates recipients', async () => {
    await emitEvent({
      type: 'announcement_posted',
      sectionId: 'sec-1',
      institutionId: 'inst-1',
      actorId: 'prof',
      audience: ['s1', 's1', 'prof'],
      title: 'Notice',
    })
    const [rows] = upsertMock.mock.calls[0]
    expect(rows.map((r: { recipient_id: string }) => r.recipient_id)).toEqual(['s1'])
  })

  it('stamps metadata.course_label from the section course (code preferred)', async () => {
    const mod = await import('@/lib/supabase/admin')
    vi.spyOn(mod, 'createAdminClient').mockImplementationOnce(
      () =>
        makeAdminDb({
          institution_id: 'inst-1',
          course: { code: 'CS201', title: 'Data Structures' },
        }) as unknown as ReturnType<typeof mod.createAdminClient>,
    )
    await emitEvent({
      type: 'quiz_published',
      sectionId: 'sec-1',
      audience: ['s1'],
      entity: { type: 'quiz', id: 'q-1' },
      title: 'New quiz',
    })
    expect(upsertMock.mock.calls[0][0][0].metadata).toMatchObject({ course_label: 'CS201' })
  })

  it('falls back to the course title and handles the array-shaped PostgREST join', async () => {
    const mod = await import('@/lib/supabase/admin')
    // PostgREST can return an embedded relation as a one-element array; no code → title.
    vi.spyOn(mod, 'createAdminClient').mockImplementationOnce(
      () =>
        makeAdminDb({
          institution_id: 'inst-1',
          course: [{ code: null, title: 'Data Structures' }],
        }) as unknown as ReturnType<typeof mod.createAdminClient>,
    )
    await emitEvent({
      type: 'quiz_published',
      sectionId: 'sec-1',
      audience: ['s1'],
      entity: { type: 'quiz', id: 'q-2' },
      title: 'New quiz',
    })
    expect(upsertMock.mock.calls[0][0][0].metadata).toMatchObject({ course_label: 'Data Structures' })
  })

  it('drops recipients who have muted an optional notification type', async () => {
    const mod = await import('@/lib/supabase/admin')
    // s1 has opted out of new-assignment notifications; s2 hasn't.
    vi.spyOn(mod, 'createAdminClient').mockImplementationOnce(
      () =>
        makeAdminDb({ institution_id: 'inst-1' }, [
          { id: 's1', settings: { notifications: { mutedTypes: ['assignment_published'] } } },
        ]) as unknown as ReturnType<typeof mod.createAdminClient>,
    )
    await emitEvent({
      type: 'assignment_published',
      sectionId: 'sec-1',
      institutionId: 'inst-1',
      audience: ['s1', 's2'],
      entity: { type: 'assignment', id: 'a-9' },
      title: 'New assignment',
    })
    const [rows] = upsertMock.mock.calls[0]
    expect(rows.map((r: { recipient_id: string }) => r.recipient_id)).toEqual(['s2'])
  })

  it('is a no-op when there are no recipients', async () => {
    await emitEvent({
      type: 'announcement_posted',
      sectionId: 'sec-1',
      institutionId: 'inst-1',
      audience: [],
      title: 'Notice',
    })
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('never throws when the write errors', async () => {
    // Force the upsert to reject by making from throw once.
    const mod = await import('@/lib/supabase/admin')
    vi.spyOn(mod, 'createAdminClient').mockImplementationOnce(() => {
      throw new Error('db down')
    })
    await expect(
      emitEvent({ type: 'announcement_posted', sectionId: 'sec-1', institutionId: 'inst-1', audience: ['s1'], title: 't' }),
    ).resolves.toBeUndefined()
  })
})

describe('markFeedItemDone', () => {
  it('flips is_done for the recipient + entity (never throws)', async () => {
    await expect(
      markFeedItemDone({ recipientId: 's1', entityType: 'assignment', entityId: 'a-1' }),
    ).resolves.toBeUndefined()
    expect(updateEqMock).toHaveBeenCalled()
  })
})
