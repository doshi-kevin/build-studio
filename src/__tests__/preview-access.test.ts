// Authorization tests for `resolvePreviewSource` — the ONE decision behind both
// source-document preview routes (/api/extraction/page renders a page; /api/extraction/pdf
// returns the WHOLE converted document). Both take an item id or storage path straight
// from the client and then read the bytes with the RLS-BYPASSING admin client, so every
// deny below is the only thing standing between an attacker and course material they
// aren't entitled to. Until this file, that decision had no automated coverage at all —
// only a one-off manual probe table in e2e/visual/extraction-and-citation.md, and only
// against the page route.
//
// The admin double is deliberately ROW-AWARE: it stores rows and evaluates the actual
// .eq()/.in() filters against them. A filter-blind stub returns the same enrollment row
// no matter who asks, so it cannot tell a correct gate from one that dropped
// `.eq('student_id', …)` — which is precisely the IDOR these tests exist to catch.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockVerifySectionAccess = vi.fn()

vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: (...args: unknown[]) => mockVerifySectionAccess(...args),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let resolvePreviewSource: any

const STUDENT = 'student-1'
const SECTION = 'sec-1'
const MODULE = 'mod-1'
const ITEM = 'item-1'
const STORED_PATH = `${SECTION}/${MODULE}/${ITEM}/deck.pptx`
const EXTRACTION = { pages: 3, units: [] }

const FUTURE = new Date(Date.now() + 86_400_000).toISOString()
const PAST = new Date(Date.now() - 86_400_000).toISOString()

type Row = Record<string, unknown>

interface Chain {
  select: () => Chain
  eq: (col: string, val: unknown) => Chain
  in: (col: string, vals: unknown[]) => Chain
  maybeSingle: () => Promise<{ data: Row | null; error: null }>
}

/**
 * Row-aware admin-client double. `.eq`/`.in` become predicates over the seeded rows,
 * so a query that forgets a filter starts matching rows it shouldn't — the mutation
 * a blind stub would wave through. `reads` records which tables were touched.
 */
function makeAdminDb(tables: Record<string, Row[]>) {
  const reads: string[] = []
  return {
    reads,
    from(table: string): Chain {
      reads.push(table)
      const preds: ((r: Row) => boolean)[] = []
      const chain: Chain = {
        select: () => chain,
        eq: (col, val) => {
          preds.push((r) => r[col] === val)
          return chain
        },
        in: (col, vals) => {
          preds.push((r) => vals.includes(r[col]))
          return chain
        },
        maybeSingle: async () => {
          const match = (tables[table] ?? []).find((r) => preds.every((p) => p(r)))
          return { data: match ?? null, error: null }
        },
      }
      return chain
    },
  }
}

/** The happy-path world: a visible item in a published, open module, student enrolled. */
function world(over: { item?: Row | null; mod?: Row | null; enrollments?: Row[] } = {}) {
  const item =
    over.item === undefined
      ? { id: ITEM, module_id: MODULE, is_visible: true, content: { filePath: STORED_PATH, extraction: EXTRACTION } }
      : over.item
  const mod =
    over.mod === undefined ? { id: MODULE, section_id: SECTION, is_published: true, unlock_date: null } : over.mod
  const enrollments = over.enrollments ?? [
    { id: 'enr-1', section_id: SECTION, student_id: STUDENT, status: 'enrolled' },
  ]
  return makeAdminDb({
    module_items: item ? [item] : [],
    modules: mod ? [mod] : [],
    enrollments,
  })
}

beforeEach(async () => {
  vi.resetModules()
  mockVerifySectionAccess.mockReset()
  // Default: the caller is NOT staff. Staff cases opt in explicitly.
  mockVerifySectionAccess.mockResolvedValue({ ok: false })
  const mod = await import('@/lib/extraction/preview-access')
  resolvePreviewSource = mod.resolvePreviewSource
})

describe('resolvePreviewSource — item mode, enrolled student', () => {
  it('resolves the stored path and the item extraction', async () => {
    const db = world()
    const res = await resolvePreviewSource(db, STUDENT, { itemId: ITEM })
    expect(res).toEqual({ ok: true, filePath: STORED_PATH, itemExtraction: EXTRACTION })
  })

  it.each(['completed', 'active'])('accepts a %s enrollment', async (status) => {
    const db = world({ enrollments: [{ id: 'e', section_id: SECTION, student_id: STUDENT, status }] })
    const res = await resolvePreviewSource(db, STUDENT, { itemId: ITEM })
    expect(res.ok).toBe(true)
  })

  it('denies a caller whose enrollment is in a DIFFERENT section', async () => {
    // Kills a dropped `.eq('section_id', …)`: this user is a legitimate student
    // somewhere, just not here.
    const db = world({ enrollments: [{ id: 'e', section_id: 'sec-9', student_id: STUDENT, status: 'enrolled' }] })
    const res = await resolvePreviewSource(db, STUDENT, { itemId: ITEM })
    expect(res).toEqual({ ok: false, status: 403, message: 'Forbidden' })
  })

  it("denies a caller when only a CLASSMATE's enrollment exists (IDOR guard)", async () => {
    // Kills a dropped `.eq('student_id', userId)` — the row is in the right section,
    // so a filter-blind check would authorize a total stranger.
    const db = world({ enrollments: [{ id: 'e', section_id: SECTION, student_id: 'student-2', status: 'enrolled' }] })
    const res = await resolvePreviewSource(db, STUDENT, { itemId: ITEM })
    expect(res).toEqual({ ok: false, status: 403, message: 'Forbidden' })
  })

  it.each(['dropped', 'pending', 'withdrawn'])('denies a %s enrollment', async (status) => {
    // Kills a widened / dropped status filter.
    const db = world({ enrollments: [{ id: 'e', section_id: SECTION, student_id: STUDENT, status }] })
    const res = await resolvePreviewSource(db, STUDENT, { itemId: ITEM })
    expect(res.status).toBe(403)
  })

  it('denies a hidden item, and denies a NULL is_visible (not just false)', async () => {
    for (const is_visible of [false, null, undefined]) {
      const db = world({
        item: { id: ITEM, module_id: MODULE, is_visible, content: { filePath: STORED_PATH } },
      })
      const res = await resolvePreviewSource(db, STUDENT, { itemId: ITEM })
      expect(res, `is_visible=${String(is_visible)}`).toEqual({ ok: false, status: 403, message: 'Forbidden' })
    }
  })

  it('denies an unpublished module, and denies a NULL is_published (not just false)', async () => {
    for (const is_published of [false, null, undefined]) {
      const db = world({ mod: { id: MODULE, section_id: SECTION, is_published, unlock_date: null } })
      const res = await resolvePreviewSource(db, STUDENT, { itemId: ITEM })
      expect(res, `is_published=${String(is_published)}`).toEqual({ ok: false, status: 403, message: 'Forbidden' })
    }
  })

  it('denies a module whose unlock_date has not arrived, and allows one that has', async () => {
    const locked = world({ mod: { id: MODULE, section_id: SECTION, is_published: true, unlock_date: FUTURE } })
    expect(await resolvePreviewSource(locked, STUDENT, { itemId: ITEM })).toEqual({
      ok: false,
      status: 403,
      message: 'Forbidden',
    })

    const opened = world({ mod: { id: MODULE, section_id: SECTION, is_published: true, unlock_date: PAST } })
    expect((await resolvePreviewSource(opened, STUDENT, { itemId: ITEM })).ok).toBe(true)
  })

  it('404s an unknown item id without consulting section access', async () => {
    const db = world({ item: null })
    const res = await resolvePreviewSource(db, STUDENT, { itemId: 'no-such-item' })
    expect(res).toEqual({ ok: false, status: 404, message: 'Not found' })
    expect(mockVerifySectionAccess).not.toHaveBeenCalled()
  })

  it('404s when the item points at a module that does not resolve to a section', async () => {
    for (const mod of [null, { id: MODULE, section_id: null, is_published: true, unlock_date: null }]) {
      const db = world({ mod })
      const res = await resolvePreviewSource(db, STUDENT, { itemId: ITEM })
      expect(res).toEqual({ ok: false, status: 404, message: 'Not found' })
    }
  })
})

describe('resolvePreviewSource — item mode, section staff', () => {
  beforeEach(() => {
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor' })
  })

  it('sees an item that is hidden, unpublished AND unlock-pending', async () => {
    const db = world({
      item: { id: ITEM, module_id: MODULE, is_visible: false, content: { filePath: STORED_PATH } },
      mod: { id: MODULE, section_id: SECTION, is_published: false, unlock_date: FUTURE },
      enrollments: [],
    })
    const res = await resolvePreviewSource(db, 'prof-1', { itemId: ITEM })
    expect(res.ok).toBe(true)
    expect(res.filePath).toBe(STORED_PATH)
    // Authorized on the section resolved FROM the item, never on a client-supplied one.
    expect(mockVerifySectionAccess).toHaveBeenCalledWith(SECTION, 'prof-1')
  })

  it('404s a stored filePath that names another section, even for that section owner', async () => {
    // The professor controls `content.filePath`; without this bind, an item in a
    // section they own could name another institution's object and get it served back.
    const db = world({
      item: { id: ITEM, module_id: MODULE, is_visible: true, content: { filePath: 'sec-2/mod-9/item-9/secret.pdf' } },
    })
    const res = await resolvePreviewSource(db, 'prof-1', { itemId: ITEM })
    expect(res).toEqual({ ok: false, status: 404, message: 'Not found' })
  })

  it('404s a stored filePath that traverses out while keeping the section prefix', async () => {
    const db = world({
      item: {
        id: ITEM,
        module_id: MODULE,
        is_visible: true,
        content: { filePath: `${SECTION}/../sec-2/secret.pdf` },
      },
    })
    const res = await resolvePreviewSource(db, 'prof-1', { itemId: ITEM })
    expect(res).toEqual({ ok: false, status: 404, message: 'Not found' })
  })

  it('404s an item with no stored filePath', async () => {
    for (const content of [{}, null, { filePath: '' }]) {
      const db = world({ item: { id: ITEM, module_id: MODULE, is_visible: true, content } })
      const res = await resolvePreviewSource(db, 'prof-1', { itemId: ITEM })
      expect(res).toEqual({ ok: false, status: 404, message: 'Not found' })
    }
  })

  it('carries no itemExtraction when the item never stored one', async () => {
    const db = world({ item: { id: ITEM, module_id: MODULE, is_visible: true, content: { filePath: STORED_PATH } } })
    const res = await resolvePreviewSource(db, 'prof-1', { itemId: ITEM })
    expect(res).toEqual({ ok: true, filePath: STORED_PATH, itemExtraction: undefined })
  })
})

describe('resolvePreviewSource — path mode (ad-hoc quiz uploads, staff only)', () => {
  const UPLOAD = `${SECTION}/quiz-ai-uploads/deck_1712.pptx`

  it('returns the path for section staff, with no extraction and no item lookup', async () => {
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor' })
    const db = world()
    const res = await resolvePreviewSource(db, 'prof-1', { filePath: UPLOAD })
    expect(res).toEqual({ ok: true, filePath: UPLOAD })
    // Path mode must never fall through to the enrollment branch.
    expect(db.reads).toEqual([])
    expect(mockVerifySectionAccess).toHaveBeenCalledWith(SECTION, 'prof-1')
  })

  it('denies a student — enrollment is never enough for an upload (it may hold answers)', async () => {
    const db = world() // caller is enrolled in SECTION, but not staff
    const res = await resolvePreviewSource(db, STUDENT, { filePath: UPLOAD })
    expect(res).toEqual({ ok: false, status: 403, message: 'Forbidden' })
  })

  it('denies traversal that keeps the authorized prefix, before section access is consulted', async () => {
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor' })
    const res = await resolvePreviewSource(world(), 'prof-1', {
      filePath: `${SECTION}/quiz-ai-uploads/../../sec-2/answers.pdf`,
    })
    expect(res).toEqual({ ok: false, status: 403, message: 'Forbidden' })
    expect(mockVerifySectionAccess).not.toHaveBeenCalled()
  })

  it('denies a path outside quiz-ai-uploads/, even for staff of that section', async () => {
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor' })
    // Path mode skips every item-level visibility check, so it must not become a
    // general reader for the section's storage prefix.
    const res = await resolvePreviewSource(world(), 'prof-1', { filePath: STORED_PATH })
    expect(res).toEqual({ ok: false, status: 403, message: 'Forbidden' })
  })

  it('denies a path with no usable section segment', async () => {
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor' })
    // A bare filename makes the whole name the "section", so the prefix check rejects it.
    expect(await resolvePreviewSource(world(), 'prof-1', { filePath: 'deck.pptx' })).toEqual({
      ok: false,
      status: 403,
      message: 'Forbidden',
    })
    // A leading slash leaves an EMPTY first segment, which short-circuits to 400 before
    // the prefix check. Different code, same outcome: no section is ever authorized.
    expect(
      await resolvePreviewSource(world(), 'prof-1', { filePath: '/quiz-ai-uploads/deck.pptx' }),
    ).toEqual({ ok: false, status: 400, message: 'Bad request' })
    expect(mockVerifySectionAccess).not.toHaveBeenCalled()
  })

  it('takes precedence over itemId, so a student cannot get item treatment by adding ?path=', async () => {
    const db = world() // the item alone WOULD resolve for this student
    const res = await resolvePreviewSource(db, STUDENT, { itemId: ITEM, filePath: UPLOAD })
    expect(res).toEqual({ ok: false, status: 403, message: 'Forbidden' })
    expect(db.reads).toEqual([])
  })
})

describe('resolvePreviewSource — bad input', () => {
  it('400s when neither an item nor a path is supplied', async () => {
    for (const params of [{}, { itemId: null, filePath: null }, { itemId: '', filePath: '' }]) {
      const res = await resolvePreviewSource(world(), STUDENT, params)
      expect(res).toEqual({ ok: false, status: 400, message: 'Bad request' })
    }
  })
})
