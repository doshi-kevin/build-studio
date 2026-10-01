// setRoadmapNodeArchived takes a roadmap node off the map (or puts it back) by
// keeping a list of node keys in `course_sections.settings.roadmapArchived`.
//
// Two things make it worth testing rather than reading:
//
//  1. It is a READ-MODIFY-WRITE on the shared `settings` jsonb — the same blob
//     that carries enabledFeatures, sidebarHidden, sidebarOrder and the mastery
//     config. A merge bug here doesn't fail loudly; it silently wipes a
//     professor's feature toggles (i.e. what their students can reach) as a side
//     effect of hiding one card. Every write assertion below therefore checks
//     the OTHER keys survived, not just that the archive list is right.
//  2. `nodeKey` is client-supplied and gets persisted verbatim, so the regex
//     gate must run before anything else, and the list must stay bounded.
//
// Auth shape matches placement-actions (verifySectionAccess + canWriteAsProfessor):
// professor-only, TAs excluded.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()
const mockLogEvent = vi.fn()
const mockRevalidatePath = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => mockRevalidatePath(...a) }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: (...args: unknown[]) => mockVerifySectionAccess(...args),
  canWriteAsProfessor: (role: string) => role === 'professor',
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const UUID = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const KEY = `quiz:${UUID}`
/** The settings keys that are NOT ours — they must come back out untouched. */
const NEIGHBOURS = {
  enabledFeatures: ['quizzes', 'assignments'],
  sidebarHidden: ['grades'],
  sidebarOrder: ['modules', 'quizzes'],
  skillMastery: { threshold: 0.7 },
}

/** Admin client over `course_sections`: serves one settings blob, records every
 *  update payload. `section: null` = the row isn't there. */
function archiveAdmin(opts: { settings?: unknown; section?: null; updateError?: unknown } = {}) {
  const rec = { updates: [] as Record<string, unknown>[] }
  const row = 'section' in opts ? opts.section : { settings: 'settings' in opts ? opts.settings : {} }
  return {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
      update: (payload: Record<string, unknown>) => {
        rec.updates.push(payload)
        return { eq: async () => ({ error: opts.updateError ?? null }) }
      },
    }),
    _rec: rec,
  }
}

/** The archived list this call wrote. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const writtenList = (admin: any): string[] => admin._rec.updates[0].settings.roadmapArchived
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const writtenSettings = (admin: any): Record<string, unknown> => admin._rec.updates[0].settings

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asProfessor(admin: any) {
  mockGetUser.mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
  mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: admin })
}

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockVerifySectionAccess.mockReset()
  mockLogEvent.mockReset()
  mockRevalidatePath.mockReset()
  mod = await import('@/lib/roadmap/archive-actions')
})

describe('setRoadmapNodeArchived — the node key is untrusted input', () => {
  it('rejects a non-archivable key before it authenticates or reads anything', async () => {
    // The gate runs first on purpose: a bad key is a bad key regardless of who
    // is asking, and this keeps an unbounded string off the DB round-trip.
    const res = await mod.setRoadmapNodeArchived('sec-1', 'not-a-node-key', true)
    expect(res).toEqual({ error: 'That node can’t be archived' })
    expect(mockGetUser).not.toHaveBeenCalled()
    expect(mockVerifySectionAccess).not.toHaveBeenCalled()
  })

  it('rejects the kinds that are not roadmap nodes, and ids that are not uuids', async () => {
    for (const bad of [
      `athena_artifact:${UUID}`,        // student-only node, never archivable
      `enabledFeatures:${UUID}`,        // a sibling settings key as a "kind"
      'quiz:1',                         // short id
      `quiz:${UUID} extra`,             // suffix smuggling
      `quiz:${UUID}\nassignment:${OTHER}`,
      '',
    ]) {
      expect(await mod.setRoadmapNodeArchived('sec-1', bad, true)).toEqual({ error: 'That node can’t be archived' })
    }
  })

  it('rejects on RESTORE too — an unarchivable key can never be in the list', async () => {
    expect(await mod.setRoadmapNodeArchived('sec-1', 'junk', false)).toEqual({ error: 'That node can’t be archived' })
  })
})

describe('setRoadmapNodeArchived — authorization', () => {
  it('rejects an unauthenticated caller', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    expect(await mod.setRoadmapNodeArchived('sec-1', KEY, true)).toEqual({ error: 'Not authenticated' })
  })

  it('rejects a TA — section access is not archive access — and writes nothing', async () => {
    const admin = archiveAdmin()
    mockGetUser.mockResolvedValue({ data: { user: { id: 'ta-1' } }, error: null })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'ta', adminDb: admin })
    const res = await mod.setRoadmapNodeArchived('sec-1', KEY, true)
    expect(res).toEqual({ error: 'Only the professor can archive nodes on the roadmap' })
    expect(admin._rec.updates).toHaveLength(0)
  })

  it('rejects a caller with no access to the section, and writes nothing', async () => {
    const admin = archiveAdmin()
    mockGetUser.mockResolvedValue({ data: { user: { id: 'stranger' } }, error: null })
    mockVerifySectionAccess.mockResolvedValue({ ok: false, adminDb: admin })
    const res = await mod.setRoadmapNodeArchived('sec-1', KEY, true)
    expect(res).toEqual({ error: 'Only the professor can archive nodes on the roadmap' })
    expect(admin._rec.updates).toHaveLength(0)
  })

  it('scopes the access check to the section id it was handed', async () => {
    const admin = archiveAdmin()
    asProfessor(admin)
    await mod.setRoadmapNodeArchived('sec-42', KEY, true)
    expect(mockVerifySectionAccess).toHaveBeenCalledWith('sec-42', 'prof-1')
  })
})

describe('setRoadmapNodeArchived — the settings read-modify-write', () => {
  it('appends the key WITHOUT disturbing the section\'s other settings', async () => {
    // The regression this guards: spreading wrong here drops enabledFeatures,
    // which silently takes features away from every student in the section.
    const admin = archiveAdmin({ settings: { ...NEIGHBOURS, roadmapArchived: [`assignment:${OTHER}`] } })
    asProfessor(admin)
    const res = await mod.setRoadmapNodeArchived('sec-1', KEY, true)
    expect(res).toEqual({ success: true })
    expect(writtenSettings(admin)).toEqual({ ...NEIGHBOURS, roadmapArchived: [`assignment:${OTHER}`, KEY] })
  })

  it('removes only that key on restore, leaving the rest of the list and blob intact', async () => {
    const admin = archiveAdmin({ settings: { ...NEIGHBOURS, roadmapArchived: [`assignment:${OTHER}`, KEY, `module_item:${OTHER}`] } })
    asProfessor(admin)
    const res = await mod.setRoadmapNodeArchived('sec-1', KEY, false)
    expect(res).toEqual({ success: true })
    expect(writtenSettings(admin)).toEqual({ ...NEIGHBOURS, roadmapArchived: [`assignment:${OTHER}`, `module_item:${OTHER}`] })
  })

  it('is idempotent in both directions — no duplicate key, no error re-restoring', async () => {
    // The canvas fires optimistically and the undo chip can be double-clicked, so
    // a repeat is normal traffic rather than an error case.
    const dup = archiveAdmin({ settings: { roadmapArchived: [KEY] } })
    asProfessor(dup)
    expect(await mod.setRoadmapNodeArchived('sec-1', KEY, true)).toEqual({ success: true })
    expect(writtenList(dup)).toEqual([KEY])

    vi.resetModules()
    mod = await import('@/lib/roadmap/archive-actions')
    const absent = archiveAdmin({ settings: { roadmapArchived: [`assignment:${OTHER}`] } })
    asProfessor(absent)
    expect(await mod.setRoadmapNodeArchived('sec-1', KEY, false)).toEqual({ success: true })
    expect(writtenList(absent)).toEqual([`assignment:${OTHER}`])
  })

  it('normalizes a garbage list instead of writing on top of it', async () => {
    // settings is hand-editable jsonb; a non-list (or a list with junk in it)
    // must not end up concatenated or spread into the new value.
    const admin = archiveAdmin({ settings: { ...NEIGHBOURS, roadmapArchived: 'quiz:whatever' } })
    asProfessor(admin)
    await mod.setRoadmapNodeArchived('sec-1', KEY, true)
    expect(writtenSettings(admin)).toEqual({ ...NEIGHBOURS, roadmapArchived: [KEY] })
  })

  it('drops non-string entries already in the list', async () => {
    const admin = archiveAdmin({ settings: { roadmapArchived: [`quiz:${OTHER}`, 7, null] } })
    asProfessor(admin)
    await mod.setRoadmapNodeArchived('sec-1', KEY, true)
    expect(writtenList(admin)).toEqual([`quiz:${OTHER}`, KEY])
  })

  it('starts a list when settings has none at all', async () => {
    const admin = archiveAdmin({ settings: null })
    asProfessor(admin)
    expect(await mod.setRoadmapNodeArchived('sec-1', KEY, true)).toEqual({ success: true })
    expect(writtenList(admin)).toEqual([KEY])
  })

  it('404s on a missing section rather than creating settings for it', async () => {
    const admin = archiveAdmin({ section: null })
    asProfessor(admin)
    expect(await mod.setRoadmapNodeArchived('sec-1', KEY, true)).toEqual({ error: 'Course section not found' })
    expect(admin._rec.updates).toHaveLength(0)
  })
})

describe('setRoadmapNodeArchived — the MAX_ARCHIVED ceiling', () => {
  const full = (n: number) => Array.from({ length: n }, (_, i) => `quiz:${i}`)

  it('refuses a NEW key once the list is at the cap', async () => {
    const { MAX_ARCHIVED } = await import('@/lib/roadmap/archive')
    const admin = archiveAdmin({ settings: { roadmapArchived: full(MAX_ARCHIVED) } })
    asProfessor(admin)
    const res = await mod.setRoadmapNodeArchived('sec-1', KEY, true)
    expect(res).toEqual({ error: 'The Archive is full — put something back first' })
    expect(admin._rec.updates).toHaveLength(0)
  })

  it('still lets a key ALREADY in the list be re-archived at the cap', async () => {
    // Otherwise a retry of an in-flight archive would surface "the Archive is
    // full" for a card that is already in it.
    const { MAX_ARCHIVED } = await import('@/lib/roadmap/archive')
    const list = [...full(MAX_ARCHIVED - 1), KEY]
    const admin = archiveAdmin({ settings: { roadmapArchived: list } })
    asProfessor(admin)
    expect(await mod.setRoadmapNodeArchived('sec-1', KEY, true)).toEqual({ success: true })
    expect(writtenList(admin)).toEqual(list)
  })

  it('never blocks a RESTORE — the way out of a full Archive stays open', async () => {
    const { MAX_ARCHIVED } = await import('@/lib/roadmap/archive')
    const admin = archiveAdmin({ settings: { roadmapArchived: [...full(MAX_ARCHIVED - 1), KEY] } })
    asProfessor(admin)
    expect(await mod.setRoadmapNodeArchived('sec-1', KEY, false)).toEqual({ success: true })
    expect(writtenList(admin)).toHaveLength(MAX_ARCHIVED - 1)
  })
})

describe('setRoadmapNodeArchived — failure and audit trail', () => {
  it('returns a direction-specific message on a failed write and logs no event', async () => {
    const failing = archiveAdmin({ updateError: { message: 'boom' } })
    asProfessor(failing)
    expect(await mod.setRoadmapNodeArchived('sec-1', KEY, true)).toEqual({ error: 'Couldn’t archive it — try again' })
    expect(mockLogEvent).not.toHaveBeenCalled()
    expect(mockRevalidatePath).not.toHaveBeenCalled()

    vi.resetModules()
    mod = await import('@/lib/roadmap/archive-actions')
    const failing2 = archiveAdmin({ updateError: { message: 'boom' } })
    asProfessor(failing2)
    expect(await mod.setRoadmapNodeArchived('sec-1', KEY, false)).toEqual({ error: 'Couldn’t put it back — try again' })
  })

  it('logs distinct event types for archive vs restore', async () => {
    const admin = archiveAdmin()
    asProfessor(admin)
    await mod.setRoadmapNodeArchived('sec-1', KEY, true)
    expect(mockLogEvent).toHaveBeenCalledWith({
      userId: 'prof-1', eventType: 'roadmap.node_archived', sectionId: 'sec-1', metadata: { nodeKey: KEY },
    })

    mockLogEvent.mockReset()
    vi.resetModules()
    mod = await import('@/lib/roadmap/archive-actions')
    const admin2 = archiveAdmin({ settings: { roadmapArchived: [KEY] } })
    asProfessor(admin2)
    await mod.setRoadmapNodeArchived('sec-1', KEY, false)
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'roadmap.node_restored' }))
  })

  it('revalidates BOTH roadmaps — archiving takes the node off the student map too', async () => {
    const admin = archiveAdmin()
    asProfessor(admin)
    await mod.setRoadmapNodeArchived('sec-9', KEY, true)
    expect(mockRevalidatePath).toHaveBeenCalledWith('/professor/courses/sec-9/roadmap')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/student/courses/sec-9/roadmap')
  })
})
