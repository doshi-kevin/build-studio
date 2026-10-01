// Tests for professor announcement server actions — ownership and validation checks.
// Verifies that announcement actions reject non-owners of the course section
// and validates input schemas. Auth gate tests removed (tautological).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ROLE_DENIED_MESSAGE } from '@/lib/auth/section-access'

// ── Chain Builder ────────────────────────────────────────────

function buildChain(finalResult: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.neq = vi.fn().mockReturnValue(chain)
  chain.or = vi.fn().mockReturnValue(chain)
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
  chain.lte = vi.fn().mockReturnValue(chain)
  chain.gt = vi.fn().mockReturnValue(chain)
  chain.then = undefined
  return chain
}

// ── Module-Level Mock References ─────────────────────────────

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockRewriteAnnouncement = vi.fn()

/* AI kill switch: these tests exercise the AI-ENABLED path — mock the guard
   open so their stubbed DB clients don't trip its fail-closed refusal. The
   disabled/locked paths are covered in ai-kill-switch.test.ts. */
vi.mock('@/lib/ai/kill-switch', () => ({
  checkAiFeature: vi.fn(async () => ({ allowed: true })),
  checkAiFeatureBySection: vi.fn(async () => ({ allowed: true })),
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
// Mock the AI at the boundary — the LLM wrapper is network-backed and tested as
// a boundary elsewhere. Here we assert the ACTION's guard chain around it: that
// non-staff never reach the (paid) model, and that a valid caller's trimmed
// draft is forwarded and its result returned.
vi.mock('@/lib/ai/llm-client', () => ({
  rewriteAnnouncement: (...args: unknown[]) => mockRewriteAnnouncement(...args),
}))
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
vi.mock('@/lib/tiptap-utils', () => ({
  extractLinkedItems: vi.fn().mockReturnValue({ mentionedStudentIds: [] }),
}))

// ── Test Setup ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getAnnouncements: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createAnnouncement: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let updateAnnouncement: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deleteAnnouncement: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let toggleAnnouncementPin: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getAnnouncementReadCounts: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let rewriteAnnouncementContent: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockRewriteAnnouncement.mockReset()

  const mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/announcements/actions')
  getAnnouncements = mod.getAnnouncements
  createAnnouncement = mod.createAnnouncement
  updateAnnouncement = mod.updateAnnouncement
  deleteAnnouncement = mod.deleteAnnouncement
  toggleAnnouncementPin = mod.toggleAnnouncementPin
  getAnnouncementReadCounts = mod.getAnnouncementReadCounts
  rewriteAnnouncementContent = mod.rewriteAnnouncementContent
})

// ── Auth helpers ─────────────────────────────────────────────

function mockAuthenticated(userId = 'prof-1') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

/**
 * Returns an admin mock where verifySectionAccess finds professor_id
 * 'real-prof-id' (≠ attacker identity) on course_sections AND no matching
 * section_staff row, so the caller is rejected.
 *
 * The mock returns the same chain for every `from()` call, but that's fine:
 * the section_staff query just reads `.role`, which is undefined on the
 * section_sections payload — so neither 'ta' nor 'grader' matches.
 */
function mockNonOwnerAdmin() {
  const admin = {
    from: vi.fn(() =>
      buildChain({
        data: { id: 'section-1', professor_id: 'real-prof-id' },
        error: null,
      })
    ),
  }
  mockAdminClient.mockReturnValue(admin)
  return admin
}

/** Returns an admin mock where the caller IS the professor of the section. */
function mockOwnerAdmin(userId: string) {
  const admin = {
    from: vi.fn(() =>
      buildChain({
        data: { id: 'section-1', professor_id: userId },
        error: null,
      })
    ),
  }
  mockAdminClient.mockReturnValue(admin)
  return admin
}

/** Returns an admin mock where the caller is an active TA on the section. */
function mockActiveTaAdmin() {
  let call = 0
  const admin = {
    from: vi.fn(() => {
      call++
      // 1st call: course_sections (different professor_id, so falls through)
      if (call === 1) {
        return buildChain({
          data: { id: 'section-1', professor_id: 'real-prof-id' },
          error: null,
        })
      }
      // 2nd call: section_staff (active TA row)
      return buildChain({ data: { role: 'ta' }, error: null })
    }),
  }
  mockAdminClient.mockReturnValue(admin)
  return admin
}

// ── Valid minimal inputs ──────────────────────────────────────

const validCreateInput = {
  title: 'Test Announcement',
  content: 'Hello students.',
  is_pinned: false,
  status: 'published' as const,
  visibility: 'all' as const,
  allow_reactions: false,
  allow_comments: false,
}

const validUpdateInput = {
  title: 'Updated Announcement',
  is_pinned: false,
  status: 'published' as const,
}

// ── getAnnouncements ─────────────────────────────────────────

describe('getAnnouncements', () => {
  it('rejects users who do not own the section', async () => {
    mockAuthenticated('attacker-id')
    mockNonOwnerAdmin()
    const result = await getAnnouncements('section-1')
    expect(result.error).toBe('You do not have access to this section')
    expect(result.data).toEqual([])
  })
})

// ── createAnnouncement ───────────────────────────────────────

describe('createAnnouncement', () => {
  it('rejects users who do not own the section', async () => {
    mockAuthenticated('attacker-id')
    mockNonOwnerAdmin()
    const result = await createAnnouncement('section-1', validCreateInput)
    expect(result.error).toBe('You do not have access to this section')
  })

  it('rejects invalid input (missing required title)', async () => {
    mockAuthenticated('prof-1')
    // Ownership check is not reached — schema validates first
    const result = await createAnnouncement('section-1', {
      ...validCreateInput,
      title: '', // fails min(1) on createAnnouncementSchema
    })
    expect(result.error).toBe('Invalid input: Title is required')
    expect(result.success).toBeUndefined()
  })

  it('rejects multi-section posting combined with "Selected students only"', async () => {
    // The professor owns the section (access ok), but multi-section + mentioned_only
    // is contradictory — the student picker is scoped to one section's roster.
    mockAuthenticated('prof-1')
    mockOwnerAdmin('prof-1')
    const result = await createAnnouncement('section-1', {
      ...validCreateInput,
      visibility: 'mentioned_only',
      additional_section_ids: ['123e4567-e89b-12d3-a456-426614174000'],
    })
    expect(result.error).toBe('Cannot post to multiple sections with "Selected students only" audience')
  })
})

// ── updateAnnouncement ───────────────────────────────────────

describe('updateAnnouncement', () => {
  it('rejects users who do not own the section', async () => {
    mockAuthenticated('attacker-id')
    mockNonOwnerAdmin()
    const result = await updateAnnouncement('ann-1', 'section-1', validUpdateInput)
    expect(result.error).toBe('You do not have access to this section')
  })

  // Multi-section edit sync: "apply to all sections" must propagate ONLY content
  // fields to sibling copies — never status/scheduling (which would silently
  // republish/reschedule the other sections). Also re-verifies access per row.
  it('sync_scope="all" propagates only content fields to sibling sections', async () => {
    mockAuthenticated('prof-1')
    const captured: { sibling: Record<string, unknown> | null } = { sibling: null }
    let annCall = 0
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'course_sections') {
          // professor owns every section queried (initial + sibling verify)
          return buildChain({ data: { id: 'section-1', professor_id: 'prof-1' }, error: null })
        }
        if (table === 'announcements') {
          annCall++
          if (annCall === 1) {
            // primary update → .select('title, parent_announcement_id').maybeSingle()
            return buildChain({ data: { title: 'Updated Title', parent_announcement_id: null }, error: null })
          }
          if (annCall === 2) {
            // group fetch → awaited .select().or() (thenable, no .single())
            const rows = [
              { id: 'ann-1', section_id: 'section-1' },
              { id: 'child-1', section_id: 'section-2' },
            ]
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const chain: any = buildChain({ data: rows, error: null })
            chain.then = (r: (v: unknown) => void) => Promise.resolve({ data: rows, error: null }).then(r)
            return chain
          }
          // sibling update → capture the payload, awaited .update().eq() (thenable)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const chain: any = buildChain({ data: null, error: null })
          chain.update = vi.fn((arg: Record<string, unknown>) => { captured.sibling = arg; return chain })
          chain.then = (r: (v: unknown) => void) => Promise.resolve({ data: null, error: null }).then(r)
          return chain
        }
        return buildChain({ data: [], error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await updateAnnouncement('ann-1', 'section-1', {
      title: 'Updated Title',
      status: 'draft',
      sync_scope: 'all',
    })

    expect(result.success).toBe(true)
    expect(captured.sibling).not.toBeNull()
    const keys = Object.keys(captured.sibling as Record<string, unknown>)
    expect(keys).toContain('title')
    expect(keys).not.toContain('status')
    expect(keys).not.toContain('published_at')
    expect(keys).not.toContain('scheduled_at')
  })
})

// ── deleteAnnouncement ───────────────────────────────────────

describe('deleteAnnouncement', () => {
  it('rejects users who do not own the section', async () => {
    mockAuthenticated('attacker-id')
    mockNonOwnerAdmin()
    const result = await deleteAnnouncement('ann-1', 'section-1')
    expect(result.error).toBe('You do not have access to this section')
  })
})

// ── toggleAnnouncementPin ────────────────────────────────────

describe('toggleAnnouncementPin', () => {
  it('rejects users who do not own the section', async () => {
    mockAuthenticated('attacker-id')
    mockNonOwnerAdmin()
    const result = await toggleAnnouncementPin('ann-1', 'section-1')
    expect(result.error).toBe('You do not have access to this section')
  })
})

// ── getAnnouncementReadCounts ────────────────────────────────

describe('getAnnouncementReadCounts', () => {
  it('returns empty data for users who do not own the section', async () => {
    // Same silent-fallback pattern: non-owners get an empty read-count map.
    mockAuthenticated('attacker-id')
    mockNonOwnerAdmin()
    const result = await getAnnouncementReadCounts('section-1')
    expect(result.data).toEqual({})
  })
})

// ── TA access ────────────────────────────────────────────────
// Regression guard: when a user has an active section_staff row with role='ta',
// verifySectionAccess returns { ok: true, role: 'ta' }, and announcement
// writes go through since canWriteAsStaff('ta') === true. This codifies
// the TA-access intent so a future refactor can't silently block TAs.

describe('TA access', () => {
  it('allows an active TA to create an announcement', async () => {
    mockAuthenticated('ta-user-id')
    mockActiveTaAdmin()
    const result = await createAnnouncement('section-1', validCreateInput)
    // We don't assert success here — the INSERT chain returns `{ data: {...} }`
    // which may or may not fully satisfy the happy path depending on mocks.
    // The critical assertion is: no FORBIDDEN and no access rejection.
    expect(result.error).not.toBe('You do not have access to this section')
    expect(result.error).not.toBe(ROLE_DENIED_MESSAGE)
  })
})

// ── Grader access (read-only for v1) ─────────────────────────
// Regression guard: when a user has an active section_staff row with
// role='grader', verifySectionAccess returns { ok: true, role: 'grader' }
// — so they pass the access check and can READ. But canWriteAsStaff
// ('grader') === false, so every write action must return FORBIDDEN.
// If this guard fires, it means the grader write-block was accidentally
// removed (a regression that would silently hand grading staff
// announcement-posting powers they shouldn't have).

function mockActiveGraderAdmin() {
  let call = 0
  const admin = {
    from: vi.fn(() => {
      call++
      if (call === 1) {
        return buildChain({
          data: { id: 'section-1', professor_id: 'real-prof-id' },
          error: null,
        })
      }
      return buildChain({ data: { role: 'grader' }, error: null })
    }),
  }
  mockAdminClient.mockReturnValue(admin)
  return admin
}

describe('Grader access', () => {
  it('allows a grader to read announcements', async () => {
    mockAuthenticated('grader-user-id')
    mockActiveGraderAdmin()
    const result = await getAnnouncements('section-1')
    // Graders must pass the access check (ok:true, role:'grader').
    expect(result.error).not.toBe('You do not have access to this section')
  })

  it('blocks a grader from creating an announcement (FORBIDDEN)', async () => {
    mockAuthenticated('grader-user-id')
    mockActiveGraderAdmin()
    const result = await createAnnouncement('section-1', validCreateInput)
    expect(result.error).toBe(ROLE_DENIED_MESSAGE)
  })

  it('blocks a grader from updating an announcement (FORBIDDEN)', async () => {
    mockAuthenticated('grader-user-id')
    mockActiveGraderAdmin()
    const result = await updateAnnouncement('ann-1', 'section-1', validUpdateInput)
    expect(result.error).toBe(ROLE_DENIED_MESSAGE)
  })

  it('blocks a grader from deleting an announcement (FORBIDDEN)', async () => {
    mockAuthenticated('grader-user-id')
    mockActiveGraderAdmin()
    const result = await deleteAnnouncement('ann-1', 'section-1')
    expect(result.error).toBe(ROLE_DENIED_MESSAGE)
  })

  it('blocks a grader from toggling pin (FORBIDDEN)', async () => {
    mockAuthenticated('grader-user-id')
    mockActiveGraderAdmin()
    const result = await toggleAnnouncementPin('ann-1', 'section-1')
    expect(result.error).toBe(ROLE_DENIED_MESSAGE)
  })
})

// ── rewriteAnnouncementContent ("Rewrite with Athena") ───────
// This action is read-only (no DB write) but reaches a PAID AI model, so its
// only real correctness surface is the guard chain: the same access + staff
// write-role gate as the write actions, PLUS an empty-content short-circuit.
// The critical guarantee is that a rejected caller (non-owner / grader) never
// reaches the model — otherwise it becomes a free generation endpoint, exactly
// the abuse the action's own comment calls out.

describe('rewriteAnnouncementContent', () => {
  it('rejects non-owners and never reaches the model', async () => {
    mockAuthenticated('attacker-id')
    mockNonOwnerAdmin()
    const result = await rewriteAnnouncementContent('section-1', { content: 'draft' })
    expect(result.error).toBe('You do not have access to this section')
    expect(mockRewriteAnnouncement).not.toHaveBeenCalled()
  })

  it('blocks a grader (FORBIDDEN) — no free AI generation for read-only staff', async () => {
    mockAuthenticated('grader-user-id')
    mockActiveGraderAdmin()
    const result = await rewriteAnnouncementContent('section-1', { content: 'draft' })
    expect(result.error).toBe(ROLE_DENIED_MESSAGE)
    expect(mockRewriteAnnouncement).not.toHaveBeenCalled()
  })

  it('rejects empty/whitespace content before spending a model call', async () => {
    mockAuthenticated('prof-1')
    mockOwnerAdmin('prof-1')
    const result = await rewriteAnnouncementContent('section-1', { content: '   ' })
    expect(result.error).toBe('Add a few words and Athena will polish them for you.')
    expect(mockRewriteAnnouncement).not.toHaveBeenCalled()
  })

  it('forwards the trimmed draft and returns the rewritten text for an owner', async () => {
    mockAuthenticated('prof-1')
    mockOwnerAdmin('prof-1')
    mockRewriteAnnouncement.mockResolvedValue({ text: 'Polished announcement.' })
    const result = await rewriteAnnouncementContent('section-1', { content: '  raw draft  ' })
    expect(result.text).toBe('Polished announcement.')
    expect(result.error).toBeUndefined()
    // Content is trimmed before the model sees it; attribution carries section + user.
    expect(mockRewriteAnnouncement).toHaveBeenCalledWith(
      'raw draft',
      expect.objectContaining({ sectionId: 'section-1', userId: 'prof-1' }),
    )
  })

  it('surfaces a model error to the caller', async () => {
    mockAuthenticated('prof-1')
    mockOwnerAdmin('prof-1')
    mockRewriteAnnouncement.mockResolvedValue({ text: '', error: 'model unavailable' })
    const result = await rewriteAnnouncementContent('section-1', { content: 'draft' })
    expect(result.error).toBe('model unavailable')
    expect(result.text).toBeUndefined()
  })
})
