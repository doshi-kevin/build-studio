// generateAssignmentRubric must draft from the studio notebook when the assignment has one
// (studio/STEM assignments have no PDF), and only fall back to the PDF path otherwise.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockAdminClient, buildFullChain } from './helpers/mock-supabase'

const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()
const mockGenerateRubricFromText = vi.fn()
let adminClient: ReturnType<typeof createMockAdminClient>

/* AI kill switch: these tests exercise the AI-ENABLED path — mock the guard
   open so their stubbed DB clients don't trip its fail-closed refusal. The
   disabled/locked paths are covered in ai-kill-switch.test.ts. */
vi.mock('@/lib/ai/kill-switch', () => ({
  checkAiFeature: vi.fn(async () => ({ allowed: true })),
  checkAiFeatureBySection: vi.fn(async () => ({ allowed: true })),
}))

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
// Stub the AI so no provider/network is touched; assert on the text it was handed.
vi.mock('@/lib/assignments/rubric-ai', () => ({
  generateRubricFromText: (...args: unknown[]) => mockGenerateRubricFromText(...args),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any

const studioSettings = {
  studio: {
    version: 1,
    templateId: 'stem-maths',
    notebook: {
      cells: [
        { id: 'c1', cell_type: 'markdown', source: '# Q1\nFind the derivative of x^2.', metadata: {}, outputs: [], execution_count: null },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    },
  },
}

beforeEach(() => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
  mockVerifySectionAccess.mockReset()
  mockGenerateRubricFromText.mockReset().mockResolvedValue({
    questions: [{ label: 'Q1', points: 10, criteria: [{ description: 'Correct derivative', points: 10 }] }],
  })
})

async function load(settings: unknown) {
  adminClient = createMockAdminClient({
    assignments: { data: { id: 'asg-1', section_id: 'sec-1', points: 100, settings }, error: null },
  })
  mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: adminClient })
  mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions')
}

describe('generateAssignmentRubric — source selection', () => {
  it('drafts from studio content when the assignment has a studio notebook', async () => {
    await load(studioSettings)
    const res = await mod.generateAssignmentRubric('sec-1', 'asg-1')

    expect(res.success).toBe(true)
    expect(mockGenerateRubricFromText).toHaveBeenCalledTimes(1)
    const [text, points] = mockGenerateRubricFromText.mock.calls[0]
    expect(text).toContain('## Q1')
    expect(text).toContain('Find the derivative of x^2.')
    expect(points).toBe(100)
  })

  it('errors (does not call AI) when there is neither studio content nor a PDF', async () => {
    await load({})
    const res = await mod.generateAssignmentRubric('sec-1', 'asg-1')

    expect(res).toEqual({ error: expect.stringContaining('attach a PDF') })
    expect(mockGenerateRubricFromText).not.toHaveBeenCalled()
  })

  it('errors when the studio notebook has no gradable content', async () => {
    await load({ studio: { version: 1, templateId: null, notebook: { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 } } })
    const res = await mod.generateAssignmentRubric('sec-1', 'asg-1')

    expect(res).toEqual({ error: expect.stringContaining('Add some content') })
    expect(mockGenerateRubricFromText).not.toHaveBeenCalled()
  })
})

// The professor's chosen max score (#543) steers the AI prompt; a valid in-range integer wins
// over the stored assignment.points, and anything out of the [1, 1000] sanity band falls back
// to assignment.points (100 in these fixtures). The 2nd positional arg to generateRubricFromText
// is that resolved target.
describe('generateAssignmentRubric — targetPoints clamp/fallback', () => {
  const targetArg = () => mockGenerateRubricFromText.mock.calls[0][1]

  it('uses a valid in-range targetPoints over the stored assignment points', async () => {
    await load(studioSettings)
    const res = await mod.generateAssignmentRubric('sec-1', 'asg-1', undefined, 250)

    expect(res.success).toBe(true)
    expect(targetArg()).toBe(250)
  })

  it('accepts the lower bound (1) and upper bound (1000)', async () => {
    await load(studioSettings)
    await mod.generateAssignmentRubric('sec-1', 'asg-1', undefined, 1)
    expect(targetArg()).toBe(1)

    mockGenerateRubricFromText.mockClear()
    await mod.generateAssignmentRubric('sec-1', 'asg-1', undefined, 1000)
    expect(targetArg()).toBe(1000)
  })

  it('falls back to assignment.points when targetPoints is omitted', async () => {
    await load(studioSettings)
    await mod.generateAssignmentRubric('sec-1', 'asg-1')
    expect(targetArg()).toBe(100)
  })

  it('falls back when targetPoints is below the minimum (0 or negative)', async () => {
    await load(studioSettings)
    await mod.generateAssignmentRubric('sec-1', 'asg-1', undefined, 0)
    expect(targetArg()).toBe(100)

    mockGenerateRubricFromText.mockClear()
    await mod.generateAssignmentRubric('sec-1', 'asg-1', undefined, -5)
    expect(targetArg()).toBe(100)
  })

  it('falls back when targetPoints exceeds the maximum (1001)', async () => {
    await load(studioSettings)
    await mod.generateAssignmentRubric('sec-1', 'asg-1', undefined, 1001)
    expect(targetArg()).toBe(100)
  })

  it('falls back when targetPoints is a non-integer', async () => {
    await load(studioSettings)
    await mod.generateAssignmentRubric('sec-1', 'asg-1', undefined, 12.5)
    expect(targetArg()).toBe(100)
  })
})

// The candidate pool comes from the tagged modules ONLY (no silent section-pool widening,
// #553-1). With zero candidates the model is never asked to tag, and the generated
// questions must carry NO skills key at all — `skills: []` would read as a final tier-1
// decision and freeze them out of similarity retagging forever (#553-5).
describe('generateAssignmentRubric — zero-candidate generation stays retaggable', () => {
  it('passes no candidate names and emits questions WITHOUT a skills key', async () => {
    await load(studioSettings) // no modules → no tagged modules → zero candidates
    // rubric-ai's plain (no-tagging) schema normalizes to skills: [] — the action must
    // strip that into an ABSENT key, not persist it.
    mockGenerateRubricFromText.mockResolvedValue({
      questions: [{ label: 'Q1', points: 10, criteria: [{ description: 'Correct derivative', points: 10 }], skills: [] }],
    })
    const res = await mod.generateAssignmentRubric('sec-1', 'asg-1')

    expect(res.success).toBe(true)
    expect(mockGenerateRubricFromText.mock.calls[0][3]).toEqual([]) // no candidate names offered
    expect('skills' in res.rubric.questions[0]).toBe(false)
  })

  it('with a scoped candidate pool, resolves model-emitted names to section skill tags', async () => {
    const tables: Record<string, { data: unknown; error: unknown }> = {
      assignments: {
        data: { id: 'asg-1', section_id: 'sec-1', points: 100, settings: { ...studioSettings, skillModules: ['mod-1'] } },
        error: null,
      },
      modules: { data: [{ id: 'mod-1', title: 'Module One', week_number: 1 }], error: null },
      module_items: {
        data: [{ content: { concepts: [{ name: 'Skill A', summary: 'What skill A covers.' }] } }],
        error: null,
      },
      skills: {
        data: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Skill A', excluded: false }],
        error: null,
      },
    }
    const adminDb = {
      from: vi.fn((table: string) => buildFullChain(tables[table] ?? { data: null, error: null })),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    }
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })
    mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions')
    mockGenerateRubricFromText.mockResolvedValue({
      questions: [{ label: 'Q1', points: 10, criteria: [{ description: 'x', points: 10 }], skills: ['Skill A'] }],
    })

    const res = await mod.generateAssignmentRubric('sec-1', 'asg-1')

    expect(res.success).toBe(true)
    expect(mockGenerateRubricFromText.mock.calls[0][3]).toEqual(['Skill A']) // scoped pool offered to the model
    expect(res.rubric.questions[0].skills).toEqual([
      { id: '11111111-1111-4111-8111-111111111111', name: 'Skill A' },
    ])
  })

  it('mints a genuinely-new model-emitted skill into the section pool and tags it (end to end)', async () => {
    const POOL = [{ id: '11111111-1111-4111-8111-111111111111', name: 'Skill A', parent_id: null, position: 0, excluded: false }]
    const inserted: Array<Record<string, unknown>> = []
    const tables: Record<string, { data: unknown; error: unknown }> = {
      assignments: {
        data: { id: 'asg-1', section_id: 'sec-1', points: 100, settings: { ...studioSettings, skillModules: ['mod-1'] } },
        error: null,
      },
      modules: { data: [{ id: 'mod-1', title: 'Module One', week_number: 1 }], error: null },
      module_items: {
        data: [{ content: { concepts: [{ name: 'Skill A', summary: 'x' }] } }],
        error: null,
      },
    }
    const adminDb = {
      from: vi.fn((table: string) => {
        // skills needs select (pool read) AND insert().select() (the mint) to differ.
        if (table === 'skills') {
          return {
            select: () => ({ eq: () => Promise.resolve({ data: POOL, error: null }) }),
            insert: (rows: Array<Record<string, unknown>>) => ({
              select: () => {
                inserted.push(...rows)
                return Promise.resolve({
                  data: rows.map((r, i) => ({ id: `new-${i}`, name: r.name as string })),
                  error: null,
                })
              },
            }),
          }
        }
        if (table === 'course_sections') {
          return {
            select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { institution_id: 'inst-1' }, error: null }) }) }),
          }
        }
        return buildFullChain(tables[table] ?? { data: null, error: null })
      }),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    }
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })
    mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions')
    mockGenerateRubricFromText.mockResolvedValue({
      questions: [{ label: 'Q1', points: 10, criteria: [{ description: 'x', points: 10 }], skills: ['Brand New Concept'] }],
    })

    const res = await mod.generateAssignmentRubric('sec-1', 'asg-1')

    expect(res.success).toBe(true)
    expect(inserted.map((r) => r.name)).toEqual(['Brand New Concept']) // minted, institution server-derived
    expect(inserted[0]).toMatchObject({ section_id: 'sec-1', institution_id: 'inst-1', source: 'ai' })
    expect(res.rubric.questions[0].skills).toEqual([{ id: 'new-0', name: 'Brand New Concept' }])
  })
})
