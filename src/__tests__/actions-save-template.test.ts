// setTemplateSaved writes to saved_templates, an RLS SELECT-only table, through the admin
// client — so the server (not the client) must enforce: signed-in, staff on THIS section,
// a sane template id, institution_id stamped from the VERIFIED section (never client-supplied),
// and an unsave scoped by user_id so it can't wipe another user's saves. These tests assert
// those guards fire (same PR #198 self-write / IDOR lesson as uploadCellImage / gradeSubmission).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildFullChain, createTableRouter } from './helpers/mock-supabase'

const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: (...args: unknown[]) => mockVerifySectionAccess(...args),
  canWriteAsStaff: (role: string) => role === 'professor' || role === 'ta',
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any
let sectionsChain: ReturnType<typeof buildFullChain>
let savedChain: ReturnType<typeof buildFullChain>

/** Build an admin client whose section lookup and saved_templates write return the given results. */
function admin(
  sectionResult: { data: unknown; error: unknown } = { data: { institution_id: 'inst-1' }, error: null },
  savedResult: { data: unknown; error: unknown } = { data: null, error: null },
) {
  sectionsChain = buildFullChain(sectionResult)
  savedChain = buildFullChain(savedResult)
  return createTableRouter({ course_sections: sectionsChain, saved_templates: savedChain })
}

function asProfessor(adminDb = admin()) {
  mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })
}

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
  mockVerifySectionAccess.mockReset()
  asProfessor()
  mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions')
})

describe('setTemplateSaved — access control', () => {
  it('rejects an unauthenticated caller and writes nothing', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    const res = await mod.setTemplateSaved('sec-1', 'ml-assignment', true)
    expect(res).toEqual({ error: expect.any(String) })
    expect(savedChain.upsert).not.toHaveBeenCalled()
    expect(savedChain.delete).not.toHaveBeenCalled()
  })

  it('rejects a non-staff caller (student) and writes nothing', async () => {
    asProfessor() // installs an adminDb we can assert stays untouched
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'student', adminDb: admin() })
    const res = await mod.setTemplateSaved('sec-1', 'ml-assignment', true)
    expect(res).toEqual({ error: expect.stringContaining('permission') })
    expect(savedChain.upsert).not.toHaveBeenCalled()
  })
})

describe('setTemplateSaved — input validation', () => {
  it('rejects an empty template id', async () => {
    const res = await mod.setTemplateSaved('sec-1', '   ', true)
    expect(res).toEqual({ error: expect.stringContaining('found') })
    expect(savedChain.upsert).not.toHaveBeenCalled()
  })

  it('rejects an over-128-char template id', async () => {
    const res = await mod.setTemplateSaved('sec-1', 'x'.repeat(129), true)
    expect(res).toEqual({ error: expect.stringContaining('found') })
    expect(savedChain.upsert).not.toHaveBeenCalled()
  })
})

describe('setTemplateSaved — save', () => {
  it('upserts the row with institution_id from the VERIFIED section', async () => {
    const res = await mod.setTemplateSaved('sec-1', 'ml-assignment', true)
    expect(res).toEqual({ success: true })
    expect(sectionsChain.eq).toHaveBeenCalledWith('id', 'sec-1')
    // institution_id comes from the section, user_id from the session — never the client.
    expect(savedChain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'prof-1', institution_id: 'inst-1', template_id: 'ml-assignment' }),
      expect.objectContaining({ onConflict: 'user_id,template_id', ignoreDuplicates: true }),
    )
  })

  it('errors and does not upsert when the section is not found', async () => {
    asProfessor(admin({ data: null, error: null }))
    const res = await mod.setTemplateSaved('sec-1', 'ml-assignment', true)
    expect(res).toEqual({ error: expect.any(String) })
    expect(savedChain.upsert).not.toHaveBeenCalled()
  })
})

describe('setTemplateSaved — unsave', () => {
  it('deletes scoped by BOTH user_id and template_id (no section lookup)', async () => {
    const res = await mod.setTemplateSaved('sec-1', 'ml-assignment', false)
    expect(res).toEqual({ success: true })
    expect(savedChain.delete).toHaveBeenCalled()
    expect(savedChain.eq).toHaveBeenCalledWith('user_id', 'prof-1')
    expect(savedChain.eq).toHaveBeenCalledWith('template_id', 'ml-assignment')
    // Unsave never needs the institution, so it must not touch course_sections.
    expect(sectionsChain.select).not.toHaveBeenCalled()
    expect(savedChain.upsert).not.toHaveBeenCalled()
  })
})
