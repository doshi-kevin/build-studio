/**
 * Student handles (src/lib/studio/handles.ts): the only way a plugin refers to a student.
 * The database is mocked; what's under test is the derivation and what each reader gets.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/studio/db', () => ({ loadInstallationHandleSalt: vi.fn(), loadSectionRoster: vi.fn() }))

const db = await import('@/lib/studio/db')
const { studentHandle, loadHandleKey, rosterHandles, rosterNames, displayName } = await import('@/lib/studio/handles')

const SALT = 'f'.repeat(64)
const OTHER_SALT = 'e'.repeat(64)
const STUDENT = '00000000-0000-4000-8000-000000000001'
const INSTALLATION = crypto.randomUUID()
const SECTION = crypto.randomUUID()

const student = (id: string, first: string | null, last: string | null, name: string | null = null) => ({ id, firstName: first, lastName: last, name })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(db.loadInstallationHandleSalt).mockResolvedValue(SALT)
})

describe('studentHandle', () => {
  it('is st_ and the first 20 base32hex characters of HMAC-SHA256(salt, student ID)', () => {
    // Computed independently: Python's hmac and base64.b32hexencode, lowercased.
    expect(studentHandle(SALT, STUDENT)).toBe('st_1hdk04q1f41rtav9s5pa')
  })

  it('is stable for one installation and unlinkable across installations', () => {
    expect(studentHandle(SALT, STUDENT)).toBe(studentHandle(SALT, STUDENT))
    expect(studentHandle(OTHER_SALT, STUDENT)).not.toBe(studentHandle(SALT, STUDENT))
  })

  it('always has the catalog’s shape', () => {
    for (let i = 0; i < 200; i++) expect(studentHandle(SALT, crypto.randomUUID())).toMatch(/^st_[0-9a-v]{20}$/)
  })
})

describe('loadHandleKey', () => {
  it('derives with the installation’s own salt, and fails closed without one', async () => {
    const key = await loadHandleKey(INSTALLATION)
    expect(db.loadInstallationHandleSalt).toHaveBeenCalledWith(INSTALLATION)
    expect(key?.of(STUDENT)).toBe(studentHandle(SALT, STUDENT))

    vi.mocked(db.loadInstallationHandleSalt).mockResolvedValue(null)
    expect(await loadHandleKey(INSTALLATION)).toBeNull()
  })
})

describe('rosterHandles and rosterNames', () => {
  const ROSTER = [student(crypto.randomUUID(), 'Ada', 'Lovelace'), student(crypto.randomUUID(), 'Alan', 'Turing'), student(STUDENT, null, null, 'Grace')]

  beforeEach(() => vi.mocked(db.loadSectionRoster).mockResolvedValue(ROSTER))

  it('course.roster gets handles only, sorted by handle rather than by name or enrollment', async () => {
    const handles = await rosterHandles(INSTALLATION, SECTION)
    expect(db.loadSectionRoster).toHaveBeenCalledWith(SECTION)
    const expected = ROSTER.map((s) => studentHandle(SALT, s.id)).sort()
    expect(handles).toEqual(expected.map((handle) => ({ handle })))
    expect(JSON.stringify(handles)).not.toMatch(/Ada|Alan|Grace|Lovelace|Turing/)
  })

  it('the professor’s page gets a name for each handle', async () => {
    expect(await rosterNames(INSTALLATION, SECTION)).toEqual({
      [studentHandle(SALT, ROSTER[0].id)]: 'Ada Lovelace',
      [studentHandle(SALT, ROSTER[1].id)]: 'Alan Turing',
      [studentHandle(SALT, STUDENT)]: 'Grace',
    })
  })

  it('both fail closed when the roster or the salt can’t be read', async () => {
    vi.mocked(db.loadSectionRoster).mockResolvedValue(null)
    expect(await rosterHandles(INSTALLATION, SECTION)).toBeNull()
    expect(await rosterNames(INSTALLATION, SECTION)).toBeNull()
    vi.mocked(db.loadSectionRoster).mockResolvedValue(ROSTER)
    vi.mocked(db.loadInstallationHandleSalt).mockResolvedValue(null)
    expect(await rosterHandles(INSTALLATION, SECTION)).toBeNull()
  })
})

describe('displayName', () => {
  it.each([
    [student(STUDENT, 'Ada', 'Lovelace', 'Countess'), 'Ada Lovelace'],
    [student(STUDENT, 'Ada', null), 'Ada'],
    [student(STUDENT, ' ', ' ', 'A. Lovelace'), 'A. Lovelace'],
    [student(STUDENT, null, null, null), 'Student'],
  ])('%j reads as %s', (s, expected) => {
    expect(displayName(s)).toBe(expected)
  })
})
