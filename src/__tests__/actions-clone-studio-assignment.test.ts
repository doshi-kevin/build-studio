// cloneStudioAssignment must not let a clone share storage objects with its source.
//
// The clone copies the source's settings blob verbatim, which includes settings.pdfs[].path and
// settings.rubricSources[].path. Left pointing at the same objects, removeAssignmentPdf /
// removeRubricSource — which hard-delete by path with no reference counting — would delete the
// ORIGINAL's file, 404ing a live assignment's brief for every enrolled student. So the clone gets
// its own copies and its settings are repointed at them.
//
// Pattern 2: module-level mock vars + vi.mock + vi.resetModules() + dynamic import.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()

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

const SOURCE_PDF = { path: 'sec-1/assignment-pdfs/asg-src/1-brief.pdf', name: 'brief.pdf' }
const SOURCE_RUBRIC_SRC = { path: 'sec-1/assignment-rubric-sources/asg-src/1-key.pdf', name: 'key.pdf' }

function makeAdmin({
  copyError = null as { message: string } | null,
  rpcError = null as { message: string } | null,
  legacySinglePdf = false,
} = {}) {
  const source = {
    title: 'Midterm brief',
    submission_type: 'files',
    points: 100,
    is_graded: true,
    created_by: 'prof-1',
    settings: legacySinglePdf
      ? // Pre-multi-PDF templates stored a single `pdf` object; parseAssignmentPdfs folds it in.
        { pdf: SOURCE_PDF, rubric: { questions: [] } }
      : {
          pdfs: [SOURCE_PDF],
          rubricSources: [SOURCE_RUBRIC_SRC],
          rubric: { questions: [] },
        },
  }

  const chainFor = (data: unknown) => {
    const c: Record<string, unknown> = {}
    c.select = () => c
    c.eq = () => c
    c.maybeSingle = () => Promise.resolve({ data, error: null })
    c.single = () => Promise.resolve({ data, error: null })
    c.insert = () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'asg-clone' }, error: null }) }) })
    c.delete = deleteFn
    return c
  }
  // Capture the .eq(...) args so a test can assert WHICH row was deleted — the same chain serves
  // every from('assignments') call, so an unscoped assertion would also pass if the SOURCE was hit.
  const deleteEq = vi.fn().mockResolvedValue({ error: null })
  const deleteFn = vi.fn(() => ({ eq: deleteEq }))

  const copy = vi.fn().mockResolvedValue({ error: copyError })
  // The fail-closed path also removes the copies it just made, so the orphaned objects don't
  // outlive the row they belonged to.
  const remove = vi.fn().mockResolvedValue({ error: null })
  const rpc = vi.fn().mockResolvedValue({ error: rpcError })

  const adminDb = {
    from: (t: string) => {
      // The source lookup, the insert and the fail-closed delete all ride this one chain.
      if (t === 'assignments') return chainFor(source)
      if (t === 'course_sections') return chainFor({ institution_id: 'inst-1' })
      return chainFor(null)
    },
    storage: { from: () => ({ copy, remove }) },
    rpc,
  }
  return { adminDb, copy, remove, rpc, deleteFn, deleteEq }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
  mockVerifySectionAccess.mockReset()
  mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions')
})

describe('cloneStudioAssignment — storage objects are copied, never shared', () => {
  it('copies every source file and repoints the clone at the NEW paths', async () => {
    const { adminDb, copy, rpc } = makeAdmin()
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })

    const res = await mod.cloneStudioAssignment('sec-1', 'asg-src')
    expect(res).toEqual({ success: true, assignmentId: 'asg-clone' })

    // One copy per source file, each FROM the source path.
    expect(copy).toHaveBeenCalledTimes(2)
    const froms = copy.mock.calls.map((c) => c[0])
    expect(froms).toContain(SOURCE_PDF.path)
    expect(froms).toContain(SOURCE_RUBRIC_SRC.path)

    // Every destination is under the CLONE's id, so the two assignments can never collide.
    for (const [, to] of copy.mock.calls) {
      expect(to).toContain('asg-clone')
      expect(to).not.toBe(SOURCE_PDF.path)
      expect(to).not.toBe(SOURCE_RUBRIC_SRC.path)
    }

    // The clone's settings are rewritten to the copies — no source path survives.
    const [fn, args] = rpc.mock.calls[0]
    expect(fn).toBe('merge_assignment_settings')
    expect(args.p_assignment_id).toBe('asg-clone')
    const paths = [...args.p_patch.pdfs, ...args.p_patch.rubricSources].map((f: { path: string }) => f.path)
    expect(paths).not.toContain(SOURCE_PDF.path)
    expect(paths).not.toContain(SOURCE_RUBRIC_SRC.path)
    // Names are preserved so the clone still reads the same to the professor.
    expect(args.p_patch.pdfs[0].name).toBe('brief.pdf')
    // The legacy single `pdf` key is dropped so it can't keep pointing at the source's object.
    expect(args.p_remove).toContain('pdf')
  })

  it('drops a file it could not copy rather than leaving it pointed at the source', async () => {
    const { adminDb, rpc } = makeAdmin({ copyError: { message: 'storage down' } })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })

    const res = await mod.cloneStudioAssignment('sec-1', 'asg-src')
    expect(res).toEqual({ success: true, assignmentId: 'asg-clone' })

    const [, args] = rpc.mock.calls[0]
    expect(args.p_patch.pdfs).toEqual([])
    expect(args.p_patch.rubricSources).toEqual([])
  })

  it('fails closed — deletes the draft if the settings could not be repointed', async () => {
    const { adminDb, deleteFn, deleteEq, remove } = makeAdmin({ rpcError: { message: 'rpc down' } })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })

    const res = await mod.cloneStudioAssignment('sec-1', 'asg-src')

    // Better to hand back an error than a clone whose deletes would nuke the original's files.
    expect(res).toEqual({ error: 'Could not create the assignment from that template. Please try again.' })
    expect(deleteFn).toHaveBeenCalled()
    // The CLONE, never the source.
    expect(deleteEq).toHaveBeenCalledWith('id', 'asg-clone')
    // And the copies are cleaned up — only the clone's own paths, never the source's.
    const removed: string[] = remove.mock.calls[0][0]
    expect(removed).toHaveLength(2)
    for (const path of removed) {
      expect(path).toContain('asg-clone')
      expect(path).not.toBe(SOURCE_PDF.path)
      expect(path).not.toBe(SOURCE_RUBRIC_SRC.path)
    }
  })

  it('copies the LEGACY single `pdf` key too, and drops it from the clone', async () => {
    const { adminDb, copy, rpc } = makeAdmin({ legacySinglePdf: true })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })

    const res = await mod.cloneStudioAssignment('sec-1', 'asg-src')
    expect(res).toEqual({ success: true, assignmentId: 'asg-clone' })

    // Without this the clone would keep pointing at the source's object AND `p_remove: ['pdf']`
    // would strip its only reference — losing the brief with no way back.
    expect(copy).toHaveBeenCalledTimes(1)
    expect(copy.mock.calls[0][0]).toBe(SOURCE_PDF.path)
    const [, args] = rpc.mock.calls[0]
    expect(args.p_patch.pdfs).toHaveLength(1)
    expect(args.p_patch.pdfs[0].path).toContain('asg-clone')
    expect(args.p_remove).toContain('pdf')
  })
})
