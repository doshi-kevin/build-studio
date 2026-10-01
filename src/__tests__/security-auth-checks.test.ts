// Tests that security-critical server actions enforce authorization checks.
// Verifies fixes for: missing verifyOwnership in getQuizSubmissionCounts,
// missing verifyEnrollment in getQuizClassAverage, and REVOKE/GRANT on
// the increment_student_quizzes_taken SECURITY DEFINER RPC.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

// ── Mock Supabase clients ──────────────────────────────────────────

// Chain builder: from().select().eq().eq()...single()
function buildChain(finalResult: { data: unknown; error: unknown; count?: number }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.in = vi.fn().mockReturnValue(chain)
  chain.neq = vi.fn().mockReturnValue(chain)
  chain.gt = vi.fn().mockReturnValue(chain)
  chain.order = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(chain)
  chain.single = vi.fn().mockResolvedValue(finalResult)
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult)
  // For count queries
  chain.then = undefined
  return chain
}

// Admin client mock that tracks calls
let adminFromCalls: string[] = []
function createMockAdminClient(overrides: Record<string, { data: unknown; error: unknown }> = {}) {
  adminFromCalls = []
  return {
    from: vi.fn((table: string) => {
      adminFromCalls.push(table)
      const result = overrides[table] ?? { data: [], error: null }
      return buildChain(result)
    }),
  }
}

// ── Mock modules ───────────────────────────────────────────────────

// Mock next/cache (server actions use revalidatePath)
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

// Mock Supabase server client (used by getAuthUser)
const mockGetUser = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: mockGetUser,
    },
  })),
}))

// Mock Supabase admin client
const mockAdminClient = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))

// Mock logger
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// Mock quiz scoring (imported by student actions)
vi.mock('@/lib/quiz/scoring', () => ({
  gradeAnswer: vi.fn(),
  resolveQuestionPool: vi.fn(),
}))

// Mock quiz utils
vi.mock('@/lib/quiz/utils', () => ({
  shuffleArray: vi.fn((arr: unknown[]) => arr),
}))

// Mock adaptive engine
vi.mock('@/lib/quiz/adaptive-engine', () => ({
  assignCohort: vi.fn(),
  calculateEloUpdate: vi.fn(),
  selectAdaptiveQuestion: vi.fn(),
  selectControlQuestions: vi.fn(),
  DEFAULT_START_RATING: 1200,
}))

// ── Test helpers ───────────────────────────────────────────────────

function mockAuthenticatedUser(id = 'user-123') {
  mockGetUser.mockResolvedValue({
    data: { user: { id } },
    error: null,
  })
}

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({
    data: { user: null },
    error: { message: 'Not authenticated' },
  })
}

// ═══════════════════════════════════════════════════════════════════
// Vuln 1: getQuizSubmissionCounts must call verifyOwnership
// ═══════════════════════════════════════════════════════════════════

describe('Professor: getQuizSubmissionCounts authorization', () => {
  let getQuizSubmissionCounts: (sectionId: string) => Promise<{ error?: string; data: Record<string, { submitted: number; inProgress: number }> }>

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()

    // Re-import after resetting mocks so the module picks up fresh mocks
    const mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions')
    getQuizSubmissionCounts = mod.getQuizSubmissionCounts
  })

  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()

    const result = await getQuizSubmissionCounts('section-abc')
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects users who do not have access to the section', async () => {
    mockAuthenticatedUser('attacker-id')

    // verifySectionAccess queries course_sections (mismatched professor_id) then
    // section_staff (no row) — both return non-owner data, so access is denied.
    const admin = createMockAdminClient({
      course_sections: { data: { id: 'section-abc', professor_id: 'real-prof-id' }, error: null },
    })
    mockAdminClient.mockReturnValue(admin)

    const result = await getQuizSubmissionCounts('section-abc')
    expect(result.error).toContain('do not have access')
  })

})

// ═══════════════════════════════════════════════════════════════════
// Vuln 2: getQuizClassAverage must call verifyEnrollment
// ═══════════════════════════════════════════════════════════════════

describe('Student: getQuizClassAverage authorization', () => {
  let getQuizClassAverage: (sectionId: string, quizId: string) => Promise<{ error?: string; data?: unknown }>

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()

    const mod = await import('@/app/(dashboard)/student/courses/[sectionId]/quizzes/actions')
    getQuizClassAverage = mod.getQuizClassAverage
  })

  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()

    const result = await getQuizClassAverage('section-abc', 'quiz-1')
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects users not enrolled in the section', async () => {
    mockAuthenticatedUser('attacker-id')

    // verifyEnrollment queries enrollments — return null to simulate not enrolled
    const admin = createMockAdminClient({
      enrollments: { data: null, error: null },
    })
    mockAdminClient.mockReturnValue(admin)

    const result = await getQuizClassAverage('section-abc', 'quiz-1')
    expect(result.error).toContain('Not enrolled')
  })

  it('returns data for enrolled students', async () => {
    mockAuthenticatedUser('student-id')

    // Build a fully chainable mock that supports multiple .eq() calls
    function buildFullChain(finalResult: { data: unknown; error: unknown; count?: number }) {
      const chain: Record<string, ReturnType<typeof vi.fn>> = {}
      chain.select = vi.fn().mockReturnValue(chain)
      chain.eq = vi.fn().mockReturnValue(chain)
      chain.in = vi.fn().mockReturnValue(chain)
      chain.single = vi.fn().mockResolvedValue(finalResult)
      // Allow the chain to be awaited directly (for queries without .single())
      const thenable = Object.assign(chain, {
        then: (res: (v: unknown) => void) => Promise.resolve(finalResult).then(res),
      })
      return thenable
    }

    const chains: Record<string, ReturnType<typeof buildFullChain>> = {
      enrollments: buildFullChain({ data: { id: 'enroll-1' }, error: null }),
      quizzes: buildFullChain({ data: { due_date: null }, error: null }),
      quiz_attempts: buildFullChain({ data: [{ student_id: 'student-id', score: 85 }], error: null }),
    }

    const admin = {
      from: vi.fn((table: string) => chains[table] ?? buildFullChain({ data: null, error: null })),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await getQuizClassAverage('section-abc', 'quiz-1')
    expect(result.error).toBeUndefined()
    expect(result.data).toBeDefined()
    expect((result.data as { submissionCount: number }).submissionCount).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════
// Vuln 3: SECURITY DEFINER RPC must have REVOKE/GRANT
// ═══════════════════════════════════════════════════════════════════

describe('Migration: increment_student_quizzes_taken RPC permissions', () => {
  const migrationsDir = path.resolve(__dirname, '../../supabase/migrations')

  it('migration 00000000000005 contains REVOKE/GRANT for the RPC function', () => {
    const sql = readFileSync(path.join(migrationsDir, '00000000000005_adaptive_quiz.sql'), 'utf-8')

    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION increment_student_quizzes_taken FROM PUBLIC')
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION increment_student_quizzes_taken TO service_role')
  })

  it('dedicated migration 00000000000012 exists with REVOKE/GRANT for existing databases', () => {
    const sql = readFileSync(path.join(migrationsDir, '00000000000012_secure_rpc_permissions.sql'), 'utf-8')

    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION increment_student_quizzes_taken FROM PUBLIC')
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION increment_student_quizzes_taken FROM')
    expect(sql).toContain('anon')
    expect(sql).toContain('authenticated')
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION increment_student_quizzes_taken TO service_role')
  })

  it('RPC function is SECURITY DEFINER (confirming it needs the REVOKE)', () => {
    const sql = readFileSync(path.join(migrationsDir, '00000000000005_adaptive_quiz.sql'), 'utf-8')

    // The function must be SECURITY DEFINER — that's why we need the REVOKE
    expect(sql).toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+increment_student_quizzes_taken[\s\S]*?SECURITY\s+DEFINER/)
  })
})

// ═══════════════════════════════════════════════════════════════════
// Migration: security_audit_remediation — RLS/security audit fixes.
// Locks DB objects that the audit found reachable cross-tenant via PostgREST.
// Whitespace is collapsed so alignment in the .sql doesn't matter.
// ═══════════════════════════════════════════════════════════════════

describe('Migration: security_audit_remediation', () => {
  const migrationsDir = path.resolve(__dirname, '../../supabase/migrations')
  const sql = readFileSync(
    path.join(migrationsDir, '20260626184930_security_audit_remediation.sql'),
    'utf-8',
  )
    .toLowerCase()
    .replace(/\s+/g, ' ')

  it('H1: both SECURITY DEFINER views are security_invoker + revoked from anon/authenticated', () => {
    for (const view of ['institutions_with_counts', 'section_staff_with_institution']) {
      expect(sql).toContain(`alter view public.${view} set (security_invoker = on)`)
      expect(sql).toContain(`revoke all on public.${view} from anon, authenticated`)
    }
  })

  it('H2: client EXECUTE is revoked on every over-granted SECURITY DEFINER function', () => {
    const fns = [
      'increment_student_quizzes_taken(uuid, uuid, integer)',
      'finalize_overdue_assignments()',
      'publish_scheduled_assignments()',
      'claim_next_extraction_job(uuid, integer)',
      'cancel_pending_extraction_jobs(uuid)',
      'lc_auto_end_stale_rooms()',
      'lc_reap_orphan_decks()',
    ]
    for (const fn of fns) {
      expect(sql).toContain(`revoke execute on function public.${fn} from public, anon, authenticated`)
      expect(sql).toContain(`grant execute on function public.${fn} to service_role`)
    }
  })

  it('H2: increment_student_quizzes_taken has a baked-in server-only caller guard (drift-proof)', () => {
    expect(sql).toContain("current_user = 'postgres' or coalesce(auth.role(), '') = 'service_role'")
    expect(sql).toContain('increment_student_quizzes_taken is server-only')
  })

  it('M1: challenge_claims FOR ALL write policy is removed, replaced by SELECT-only', () => {
    expect(sql).toContain('drop policy if exists "students can manage own claims" on public.challenge_claims')
    expect(sql).toContain('create policy "students read own claims" on public.challenge_claims for select to authenticated')
    // No remaining client write policy on challenge_claims in this migration.
    expect(sql).not.toContain('on public.challenge_claims for all')
  })

  it('M2: profile guard freezes is_platform_owner and status (not just role/institution_id)', () => {
    expect(sql).toContain('create or replace function public.prevent_profile_privilege_escalation()')
    expect(sql).toContain('new.is_platform_owner is distinct from old.is_platform_owner')
    expect(sql).toContain("coalesce(new.status, '') is distinct from coalesce(old.status, '')")
    // The service_role early-return must remain (keeps server-action writes working),
    // and the new column checks must sit AFTER the INSERT early-return (the INSERT
    // branch returns first, so OLD-is-NULL never trips the UPDATE-only guards).
    expect(sql).toContain("coalesce(auth.role(), '') = 'service_role'")
    expect(sql).toContain("current_user in ('postgres', 'service_role', 'supabase_admin')")
    expect(sql).toContain("if tg_op = 'insert' then")
  })

  it('M3: search_path is pinned on the verified SECURITY DEFINER functions', () => {
    for (const fn of ['lc_auto_end_stale_rooms()', 'lc_reap_orphan_decks()', 'schedule_quiz_publish()']) {
      expect(sql).toContain(`alter function public.${fn} set search_path = public`)
    }
  })
})

describe('Migration: security_audit_rpc_hardening (2026-07-15)', () => {
  const migrationsDir = path.resolve(__dirname, '../../supabase/migrations')
  const sql = readFileSync(
    path.join(migrationsDir, '20260715191137_security_audit_rpc_hardening_jul15.sql'),
    'utf-8',
  ).toLowerCase()

  it('C1/H1: get_dm_unread_counts + get_teammate_ids revoke from PUBLIC (not just anon/authenticated)', () => {
    // Revoking only anon/authenticated leaves the default PUBLIC grant intact,
    // so `public` MUST be in the revoke list or the anon leak stays open.
    expect(sql).toContain('revoke execute on function public.get_dm_unread_counts(uuid) from public, anon, authenticated')
    expect(sql).toContain('revoke execute on function public.get_teammate_ids(uuid) from public, anon, authenticated')
    expect(sql).toContain('grant execute on function public.get_dm_unread_counts(uuid) to service_role')
    expect(sql).toContain('grant execute on function public.get_teammate_ids(uuid) to service_role')
  })

  it('C1: get_dm_unread_counts gains a pinned search_path (was unset)', () => {
    expect(sql).toMatch(/create or replace function public\.get_dm_unread_counts[\s\S]*?set search_path to 'public'/)
  })

  it('C2/M1: policy-backed functions keep authenticated but add an auth.uid() caller guard + revoke anon', () => {
    // These back RLS policies (profiles / phase_comments), so authenticated must
    // keep EXECUTE; the guard closes the direct-RPC IDOR instead of a blanket revoke.
    expect(sql).toContain('revoke execute on function public.get_visible_profile_ids(uuid) from public, anon')
    expect(sql).toContain('revoke execute on function public.can_access_phase(uuid, uuid) from public, anon')
    expect(sql).toContain('p_user_id = (select auth.uid())')
    expect(sql).toContain("(select auth.role()) = 'service_role'")
    // authenticated must NOT be revoked from the policy-backed functions
    expect(sql).not.toContain('revoke execute on function public.get_visible_profile_ids(uuid) from public, anon, authenticated')
  })
})
