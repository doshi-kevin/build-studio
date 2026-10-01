// Authorization tests for student intel vote/answer actions (security review
// Vuln 10). toggleAnswerVote/toggleTipVote had only an auth check; submitAnswer
// never bound the question to the course. They must require course enrolment
// and bind the answer/tip/question to that course.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildFullChain, createMockAdminClient } from './helpers/mock-supabase'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockGetCourseId = vi.fn()
const mockVerifyAlumni = vi.fn()

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
vi.mock('@/lib/supabase/queries', () => ({
  intelQueries: {
    getCourseIdFromSection: (...a: unknown[]) => mockGetCourseId(...a),
    verifyAlumniStatus: (...a: unknown[]) => mockVerifyAlumni(...a),
  },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  mockAdminClient.mockReset()
  mockGetCourseId.mockReset().mockResolvedValue('course-1')
  mockVerifyAlumni.mockReset().mockResolvedValue(true)
  mod = await import('@/app/(dashboard)/student/courses/[sectionId]/intel/actions')
})

describe('toggleAnswerVote — authorization', () => {
  it('rejects a non-enrolled user and never writes a vote', async () => {
    mockVerifyAlumni.mockResolvedValue(false)
    const client = createMockAdminClient({})
    mockAdminClient.mockReturnValue(client)

    const res = await mod.toggleAnswerVote('answer-1', 'section-1')
    expect(res.error).toBe('You must be enrolled in this course to vote')
    expect(client._tableCalls).not.toContain('course_answer_votes')
  })

  it('rejects an answer that belongs to another course and never writes', async () => {
    const client = createMockAdminClient({
      course_answers: { data: null, error: null }, // not in course-1
    })
    mockAdminClient.mockReturnValue(client)

    const res = await mod.toggleAnswerVote('answer-x', 'section-1')
    expect(res.error).toBe('Answer not found')
    expect(client._tableCalls).not.toContain('course_answer_votes')
  })
})

describe('toggleTipVote — authorization', () => {
  it('rejects a tip that belongs to another course and never writes', async () => {
    const client = createMockAdminClient({
      course_tips: { data: null, error: null }, // not in course-1
    })
    mockAdminClient.mockReturnValue(client)

    const res = await mod.toggleTipVote('tip-x', 'section-1')
    expect(res.error).toBe('Tip not found')
    expect(client._tableCalls).not.toContain('course_tip_votes')
  })
})

describe('submitAnswer — question/course binding', () => {
  it('rejects a question that belongs to another course and never inserts', async () => {
    const client = createMockAdminClient({
      course_questions: { data: null, error: null }, // not in course-1
    })
    mockAdminClient.mockReturnValue(client)

    const res = await mod.submitAnswer('question-x', 'section-1', { body: 'an answer body' })
    expect(res.error).toBe('Question not found')
    expect(client._tableCalls).not.toContain('course_answers')
  })
})

/**
 * askQuestion was the one panel action with no eligibility check (#734).
 *
 * Its nine siblings all called resolveAndVerifyAlumni; this one resolved the
 * course and wrote. `sectionId` is an ordinary action argument and the whole path
 * runs on the admin client, so RLS is not a backstop — any authenticated user on
 * the platform could POST a question into any course in ANY institution, and it
 * would render on that course's Intel panel to its enrolled students. The Intel
 * page itself is gated by verifyFeatureEnabled, but the action is reachable
 * directly and the page gate protects the page, not the endpoint.
 *
 * The oracle is that course_questions is never touched. A test asserting only on
 * the returned error would also pass if the row were written and an error returned
 * afterwards, which is precisely the shape of a half-applied fix.
 */
describe('askQuestion — enrollment gate (#734)', () => {
  const VALID = { title: 'How is the midterm curved?', body: '' }

  it('rejects a user not enrolled in the course and writes no question', async () => {
    mockVerifyAlumni.mockResolvedValue(false)
    const client = createMockAdminClient({})
    mockAdminClient.mockReturnValue(client)

    const res = await mod.askQuestion('section-1', VALID)

    expect(res.error).toBe('You must be enrolled in this course to ask a question')
    expect(client._tableCalls).not.toContain('course_questions')
  })

  it('rejects a section that resolves to no course, before any write', async () => {
    /* An unresolvable sectionId must not fall through to a write with a null
       course_id — the row would be orphaned and invisible to moderation. */
    mockGetCourseId.mockResolvedValue(null)
    const client = createMockAdminClient({})
    mockAdminClient.mockReturnValue(client)

    const res = await mod.askQuestion('section-x', VALID)

    expect(res.error).toBe('Course not found')
    expect(client._tableCalls).not.toContain('course_questions')
  })

  it('still lets an enrolled student ask — the gate is not a lockout', async () => {
    /* buildFullChain, not createMockAdminClient: this case runs past the guard into
       the .insert(), which the read-only chain does not model. */
    const chain = buildFullChain({ data: { id: 'q-1' }, error: null })
    const tables: string[] = []
    mockAdminClient.mockReturnValue({ from: vi.fn((t: string) => { tables.push(t); return chain }) })

    const res = await mod.askQuestion('section-1', VALID)

    expect(res.error).toBeUndefined()
    expect(tables).toContain('course_questions')
  })
})

/**
 * Reviving a soft-deleted review must not launder a MODERATED one (#733).
 *
 * course_reviews_course_id_author_id_key is UNIQUE (course_id, author_id) and not
 * partial, so a soft-deleted row keeps occupying the author's one slot for the
 * course. Deleting your review to rewrite it — the obvious reason anyone deletes
 * one — therefore locked you out forever, and the refusal described a review you
 * could no longer see.
 *
 * The fix resurrects the hidden row instead. The load-bearing detail is the
 * `.eq('status', 'hidden')` predicate: without it, the same code path lets an
 * author flip a FLAGGED review back to active and erase a moderator's decision.
 * That predicate is one line, reads like defensive noise, and is exactly the kind
 * of thing a later refactor drops — so both halves are pinned here: that the
 * revive is scoped, and that an unscoped-revive candidate (zero rows) is refused
 * rather than silently succeeding.
 */
describe('submitReview — reviving a deleted review (#733)', () => {
  const VALID = {
    rating_overall: 4,
    rating_difficulty: 3,
    rating_workload: 3,
    rating_teaching: 5,
    rating_grading_fairness: 4,
  }

  /** One chain for course_reviews: the INSERT ends in .single(), the revive in
      .maybeSingle(), so the two outcomes are configurable independently. */
  function reviewChain(insert: unknown, revive: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'eq', 'insert', 'update']) chain[m] = vi.fn(() => chain)
    chain.single = vi.fn().mockResolvedValue(insert)
    chain.maybeSingle = vi.fn().mockResolvedValue(revive)
    return chain
  }

  const CONFLICT = { data: null, error: { code: '23505', message: 'duplicate key' } }

  it('scopes the revive to the hidden row, so a flagged review cannot be restored', async () => {
    const chain = reviewChain(CONFLICT, { data: { id: 'rev-1' }, error: null })
    mockAdminClient.mockReturnValue({ from: vi.fn(() => chain) })

    const res = await mod.submitReview('section-1', VALID)

    expect(res.success).toBe(true)
    /* The predicate IS the moderation boundary. Asserting it was sent, not just
       that the update ran — an unscoped update would also have succeeded here. */
    expect(chain.eq).toHaveBeenCalledWith('status', 'hidden')
  })

  it('falls back to the original refusal when no hidden row matched', async () => {
    /* Zero rows means the existing review is flagged (or a concurrent write already
       revived it). "You have already reviewed this course" is the honest answer
       there — and critically NOT a success, which would tell the author their
       rewrite was published when nothing changed. */
    const chain = reviewChain(CONFLICT, { data: null, error: null })
    mockAdminClient.mockReturnValue({ from: vi.fn(() => chain) })

    const res = await mod.submitReview('section-1', VALID)

    expect(res.error).toBe('You have already reviewed this course')
    expect(res.success).toBeUndefined()
  })
})

/**
 * The four ownership-only actions authorise on `author_id === user.id`, which is a
 * STRONGER bar than enrollment — you can only touch your own rows. But none of them
 * checked that the `sectionId` argument had anything to do with the row, and sectionId
 * is a plain client-supplied string that flows into logEvent({ sectionId }) and
 * revalidatePath(). So an author could tag their own edits with an arbitrary — even
 * another tenant's — section.
 *
 * Low impact on its own. Pinned anyway because the audit log is exactly what you reach
 * for after an incident, and a log you can write false entries into is worth less than
 * one you can't. The oracle is that the update never runs: a test asserting only on the
 * error would also pass if the row were written first.
 */
describe('ownership-only actions bind sectionId to the content', () => {
  /* buildFullChain, not createMockAdminClient: the latter's buildChain has no
     .update(), so the action threw and the "update never ran" assertion passed
     vacuously — which is the exact shape of test the oracle is supposed to rule out. */
  const routerFor = (table: string, row: unknown) => {
    const chain = buildFullChain({ data: row, error: null })
    return { client: { from: vi.fn(() => chain), rpc: vi.fn() }, chain }
  }

  it('deleteContent refuses a question whose course is not the one behind sectionId', async () => {
    const { client, chain } = routerFor('course_questions', { author_id: 'user-1', course_id: 'course-ELSEWHERE' })
    mockAdminClient.mockReturnValue(client)
    mockGetCourseId.mockResolvedValue('course-1')

    const res = await mod.deleteContent('course_questions', 'question-1', 'section-1')
    expect(res.error).toBe('Content not found')
    /* The refusal must land BEFORE the soft delete — the real oracle. */
    expect(chain.update).not.toHaveBeenCalled()
  })

  it('deleteContent still soft-deletes the author\'s own content in the right section', async () => {
    const { client, chain } = routerFor('course_questions', { author_id: 'user-1', course_id: 'course-1' })
    mockAdminClient.mockReturnValue(client)
    mockGetCourseId.mockResolvedValue('course-1')

    const res = await mod.deleteContent('course_questions', 'question-1', 'section-1')
    expect(res.success).toBe(true)
    expect(chain.update).toHaveBeenCalledWith({ status: 'hidden' })
  })

  it('deleteReview refuses a review from another course without writing', async () => {
    const { client, chain } = routerFor('course_reviews', { author_id: 'user-1', course_id: 'course-ELSEWHERE' })
    mockAdminClient.mockReturnValue(client)
    mockGetCourseId.mockResolvedValue('course-1')

    const res = await mod.deleteReview('review-1', 'section-1')
    expect(res.error).toBe('Review not found')
    expect(chain.update).not.toHaveBeenCalled()
  })
})

/**
 * uploadResource took `filePath` as a bare positional argument — createResourceSchema
 * validates only title/description/category/is_anonymous — so it was stored verbatim.
 *
 * That was inert while nothing re-signed it. It stopped being inert the moment
 * getResources began re-signing file_path with the ADMIN client, which bypasses storage
 * RLS by design: a member of ANY one course could pass `<otherCourseId>/x.pdf` and have
 * their own Resources tab hand back a working signed URL to another course's — another
 * institution's — object. The bucket's upload policy correctly blocks cross-course
 * WRITES; the object and the metadata row are authorized independently, and the path
 * travelled the unguarded route.
 *
 * Caught in security review of the very change that made it live, which is why the test
 * exists: the vulnerability was created by a fix, so the regression is a plausible one.
 *
 * Oracle is that nothing is INSERTED — an error-only assertion would also pass if the row
 * were written and the error returned afterwards.
 */
describe('uploadResource — the file path is confined to its own course', () => {
  const input = { title: 'Notes', category: 'notes' as const }

  const harness = () => {
    const chain = buildFullChain({ data: { id: 'res-1' }, error: null })
    mockAdminClient.mockReturnValue({ from: vi.fn(() => chain), rpc: vi.fn() })
    return chain
  }

  it.each([
    ['another course', 'course-ELSEWHERE/stolen.pdf'],
    ['traversal', 'course-1/../course-ELSEWHERE/stolen.pdf'],
    ['absolute', '/course-1/x.pdf'],
    ['no folder at all', 'x.pdf'],
    ['a prefix that merely starts the same', 'course-1-other/x.pdf'],
  ])('refuses a path in %s and inserts nothing', async (_label, path) => {
    const chain = harness()
    mockGetCourseId.mockResolvedValue('course-1')
    mockVerifyAlumni.mockResolvedValue(true)

    const res = await mod.uploadResource('section-1', input, path, 'f.pdf', 10, 'application/pdf')

    expect(res.error).toBe('Invalid file path')
    expect(chain.insert).not.toHaveBeenCalled()
  })

  it('accepts a path inside the resolved course and stores no client-supplied url', async () => {
    const chain = harness()
    mockGetCourseId.mockResolvedValue('course-1')
    mockVerifyAlumni.mockResolvedValue(true)

    const res = await mod.uploadResource('section-1', input, 'course-1/notes_123.pdf', 'notes.pdf', 10, 'application/pdf')

    expect(res.error).toBeUndefined()
    /* file_url is derived at read time now, so nothing a caller chose reaches the column —
       it used to be stored verbatim and rendered straight into an href. */
    expect(chain.insert).toHaveBeenCalledWith(expect.objectContaining({ file_url: '' }))
  })
})
