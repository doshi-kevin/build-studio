// Tests for verifySectionAccess — the centralized helper that decides
// whether a caller can access a section as the professor, an active TA,
// or an active grader. Read/write gating elsewhere relies on the role
// returned here, so regressions in this helper would silently open or
// close access across the app.

import { describe, it, expect, vi, beforeEach } from 'vitest'

function buildChain(finalResult: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.gt = vi.fn().mockReturnValue(chain)
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult)
  chain.then = undefined
  return chain
}

const mockAdminClient = vi.fn()

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let verifySectionAccess: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let canWriteAsProfessor: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let canWriteAsStaff: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let canGrade: any

beforeEach(async () => {
  vi.resetModules()
  mockAdminClient.mockReset()
  const mod = await import('@/lib/auth/section-access')
  verifySectionAccess = mod.verifySectionAccess
  canWriteAsProfessor = mod.canWriteAsProfessor
  canWriteAsStaff = mod.canWriteAsStaff
  canGrade = mod.canGrade
})

/** Configure the admin mock to respond to `from('course_sections')` with
 * one payload and `from('section_staff')` with another. */
function mockDualFrom(
  sectionRow: { id: string; professor_id: string } | null,
  staffRow: { role: 'ta' | 'grader' } | null,
) {
  mockAdminClient.mockReturnValue({
    from: vi.fn((table: string) => {
      if (table === 'course_sections') {
        return buildChain({ data: sectionRow, error: null })
      }
      if (table === 'section_staff') {
        return buildChain({ data: staffRow, error: null })
      }
      return buildChain({ data: null, error: null })
    }),
  })
}

describe('verifySectionAccess', () => {
  it('returns { ok: false } when the section does not exist', async () => {
    mockDualFrom(null, null)
    const result = await verifySectionAccess('missing-section', 'any-user')
    expect(result.ok).toBe(false)
  })

  it('returns role=professor when caller owns the section', async () => {
    mockDualFrom({ id: 's1', professor_id: 'prof-1' }, null)
    const result = await verifySectionAccess('s1', 'prof-1')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.role).toBe('professor')
  })

  it('returns role=ta when caller has an active TA assignment', async () => {
    mockDualFrom({ id: 's1', professor_id: 'other-prof' }, { role: 'ta' })
    const result = await verifySectionAccess('s1', 'ta-1')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.role).toBe('ta')
  })

  it('returns role=grader when caller has an active grader assignment', async () => {
    mockDualFrom({ id: 's1', professor_id: 'other-prof' }, { role: 'grader' })
    const result = await verifySectionAccess('s1', 'g-1')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.role).toBe('grader')
  })

  it('returns { ok: false } when caller is not professor and not active staff', async () => {
    mockDualFrom({ id: 's1', professor_id: 'other-prof' }, null)
    const result = await verifySectionAccess('s1', 'stranger')
    expect(result.ok).toBe(false)
  })

  it('professor check short-circuits before the staff query', async () => {
    // If both fire, the professor branch still wins because professor_id
    // matches userId — staff data is irrelevant in that case.
    mockDualFrom({ id: 's1', professor_id: 'prof-1' }, { role: 'grader' })
    const result = await verifySectionAccess('s1', 'prof-1')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.role).toBe('professor')
  })
})

describe('canWriteAsProfessor', () => {
  it('only professor role qualifies', () => {
    expect(canWriteAsProfessor('professor')).toBe(true)
    expect(canWriteAsProfessor('ta')).toBe(false)
    expect(canWriteAsProfessor('grader')).toBe(false)
  })
})

describe('canWriteAsStaff', () => {
  it('professor + ta qualify, grader does not — authoring is not grading (#746)', () => {
    expect(canWriteAsStaff('professor')).toBe(true)
    expect(canWriteAsStaff('ta')).toBe(true)
    /* Still false, and now deliberately so rather than by omission: graders got
       score writes via canGrade, NOT announcements or content authoring. */
    expect(canWriteAsStaff('grader')).toBe(false)
  })
})

describe('canGrade', () => {
  it('admits graders — a role named grader must be able to grade (#746)', () => {
    expect(canGrade('professor')).toBe(true)
    expect(canGrade('ta')).toBe(true)
    expect(canGrade('grader')).toBe(true)
  })

  it('is strictly wider than canWriteAsStaff, and only for graders', () => {
    /* The three predicates form a deliberate hierarchy. If a future edit makes
       canWriteAsStaff admit graders, the distinction this issue created collapses
       and a grader silently gains announcement + content writes. */
    for (const role of ['professor', 'ta', 'grader'] as const) {
      if (canWriteAsStaff(role)) expect(canGrade(role)).toBe(true)
    }
    expect(canWriteAsStaff('grader')).toBe(false)
    expect(canGrade('grader')).toBe(true)
    expect(canWriteAsProfessor('grader')).toBe(false)
  })
})
