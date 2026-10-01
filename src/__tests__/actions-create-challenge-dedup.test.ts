/**
 * createChallenge's double-submit guard (#703 part 2).
 *
 * Production held the proof: two "QA Double Click B18" drafts in CS-101 A, created **4.4 ms
 * apart** (19:55:44.420971 and 19:55:44.425348). The dialog already disables its submit button
 * while pending, and that did not help, because the second click landed before React re-rendered
 * with the button disabled. That is why `data-access.md` puts the guard for a one-shot action in
 * the database and has the action branch on 23505.
 *
 * The property under test is the one that decides whether the guard is USABLE: a unique-violation
 * is the guard working, so it has to reach the professor as "you already have a draft with this
 * title", not as the generic "Failed to create challenge" that every other insert error produces.
 * A guard that reports itself as a server fault teaches people to click again.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetAuthUser = vi.fn()
const mockAdminDb = vi.fn()

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/events/emit', () => ({ emitEvent: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mockGetAuthUser } }),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => mockAdminDb() }))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createChallenge: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let updateChallenge: any

const SECTION = '8a2ac745-bbd2-4848-a4b6-aeac1e69bb4b'

const VALID = {
  title: 'Week 1 Challenge',
  description: 'Do the thing',
  type: 'general' as const,
  difficulty: 'medium' as const,
  points: 10,
  bonus_points: 0,
  badge_id: null,
  max_claims: null,
  due_at: null,
  skill_ids: [],
}

/** Admin client whose `challenges` insert fails with the given Postgres error. */
function dbWithInsertError(error: unknown) {
  const build = (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      insert: () => chain,
      single: () =>
        table === 'challenges'
          ? Promise.resolve({ data: null, error })
          : Promise.resolve({ data: { id: SECTION, professor_id: 'prof-1', institution_id: 'inst-1' }, error: null }),
      maybeSingle: () =>
        Promise.resolve({ data: { id: SECTION, professor_id: 'prof-1', institution_id: 'inst-1' }, error: null }),
      then: (f: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(f),
    }
    return chain
  }
  return { from: (t: string) => build(t) }
}

/** Admin client whose `challenges` UPDATE fails with the given Postgres error. */
function dbWithUpdateError(error: unknown) {
  const build = (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      insert: () => chain,
      update: () => ({
        eq: () => ({
          eq: () => ({
            select: () =>
              table === 'challenges'
                ? Promise.resolve({ data: null, error })
                : Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
      single: () =>
        Promise.resolve({ data: { id: SECTION, professor_id: 'prof-1', institution_id: 'inst-1' }, error: null }),
      maybeSingle: () =>
        Promise.resolve({ data: { id: SECTION, professor_id: 'prof-1', institution_id: 'inst-1' }, error: null }),
      then: (f: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(f),
    }
    return chain
  }
  return { from: (t: string) => build(t) }
}

beforeEach(async () => {
  vi.resetModules()
  mockGetAuthUser.mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
  const mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/challenges/actions')
  createChallenge = mod.createChallenge
  updateChallenge = mod.updateChallenge
})

describe('createChallenge: the 23505 branch (#703 part 2)', () => {
  it('tells the professor a draft with that title already exists', async () => {
    /* The collision the partial unique index produces on a double-submit. If this reported the
       generic failure, the professor's reasonable next move is to click Create again. */
    mockAdminDb.mockReturnValue(
      dbWithInsertError({ code: '23505', message: 'duplicate key value violates unique constraint' }),
    )

    const res = await createChallenge(SECTION, VALID)

    expect(res.error).toBe('You already have a draft challenge with this title.')
    expect(res.error).not.toMatch(/Failed to create/)
  })

  it('still reports a real insert failure generically', async () => {
    /* The other direction, and the reason the branch has to be keyed on the CODE rather than on
       any insert error: a genuine DB fault must not be dressed up as a duplicate title, which
       would send the professor renaming a challenge to work around an outage. */
    mockAdminDb.mockReturnValue(dbWithInsertError({ code: '08006', message: 'connection failure' }))

    const res = await createChallenge(SECTION, VALID)

    expect(res.error).toBe('Failed to create challenge')
  })
})

describe('updateChallenge: the same guard applies to renames (#703 part 2)', () => {
  it('explains a title collision instead of reporting a server fault', async () => {
    /* The partial unique index covers renames too, which the create-path fix overlooked. A
       professor retitling a draft onto an existing draft's title hits 23505, and a generic
       "Failed to update challenge" reads as our fault for something they can fix in one edit. */
    mockAdminDb.mockReturnValue(
      dbWithUpdateError({ code: '23505', message: 'duplicate key value violates unique constraint' }),
    )

    const res = await updateChallenge(SECTION, 'ch-1', { title: 'Week 1 Challenge' })

    expect(res.error).toBe('You already have a draft challenge with this title.')
  })

  it('still reports a real update failure generically', async () => {
    mockAdminDb.mockReturnValue(dbWithUpdateError({ code: '08006', message: 'connection failure' }))

    const res = await updateChallenge(SECTION, 'ch-1', { title: 'Week 1 Challenge' })

    expect(res.error).toBe('Failed to update challenge')
  })
})
