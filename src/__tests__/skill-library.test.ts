// Tests for the course-wide skill library (src/lib/skills/library.ts, issue #173).
//
// The behaviours that carry the safety of the feature — each one, if it broke,
// would either lose a professor's curation or leak the wrong concepts forward:
//   - seeding NEVER touches a section that already has any skill row,
//   - seeding rebuilds the two-level hierarchy (subtopics under the new mains),
//   - publishing sends up only TRACKED skills (excluded / suppressed stay behind),
//   - publishing de-dups against the library by canonical name ("Back-Propagation"
//     must not become a second entry next to "backpropagation"),
//   - every read and write is SCOPED (section for `skills`, course for
//     `course_skills`) — this runs on the admin client, so the query filters are
//     the whole tenant boundary,
//   - a re-publish that changes nothing writes nothing (it runs on every reconcile),
//   - a course-less section is a no-op in both directions.
//
// Driven by a table-routed in-memory admin double, same shape as
// skill-recompute.test.ts. The double RECORDS the filters each query was scoped
// by rather than treating .eq() as a no-op passthrough: a filter-blind double
// cannot tell a correctly-scoped read from one that returns the whole table.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { seedSectionSkillsFromLibrary, publishSectionSkillsToLibrary } from '@/lib/skills/library'

const SECTION = 'sec-1'

interface SectionSkillFx {
  id: string
  parent_id: string | null
  name: string
  info?: string | null
  position?: number
  excluded?: boolean
  suppressed?: boolean
  library_skill_id?: string | null
}

interface LibraryFx {
  id: string
  parent_id: string | null
  name: string
  info?: string | null
  position?: number
}

interface Fixture {
  course_sections?: { course_id: string | null; institution_id: string } | null
  skills?: SectionSkillFx[]
  course_skills?: LibraryFx[]
  /** Simulate the course-wide canonical unique index firing: the first
   *  course_skills insert is rejected, and these rows — the ones another section
   *  of the course committed in the meantime — are what a re-read then finds. */
  courseSkillsInsertConflict?: LibraryFx[]
}

type Filters = Array<[string, unknown]>

function makeAdmin(fx: Fixture) {
  const inserted: Record<string, Array<Record<string, unknown>>> = { skills: [], course_skills: [] }
  const updated: Array<{ table: string; patch: Record<string, unknown>; filters: Filters }> = []
  const reads: Array<{ table: string; head: boolean; filters: Filters }> = []
  let idSeq = 0
  let conflictFired = false

  function chain(table: string) {
    let result: { data: unknown; error: unknown } = { data: [], error: null }
    if (table === 'course_sections') result = { data: fx.course_sections ?? null, error: null }
    if (table === 'skills') result = { data: fx.skills ?? [], error: null }
    if (table === 'course_skills') result = { data: fx.course_skills ?? [], error: null }

    // The query in flight on this handle, so .eq() knows which record to scope.
    let current: { filters: Filters } | null = null
    const self: Record<string, unknown> = {}
    // `select` doubles as the count probe the seed guard uses
    // (.select('id', { count: 'exact', head: true })).
    self.select = (_cols?: string, opts?: { count?: string; head?: boolean }) => {
      const read = { table, head: !!opts?.head, filters: [] as Filters }
      reads.push(read)
      current = read
      if (opts?.head) {
        const rows = (result.data ?? []) as unknown[]
        const counted = { count: Array.isArray(rows) ? rows.length : 0, data: null, error: null }
        const probe: Record<string, unknown> = {}
        probe.eq = (col: string, val: unknown) => { read.filters.push([col, val]); return probe }
        for (const m of ['in', 'order', 'limit']) probe[m] = () => probe
        probe.then = (resolve: (v: unknown) => unknown) => resolve(counted)
        return probe
      }
      return self
    }
    self.eq = (col: string, val: unknown) => { current?.filters.push([col, val]); return self }
    for (const m of ['in', 'is', 'not', 'order', 'limit']) self[m] = () => self
    self.maybeSingle = async () => result
    self.then = (resolve: (v: unknown) => unknown) => resolve(result)
    self.insert = (rows: Array<Record<string, unknown>>) => {
      let ret: { data: unknown; error: unknown }
      if (table === 'course_skills' && fx.courseSkillsInsertConflict && !conflictFired) {
        conflictFired = true
        // The loser's rows are NOT written; the winner's are what a re-read sees.
        fx.course_skills = [...(fx.course_skills ?? []), ...fx.courseSkillsInsertConflict]
        ret = { data: null, error: { code: '23505', message: 'duplicate key value' } }
      } else {
        const withIds = rows.map((r) => ({ ...r, id: `${table}-new-${++idSeq}` }))
        inserted[table]!.push(...withIds)
        ret = { data: withIds, error: null }
      }
      const thenable: Record<string, unknown> = {
        select: () => thenable,
        then: (resolve: (v: unknown) => unknown) => resolve(ret),
      }
      return thenable
    }
    self.update = (patch: Record<string, unknown>) => {
      const rec = { table, patch, filters: [] as Filters }
      updated.push(rec)
      const t: Record<string, unknown> = {}
      t.eq = (col: string, val: unknown) => { rec.filters.push([col, val]); return t }
      t.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
      return t
    }
    return self
  }

  return { admin: { from: (t: string) => chain(t) }, inserted, updated, reads }
}

const inst = { course_id: 'course-1', institution_id: 'inst-1' }

/** The one read of `table` matching the head/non-head shape. */
const readOf = (reads: Array<{ table: string; head: boolean; filters: Filters }>, table: string, head = false) =>
  reads.find((r) => r.table === table && r.head === head)!

describe('seedSectionSkillsFromLibrary', () => {
  it('copies the library hierarchy into an empty section', async () => {
    const { admin, inserted, reads } = makeAdmin({
      course_sections: inst,
      skills: [],
      course_skills: [
        { id: 'lib-main', parent_id: null, name: 'Language Modeling', position: 0 },
        { id: 'lib-sub', parent_id: 'lib-main', name: 'Perplexity', position: 0 },
      ],
    })

    const res = await seedSectionSkillsFromLibrary(admin, SECTION)

    expect(res.seeded).toBe(2)
    const mains = inserted.skills!.filter((r) => r.parent_id === null)
    const subs = inserted.skills!.filter((r) => r.parent_id !== null)
    expect(mains).toHaveLength(1)
    expect(subs).toHaveLength(1)
    // The subtopic hangs off the NEW section row, not the library id.
    expect(subs[0]!.parent_id).toBe(mains[0]!.id)
    // Seeded rows are tracked from birth and carry their provenance.
    expect(mains[0]).toMatchObject({
      section_id: SECTION,
      institution_id: 'inst-1',
      source: 'professor',
      excluded: false,
      suppressed: false,
      library_skill_id: 'lib-main',
    })
    // The library read is scoped to THIS course — unscoped it would seed another
    // course's concepts into the section.
    expect(readOf(reads, 'course_skills').filters).toEqual([['course_id', 'course-1']])
  })

  it('refuses to seed a section that already has any skill row', async () => {
    const { admin, inserted, reads } = makeAdmin({
      course_sections: inst,
      // A single EXCLUDED row still counts: the professor has curated here.
      skills: [{ id: 's1', parent_id: null, name: 'Something', excluded: true }],
      course_skills: [{ id: 'lib-main', parent_id: null, name: 'Language Modeling' }],
    })

    const res = await seedSectionSkillsFromLibrary(admin, SECTION)

    expect(res.seeded).toBe(0)
    expect(inserted.skills).toHaveLength(0)
    // The emptiness probe is the entire safety story, so assert WHAT it counted:
    // a probe scoped to anything but this section either never seeds at all, or
    // seeds into a section the professor already curated.
    expect(readOf(reads, 'skills', true).filters).toEqual([['section_id', SECTION]])
  })

  it('no-ops for a section with no course', async () => {
    const { admin, inserted } = makeAdmin({
      course_sections: { course_id: null, institution_id: 'inst-1' },
      course_skills: [{ id: 'lib-main', parent_id: null, name: 'Language Modeling' }],
    })

    expect(await seedSectionSkillsFromLibrary(admin, SECTION)).toEqual({ seeded: 0 })
    expect(inserted.skills).toHaveLength(0)
  })
})

describe('publishSectionSkillsToLibrary', () => {
  it('publishes only tracked skills, with subtopics under their main', async () => {
    const { admin, inserted, reads } = makeAdmin({
      course_sections: inst,
      skills: [
        { id: 's-main', parent_id: null, name: 'Language Modeling', position: 0 },
        { id: 's-sub', parent_id: 's-main', name: 'Perplexity', position: 0 },
        { id: 's-dropped', parent_id: null, name: 'Course Logistics', excluded: true },
        { id: 's-suggested', parent_id: null, name: 'Maybe Concept', suppressed: true },
      ],
      course_skills: [],
    })

    const res = await publishSectionSkillsToLibrary(admin, SECTION)

    expect(res.published).toBe(2)
    const names = inserted.course_skills!.map((r) => r.name)
    expect(names).toEqual(['Language Modeling', 'Perplexity'])
    expect(names).not.toContain('Course Logistics')
    expect(names).not.toContain('Maybe Concept')
    const libMain = inserted.course_skills!.find((r) => r.name === 'Language Modeling')!
    const libSub = inserted.course_skills!.find((r) => r.name === 'Perplexity')!
    expect(libSub.parent_id).toBe(libMain.id)
    expect(libMain).toMatchObject({ course_id: 'course-1', institution_id: 'inst-1' })
    // The pool read runs on the ADMIN client, which bypasses RLS: unscoped it
    // would hand back every section's — and every institution's — skills and
    // publish them all into this one course's library.
    expect(readOf(reads, 'skills').filters).toEqual([['section_id', SECTION]])
  })

  it('links to an existing library entry instead of duplicating a spelling variant', async () => {
    const { admin, inserted, updated } = makeAdmin({
      course_sections: inst,
      skills: [{ id: 's-main', parent_id: null, name: 'Back-Propagation' }],
      course_skills: [{ id: 'lib-bp', parent_id: null, name: 'backpropagation' }],
    })

    const res = await publishSectionSkillsToLibrary(admin, SECTION)

    expect(res.published).toBe(0)
    expect(inserted.course_skills).toHaveLength(0)
    // The section row is linked to the entry that already existed, and the
    // link-back is scoped to this section as well as the row id.
    expect(updated).toEqual([
      { table: 'skills', patch: { library_skill_id: 'lib-bp' }, filters: [['id', 's-main'], ['section_id', SECTION]] },
    ])
  })

  it('links to the row that won a concurrent publish rather than losing the link', async () => {
    // Another section of this course commits "backpropagation" between our
    // library read and our insert, so the canonical unique index rejects ours.
    // Failing to link here is silent but not harmless: an unlinked section skill
    // forks a SECOND library entry the next time it is renamed.
    const { admin, inserted, updated } = makeAdmin({
      course_sections: inst,
      skills: [{ id: 's-main', parent_id: null, name: 'Back-Propagation' }],
      course_skills: [],
      courseSkillsInsertConflict: [{ id: 'lib-winner', parent_id: null, name: 'backpropagation' }],
    })

    const res = await publishSectionSkillsToLibrary(admin, SECTION)

    expect(res.published).toBe(0) // the loser's insert published nothing
    expect(inserted.course_skills).toHaveLength(0)
    expect(updated).toEqual([
      { table: 'skills', patch: { library_skill_id: 'lib-winner' }, filters: [['id', 's-main'], ['section_id', SECTION]] },
    ])
  })

  it('drops a subtopic whose main was excluded rather than promoting it to a main', async () => {
    const { admin, inserted } = makeAdmin({
      course_sections: inst,
      skills: [
        { id: 's-main', parent_id: null, name: 'Dropped Main', excluded: true },
        { id: 's-sub', parent_id: 's-main', name: 'Orphan Sub' },
      ],
      course_skills: [],
    })

    const res = await publishSectionSkillsToLibrary(admin, SECTION)

    expect(res.published).toBe(0)
    expect(inserted.course_skills).toHaveLength(0)
  })

  it('carries a rename into the already-linked library entry', async () => {
    const { admin, updated } = makeAdmin({
      course_sections: inst,
      skills: [{ id: 's-main', parent_id: null, name: 'Neural Language Models', library_skill_id: 'lib-nlm' }],
      course_skills: [{ id: 'lib-nlm', parent_id: null, name: 'Neural LMs' }],
    })

    await publishSectionSkillsToLibrary(admin, SECTION)

    expect(updated).toEqual([
      {
        table: 'course_skills',
        patch: expect.objectContaining({ name: 'Neural Language Models' }),
        filters: [['id', 'lib-nlm']],
      },
    ])
  })

  it('writes nothing when a fully-linked, unchanged section re-publishes', async () => {
    // Publish runs at the END OF EVERY reconcile, which itself runs on every
    // mastery recompute. Steady state has to be zero writes, not one UPDATE per
    // skill per run.
    const { admin, inserted, updated } = makeAdmin({
      course_sections: inst,
      skills: [
        { id: 's-main', parent_id: null, name: 'Language Modeling', library_skill_id: 'lib-main' },
        { id: 's-sub', parent_id: 's-main', name: 'Perplexity', library_skill_id: 'lib-sub' },
      ],
      course_skills: [
        { id: 'lib-main', parent_id: null, name: 'Language Modeling' },
        { id: 'lib-sub', parent_id: 'lib-main', name: 'Perplexity' },
      ],
    })

    const res = await publishSectionSkillsToLibrary(admin, SECTION)

    expect(res).toEqual({ published: 0 })
    expect(inserted.course_skills).toHaveLength(0)
    expect(updated).toEqual([])
  })

  it('no-ops for a section with no course', async () => {
    // The library lives on the course; a course-less section has nowhere to
    // publish to, and must not invent a course_id to write against.
    const { admin, inserted, updated } = makeAdmin({
      course_sections: { course_id: null, institution_id: 'inst-1' },
      skills: [{ id: 's-main', parent_id: null, name: 'Language Modeling' }],
      course_skills: [],
    })

    expect(await publishSectionSkillsToLibrary(admin, SECTION)).toEqual({ published: 0 })
    expect(inserted.course_skills).toHaveLength(0)
    expect(updated).toEqual([])
  })
})
