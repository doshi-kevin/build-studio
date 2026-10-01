// submitVerbalAssessment's deadline gate.
//
// submitAssignment has always gated on canSubmitPastDeadline (twice — once up front and once on a
// fresh re-read). The verbal path had NO deadline gate at all and did not even select due_at, so a
// recorded verbal assessment could be handed in after the deadline when the equivalent file or text
// submission would be refused. These tests pin the gate and the reopen-window override.
//
// Pattern 2: module-level mock vars + vi.mock + vi.resetModules() + dynamic import.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockAdmin = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => mockAdmin() }))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/events/emit', () => ({ markFeedItemDone: vi.fn(), emitEvent: vi.fn() }))
vi.mock('@/lib/events/audience', () => ({ resolveStaffAudience: vi.fn(async () => ['staff-1']) }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
// Transcription/TTS must never be reached on a rejected submit — asserted below.
const mockTranscribe = vi.fn()
vi.mock('@/lib/ai/elevenlabs/stt', () => ({
  transcribeRecording: (...a: unknown[]) => mockTranscribe(...a),
  sliceByOffsets: vi.fn(() => []),
}))
vi.mock('@/lib/ai/elevenlabs/tts', () => ({ synthesizeSpeech: vi.fn() }))

const PAST_DUE = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
const FUTURE = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()

function makeAdmin({
  dueAt = PAST_DUE as string | null,
  existing = null as null | Record<string, unknown>,
} = {}) {
  const assignment = {
    id: 'asg-1',
    section_id: 'sec-1',
    status: 'published',
    institution_id: 'inst-1',
    due_at: dueAt,
    // Marks it as a verbal assessment so the action gets past its kind check.
    settings: { kind: 'verbal', verbalAssessment: { questions: [] } },
  }
  const chainFor = (data: unknown) => {
    const c: Record<string, unknown> = {}
    c.select = () => c
    c.eq = () => c
    c.in = () => c
    c.is = () => c
    c.maybeSingle = () => Promise.resolve({ data, error: null })
    c.upsert = vi.fn().mockResolvedValue({ error: null })
    c.update = () => c
    return c
  }
  return {
    client: {
      from: (t: string) => {
        if (t === 'assignments') return chainFor(assignment)
        if (t === 'enrollments') return chainFor({ id: 'enr-1' })
        if (t === 'assignment_submissions') return chainFor(existing)
        return chainFor(null)
      },
      storage: { from: () => ({ upload: vi.fn().mockResolvedValue({ error: null }) }) },
    },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'stu-1' } }, error: null })
  mockAdmin.mockReset()
  // ok:false = "transcription unavailable", the action's supported degraded path. Lets the
  // allowed-submission cases run to completion instead of throwing inside the mock.
  mockTranscribe.mockReset().mockResolvedValue({ ok: false, words: [] })
  mod = await import('@/app/(dashboard)/student/courses/[sectionId]/assignments/actions')
})

/** A minimal FormData for the action; the deadline gate rejects before any of it is read. */
function formData() {
  const fd = new FormData()
  fd.set('answers', JSON.stringify([]))
  fd.set('video', new File([new Uint8Array([1, 2, 3])], 'take.webm', { type: 'video/webm' }))
  return fd
}

describe('submitVerbalAssessment — deadline gate', () => {
  it('rejects a submission after the deadline when no reopen window was granted', async () => {
    mockAdmin.mockReturnValue(makeAdmin({ dueAt: PAST_DUE }).client)

    const res = await mod.submitVerbalAssessment('sec-1', 'asg-1', formData())

    expect(res).toEqual({
      error: 'The deadline for this assignment has passed. Ask your instructor to reopen it for you.',
    })
    // The expensive path must not run for a rejected submit.
    expect(mockTranscribe).not.toHaveBeenCalled()
  })

  it('allows it past the deadline when the professor granted an ACTIVE reopen window', async () => {
    mockAdmin.mockReturnValue(
      makeAdmin({ dueAt: PAST_DUE, existing: { id: 'sub-1', status: 'draft', files: [], resubmit_until: FUTURE } })
        .client,
    )

    const res = await mod.submitVerbalAssessment('sec-1', 'asg-1', formData())

    // Asserting the real value, not just "not the deadline error": a negative assertion here would
    // also pass if the gate didn't exist at all, which is exactly the bug being pinned.
    expect(res).toEqual({ success: true })
  })

  it('an EXPIRED reopen window does not reopen the deadline', async () => {
    const expired = new Date(Date.now() - 60_000).toISOString()
    mockAdmin.mockReturnValue(
      makeAdmin({ dueAt: PAST_DUE, existing: { id: 'sub-1', status: 'draft', files: [], resubmit_until: expired } })
        .client,
    )

    const res = await mod.submitVerbalAssessment('sec-1', 'asg-1', formData())

    expect(res).toEqual({
      error: 'The deadline for this assignment has passed. Ask your instructor to reopen it for you.',
    })
  })

  it('an assignment with no due date is never deadline-gated', async () => {
    mockAdmin.mockReturnValue(makeAdmin({ dueAt: null }).client)

    const res = await mod.submitVerbalAssessment('sec-1', 'asg-1', formData())

    expect(res).toEqual({ success: true })
  })
})
