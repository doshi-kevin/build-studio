// Roadmap placement pins a quiz/assignment/live-session under a module. The ids
// come from the client, so the action is IDOR-shaped: it must (a) allow only the
// section professor to place resources, and (b) verify BOTH the module and the
// resource actually belong to this section before writing an edge. The write
// itself (writePlacementEdge) is idempotent — the place_roadmap_edge RPC does an
// atomic INSERT ... ON CONFLICT DO UPDATE, so re-picking just moves it.
//
// writePlacementEdge is exercised through the real module (not mocked) so the
// atomic-upsert replace contract is covered here too.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: (...args: unknown[]) => mockVerifySectionAccess(...args),
  canWriteAsProfessor: (role: string) => role === 'professor',
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// Records roadmap_edges deletes/inserts; returns configurable module/resource
// existence so the cross-section checks can be driven. `module: null` /
// `resource: null` simulate an id that is NOT in this section.
function placementAdmin(opts: { module?: unknown; resource?: unknown } = {}) {
  // writePlacementEdge now does the idempotent replace atomically via the
  // place_roadmap_edge RPC (INSERT ... ON CONFLICT DO UPDATE), so we record the
  // rpc call rather than delete/insert on roadmap_edges.
  const edge = { rpcCalls: [] as Array<{ name: string; params: Record<string, unknown> }> }
  function lookup(data: unknown) {
    return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error: null }) }) }) }) }
  }
  return {
    from: (table: string) => {
      if (table === 'modules') return lookup('module' in opts ? opts.module : { id: 'mod-1' })
      // quizzes / assignments / lc_rooms
      return lookup('resource' in opts ? opts.resource : { id: 'q-1' })
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      edge.rpcCalls.push({ name, params })
      return { error: null }
    },
    _edge: edge,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockVerifySectionAccess.mockReset()
  mod = await import('@/lib/roadmap/placement-actions')
})

describe('setResourcePlacement — authorization', () => {
  it('rejects an unauthenticated caller', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    const res = await mod.setResourcePlacement('sec-1', 'quiz', 'q-1', 'mod-1')
    expect(res).toEqual({ error: 'Not authenticated' })
  })

  it('rejects a TA (has section access but not professor-level write) and writes no edge', async () => {
    const admin = placementAdmin()
    mockGetUser.mockResolvedValue({ data: { user: { id: 'ta-1' } }, error: null })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'ta', adminDb: admin })
    const res = await mod.setResourcePlacement('sec-1', 'quiz', 'q-1', 'mod-1')
    expect(res).toEqual({ error: 'Only the professor can place resources on the roadmap' })
    expect(admin._edge.rpcCalls).toHaveLength(0)
  })

  it('rejects a caller with no access to the section', async () => {
    const admin = placementAdmin()
    mockGetUser.mockResolvedValue({ data: { user: { id: 'x' } }, error: null })
    mockVerifySectionAccess.mockResolvedValue({ ok: false, adminDb: admin })
    const res = await mod.setResourcePlacement('sec-1', 'quiz', 'q-1', 'mod-1')
    expect(res).toEqual({ error: 'Only the professor can place resources on the roadmap' })
    expect(admin._edge.rpcCalls).toHaveLength(0)
  })
})

describe('setResourcePlacement — cross-section endpoint verification (IDOR)', () => {
  it('rejects a module id that does not belong to this section, writing no edge', async () => {
    const admin = placementAdmin({ module: null }) // module lookup finds nothing in sec-1
    mockGetUser.mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: admin })
    const res = await mod.setResourcePlacement('sec-1', 'quiz', 'q-1', 'mod-other')
    expect(res).toEqual({ error: 'Module not found in this section' })
    expect(admin._edge.rpcCalls).toHaveLength(0)
  })

  it('rejects a resource id that does not belong to this section, writing no edge', async () => {
    const admin = placementAdmin({ resource: null }) // resource not in sec-1
    mockGetUser.mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: admin })
    const res = await mod.setResourcePlacement('sec-1', 'quiz', 'q-other', 'mod-1')
    expect(res).toEqual({ error: 'Resource not found in this section' })
    expect(admin._edge.rpcCalls).toHaveLength(0)
  })
})

describe('setResourcePlacement — happy path + idempotent replace', () => {
  it('replaces any prior placement (atomic upsert) with the module→resource edge', async () => {
    const admin = placementAdmin()
    mockGetUser.mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: admin })
    const res = await mod.setResourcePlacement('sec-1', 'quiz', 'q-1', 'mod-1')
    expect(res).toEqual({ success: true })
    // One atomic placement call — the RPC does the idempotent replace in-DB.
    expect(admin._edge.rpcCalls).toHaveLength(1)
    expect(admin._edge.rpcCalls[0]).toEqual({
      name: 'place_roadmap_edge',
      params: {
        p_section_id: 'sec-1',
        p_module_id: 'mod-1',
        p_kind: 'quiz',
        p_resource_id: 'q-1',
        p_position: null,
      },
    })
  })

  it('passes a finite drag position through to the edge, coercing non-finite to null', async () => {
    const admin = placementAdmin()
    mockGetUser.mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: admin })
    await mod.setResourcePlacement('sec-1', 'assignment', 'a-1', 'mod-1', 3.5)
    expect(admin._edge.rpcCalls[0].params).toMatchObject({ p_kind: 'assignment', p_resource_id: 'a-1', p_position: 3.5 })
  })
})
