// saveAssignmentRubric — merged contract of the two lineages:
//
// Points: the assignment total is DERIVED from the rubric (criteria sum over graded
// questions; 100 fallback when it carries no points) and the write goes through the
// merge_assignment_settings RPC (atomic, key-scoped: p_patch carries ONLY { rubric },
// p_remove drops the promoted draft, p_cols carries the derived points). Preserving OTHER
// settings keys is the RPC's job at the SQL layer, not the client's.
//
// Skill tagging (two-tier): a question WITH a `skills` array keeps it verbatim (ids
// sanitized against the section pool, never added to; empty array = the professor/LLM
// said none). A question with NO `skills` key is hand-added and gets embedding-similarity
// tags from the tagged modules' pool — but ONLY a confident result is persisted: a
// below-bench / zero-candidate / embed-failure outcome leaves the key absent so the next
// save retries (#553-5; persisting [] would read as a tier-1 final decision forever).
//
// AI grading (ai-grading lineage): after the rubric write, reference vectors sync when the
// section has an institution_id (course_sections mock), then settings.aiGrading is stamped
// via a SECOND merge_assignment_settings call — so mergeArgs reads rpc.mock.calls[0].

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildFullChain } from './helpers/mock-supabase'

const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()
const mockEmbedTextsBatch = vi.fn()

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
// suggestSkillsBySimilarity dynamically imports the embed batch — intercept it so no
// test ever reaches the network.
vi.mock('@/lib/pinecone/embed', () => ({
  embedTextsBatch: (...args: unknown[]) => mockEmbedTextsBatch(...args),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any

/** Table-aware admin mock + rpc: saveAssignmentRubric reads assignments, modules,
 *  roadmap_edges (tag fallback), skills, module_items, course_sections, and writes
 *  through the merge_assignment_settings RPC. */
function buildAdminDb(tables: Record<string, { data: unknown; error: unknown }>) {
  const chains = new Map<string, ReturnType<typeof buildFullChain>>()
  const rpc = vi.fn().mockResolvedValue({ error: null })
  const adminDb = {
    from: vi.fn((table: string) => {
      if (!chains.has(table)) {
        chains.set(table, buildFullChain(tables[table] ?? { data: null, error: null }))
      }
      return chains.get(table)
    }),
    rpc,
  }
  return { adminDb, rpc, chain: (table: string) => chains.get(table) }
}

/** Pull the (fn, args) of the FIRST merge_assignment_settings rpc call (the rubric write;
 *  a second call may stamp aiGrading when the vector sync runs). */
function mergeArgs(rpc: ReturnType<typeof vi.fn>) {
  expect(rpc).toHaveBeenCalled()
  const [fn, args] = rpc.mock.calls[0]
  expect(fn).toBe('merge_assignment_settings')
  return args as {
    p_assignment_id: string
    p_section_id: string
    p_patch: Record<string, unknown>
    p_remove?: string[]
    p_cols?: { points?: number }
  }
}

const ASSIGNMENT = { id: 'asg-1', section_id: 'sec-1', points: 100, settings: {} }

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
  mockVerifySectionAccess.mockReset()
  mockEmbedTextsBatch.mockReset()
  mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions')
})

describe('saveAssignmentRubric — derives the assignment total', () => {
  it('accepts a rubric that exceeds the old total and writes points = the criteria sum (no cap)', async () => {
    const { adminDb, rpc } = buildAdminDb({
      assignments: { data: ASSIGNMENT, error: null },
      modules: { data: [], error: null },
      skills: { data: [], error: null },
      course_sections: { data: null, error: null },
    })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })

    const res = await mod.saveAssignmentRubric('sec-1', 'asg-1', {
      questions: [
        { label: 'Q1', points: 80, criteria: [{ description: 'a', points: 80 }], skills: [] },
        { label: 'Q2', points: 40, criteria: [{ description: 'b', points: 40 }], skills: [] }, // sums to 120
      ],
    })
    expect(res).toMatchObject({ success: true, points: 120 })
    expect(mergeArgs(rpc).p_cols?.points).toBe(120)
  })

  it('falls back to 100 points when the rubric has no criteria points', async () => {
    const { adminDb, rpc } = buildAdminDb({
      assignments: { data: ASSIGNMENT, error: null },
      modules: { data: [], error: null },
      skills: { data: [], error: null },
      course_sections: { data: null, error: null },
    })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })

    const res = await mod.saveAssignmentRubric('sec-1', 'asg-1', {
      questions: [{ label: 'Q1', points: 50, criteria: [], skills: [] }],
    })
    expect(res).toMatchObject({ success: true })
    expect(mergeArgs(rpc).p_cols?.points).toBe(100)
  })

  it("still rejects a question whose criteria exceed that question's own points", async () => {
    const { adminDb, rpc } = buildAdminDb({
      assignments: { data: ASSIGNMENT, error: null },
      modules: { data: [], error: null },
    })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })

    const res = await mod.saveAssignmentRubric('sec-1', 'asg-1', {
      questions: [{ label: 'Q1', points: 10, criteria: [{ description: 'a', points: 14 }], skills: [] }],
    })
    expect(res).toEqual({ error: expect.stringContaining("over this question's 10") })
    expect(rpc).not.toHaveBeenCalled() // rejected before the merge
  })
})

describe('saveAssignmentRubric — promotion clears the autosaved draft', () => {
  it('patches ONLY settings.rubric and removes settings.rubricDraft (other keys preserved by the RPC merge)', async () => {
    const { adminDb, rpc } = buildAdminDb({
      assignments: { data: ASSIGNMENT, error: null },
      modules: { data: [], error: null }, // no modules → tag requirement waived
      skills: { data: [], error: null },
      course_sections: { data: null, error: null }, // no institution → vector sync skipped
    })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })

    const res = await mod.saveAssignmentRubric('sec-1', 'asg-1', {
      questions: [{ label: 'Q1', points: 50, criteria: [], skills: [] }],
    })

    expect(res).toMatchObject({ success: true })
    const args = mergeArgs(rpc)
    expect(args.p_patch.rubric).toBeTruthy() // approved rubric patched in
    expect('rubricDraft' in args.p_patch).toBe(false) // draft is removed, not patched
    expect(args.p_remove).toContain('rubricDraft') // stale draft dropped via the merge's key removal
  })
})

describe('saveAssignmentRubric — compulsory module tagging', () => {
  it('rejects the save when the section has modules and none is tagged (no write)', async () => {
    const { adminDb, rpc } = buildAdminDb({
      assignments: { data: ASSIGNMENT, error: null }, // settings has no skillModules
      modules: { data: [{ id: 'mod-1', title: 'M1', week_number: 1 }], error: null },
      roadmap_edges: { data: null, error: null }, // no placement to fall back to
    })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })

    const res = await mod.saveAssignmentRubric('sec-1', 'asg-1', {
      questions: [{ label: 'Q1', points: 10, criteria: [], skills: [] }],
    })
    expect(res).toEqual({ error: expect.stringContaining('Tag at least one module') })
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('saveAssignmentRubric — two-tier skill tagging', () => {
  it('honors the skills array verbatim (sanitized), and similarity-tags only questions with no skills key', async () => {
    const { adminDb, rpc } = buildAdminDb({
      assignments: {
        data: { ...ASSIGNMENT, settings: { skillModules: ['mod-1'] } },
        error: null,
      },
      modules: { data: [{ id: 'mod-1', title: 'Module One', week_number: 1 }], error: null },
      skills: {
        data: [
          { id: '11111111-1111-4111-8111-111111111111', name: 'Skill A', excluded: false },
          { id: '22222222-2222-4222-8222-222222222222', name: 'Skill B', excluded: false },
        ],
        error: null,
      },
      // Module provenance: concept "Skill A" (with summary) matches the pool.
      module_items: {
        data: [{ content: { concepts: [{ name: 'Skill A', summary: 'What skill A covers.' }] } }],
        error: null,
      },
      course_sections: { data: null, error: null },
    })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })
    // One question text + one candidate ("Skill A. What skill A covers."): identical
    // unit vectors → cosine 1 → above the bench → tagged.
    mockEmbedTextsBatch.mockResolvedValue({
      vectors: [
        [1, 0],
        [1, 0],
      ],
      tokens: 2,
      estimated: true,
    })

    const res = await mod.saveAssignmentRubric('sec-1', 'asg-1', {
      questions: [
        // Tier 1: array present — keeps only the pool-valid id, gains nothing.
        { label: 'Q1', points: 10, criteria: [], skills: [{ id: '11111111-1111-4111-8111-111111111111', name: 'spoofed name' }, { id: '99999999-9999-4999-8999-999999999999', name: 'Evil' }] },
        // Tier 1: explicitly emptied — stays empty (professor removal respected).
        { label: 'Q2', points: 10, criteria: [], skills: [] },
        // Tier 2: no skills key — hand-added, similarity-tagged.
        { label: 'Q3', points: 10, criteria: [{ description: 'about skill A', points: 5 }] },
      ],
    })

    expect(res).toMatchObject({ success: true })
    // Candidate embeds as "name. context" — the enrichment that kills pun matches.
    expect(mockEmbedTextsBatch).toHaveBeenCalledTimes(1)
    expect(mockEmbedTextsBatch.mock.calls[0][0][1]).toBe('Skill A. What skill A covers.')

    const written = (mergeArgs(rpc).p_patch as {
      rubric: { questions: Array<{ skills: Array<{ id: string; name: string }> }> }
    }).rubric.questions
    expect(written[0].skills).toEqual([{ id: '11111111-1111-4111-8111-111111111111', name: 'Skill A' }]) // forged id dropped, server name wins
    expect(written[1].skills).toEqual([]) // emptied stays empty
    expect(written[2].skills).toEqual([{ id: '11111111-1111-4111-8111-111111111111', name: 'Skill A' }]) // hand-added gets the similarity tag
  })
})

describe('saveAssignmentRubric — a "no match" similarity result is never frozen (#553-5)', () => {
  const TAGGED_SETTINGS = { ...ASSIGNMENT, settings: { skillModules: ['mod-1'] } }
  const POOL = {
    data: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Skill A', excluded: false }],
    error: null,
  }
  const MODULES = { data: [{ id: 'mod-1', title: 'Module One', week_number: 1 }], error: null }

  it('below-bench similarity leaves the skills key ABSENT so the next save retries', async () => {
    const { adminDb, rpc } = buildAdminDb({
      assignments: { data: TAGGED_SETTINGS, error: null },
      modules: MODULES,
      skills: POOL,
      module_items: {
        data: [{ content: { concepts: [{ name: 'Skill A', summary: 'x' }] } }],
        error: null,
      },
    })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })
    // Orthogonal vectors → cosine 0 → below the 0.64 bench → empty result.
    mockEmbedTextsBatch.mockResolvedValue({ vectors: [[1, 0], [0, 1]], tokens: 2, estimated: true })

    const res = await mod.saveAssignmentRubric('sec-1', 'asg-1', {
      questions: [{ label: 'Q1', points: 10, criteria: [{ description: 'unrelated topic', points: 5 }] }],
    })
    expect(res).toMatchObject({ success: true })
    const written = (mergeArgs(rpc).p_patch as { rubric: { questions: Array<Record<string, unknown>> } }).rubric.questions
    // The freeze bug: this used to persist skills: [], which tier 1 read as a final
    // decision, permanently blocking retagging. The key must simply not exist.
    expect('skills' in written[0]).toBe(false)
  })

  it('zero candidates (tagged modules match no skills) skips the embed entirely and leaves the key absent', async () => {
    const { adminDb, rpc } = buildAdminDb({
      assignments: { data: TAGGED_SETTINGS, error: null },
      modules: MODULES,
      skills: POOL,
      module_items: { data: [], error: null }, // no provenance → scoped pool is EMPTY (no silent widen, #553-1)
    })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })

    const res = await mod.saveAssignmentRubric('sec-1', 'asg-1', {
      questions: [{ label: 'Q1', points: 10, criteria: [{ description: 'about skill A', points: 5 }] }],
    })
    expect(res).toMatchObject({ success: true })
    expect(mockEmbedTextsBatch).not.toHaveBeenCalled() // empty candidates never reach the network
    const written = (mergeArgs(rpc).p_patch as { rubric: { questions: Array<Record<string, unknown>> } }).rubric.questions
    expect('skills' in written[0]).toBe(false)
  })
})

describe('saveAssignmentRubric — untagging sticks (#553-2)', () => {
  it('rejects the save when skillModules is an explicit [] even though a roadmap edge exists', async () => {
    const { adminDb, rpc } = buildAdminDb({
      assignments: { data: { ...ASSIGNMENT, settings: { skillModules: [] } }, error: null },
      modules: { data: [{ id: 'mod-1', title: 'M1', week_number: 1 }], error: null },
      roadmap_edges: { data: { from_node_id: 'mod-1' }, error: null }, // must NOT resurrect the tag
    })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })

    const res = await mod.saveAssignmentRubric('sec-1', 'asg-1', {
      questions: [{ label: 'Q1', points: 10, criteria: [], skills: [] }],
    })
    expect(res).toEqual({ error: expect.stringContaining('Tag at least one module') })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('still back-fills from the edge for a legacy assignment with NO skillModules key', async () => {
    const { adminDb, rpc } = buildAdminDb({
      assignments: { data: ASSIGNMENT, error: null }, // settings: {} — key absent
      modules: { data: [{ id: 'mod-1', title: 'M1', week_number: 1 }], error: null },
      roadmap_edges: { data: { from_node_id: 'mod-1' }, error: null },
      skills: { data: [], error: null },
    })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })

    const res = await mod.saveAssignmentRubric('sec-1', 'asg-1', {
      questions: [{ label: 'Q1', points: 10, criteria: [], skills: [] }],
    })
    expect(res).toMatchObject({ success: true })
    expect(rpc).toHaveBeenCalled()
  })
})

describe('saveAssignmentRubric — gate queries fail closed', () => {
  it('returns an error (no write) when the legacy edge lookup fails, instead of waiving the gate', async () => {
    const { adminDb, rpc } = buildAdminDb({
      assignments: { data: ASSIGNMENT, error: null }, // key absent → the edge lookup runs
      modules: { data: [{ id: 'mod-1', title: 'M1', week_number: 1 }], error: null },
      roadmap_edges: { data: null, error: { message: 'transient' } },
    })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })

    const res = await mod.saveAssignmentRubric('sec-1', 'asg-1', {
      questions: [{ label: 'Q1', points: 10, criteria: [], skills: [] }],
    })
    expect(res).toEqual({ error: expect.stringContaining('Could not load the course modules') })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns an error (no write) when the modules query fails, instead of waiving the gate', async () => {
    const { adminDb, rpc } = buildAdminDb({
      assignments: { data: ASSIGNMENT, error: null },
      modules: { data: null, error: { message: 'transient' } },
    })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })

    const res = await mod.saveAssignmentRubric('sec-1', 'asg-1', {
      questions: [{ label: 'Q1', points: 10, criteria: [], skills: [] }],
    })
    expect(res).toEqual({ error: expect.stringContaining('Could not load the course modules') })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns an error (no write) when the section skills query fails, instead of silently stripping tier-1 tags', async () => {
    const { adminDb, rpc } = buildAdminDb({
      assignments: { data: ASSIGNMENT, error: null },
      modules: { data: [], error: null }, // no modules → gate waived; failure is downstream
      skills: { data: null, error: { message: 'transient' } },
    })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })

    const res = await mod.saveAssignmentRubric('sec-1', 'asg-1', {
      questions: [{ label: 'Q1', points: 10, criteria: [], skills: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Skill A' }] }],
    })
    expect(res).toEqual({ error: expect.stringContaining('Could not save the rubric') })
    expect(rpc).not.toHaveBeenCalled()
  })

  /* A rubric totalling over the assignment ceiling is a VALIDATION problem, but the total is
     only rejected downstream when it reaches assignments.points — so the professor was told
     "Could not save the rubric. Please try again.", a transient-sounding message for
     something retrying can never fix, with nothing naming the offending field.

     The oracle is the message, not the refusal: the old behaviour also refused. */
  it('names the over-budget rubric instead of returning a generic retry message', async () => {
    const { adminDb, rpc } = buildAdminDb({
      assignments: { data: ASSIGNMENT, error: null },
      modules: { data: [], error: null },
      skills: { data: [], error: null },
    })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })

    const res = await mod.saveAssignmentRubric('sec-1', 'asg-1', {
      questions: [
        { label: 'Q1', points: 1500, criteria: [{ description: 'All of it', points: 1500 }], skills: [] },
      ],
    })

    expect(res.error).toMatch(/1500 points/)
    expect(res.error).toMatch(/1000/)
    // and it must NOT read as a transient failure
    expect(res.error).not.toMatch(/try again/i)
    expect(rpc).not.toHaveBeenCalled()
  })
})
