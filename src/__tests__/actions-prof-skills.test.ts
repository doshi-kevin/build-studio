// Tests for the professor Skill-Mastery server action `setSkillExcluded`.
//
// Two things matter and could regress unnoticed:
//   1. Access control — a caller who can't write the section is rejected before
//      any DB write (the action gates on requireSectionWriter).
//   2. The exclude CASCADE — flipping a MAIN skill must also flip its subtopics.
//      The action expresses this as a single UPDATE filtered by
//      `.or(id.eq.<id>, parent_id.eq.<id>)`; we capture that filter to prove the
//      cascade is wired (not just the one row).
//
// Pattern 2 (auth mock): module-level mocks + dynamic import. We mock the
// section-access guard so we can toggle ownership and inject the adminDb the
// action writes through.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()
const mockUpdateChain = { eq: vi.fn(), or: vi.fn() }
const mockAdminDb = { from: vi.fn(), rpc: vi.fn() }

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: (...a: unknown[]) => mockVerifySectionAccess(...a),
  canWriteAsStaff: (role: string) => role === 'professor' || role === 'ta',
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
// `after` should run its callback synchronously so we can assert the recompute kick.
vi.mock('next/server', () => ({ after: (fn: () => void) => fn() }))
const mockEnqueue = vi.fn()
vi.mock('@/lib/extraction/enqueue', () => ({
  enqueueMasteryRecompute: (...a: unknown[]) => mockEnqueue(...a),
}))

const SECTION = '550e8400-e29b-41d4-a716-446655440000'
const TOPIC = '550e8400-e29b-41d4-a716-446655440001'

/* eslint-disable @typescript-eslint/no-explicit-any */
let setSkillExcluded: (input: unknown) => Promise<any>
let addSkill: (input: unknown) => Promise<any>
let renameSkill: (input: unknown) => Promise<any>
let updateSkillMasteryConfig: (input: unknown) => Promise<any>
/* eslint-enable @typescript-eslint/no-explicit-any */

// A course_sections lookup: `.select(...).eq(...).maybeSingle()`.
function sectionHandle(institutionId: string | null) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  chain.maybeSingle = vi.fn(async () => ({ data: institutionId ? { institution_id: institutionId } : null }))
  return chain
}

// A skills handle with three distinct terminals used by addSkill/renameSkill:
//   .select(...).eq()[.neq()]  → awaitable, resolves { data: rows }  (dup-name scan)
//   .insert({...})             → resolves { error }                  (addSkill)
//   .update({...}).eq().eq()   → awaitable, resolves { error }       (renameSkill)
function skillsHandle(opts: {
  rows: Array<{ name: string; parent_id?: string | null }>
  insertError?: unknown
  updateError?: unknown
  /** Rows the update matched. PostgREST returns this when count:'exact' is passed;
   *  renameSkill now reads it so a write that matched nothing reports failure (#601). */
  updateCount?: number
}) {
  const selectChain: Record<string, unknown> = {}
  selectChain.eq = vi.fn(() => selectChain)
  selectChain.neq = vi.fn(() => selectChain)
  selectChain.is = vi.fn(() => selectChain)
  selectChain.then = (resolve: (v: unknown) => void) => resolve({ data: opts.rows })

  const updateChain: Record<string, unknown> = {}
  updateChain.eq = vi.fn(() => updateChain)
  updateChain.then = (resolve: (v: unknown) => void) =>
    resolve({ error: opts.updateError ?? null, count: opts.updateCount ?? 1 })

  return {
    select: vi.fn(() => selectChain),
    insert: vi.fn(async () => ({ error: opts.insertError ?? null })),
    update: vi.fn(() => updateChain),
  }
}

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockVerifySectionAccess.mockReset()
  mockEnqueue.mockReset()
  mockUpdateChain.eq.mockReset().mockReturnValue(mockUpdateChain)
  mockUpdateChain.or.mockReset().mockResolvedValue({ error: null })
  mockAdminDb.from.mockReset().mockReturnValue({ update: () => mockUpdateChain })
  mockAdminDb.rpc.mockReset().mockResolvedValue({ error: null })

  mockGetUser.mockResolvedValue({ data: { user: { id: 'prof-1' } } })
  mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: mockAdminDb })

  const mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/skills/actions')
  setSkillExcluded = mod.setSkillExcluded
  addSkill = mod.addSkill
  renameSkill = mod.renameSkill
  updateSkillMasteryConfig = mod.updateSkillMasteryConfig
})

describe('setSkillExcluded', () => {
  it('rejects an unauthenticated caller without writing', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await setSkillExcluded({ sectionId: SECTION, skillId: TOPIC, excluded: true })
    expect(res).toHaveProperty('error')
    expect(mockAdminDb.from).not.toHaveBeenCalled()
  })

  it('rejects a caller who cannot write the section', async () => {
    mockVerifySectionAccess.mockResolvedValue({ ok: false, adminDb: mockAdminDb })
    const res = await setSkillExcluded({ sectionId: SECTION, skillId: TOPIC, excluded: true })
    expect(res).toHaveProperty('error')
    expect(mockAdminDb.from).not.toHaveBeenCalled()
  })

  it('rejects invalid input (non-uuid skillId) before any guard or write', async () => {
    const res = await setSkillExcluded({ sectionId: SECTION, skillId: 'nope', excluded: true })
    expect(res).toHaveProperty('error')
    expect(mockVerifySectionAccess).not.toHaveBeenCalled()
  })

  it('cascades the exclude to subtopics via .or(id, parent_id) and kicks a recompute', async () => {
    const res = await setSkillExcluded({ sectionId: SECTION, skillId: TOPIC, excluded: true })
    expect(res).toEqual({ success: true })

    // Scoped to the section…
    expect(mockUpdateChain.eq).toHaveBeenCalledWith('section_id', SECTION)
    // …and the cascade filter targets the skill itself OR any child of it.
    expect(mockUpdateChain.or).toHaveBeenCalledWith(`id.eq.${TOPIC},parent_id.eq.${TOPIC}`)
    // Inclusion changed → background recompute for the section.
    expect(mockEnqueue).toHaveBeenCalledWith(SECTION)
  })
})

// Duplicate-name rejection (#330): the tag→skill mapping matches by name across
// the whole section, so two skills with the same name (case-insensitively) make
// the mapping ambiguous. addSkill/renameSkill must refuse before writing.
describe('addSkill', () => {
  it('rejects a name that duplicates an existing skill (case-insensitive) without inserting', async () => {
    const skills = skillsHandle({ rows: [{ name: 'Vectors', parent_id: null }] })
    mockAdminDb.from.mockImplementation((table: string) => {
      if (table === 'course_sections') return sectionHandle('inst-1')
      if (table === 'skills') return skills
      throw new Error(`unexpected table ${table}`)
    })

    const res = await addSkill({ sectionId: SECTION, name: 'vectors' })
    expect(res).toHaveProperty('error')
    expect(skills.insert).not.toHaveBeenCalled()
  })

  it('inserts a non-duplicate main skill at position = sibling count of its level', async () => {
    // Two existing mains + one subtopic; the new main goes to position 2.
    const skills = skillsHandle({
      rows: [
        { name: 'Vectors', parent_id: null },
        { name: 'Matrices', parent_id: null },
        { name: 'Dot product', parent_id: TOPIC },
      ],
    })
    mockAdminDb.from.mockImplementation((table: string) => {
      if (table === 'course_sections') return sectionHandle('inst-1')
      if (table === 'skills') return skills
      throw new Error(`unexpected table ${table}`)
    })

    const res = await addSkill({ sectionId: SECTION, name: 'Tensors' })
    expect(res).toEqual({ success: true })
    expect(skills.insert).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Tensors', parent_id: null, position: 2, institution_id: 'inst-1' }),
    )
  })
})

describe('renameSkill', () => {
  it('rejects a rename that collides with another skill (case-insensitive) without updating', async () => {
    const skills = skillsHandle({ rows: [{ name: 'Matrices' }] })
    mockAdminDb.from.mockImplementation((table: string) => {
      if (table === 'skills') return skills
      throw new Error(`unexpected table ${table}`)
    })

    const res = await renameSkill({ sectionId: SECTION, skillId: TOPIC, name: 'matrices' })
    expect(res).toHaveProperty('error')
    expect(skills.update).not.toHaveBeenCalled()
  })

  it('renames when the new name does not collide', async () => {
    const skills = skillsHandle({ rows: [{ name: 'Matrices' }] })
    mockAdminDb.from.mockImplementation((table: string) => {
      if (table === 'skills') return skills
      throw new Error(`unexpected table ${table}`)
    })

    const res = await renameSkill({ sectionId: SECTION, skillId: TOPIC, name: 'Tensors' })
    expect(res).toEqual({ success: true })
    // Second arg is { count: 'exact' } — renameSkill reads the matched-row count so a write
    // that hit nothing reports failure instead of a false success (#601).
    expect(skills.update).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Tensors' }),
      { count: 'exact' },
    )
  })

  /* Both writes are already section-scoped, so a skillId from another course correctly
     matches nothing — the tenancy behaviour was right. What was wrong is that neither read
     the row count, so the caller was told the rename worked and rendered the new name over
     data that never changed. The oracle is the RETURN VALUE, not the query. */
  it('reports failure when the rename matched no row', async () => {
    const skills = skillsHandle({ rows: [{ name: 'Matrices' }], updateCount: 0 })
    mockAdminDb.from.mockImplementation((table: string) => {
      if (table === 'skills') return skills
      throw new Error(`unexpected table ${table}`)
    })

    const res = await renameSkill({ sectionId: SECTION, skillId: TOPIC, name: 'Tensors' })
    expect(res).toHaveProperty('error')
    expect(res).not.toHaveProperty('success')
  })
})


// includeLiveQuiz was silently stripped by configInputSchema before #330 — it now
// must survive validation and reach the merge RPC's p_config payload.
describe('updateSkillMasteryConfig', () => {
  it('passes includeLiveQuiz through to the merge RPC', async () => {
    const res = await updateSkillMasteryConfig({
      sectionId: SECTION,
      config: { baseAlpha: 0.5, includeLiveQuiz: true },
    })
    expect(res).toEqual({ success: true })
    expect(mockAdminDb.rpc).toHaveBeenCalledWith(
      'merge_section_skill_mastery_config',
      expect.objectContaining({
        p_section_id: SECTION,
        p_config: expect.objectContaining({ includeLiveQuiz: true }),
      }),
    )
  })
})
