/**
 * logMaterialEvent — the authorization boundary on the roadmap's engagement
 * signals.
 *
 * This is a `'use server'` export, so it is a reachable POST endpoint whose every
 * argument is attacker-controlled, and it writes with the service role. What it
 * writes is not user-visible content — it is the `material.*` event stream that
 * feeds the professor's triage annotations ("no one has opened this", "12 opened
 * this week", "you are here"). So the damage from a missing check is a professor
 * acting on fabricated numbers, and there is no screen that would ever look wrong.
 *
 * Enrolment alone used to be the whole gate: any valid uuid pair was accepted, so
 * a scripted caller could pump events at arbitrary item ids. These pin the guards
 * that close that, and one happy path so the guards can't silently swallow
 * everything instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildFullChain } from './helpers/mock-supabase'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockLogEvent = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/supabase/event-logger', () => ({
  logEvent: (...args: unknown[]) => mockLogEvent(...args),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let logMaterialEvent: any

const SECTION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ITEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: USER } }, error: null })
  mockAdminClient.mockReset()
  mockLogEvent.mockReset()
  const mod = await import('@/lib/events/material-events')
  logMaterialEvent = mod.logMaterialEvent
})

/**
 * `enrolled`/`item` are the two `.maybeSingle()` reads, in order. A missing row
 * models the real refusal: the predicates below did not match, so PostgREST
 * returns nothing rather than an error.
 */
function db(opts: { enrolled?: unknown; item?: unknown }) {
  /* Default the joined module to open. The guard now reads `unlock_date` off the
     row rather than filtering it DB-side, so a fixture without it would silently
     exercise the null (= open) branch and never the locked one. */
  if (opts.item && typeof opts.item === 'object' && !('modules' in opts.item)) {
    opts = { ...opts, item: { ...opts.item, modules: { unlock_date: null } } }
  }
  const enrollments = buildFullChain({ data: opts.enrolled ?? null, error: null })
  const items = buildFullChain({ data: opts.item ?? null, error: null })
  const tables: string[] = []
  mockAdminClient.mockReturnValue({
    from: vi.fn((table: string) => {
      tables.push(table)
      return table === 'enrollments' ? enrollments : items
    }),
  })
  return { enrollments, items, tables }
}

describe('logMaterialEvent — the item must belong to this section', () => {
  it('logs a viewed event for an enrolled student on a real, visible item', async () => {
    db({ enrolled: { id: 'enr-1' }, item: { id: ITEM } })
    await logMaterialEvent(SECTION, ITEM, 'viewed')
    expect(mockLogEvent).toHaveBeenCalledTimes(1)
    expect(mockLogEvent.mock.calls[0][0]).toMatchObject({
      userId: USER,
      eventType: 'material.viewed',
      sectionId: SECTION,
      metadata: { itemId: ITEM },
    })
  })

  /* The lookup is what makes the id mean something. Without it, `itemId` was
     nothing but a uuid-shaped string copied into event metadata — so the counts
     these events roll up to could name any row in the database, or none. */
  it('logs nothing when the item lookup matches no row', async () => {
    db({ enrolled: { id: 'enr-1' }, item: null })
    await logMaterialEvent(SECTION, ITEM, 'viewed')
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('constrains the lookup by section, published module AND item visibility', async () => {
    const { items } = db({ enrolled: { id: 'enr-1' }, item: { id: ITEM } })
    await logMaterialEvent(SECTION, ITEM, 'downloaded')
    /* The same published + visible join the roadmap itself reads through, so a
       hidden item or an unpublished module cannot be logged against either —
       otherwise a student could report engagement with material they were never
       shown, on a week the class hasn't reached. */
    expect(items.eq).toHaveBeenCalledWith('id', ITEM)
    expect(items.eq).toHaveBeenCalledWith('modules.section_id', SECTION)
    expect(items.eq).toHaveBeenCalledWith('modules.is_published', true)
    expect(items.eq).toHaveBeenCalledWith('is_visible', true)
    // An inner join — a LEFT join would return the item row with a null module.
    expect(items.select).toHaveBeenCalledWith(expect.stringContaining('modules!inner'))
  })

  /* A week behind a future `unlock_date` is published but not open yet. Its cards
     never reach the student's roadmap, so an event against one is either a stale id
     (the professor pushed the date back) or a scripted caller — either way it would
     put engagement numbers on material the class cannot have opened. */
  it('logs nothing for an item in a week that has not opened yet', async () => {
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
    db({ enrolled: { id: 'enr-1' }, item: { id: ITEM, modules: { unlock_date: future } } })
    await logMaterialEvent(SECTION, ITEM, 'viewed')
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('still logs once the open date has passed', async () => {
    const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    db({ enrolled: { id: 'enr-1' }, item: { id: ITEM, modules: { unlock_date: past } } })
    await logMaterialEvent(SECTION, ITEM, 'viewed')
    expect(mockLogEvent).toHaveBeenCalledTimes(1)
  })

  /* An enrollments row survives a drop or a withdrawal, so existence is not
     membership. Filtering on status is what stops a dropped student from carrying
     on writing into their old section's signals. */
  it('refuses a caller with no on-roster enrollment, before looking the item up', async () => {
    const { tables } = db({ enrolled: null })
    await logMaterialEvent(SECTION, ITEM, 'viewed')
    expect(tables).not.toContain('module_items')
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('gates enrollment on status, not merely on a row existing', async () => {
    const { enrollments } = db({ enrolled: { id: 'enr-1' }, item: { id: ITEM } })
    await logMaterialEvent(SECTION, ITEM, 'viewed')
    expect(enrollments.in).toHaveBeenCalledWith('status', expect.arrayContaining(['enrolled']))
    const statuses = enrollments.in.mock.calls[0][1] as string[]
    expect(statuses).not.toContain('dropped')
    expect(statuses).not.toContain('withdrawn')
  })

  it('never reaches the database for an unauthenticated caller', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    db({ enrolled: { id: 'enr-1' }, item: { id: ITEM } })
    await logMaterialEvent(SECTION, ITEM, 'viewed')
    expect(mockAdminClient).not.toHaveBeenCalled()
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  /* `kind` is interpolated straight into events.event_type — text, no CHECK,
      written with the service role. The allowlist is the only thing standing
      between a student and a forged audit row. */
  it('refuses a kind outside the allowlist and a non-uuid id, without touching the DB', async () => {
    db({ enrolled: { id: 'enr-1' }, item: { id: ITEM } })
    await logMaterialEvent(SECTION, ITEM, 'grade.updated')
    await logMaterialEvent(SECTION, 'not-a-uuid', 'viewed')
    await logMaterialEvent('not-a-uuid', ITEM, 'viewed')
    expect(mockAdminClient).not.toHaveBeenCalled()
    expect(mockLogEvent).not.toHaveBeenCalled()
  })
})
