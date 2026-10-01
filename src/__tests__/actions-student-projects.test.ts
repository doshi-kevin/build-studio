// Tests for student project phase-item server actions — IDOR authorization.
// Regression coverage for the security-audit fix (2026-07-15): update/delete/
// togglePhaseItem must bind the phase to the caller's team (not just verify
// team membership), so a team member cannot mutate another team's checklist
// items by passing a foreign phaseId/itemId. Guard: project_phases WHERE
// id = phaseId AND team_id = teamId.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Chain Builder ────────────────────────────────────────────

function buildChain(finalResult: { data: unknown; error: unknown; count?: number }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.neq = vi.fn().mockReturnValue(chain)
  chain.in = vi.fn().mockReturnValue(chain)
  chain.is = vi.fn().mockReturnValue(chain)
  chain.order = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(chain)
  chain.single = vi.fn().mockResolvedValue(finalResult)
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult)
  chain.insert = vi.fn().mockReturnValue(chain)
  chain.update = vi.fn().mockReturnValue(chain)
  chain.delete = vi.fn().mockReturnValue(chain)
  chain.upsert = vi.fn().mockReturnValue(chain)
  chain.gt = vi.fn().mockReturnValue(chain)
  chain.then = undefined
  return chain
}

// ── Module-Level Mocks ───────────────────────────────────────

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/events/emit', () => ({ emitEvent: vi.fn() }))
vi.mock('@/lib/ai/llm-client', () => ({ generateProjectPhases: vi.fn() }))
vi.mock('@/lib/chat/system-messages', () => ({ emitSystemMessage: vi.fn() }))

// ── Test Setup ───────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
let updatePhaseItem: any
let deletePhaseItem: any
let togglePhaseItem: any
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()

  const mod = await import(
    '@/app/(dashboard)/student/courses/[sectionId]/projects/actions'
  )
  updatePhaseItem = mod.updatePhaseItem
  deletePhaseItem = mod.deletePhaseItem
  togglePhaseItem = mod.togglePhaseItem
})

function mockAuthenticated(userId = 'student-1') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

/**
 * Caller is enrolled AND a member of their OWN team, but the phase they pass
 * belongs to ANOTHER team (project_phases lookup returns null). Tracks whether
 * the phase_items mutation was reached.
 * Call order: 1=enrollments, 2=project_members, 3=project_phases (guard).
 */
function mockForeignPhaseAdmin() {
  let call = 0
  const state = { wrote: false }
  const admin = {
    from: vi.fn(() => {
      call++
      if (call === 1) return buildChain({ data: { id: 'enr-1' }, error: null }) // verifyEnrollment
      if (call === 2) return buildChain({ data: { id: 'pm-1', role: 'member' }, error: null }) // verifyTeamAccess
      if (call === 3) return buildChain({ data: null, error: null }) // project_phases: foreign phase → not found
      // Any later call would be the mutation — flag it (guard failure).
      const chain = buildChain({ data: null, error: null })
      chain.update = vi.fn(() => { state.wrote = true; return chain })
      chain.delete = vi.fn(() => { state.wrote = true; return chain })
      return chain
    }),
  }
  mockAdminClient.mockReturnValue(admin)
  return state
}

// ── updatePhaseItem / deletePhaseItem / togglePhaseItem ──────

describe('phase-item mutators: cross-team IDOR guard', () => {
  it('updatePhaseItem rejects a phase from another team and does not write', async () => {
    mockAuthenticated('student-1')
    const state = mockForeignPhaseAdmin()
    const result = await updatePhaseItem('item-B', 'phase-B', 'team-1', 'section-1', { title: 'Updated' })
    expect(result.error).toBe('Phase not found')
    expect(state.wrote).toBe(false)
  })

  it('deletePhaseItem rejects a phase from another team and does not write', async () => {
    mockAuthenticated('student-1')
    const state = mockForeignPhaseAdmin()
    const result = await deletePhaseItem('item-B', 'phase-B', 'team-1', 'section-1')
    expect(result.error).toBe('Phase not found')
    expect(state.wrote).toBe(false)
  })

  it('togglePhaseItem rejects a phase from another team and does not write', async () => {
    mockAuthenticated('student-1')
    const state = mockForeignPhaseAdmin()
    const result = await togglePhaseItem('item-B', 'phase-B', 'team-1', 'section-1', true)
    expect(result.error).toBe('Phase not found')
    expect(state.wrote).toBe(false)
  })

  it('updatePhaseItem still rejects a non-team-member (pre-existing guard intact)', async () => {
    mockAuthenticated('outsider')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr-1' }, error: null }) // enrolled
        return buildChain({ data: null, error: null }) // project_members → not a member
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const result = await updatePhaseItem('item-1', 'phase-1', 'team-1', 'section-1', { title: 'x' })
    expect(result.error).toBe('Not a member of this team')
  })
})
