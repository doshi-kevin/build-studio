/**
 * Studio's access switches (access.ts), the student publication predicate, the frame
 * status answer, and plugin course tabs. The admin
 * client is a stub whose answers each test chooses; the entitlement logic is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StudioViewer } from '@/lib/studio/context'

type Answer = { data: unknown; error: unknown }
const answers: Record<string, Answer> = {}
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const answer = () => answers[table] ?? { data: null, error: null }
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => answer(),
        single: async () => answer(),
      }
      return query
    },
  }),
}))
vi.mock('@/lib/studio/db', () => ({ listSectionInstallations: vi.fn() }))

const access = await import('@/lib/studio/access')
const { isPublishedToStudents } = await import('@/lib/studio/publication')
const { frameStatusFor } = await import('@/lib/studio/bridge/status')
const { studentToolTabs, studentPastTools, professorToolTabs, sectionToolCount } = await import('@/lib/studio/navigation')
const { listSectionInstallations } = await import('@/lib/studio/db')
const { PROFESSOR_SIDEBAR_FEATURES, STUDIO_TOOL_KEY, activeFeatureKey, orderWithTools, studentSidebarFeatures, studioToolFeature } =
  await import('@/lib/course-features')

const INSTITUTION = crypto.randomUUID()
const settingsRow = (settings: unknown): Answer => ({ data: { settings }, error: null })

beforeEach(() => {
  for (const k of Object.keys(answers)) delete answers[k]
  vi.clearAllMocks()
})
afterEach(() => vi.unstubAllEnvs())

describe('the kill switch value', () => {
  it.each([
    ['no studio key', {}, false],
    ['disabled: false', { studio: { disabled: false } }, false],
    ['disabled: true', { studio: { disabled: true } }, true],
    ['a non-boolean disabled', { studio: { disabled: 'no' } }, true],
    ['a studio key that isn’t an object', { studio: 'off' }, true],
    ['studio: null', { studio: null }, true],
    ['settings that aren’t an object', ['studio'], true],
  ])('%s: engaged = %s', (_label, settings, engaged) => {
    expect(access.killSwitchEngagedBy(settings)).toBe(engaged)
  })
})

describe('studioKillSwitchEngaged', () => {
  it('fails closed when platform_settings can’t be read', async () => {
    answers.platform_settings = { data: null, error: { message: 'connection reset' } }
    expect(await access.studioKillSwitchEngaged()).toBe(true)
  })

  it('reads the stored decision', async () => {
    answers.platform_settings = settingsRow({ studio: { disabled: true } })
    expect(await access.studioKillSwitchEngaged()).toBe(true)
    answers.platform_settings = settingsRow({ ai: { allDisabled: true } })
    expect(await access.studioKillSwitchEngaged()).toBe(false)
  })

  it('a missing singleton row is an ops problem, not a stored decision', async () => {
    answers.platform_settings = { data: null, error: null }
    expect(await access.studioKillSwitchEngaged()).toBe(false)
  })
})

describe('studioAccess', () => {
  beforeEach(() => {
    answers.platform_settings = settingsRow({})
  })

  it('is off while the kill switch is engaged, whatever the entitlement', async () => {
    answers.platform_settings = settingsRow({ studio: { disabled: true } })
    answers.institutions = settingsRow({ entitlements: { granted: ['studio'] } })
    expect(await access.studioAccess(INSTITUTION)).toBe('off')
  })

  it('is read-only for a school without the Studio entitlement, which is the default', async () => {
    answers.institutions = settingsRow({})
    expect(await access.studioAccess(INSTITUTION)).toBe('read_only')
  })

  it('is read-only once the entitlement is revoked', async () => {
    answers.institutions = settingsRow({ entitlements: { granted: [], revoked: ['studio'] } })
    expect(await access.studioAccess(INSTITUTION)).toBe('read_only')
  })

  it('is full for a school granted Studio', async () => {
    answers.institutions = settingsRow({ entitlements: { granted: ['studio'] } })
    expect(await access.studioAccess(INSTITUTION)).toBe('full')
  })

  it('fails open on an entitlement read error, like every entitlement', async () => {
    answers.institutions = { data: null, error: { message: 'timeout' } }
    expect(await access.studioAccess(INSTITUTION)).toBe('full')
  })
})

describe('the release gate', () => {
  it.each([undefined, '', 'off', 'true', 'ON', 'on '])('stays closed for STUDIO_STUDENT_ACCESS=%j', (value) => {
    if (value !== undefined) vi.stubEnv('STUDIO_STUDENT_ACCESS', value)
    expect(access.studentAccessReleased()).toBe(false)
  })

  it('opens only for exactly "on"', () => {
    vi.stubEnv('STUDIO_STUDENT_ACCESS', 'on')
    expect(access.studentAccessReleased()).toBe(true)
  })
})

describe('isPublishedToStudents', () => {
  it('needs both the release gate and the professor showing the installation', () => {
    expect(isPublishedToStudents({ studentVisibility: 'visible' })).toBe(false)
    vi.stubEnv('STUDIO_STUDENT_ACCESS', 'on')
    expect(isPublishedToStudents({ studentVisibility: 'hidden' })).toBe(false)
    expect(isPublishedToStudents({ studentVisibility: 'visible' })).toBe(true)
  })
})

describe('frameStatusFor', () => {
  const VERSION = crypto.randomUUID()
  const viewer = (writable: boolean) => ({ versionId: VERSION, writable }) as StudioViewer

  it.each([
    ['no viewer', null, VERSION, 'unavailable'],
    ['another version', viewer(true), crypto.randomUUID(), 'stale'],
    ['a viewer who may not write', viewer(false), VERSION, 'readOnly'],
    ['a viewer who may write', viewer(true), VERSION, 'available'],
  ] as const)('%s: %s', (_label, v, expected, status) => {
    expect(frameStatusFor(v, expected)).toBe(status)
  })
})

describe('plugin course tabs', () => {
  const ID = '6f1c1c3e-2b8a-4c3e-9b1a-0d2f3c4b5a69'
  const tool = { installationId: ID, name: 'Exit ticket', hiddenFromStudents: false }

  it('a student tab opens the student route; a professor tab opens the runtime page', () => {
    expect(studioToolFeature(tool, 'student')).toMatchObject({ key: `studio:${ID}`, label: 'Exit ticket', route: `/tools/${ID}` })
    expect(studioToolFeature(tool, 'professor').route).toBe(`/studio/${ID}`)
  })

  it('the order key is exactly studio:<uuid>', () => {
    expect(STUDIO_TOOL_KEY.test(`studio:${ID}`)).toBe(true)
    for (const bad of ['studio', `studio:${ID}x`, `x-studio:${ID}`, 'studio:not-a-uuid', `quizzes`]) {
      expect(STUDIO_TOOL_KEY.test(bad), bad).toBe(false)
    }
  })

  it('student tabs follow the professor’s order, and an unordered tab comes last', () => {
    const keys = (order: string[]) => studentSidebarFeatures(['quizzes'], order, [tool]).map((f) => f.key)
    expect(keys([`studio:${ID}`, 'modules'])[0]).toBe(`studio:${ID}`)
    expect(keys([]).at(-1)).toBe(`studio:${ID}`)
  })

  it('a professor’s unplaced tool sits right after Studio; a placed one keeps its place', () => {
    const tab = studioToolFeature(tool, 'professor')
    const keys = (order: string[]) => orderWithTools(PROFESSOR_SIDEBAR_FEATURES, [tab], order).map((f) => f.key)
    const unplaced = keys([])
    expect(unplaced[unplaced.indexOf('studio') + 1]).toBe(`studio:${ID}`)
    expect(keys([`studio:${ID}`])[0]).toBe(`studio:${ID}`)
  })

  it('on a plugin page only the plugin tab is highlighted, not Studio as well', () => {
    const base = '/professor/courses/s'
    const features = orderWithTools(PROFESSOR_SIDEBAR_FEATURES, [studioToolFeature(tool, 'professor')], [])
    expect(activeFeatureKey(features, base, `${base}/studio/${ID}`)).toBe(`studio:${ID}`)
    expect(activeFeatureKey(features, base, `${base}/studio`)).toBe('studio')
    // A route that merely starts with another's letters doesn't count.
    expect(activeFeatureKey(features, base, `${base}/studiox`)).toBeUndefined()
  })

  it('no tools means the student sidebar is exactly what it was', () => {
    expect(studentSidebarFeatures(['quizzes'], [])).toEqual(studentSidebarFeatures(['quizzes'], [], []))
  })
})

describe('which plugins become tabs', () => {
  const SECTION = crypto.randomUUID()
  const row = (id: string, studentVisibility: 'hidden' | 'visible', name: string | null = 'Exit ticket') => ({
    id,
    status: 'active' as const,
    studentVisibility,
    currentVersionId: crypto.randomUUID(),
    name,
  })

  beforeEach(() => {
    answers.platform_settings = settingsRow({})
  })

  it('students get nothing while the release gate is closed, without a query', async () => {
    expect(await studentToolTabs(SECTION)).toEqual([])
    expect(listSectionInstallations).not.toHaveBeenCalled()
  })

  it('students get nothing while the kill switch is engaged', async () => {
    vi.stubEnv('STUDIO_STUDENT_ACCESS', 'on')
    answers.platform_settings = settingsRow({ studio: { disabled: true } })
    expect(await studentToolTabs(SECTION)).toEqual([])
    expect(listSectionInstallations).not.toHaveBeenCalled()
  })

  it('students ask the database for visible installations only', async () => {
    vi.stubEnv('STUDIO_STUDENT_ACCESS', 'on')
    const id = crypto.randomUUID()
    vi.mocked(listSectionInstallations).mockResolvedValue([row(id, 'visible')])
    expect(await studentToolTabs(SECTION)).toEqual([{ installationId: id, name: 'Exit ticket', hiddenFromStudents: false }])
    expect(listSectionInstallations).toHaveBeenCalledWith(SECTION, { status: 'active', onlyVisible: true })
  })

  it('professors see every active installation, hidden ones marked, unnamed ones labelled', async () => {
    const [a, b] = [crypto.randomUUID(), crypto.randomUUID()]
    vi.mocked(listSectionInstallations).mockResolvedValue([row(a, 'hidden'), row(b, 'visible', null)])
    expect(await professorToolTabs(SECTION)).toEqual([
      { installationId: a, name: 'Exit ticket', hiddenFromStudents: true },
      { installationId: b, name: 'Course tool', hiddenFromStudents: false },
    ])
    expect(listSectionInstallations).toHaveBeenCalledWith(SECTION, { status: 'active', onlyVisible: false })
  })

  it('past tools are archived installations that were visible, behind the same gates', async () => {
    expect(await studentPastTools(SECTION)).toEqual([])
    expect(listSectionInstallations).not.toHaveBeenCalled()
    vi.stubEnv('STUDIO_STUDENT_ACCESS', 'on')
    const id = crypto.randomUUID()
    vi.mocked(listSectionInstallations).mockResolvedValue([{ ...row(id, 'visible'), status: 'archived' }])
    expect(await studentPastTools(SECTION)).toEqual([{ installationId: id, name: 'Exit ticket', hiddenFromStudents: false }])
    expect(listSectionInstallations).toHaveBeenCalledWith(SECTION, { status: 'archived', onlyVisible: true })
  })

  it('course assistants are told how many active tools exist, hidden ones included', async () => {
    vi.mocked(listSectionInstallations).mockResolvedValue([row(crypto.randomUUID(), 'hidden'), row(crypto.randomUUID(), 'visible')])
    expect(await sectionToolCount(SECTION)).toBe(2)
    expect(listSectionInstallations).toHaveBeenCalledWith(SECTION, { status: 'active', onlyVisible: false })
  })
})
