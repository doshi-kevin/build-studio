/**
 * The Postgres retriever's second try: a focused search whose words found nothing runs once
 * more on the focused modules' published titles. The database functions are mocked; their
 * SQL runs against Postgres in src/__tests__/db/studio-course-context.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CourseUnitRow } from '@/lib/studio/builder/course-material'

vi.mock('@/lib/auth/section-access', () => ({ verifySectionAccess: vi.fn(), canWriteAsProfessor: vi.fn() }))
vi.mock('@/lib/studio/db', () => ({
  loadOwnerRosterFullNames: vi.fn(),
  loadSectionFocus: vi.fn(),
  courseSearch: vi.fn(),
}))

const db = await import('@/lib/studio/db')
const { postgresRetriever, retrievalScope } = await import('@/lib/studio/builder/course-retriever')

const INSTITUTION = crypto.randomUUID()
const SECTION = crypto.randomUUID()
const scope = retrievalScope({ institutionId: INSTITUTION, sectionId: SECTION, ownerId: crypto.randomUUID() })!
const row: CourseUnitRow = {
  unitKey: 'p:a1b2c3d4-1111-4111-8111-00000000000a:2',
  sourceKind: 'item',
  moduleTitle: 'Week 6: Cellular respiration',
  weekNumber: 6,
  itemType: 'lecture',
  page: 2,
  title: 'Glycolysis',
  heading: null,
  disclosure: 'released',
  opensAt: null,
  excerpt: 'Glycolysis splits glucose into two pyruvate.',
}
const modules = [
  { id: 'm6', title: 'Week 6: Cellular respiration', weekNumber: 6, unlockDate: null, isPublished: true },
  { id: 'm7', title: 'Week 7: Genetics', weekNumber: 7, unlockDate: null, isPublished: true },
]

beforeEach(() => {
  vi.mocked(db.loadOwnerRosterFullNames).mockResolvedValue([])
  vi.mocked(db.loadSectionFocus).mockResolvedValue({ startDate: null, modules })
  vi.mocked(db.courseSearch).mockReset()
})

describe('a focused search that found nothing', () => {
  it('tries the focused week’s title in the same course and reports the words it used', async () => {
    vi.mocked(db.courseSearch).mockResolvedValueOnce({ rows: [], withheld: 0 }).mockResolvedValueOnce({ rows: [row], withheld: 1 })
    const r = await postgresRetriever.search(scope, 'flashcards', 'week:6')
    expect(vi.mocked(db.courseSearch).mock.calls).toEqual([
      [INSTITUTION, SECTION, 'flashcards', ['m6'], expect.any(Number)],
      [INSTITUTION, SECTION, 'Cellular respiration', ['m6'], expect.any(Number)],
    ])
    expect(r).toMatchObject({ ok: true, keys: [row.unitKey], withheld: 1, query: 'Cellular respiration' })
  })

  it('keeps the first answer, with no query of its own, when the titles find nothing either', async () => {
    vi.mocked(db.courseSearch).mockResolvedValueOnce({ rows: [], withheld: 2 }).mockResolvedValueOnce({ rows: [], withheld: 0 })
    const r = await postgresRetriever.search(scope, 'flashcards', 'week:6')
    expect(r).toEqual({ ok: true, shown: [], keys: [], scheduled: [], withheld: 2 })
  })

  it('has nothing to fall back on without a focus', async () => {
    vi.mocked(db.courseSearch).mockResolvedValueOnce({ rows: [], withheld: 0 })
    const r = await postgresRetriever.search(scope, 'flashcards', null)
    expect(db.courseSearch).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ ok: true, keys: [] })
    expect(r).not.toHaveProperty('query')
  })
})

it('a search that found something never runs a second time', async () => {
  vi.mocked(db.courseSearch).mockResolvedValueOnce({ rows: [row], withheld: 0 })
  const r = await postgresRetriever.search(scope, 'glycolysis', 'week:6')
  expect(db.courseSearch).toHaveBeenCalledTimes(1)
  expect(r).not.toHaveProperty('query')
})
