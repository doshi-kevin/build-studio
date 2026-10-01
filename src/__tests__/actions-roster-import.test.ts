// Tests for the admin bulk roster import actions (previewRosterImport / commitRosterChunk).
// Covers the rules that matter: institution-scoped resolution, course/section ambiguity,
// idempotent enrollment writes (re-enroll via guarded update, 23505 → already enrolled),
// one account per duplicate new email, and per-row error isolation.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module-Level Mock References ─────────────────────────────

const mockVerifyAdmin = vi.fn()
const mockAdminClient = vi.fn()
const mockProvision = vi.fn()
const mockSendCredentials = vi.fn()
const mockEmitEvent = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/events/emit', () => ({ emitEvent: (...args: unknown[]) => mockEmitEvent(...args) }))
vi.mock('@/lib/auth/admin-context', () => ({
  verifyInstitutionAdmin: (...args: unknown[]) => mockVerifyAdmin(...args),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/admin/provision-student', () => ({
  provisionStudentAccount: (...args: unknown[]) => mockProvision(...args),
}))
vi.mock('@/lib/email', () => ({
  sendStudentCredentials: (...args: unknown[]) => mockSendCredentials(...args),
}))

// ── Chain builders ───────────────────────────────────────────

/** Thenable query chain: any await along the chain resolves `result`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function thenableChain(result: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  for (const m of ['select', 'eq', 'in', 'limit', 'order']) {
    chain[m] = vi.fn().mockReturnValue(chain)
  }
  chain.single = vi.fn(() => Promise.resolve(result))
  chain.maybeSingle = vi.fn(() => Promise.resolve(result))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chain.then = (res: any, rej: any) => Promise.resolve(result).then(res, rej)
  return chain
}

interface DbState {
  profiles?: unknown[]
  courses?: unknown[]
  sections?: unknown[]
  /** existing enrollment rows returned by the pair lookup */
  enrollments?: unknown[]
  /** on-roster head-count per capacity check */
  count?: number
  /** result of .insert().select('id').single() */
  insertResult?: { data: unknown; error: unknown }
  /** rows matched by the guarded re-enroll UPDATE */
  updateRows?: unknown[]
}

/** enrollments chain: lookup / capacity-count / insert / update, by verb used. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function enrollmentsChain(state: DbState, spies: { inserts: any[]; updates: any[] }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  let mode: 'lookup' | 'count' | 'insert' | 'update' = 'lookup'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chain.select = vi.fn((_cols?: string, opts?: any) => {
    if (opts?.head) mode = 'count'
    return chain
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chain.insert = vi.fn((payload: any) => {
    mode = 'insert'
    spies.inserts.push(payload)
    return chain
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chain.update = vi.fn((payload: any) => {
    mode = 'update'
    spies.updates.push(payload)
    return chain
  })
  for (const m of ['eq', 'in', 'limit', 'order']) chain[m] = vi.fn().mockReturnValue(chain)
  chain.single = vi.fn(() =>
    Promise.resolve(state.insertResult ?? { data: { id: 'enr-new-1' }, error: null })
  )
  chain.maybeSingle = chain.single
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chain.then = (res: any, rej: any) => {
    const result =
      mode === 'count'
        ? { count: state.count ?? 0, error: null }
        : mode === 'update'
          ? { data: state.updateRows ?? [{ id: 'enr-upd-1' }], error: null }
          : { data: state.enrollments ?? [], error: null }
    return Promise.resolve(result).then(res, rej)
  }
  return chain
}

function mockDb(state: DbState) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spies = { inserts: [] as any[], updates: [] as any[], eqCalls: {} as Record<string, any[]> }
  const admin = {
    from: vi.fn((table: string) => {
      if (table === 'profiles') {
        const c = thenableChain({ data: state.profiles ?? [], error: null })
        spies.eqCalls.profiles = c.eq.mock.calls
        return c
      }
      if (table === 'courses') {
        const c = thenableChain({ data: state.courses ?? [], error: null })
        spies.eqCalls.courses = c.eq.mock.calls
        return c
      }
      if (table === 'course_sections') {
        const c = thenableChain({ data: state.sections ?? [], error: null })
        spies.eqCalls.course_sections = c.eq.mock.calls
        return c
      }
      return enrollmentsChain(state, spies)
    }),
  }
  mockAdminClient.mockReturnValue(admin)
  return { admin, spies }
}

// ── Fixtures ─────────────────────────────────────────────────

const INST = 'inst-1'
const csCourse = { id: 'course-cs', code: 'CS-101', title: 'Intro to CS', department: { id: 'd1', name: 'CS Dept' } }
const csSection = { id: 'sec-cs-a', course_id: 'course-cs', section_code: 'A', semester: 'fall', year: 2026, max_students: null }
const existingStudent = { id: 'stu-1', email: 'jane@uni.edu', role: 'student', name: 'Jane Doe' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let previewRosterImport: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let commitRosterChunk: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let updateEnrollmentPolicy: any

beforeEach(async () => {
  vi.resetModules()
  mockVerifyAdmin.mockReset()
  mockAdminClient.mockReset()
  mockProvision.mockReset()
  mockSendCredentials.mockReset()
  mockEmitEvent.mockReset()

  mockVerifyAdmin.mockResolvedValue({ userId: 'admin-1', institutionId: INST })
  mockSendCredentials.mockResolvedValue(true)

  const mod = await import('@/app/(dashboard)/admin/students/roster-actions')
  previewRosterImport = mod.previewRosterImport
  commitRosterChunk = mod.commitRosterChunk
  updateEnrollmentPolicy = mod.updateEnrollmentPolicy
})

// ── previewRosterImport ──────────────────────────────────────

describe('previewRosterImport', () => {
  it('rejects when the caller is not an institution admin', async () => {
    mockVerifyAdmin.mockResolvedValue({ error: 'Unauthorized — admin access required' })
    const result = await previewRosterImport('jane@uni.edu, CS-101')
    expect(result.error).toBe('Unauthorized — admin access required')
  })

  it('scopes every resolution query to the verified institution', async () => {
    const { spies } = mockDb({ profiles: [existingStudent], courses: [csCourse], sections: [csSection] })
    await previewRosterImport('jane@uni.edu, CS-101')
    expect(spies.eqCalls.profiles).toContainEqual(['institution_id', INST])
    expect(spies.eqCalls.courses).toContainEqual(['institution_id', INST])
    expect(spies.eqCalls.course_sections).toContainEqual(['institution_id', INST])
  })

  it('classifies a mixed paste row by row without writing', async () => {
    const { spies } = mockDb({
      profiles: [existingStudent],
      courses: [csCourse],
      sections: [csSection],
      enrollments: [],
    })
    const result = await previewRosterImport(
      ['jane@uni.edu, CS-101', 'New Kid, new@uni.edu, CS-101', 'ghost@uni.edu, NOPE-999'].join('\n')
    )
    expect(result.success).toBe(true)
    expect(result.results.map((r: { status: string }) => r.status)).toEqual(['enroll', 'create_enroll', 'error'])
    expect(result.results[2].detail).toContain('NOPE-999')
    expect(result.summary).toMatchObject({ enroll: 1, createAndEnroll: 1, errors: 1 })
    expect(spies.inserts).toHaveLength(0)
    expect(spies.updates).toHaveLength(0)
    expect(mockProvision).not.toHaveBeenCalled()
  })

  it('errors on a course code that exists in two departments', async () => {
    mockDb({
      courses: [csCourse, { ...csCourse, id: 'course-cs-2', department: { id: 'd2', name: 'Math Dept' } }],
      sections: [csSection],
    })
    const result = await previewRosterImport('Jane Doe, jane2@uni.edu, CS-101')
    expect(result.results[0].status).toBe('error')
    expect(result.results[0].detail).toContain('more than one department')
  })

  it('errors on a multi-section course unless the row picks one with CODE/SECTION', async () => {
    const sectionB = { ...csSection, id: 'sec-cs-b', section_code: 'B' }
    mockDb({ profiles: [existingStudent], courses: [csCourse], sections: [csSection, sectionB] })

    const ambiguous = await previewRosterImport('jane@uni.edu, CS-101')
    expect(ambiguous.results[0].status).toBe('error')
    expect(ambiguous.results[0].detail).toContain('2 active sections')

    const picked = await previewRosterImport('jane@uni.edu, CS-101/B')
    expect(picked.results[0].status).toBe('enroll')
    expect(picked.results[0].detail).toContain('Section B')
  })

  it('rejects a staff email and a new email with no name', async () => {
    mockDb({
      profiles: [{ id: 'prof-1', email: 'prof@uni.edu', role: 'professor', name: 'Prof' }],
      courses: [csCourse],
      sections: [csSection],
    })
    const result = await previewRosterImport('prof@uni.edu, CS-101\nnameless@uni.edu, CS-101')
    expect(result.results[0].detail).toContain('staff account')
    expect(result.results[1].detail).toContain('needs a name')
  })

  it('marks previously dropped students as re-enroll and enrolled ones as skips', async () => {
    mockDb({
      profiles: [existingStudent, { id: 'stu-2', email: 'john@uni.edu', role: 'student', name: 'John' }],
      courses: [csCourse],
      sections: [csSection],
      enrollments: [
        { id: 'enr-1', student_id: 'stu-1', section_id: 'sec-cs-a', status: 'dropped' },
        { id: 'enr-2', student_id: 'stu-2', section_id: 'sec-cs-a', status: 'enrolled' },
      ],
    })
    const result = await previewRosterImport('jane@uni.edu, CS-101\njohn@uni.edu, CS-101')
    expect(result.results[0].status).toBe('reenroll')
    expect(result.results[1].status).toBe('already_enrolled')
  })

  it('warns (never blocks) when the import pushes a section over capacity', async () => {
    mockDb({
      profiles: [existingStudent],
      courses: [csCourse],
      sections: [{ ...csSection, max_students: 10 }],
      count: 10,
    })
    const result = await previewRosterImport('jane@uni.edu, CS-101')
    expect(result.results[0].status).toBe('enroll')
    expect(result.results[0].warning).toContain('11/10')
  })
})

// ── commitRosterChunk ────────────────────────────────────────

describe('commitRosterChunk', () => {
  it('creates ONE account for a new email on two rows and enrolls both', async () => {
    const { spies } = mockDb({ courses: [csCourse], sections: [csSection] })
    mockProvision.mockResolvedValue({ ok: true, profile: {}, userId: 'stu-new', password: 'temp-pw' })

    const result = await commitRosterChunk('New Kid, new@uni.edu, CS-101\nNew Kid, new@uni.edu, CS-101/A')
    expect(result.success).toBe(true)
    expect(mockProvision).toHaveBeenCalledTimes(1)
    expect(mockProvision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: 'new@uni.edu', cwid: null, institutionId: INST, invitedBy: 'admin-1' })
    )
    expect(spies.inserts).toHaveLength(2)
    expect(spies.inserts[0]).toMatchObject({ student_id: 'stu-new', section_id: 'sec-cs-a', status: 'enrolled', source: 'import' })
    // One credentials email for the account, not per row.
    expect(mockSendCredentials).toHaveBeenCalledTimes(1)
    expect(mockSendCredentials).toHaveBeenCalledWith('new@uni.edu', 'New Kid', null, 'temp-pw')
    expect(result.createdAccounts).toEqual([
      { email: 'new@uni.edu', name: 'New Kid', password: 'temp-pw', emailSent: true },
    ])
  })

  it('re-enrolls a dropped student via the guarded update and resets enrolled_at', async () => {
    const { spies } = mockDb({
      profiles: [existingStudent],
      courses: [csCourse],
      sections: [csSection],
      enrollments: [{ id: 'enr-1', student_id: 'stu-1', section_id: 'sec-cs-a', status: 'dropped' }],
      updateRows: [{ id: 'enr-1' }],
    })
    const result = await commitRosterChunk('jane@uni.edu, CS-101')
    expect(result.results[0].status).toBe('reenroll')
    expect(spies.updates[0]).toMatchObject({ status: 'enrolled', source: 'import' })
    expect(spies.updates[0].enrolled_at).toBeTruthy()
    expect(spies.inserts).toHaveLength(0)
  })

  it('downgrades to already_enrolled when the guarded update matches nothing (raced)', async () => {
    mockDb({
      profiles: [existingStudent],
      courses: [csCourse],
      sections: [csSection],
      enrollments: [{ id: 'enr-1', student_id: 'stu-1', section_id: 'sec-cs-a', status: 'dropped' }],
      updateRows: [],
    })
    const result = await commitRosterChunk('jane@uni.edu, CS-101')
    expect(result.results[0].status).toBe('already_enrolled')
  })

  it('downgrades a 23505 unique violation on insert to already_enrolled', async () => {
    mockDb({
      profiles: [existingStudent],
      courses: [csCourse],
      sections: [csSection],
      insertResult: { data: null, error: { code: '23505', message: 'duplicate key' } },
    })
    const result = await commitRosterChunk('jane@uni.edu, CS-101')
    expect(result.results[0].status).toBe('already_enrolled')
  })

  it('isolates a provisioning failure to that email and continues the chunk', async () => {
    const { spies } = mockDb({ profiles: [existingStudent], courses: [csCourse], sections: [csSection] })
    mockProvision.mockResolvedValue({ ok: false, error: 'Failed to create account: boom' })

    const result = await commitRosterChunk('Bad Kid, bad@uni.edu, CS-101\njane@uni.edu, CS-101')
    expect(result.results[0].status).toBe('error')
    expect(result.results[1].status).toBe('enroll')
    // Only ONE createUser attempt per failing email even if repeated.
    const repeat = await commitRosterChunk('Bad Kid, bad@uni.edu, CS-101\nBad Kid, bad@uni.edu, CS-101/A')
    expect(repeat.results.every((r: { status: string }) => r.status === 'error')).toBe(true)
    expect(mockProvision).toHaveBeenCalledTimes(2) // once per chunk, not per row
    expect(spies.inserts).toHaveLength(1) // only jane's row wrote
  })

  it('notifies each enrolled student via enrollment_added targeted at them alone', async () => {
    mockDb({ profiles: [existingStudent], courses: [csCourse], sections: [csSection] })
    await commitRosterChunk('jane@uni.edu, CS-101')
    expect(mockEmitEvent).toHaveBeenCalledTimes(1)
    expect(mockEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'enrollment_added',
        audience: ['stu-1'],
        sectionId: 'sec-cs-a',
        entity: { type: 'enrollment', id: 'enr-new-1' },
      })
    )
  })
})

// ── updateEnrollmentPolicy ───────────────────────────────────
// The admin half of the self-unenroll policy the student action reads
// (parseInstitutionSettings / dropSection). Two things must hold: an invalid
// window never reaches the DB, and the write MERGES under settings — clobbering
// the JSONB would silently drop every other institution setting.

/** institutions table double: select→settings, update→captured payload. */
/**
 * Institution double for updateEnrollmentPolicy.
 *
 * The write is no longer a bare `.update().eq()` — since #742 it carries the
 * optimistic guard, so the shape is
 * `.update().eq(id).eq(updated_at?).select(...).maybeSingle()`. The chain therefore
 * has to know whether `update()` has been called, because `select()` means "read the
 * settings" before it and "read back the written row" after it.
 *
 * `guardMatches: false` models the stale write: the UPDATE's WHERE excludes the row,
 * so Postgres returns zero rows rather than an error.
 */
function mockInstitutionDb(
  opts: {
    settings?: unknown
    fetchError?: unknown
    updateError?: unknown
    updatedAt?: string | null
    guardMatches?: boolean
  } = {}
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: any[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const guards: any[] = []
  const updatedAt = opts.updatedAt ?? '2026-08-21T00:00:00.000Z'
  const guardMatches = opts.guardMatches ?? true
  let updated = false

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  chain.select = vi.fn().mockReturnValue(chain)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chain.update = vi.fn((payload: any) => {
    updates.push(payload)
    updated = true
    return chain
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chain.eq = vi.fn((col: string, val: any) => {
    if (updated && col === 'updated_at') guards.push(val)
    return chain
  })
  chain.single = vi.fn(() =>
    Promise.resolve({
      data: opts.fetchError ? null : { settings: opts.settings ?? {}, updated_at: updatedAt },
      error: opts.fetchError ?? null,
    })
  )
  chain.maybeSingle = vi.fn(() => {
    /* After the update: the written row, or null when the guard excluded it. Before
       it (the conflict re-read), the current row. */
    if (opts.updateError) return Promise.resolve({ data: null, error: opts.updateError })
    if (updated && !guardMatches) {
      updated = false // the next maybeSingle is the conflict re-read
      return Promise.resolve({ data: null, error: null })
    }
    return Promise.resolve({
      data: { settings: opts.settings ?? {}, updated_at: updatedAt },
      error: null,
    })
  })
  mockAdminClient.mockReturnValue({ from: vi.fn(() => chain) })
  return { updates, guards }
}

describe('updateEnrollmentPolicy', () => {
  it('rejects a caller who is not an institution admin', async () => {
    mockVerifyAdmin.mockResolvedValue({ error: 'Unauthorized — admin access required' })
    const { updates } = mockInstitutionDb()
    const result = await updateEnrollmentPolicy({ enabled: true, days: 14 })
    expect(result.error).toBe('Unauthorized — admin access required')
    expect(updates).toHaveLength(0)
  })

  it.each([0, 366, 1.5])('rejects an out-of-range window (%s days) without writing', async (days) => {
    const { updates } = mockInstitutionDb()
    const result = await updateEnrollmentPolicy({ enabled: true, days })
    expect(result.error).toContain('between 1 and 365')
    expect(updates).toHaveLength(0)
  })

  it('merges the policy under settings without clobbering sibling keys', async () => {
    const { updates } = mockInstitutionDb({ settings: { branding: { logo: 'x.png' }, selfUnenroll: { enabled: false, days: 14 } } })

    const result = await updateEnrollmentPolicy({ enabled: true, days: 30 })

    expect(result.success).toBe(true)
    expect(updates[0].settings).toEqual({
      branding: { logo: 'x.png' },
      selfUnenroll: { enabled: true, days: 30 },
    })
  })

  it('surfaces a load failure instead of writing a settings blob from nothing', async () => {
    const { updates } = mockInstitutionDb({ fetchError: { message: 'boom' } })
    const result = await updateEnrollmentPolicy({ enabled: true, days: 30 })
    expect(result.error).toBe('Could not load institution settings')
    expect(updates).toHaveLength(0)
  })

  it('reports a failed write rather than claiming success', async () => {
    mockInstitutionDb({ updateError: { message: 'boom' } })
    const result = await updateEnrollmentPolicy({ enabled: false, days: 14 })
    expect(result.error).toBe('Failed to save the policy')
  })

  /* ── Optimistic concurrency (#742) ─────────────────────────────
   * Two admins editing this policy at once used to lose one change silently while
   * BOTH were shown success. Reproduced live with two sessions (7 days vs 21 days):
   * two success toasts, one stored value.
   *
   * The guard also protects the read-modify-write on the settings JSONB, which
   * rebuilds the whole object from a value read moments earlier — harmless while
   * selfUnenroll is the only key, and a lost-update the instant there are two.
   */
  it('sends the rendered updated_at as the guard so a stale write cannot match', async () => {
    const { guards } = mockInstitutionDb({ settings: {} })
    const result = await updateEnrollmentPolicy({ enabled: true, days: 30 }, '2026-08-20T09:00:00.000Z')
    expect(result.success).toBe(true)
    /* In the WHERE, not compared beforehand — a pre-flight compare is the same race. */
    expect(guards).toEqual(['2026-08-20T09:00:00.000Z'])
  })

  it('reports a conflict, NOT success, when the guard matches zero rows', async () => {
    mockInstitutionDb({ settings: { selfUnenroll: { enabled: true, days: 7 } }, guardMatches: false })
    const result = await updateEnrollmentPolicy({ enabled: true, days: 21 }, '2026-08-20T09:00:00.000Z')

    expect(result.success).toBeUndefined()
    expect(result.conflict).toBe(true)
    expect(result.error).toBeTruthy()
    /* Hands back what actually won, so the loser sees the real value instead of
       being told to go and find it. */
    expect(result.current?.policy).toEqual({ enabled: true, days: 7 })
  })

  it('still writes when no baseline is supplied, but applies no guard', async () => {
    /* Deliberately NOT fail-closed: this action has callers that predate the guard,
       and refusing them would break saving outright. The action logs a warning
       instead — the absence of the predicate is the thing worth catching here. */
    const { guards } = mockInstitutionDb({ settings: {} })
    const result = await updateEnrollmentPolicy({ enabled: false, days: 14 })
    expect(result.success).toBe(true)
    expect(guards).toEqual([])
  })
})
