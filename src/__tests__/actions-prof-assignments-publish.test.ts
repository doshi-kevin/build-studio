// Tests for publishStudioAssignment's publish-vs-update notification branch:
//  - re-saving an ALREADY-published assignment → assignment_updated (a change notice)
//  - a first publish (was draft) → assignment_published (re-announce)
//  - a SCHEDULED publish (future scheduleAt) → no inline notify (the sweep owns it)
// This is the risky runtime branch introduced with the Pulse update-notice fix; it must
// not silently regress a live-assignment edit back into a "New assignment" announcement.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()
const mockEmitEvent = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: (...a: unknown[]) => mockVerifySectionAccess(...a),
  canWriteAsStaff: () => true,
  canWriteAsProfessor: () => true,
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/events/emit', () => ({
  emitEvent: (...a: unknown[]) => mockEmitEvent(...a),
  markFeedItemDone: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

/* eslint-disable @typescript-eslint/no-explicit-any */
let publishStudioAssignment: any
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
  mockVerifySectionAccess.mockReset()
  mockEmitEvent.mockReset()
  const mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions')
  publishStudioAssignment = mod.publishStudioAssignment
})

// Thenable chain: supports .maybeSingle() for the assignments read. The settings write now
// goes through the merge_assignment_settings RPC (see adminDb.rpc below), not update().eq().
function thenableChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'order', 'limit', 'gt', 'insert', 'update', 'delete']) {
    chain[m] = vi.fn(() => chain)
  }
  chain.single = vi.fn().mockResolvedValue(result)
  chain.maybeSingle = vi.fn().mockResolvedValue(result)
  chain.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onF, onR)
  return chain
}

// verifySectionAccess grants a professor + an adminDb whose assignments row reports
// `priorStatus` (the value that drives the update-vs-announce branch). rpc resolves the
// merge_assignment_settings write cleanly so the action proceeds to the notification branch.
// `opts` shapes the module-tag publish gate: `modules` is the section's module list and
// `settings` the assignment settings (skillModules / kind). Defaults keep the gate waived.
function accessWithAssignment(
  priorStatus: string,
  opts: {
    modules?: Array<{ id: string }> | null
    settings?: Record<string, unknown>
    edge?: unknown
    /** When true, the place_roadmap_edge RPC fails while the merge write succeeds. */
    placeEdgeFails?: boolean
  } = {},
) {
  const rpc = vi.fn((...call: [fn: string, args?: Record<string, unknown>]) =>
    Promise.resolve(
      opts.placeEdgeFails && call[0] === 'place_roadmap_edge' ? { error: { message: 'edge write failed' } } : { error: null },
    ),
  )
  const modules = opts.modules === undefined ? [] : opts.modules
  const settings = opts.settings ?? {}
  mockVerifySectionAccess.mockResolvedValue({
    ok: true,
    role: 'professor',
    adminDb: {
      // Table-aware: resolveTaggedModules (module-tag publish gate) reads `modules` (array)
      // and, when nothing is tagged, `roadmap_edges` (row-or-null); everything else gets the
      // assignment row. Zero modules → the gate is waived and publish proceeds.
      from: vi.fn((table: string) => {
        if (table === 'modules') return thenableChain({ data: modules, error: null })
        if (table === 'roadmap_edges') return thenableChain({ data: opts.edge ?? null, error: null })
        return thenableChain({
          data: { id: 'a-1', section_id: 'section-1', settings, title: 'HW1', status: priorStatus },
          error: null,
        })
      }),
      rpc,
    },
  })
  return rpc
}

describe('publishStudioAssignment — publish vs update notification', () => {
  it('emits assignment_updated when re-saving an already-published assignment', async () => {
    accessWithAssignment('published')
    const result = await publishStudioAssignment('section-1', 'a-1', {}, true)
    expect(result.success).toBe(true)
    expect(mockEmitEvent).toHaveBeenCalledTimes(1)
    expect(mockEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'assignment_updated',
        actionable: false,
        onDuplicate: 'refresh',
        entity: { type: 'assignment', id: 'a-1' },
      }),
    )
  })

  it('emits assignment_published on first publish (was draft)', async () => {
    accessWithAssignment('draft')
    const result = await publishStudioAssignment('section-1', 'a-1', {}, true)
    expect(result.success).toBe(true)
    expect(mockEmitEvent).toHaveBeenCalledTimes(1)
    expect(mockEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'assignment_published',
        actionable: true,
        entity: { type: 'assignment', id: 'a-1' },
      }),
    )
  })

  it('never writes points on publish, even if a client sends one (rubric owns the total)', async () => {
    // The points loophole, publish half: publishSettingsSchema drops `points`, so a crafted
    // client value must not reach the merge RPC's scalar columns.
    const rpc = accessWithAssignment('draft')
    const result = await publishStudioAssignment('section-1', 'a-1', { points: 999 }, true)
    expect(result.success).toBe(true)
    expect(rpc).toHaveBeenCalledTimes(1)
    const [fn, args] = rpc.mock.calls[0]
    expect(fn).toBe('merge_assignment_settings')
    expect('points' in (args as { p_cols: Record<string, unknown> }).p_cols).toBe(false)
  })

  it('does not notify inline on a scheduled publish (the sweep owns it)', async () => {
    accessWithAssignment('draft')
    const result = await publishStudioAssignment('section-1', 'a-1', { scheduleAt: '2099-01-01T00:00:00Z' }, true)
    expect(result.success).toBe(true)
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })
})

describe('publishStudioAssignment — compulsory module tagging', () => {
  it('rejects publish when the section HAS modules and none is tagged (no roadmap fallback)', async () => {
    const rpc = accessWithAssignment('draft', {
      modules: [{ id: 'mod-1' }],
      settings: {}, // no skillModules
      edge: null, // no roadmap placement to fall back to
    })
    const result = await publishStudioAssignment('section-1', 'a-1', {}, true)
    expect(result).toEqual({ error: expect.stringContaining('Tag at least one module') })
    expect(rpc).not.toHaveBeenCalled() // rejected before the merge write
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })

  it('allows publish when a module IS tagged, and places under it server-side (#553-3)', async () => {
    const rpc = accessWithAssignment('draft', {
      modules: [{ id: 'mod-1' }],
      settings: { skillModules: ['mod-1'] },
    })
    const result = await publishStudioAssignment('section-1', 'a-1', {}, true)
    expect(result.success).toBe(true)
    // Two RPCs, in order: the publish merge, then the roadmap placement — written by the
    // SERVER from the freshly-resolved first tagged module, not a client mount snapshot.
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc.mock.calls[0][0]).toBe('merge_assignment_settings')
    const [placeFn, placeArgs] = rpc.mock.calls[1]
    expect(placeFn).toBe('place_roadmap_edge')
    expect(placeArgs).toMatchObject({
      p_section_id: 'section-1',
      p_module_id: 'mod-1',
      p_kind: 'assignment',
      p_resource_id: 'a-1',
    })
  })

  it('waives the gate for verbal assessments (no rubrics step) even with untagged modules', async () => {
    const rpc = accessWithAssignment('draft', {
      modules: [{ id: 'mod-1' }],
      settings: { kind: 'verbal' }, // no skillModules, but verbal is exempt
    })
    const result = await publishStudioAssignment('section-1', 'a-1', {}, true)
    expect(result.success).toBe(true)
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('an explicit skillModules: [] blocks publish even when a roadmap edge exists (#553-2)', async () => {
    // The untag write is real; the read must not resurrect it from roadmap_edges. Before
    // the fix this back-filled from the edge, so the rubrics step said "untagged, locked"
    // while Publish said "tagged, ready".
    const rpc = accessWithAssignment('published', {
      modules: [{ id: 'mod-1' }],
      settings: { skillModules: [] },
      edge: { from_node_id: 'mod-1' },
    })
    const result = await publishStudioAssignment('section-1', 'a-1', {}, true)
    expect(result).toEqual({ error: expect.stringContaining('Tag at least one module') })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('legacy assignments (no skillModules key) still back-fill from their roadmap edge', async () => {
    const rpc = accessWithAssignment('published', {
      modules: [{ id: 'mod-1' }],
      settings: {}, // key absent = never went through tagging
      edge: { from_node_id: 'mod-1' },
    })
    const result = await publishStudioAssignment('section-1', 'a-1', {}, true)
    expect(result.success).toBe(true)
    expect(rpc.mock.calls.map((c) => c[0])).toContain('place_roadmap_edge')
  })
})

describe('publishStudioAssignment — server-side roadmap placement (#553-3)', () => {
  it('reports placed: false and stays published when the edge write fails (never unpublishes)', async () => {
    const rpc = accessWithAssignment('draft', {
      modules: [{ id: 'mod-1' }],
      settings: { skillModules: ['mod-1'] },
      placeEdgeFails: true,
    })
    const result = await publishStudioAssignment('section-1', 'a-1', {}, true)
    expect(result).toMatchObject({ success: true, placed: false })
    // The publish merge landed and was NOT reverted; students were still notified.
    expect(rpc.mock.calls[0][0]).toBe('merge_assignment_settings')
    expect(rpc.mock.calls.filter((c) => c[0] === 'merge_assignment_settings')).toHaveLength(1)
    expect(mockEmitEvent).toHaveBeenCalledTimes(1)
  })

  it('places on a SCHEDULED publish too (draft-time edges are the norm; the sweep only flips status)', async () => {
    const rpc = accessWithAssignment('draft', {
      modules: [{ id: 'mod-1' }],
      settings: { skillModules: ['mod-1'] },
    })
    const result = await publishStudioAssignment(
      'section-1',
      'a-1',
      { scheduleAt: '2099-01-01T00:00:00Z' },
      true,
    )
    expect(result).toMatchObject({ success: true, placed: true })
    expect(rpc.mock.calls.map((c) => c[0])).toContain('place_roadmap_edge')
    expect(mockEmitEvent).not.toHaveBeenCalled() // scheduled: the sweep owns the notify
  })

  it('verbal picker mode places under the validated pickerModuleId', async () => {
    const rpc = accessWithAssignment('draft', {
      modules: [{ id: 'mod-7' }], // the picker check's maybeSingle resolves truthy
      settings: { kind: 'verbal' },
    })
    const result = await publishStudioAssignment(
      'section-1',
      'a-1',
      { pickerModuleId: '77777777-7777-4777-8777-777777777777' },
      true,
    )
    expect(result).toMatchObject({ success: true, placed: true })
    const place = rpc.mock.calls.find((c) => c[0] === 'place_roadmap_edge')
    expect(place?.[1]).toMatchObject({ p_module_id: '77777777-7777-4777-8777-777777777777' })
  })

  it('rejects a pickerModuleId that is not a module of this section (IDOR guard)', async () => {
    const rpc = accessWithAssignment('draft', {
      modules: null, // the membership maybeSingle finds no row
      settings: { kind: 'verbal' },
    })
    const result = await publishStudioAssignment(
      'section-1',
      'a-1',
      { pickerModuleId: '77777777-7777-4777-8777-777777777777' },
      true,
    )
    expect(result).toEqual({ error: expect.stringContaining('not in this course') })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('verbal without a pickerModuleId publishes unplaced (no placement RPC)', async () => {
    const rpc = accessWithAssignment('draft', { settings: { kind: 'verbal' } })
    const result = await publishStudioAssignment('section-1', 'a-1', {}, true)
    expect(result).toMatchObject({ success: true, placed: true }) // nothing to place = not a failure
    expect(rpc.mock.calls.map((c) => c[0])).not.toContain('place_roadmap_edge')
  })
})

/**
 * Assignment lifecycle: 'draft' and 'closed' were supported by the action but unreachable
 * from the product, so these transitions had never actually run. Two things bite the moment
 * they do.
 */
describe('setAssignmentStatus — lifecycle transitions', () => {
  /** adminDb that reports `submissionCount` non-draft submissions and records update patches. */
  /* Two DIFFERENT submission counts are now queried: non-draft (already submitted) and drafts
     with assessment_started_at set (an assessment in progress). A single aggregate count cannot
     tell them apart, which is exactly why the original version of this double could not catch
     the live-assessment hole. Route on the filters the action actually applies. */
  function statusDb(submissionCount: number, published_at: string | null, liveAssessments = 0) {
    const updates: Record<string, unknown>[] = []
    const adminDb = {
      from: vi.fn((table: string) => {
        if (table === 'assignment_submissions') {
          const chain = thenableChain({ data: null, error: null }) as Record<string, unknown>
          let isDraftQuery = false
          let wantsStartedAt = false
          chain.select = vi.fn(() => chain)
          chain.eq = vi.fn((col: string, val: unknown) => {
            if (col === 'status' && val === 'draft') isDraftQuery = true
            return chain
          })
          chain.neq = vi.fn(() => chain)
          chain.not = vi.fn((col: string) => {
            if (col === 'assessment_started_at') wantsStartedAt = true
            return chain
          })
          chain.then = (onF: (v: unknown) => unknown) =>
            Promise.resolve({
              count: isDraftQuery && wantsStartedAt ? liveAssessments : submissionCount,
              error: null,
            }).then(onF)
          return chain
        }
        const chain = thenableChain({
          data: { id: 'asg-1', section_id: 'sec-1', title: 'T', due_at: null, published_at, publish_notified_at: published_at },
          error: null,
        }) as Record<string, unknown>
        chain.update = vi.fn((patch: Record<string, unknown>) => { updates.push(patch); return chain })
        return chain
      }),
      rpc: vi.fn().mockResolvedValue({ error: null }),
    }
    return { adminDb, updates }
  }

  it('refuses to unpublish once a student has submitted, and names the alternative', async () => {
    const { adminDb, updates } = statusDb(3, '2026-01-01T00:00:00.000Z')
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })
    const mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions')

    const res = await mod.setAssignmentStatus('sec-1', 'asg-1', 'draft')

    // The student would lose access to their own submitted work — refuse, don't warn.
    expect('error' in res).toBe(true)
    const message = 'error' in res ? res.error : ''
    expect(message).toMatch(/already submitted/i)
    expect(message).toMatch(/Close submissions/i)
    expect(updates).toHaveLength(0)
  })

  it('keeps the publication history when closing submissions', async () => {
    const PUBLISHED_AT = '2026-01-01T00:00:00.000Z'
    const { adminDb, updates } = statusDb(0, PUBLISHED_AT)
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })
    const mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions')

    await mod.setAssignmentStatus('sec-1', 'asg-1', 'closed')

    expect(updates).toHaveLength(1)
    expect(updates[0].status).toBe('closed')
    /* The old code wrote `published_at: status === 'published' ? now : null`, which erased
       when the assignment went live AND cleared publish_notified_at — re-arming the publish
       sweep to notify students about work they had already been told about. */
    expect(updates[0]).not.toHaveProperty('published_at')
    expect(updates[0]).not.toHaveProperty('publish_notified_at')
  })

  /* Raised by CodeRabbit on PR #624, and it was right where the consultant was wrong: excluding
     ALL draft rows looked precise but a draft is created by two different things. A late-request
     stub is harmless; an assessment in progress stamps assessment_started_at and starts a clock.
     Withdrawing under a live assessment cuts the student off mid-attempt.

     The oracle is that NO write happens and the message names the assessment — not merely that
     an error came back, since the submitted-work branch also errors. */
  it('refuses to unpublish while a student is part-way through an assessment', async () => {
    const { adminDb, updates } = statusDb(0, '2026-01-01T00:00:00.000Z', 2)
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })
    const mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions')

    const res = await mod.setAssignmentStatus('sec-1', 'asg-1', 'draft')

    expect('error' in res).toBe(true)
    const msg = 'error' in res ? res.error : ''
    expect(msg).toMatch(/part-way through/i)
    expect(msg).toMatch(/Close submissions/i)
    expect(updates).toHaveLength(0)
  })

  it('still allows unpublish when the only draft is a late-request stub (no assessment started)', async () => {
    // liveAssessments = 0: a stub row exists but nothing is in progress, so withdrawing costs
    // the student nothing. Blocking here would be over-eager.
    const { adminDb, updates } = statusDb(0, null, 0)
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })
    const mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions')

    const res = await mod.setAssignmentStatus('sec-1', 'asg-1', 'draft')

    expect('error' in res).toBe(false)
    expect(updates).toHaveLength(1)
    expect(updates[0].status).toBe('draft')
  })
})
