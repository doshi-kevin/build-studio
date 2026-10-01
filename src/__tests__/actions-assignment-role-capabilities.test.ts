/**
 * Which capability predicate an assignment action reaches for (#749, #746).
 *
 * assignments/actions.ts used canWriteAsStaff at all 45 of its call sites — one
 * predicate for every write it performs. The guards were all present and all
 * holding; they simply disagreed with the rest of the codebase depending on which
 * predicate the author happened to reach for. Two real bugs fell out of that:
 *
 *   deleteAssignment (#749) — a TA could permanently delete any assignment in the
 *   section, taking its submissions and grades with it. Quizzes, projects and
 *   live-classroom all reserved the equivalent for the professor; assignments were
 *   the outlier. A TA is often a graduate student and the delete is unrecoverable.
 *
 *   the grading actions (#746) — a role literally named "grader" could not grade.
 *   The form rendered fully enabled and every save silently no-opped: no toast, no
 *   disabled control, no error. Score writes now go through canGrade.
 *
 * WHY THIS FILE EXISTS SEPARATELY. Every other test of this module stubs the
 * predicates with hand-copied re-implementations —
 * `canGrade: (role) => role === 'professor' || role === 'ta' || role === 'grader'`.
 * Those assert against the copy, so they would all stay green if the real
 * canGrade regressed. This file mocks ONLY verifySectionAccess and imports the
 * genuine predicates, so it fails if either half of the pairing drifts: the
 * action reaching for the wrong predicate, or the predicate changing who it
 * admits. That pairing is the whole content of both issues.
 *
 * The oracle throughout is that NOTHING WAS WRITTEN, not merely that an error came
 * back. A refusal for some unrelated reason would satisfy an error-only assertion.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildFullChain, type ChainResult } from './helpers/mock-supabase'

const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()

/* createMockAdminClient's chains have no .update()/.delete(), and the positive
   cases here run all the way through the write. buildFullChain does, so this is
   createMockAdminClient's table tracking over full chains — the tracking is what
   the "touched nothing" oracle needs. */
function trackingClient(results: Record<string, ChainResult>) {
  const tableCalls: string[] = []
  return {
    from: (table: string) => {
      tableCalls.push(table)
      return buildFullChain(results[table] ?? { data: null, error: null })
    },
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    _tableCalls: tableCalls,
  }
}

let adminClient: ReturnType<typeof trackingClient>

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => void) => { void fn },
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/skills/grade-hook', () => ({ applyGradeToSkillMastery: vi.fn() }))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

/* The point of the file: only the lookup is stubbed. canWriteAsProfessor,
   canWriteAsStaff and canGrade are the real exported functions. */
vi.mock('@/lib/auth/section-access', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/section-access')>()),
  verifySectionAccess: (...args: unknown[]) => mockVerifySectionAccess(...args),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any

/** Grant the caller `role` in sec-1, with a client that records every table touched. */
function asRole(role: 'professor' | 'ta' | 'grader') {
  adminClient = trackingClient({
    assignments: { data: { id: 'asg-1', section_id: 'sec-1', title: 'HW1' }, error: null },
    course_sections: { data: { institution_id: 'inst-1' }, error: null },
    assignment_submissions: {
      data: {
        id: 'sub-1', assignment_id: 'asg-1', student_id: 'stu-1', status: 'submitted',
        score: null, feedback: '', rubric_scores: [], rubric_comments: {}, graded_with_rubric: false,
        assignment: { section_id: 'sec-1', points: 100, title: 'HW1', settings: {} },
      },
      error: null,
    },
  })
  mockVerifySectionAccess.mockResolvedValue({ ok: true, role, adminDb: adminClient })
}

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  mockVerifySectionAccess.mockReset()
  mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions')
})

describe('deleteAssignment — professor only (#749)', () => {
  it.each(['ta', 'grader'] as const)(
    'refuses a %s and never reaches the delete',
    async (role) => {
      asRole(role)
      const res = await mod.deleteAssignment('sec-1', 'asg-1')

      expect(res.error).toBe('Only the professor can delete an assignment.')
      /* The guard sits above the existence lookup, so a correct refusal touches no
         table at all. This is what separates "refused" from "refused after reading
         the row" — and, if the guard were ever moved below the lookup, from
         "refused after deleting it". */
      expect(adminClient._tableCalls).toEqual([])
    },
  )

  it('still lets the professor delete — the narrowing is not a lockout', async () => {
    asRole('professor')
    const res = await mod.deleteAssignment('sec-1', 'asg-1')

    expect(res.error).toBeUndefined()
    expect(adminClient._tableCalls).toContain('assignments')
  })
})

describe('score writes admit graders (#746)', () => {
  /* Each of these four actions had its own copy of the canWriteAsStaff check, so
     they were fixed one by one and can regress one by one. The refusal strings are
     per-action, which is exactly why a shared helper would be the wrong assertion
     here — the message identifies WHICH gate fired. */
  const REFUSALS: Record<string, string> = {
    gradeSubmission: "You don't have permission to grade here.",
    gradeStudent: "You don't have permission to grade here.",
    resolveRegradeRequest: "You don't have permission to resolve regrades here.",
    addSubmissionCommentAsStaff: "You don't have permission to comment here.",
  }

  const invoke = async (name: string) => {
    switch (name) {
      case 'gradeSubmission':
        return mod.gradeSubmission('sec-1', {
          submissionId: '550e8400-e29b-41d4-a716-446655440000',
          score: 50,
          feedback: '',
        })
      case 'gradeStudent':
        return mod.gradeStudent('sec-1', 'asg-1', 'stu-1', { score: 50, feedback: '' })
      case 'resolveRegradeRequest':
        return mod.resolveRegradeRequest('sec-1', 'req-1', { decision: 'denied', response: 'no' })
      case 'addSubmissionCommentAsStaff':
        return mod.addSubmissionCommentAsStaff('sec-1', 'sub-1', 'a comment')
      default:
        throw new Error(`unhandled action ${name}`)
    }
  }

  it.each(Object.keys(REFUSALS))(
    '%s no longer refuses a grader at the role gate',
    async (name) => {
      asRole('grader')
      const res = await invoke(name)

      /* Asserting on the gate's exact string rather than on overall success: the
         write paths past this point need fixtures that have nothing to do with the
         issue, and their absence must not be mistaken for a refusal. Before #746
         every one of these returned precisely this message. */
      expect(res?.error).not.toBe(REFUSALS[name])
    },
  )

  it('does not widen a grader beyond score writes — deletion is still refused', async () => {
    /* canGrade is deliberately narrow. If someone "simplifies" the three predicates
       into one, this test and the deleteAssignment block above disagree, which is
       the intended tripwire. */
    asRole('grader')
    const res = await mod.deleteAssignment('sec-1', 'asg-1')
    expect(res.error).toBe('Only the professor can delete an assignment.')
  })

  it('keeps suggestGrades on canWriteAsStaff — grading is not commissioning AI work', async () => {
    /* The one deliberate exception, and the reason it needs a test of its own: it
       sits in a block of five near-identical guards that all moved to canGrade, with
       the SAME refusal string as gradeSubmission. It reads like an oversight. Anyone
       tidying for consistency would "fix" it, and the cost is a grader spending the
       section's AI budget — a resource decision, not a grading one. Pinning it here
       means the exception has to be argued with rather than assumed stale. */
    asRole('grader')
    const res = await mod.suggestGrades('sec-1', 'asg-1')
    expect(res.error).toBe("You don't have permission to grade here.")
  })
})
