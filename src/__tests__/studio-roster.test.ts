/**
 * rosterNamesAction: names for the roster table Scholera draws over a professor view.
 * resolveViewer and the roster read are mocked; what's under test is who gets names.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import exitTicket from '@/lib/studio/fixtures/exit-ticket/plugin.manifest.json'
import { parseManifest } from '@/lib/studio/manifest'
import type { StudioViewer } from '@/lib/studio/context'
import type { ViewerRole } from '@/lib/studio/policy'

vi.mock('@/lib/studio/context', () => ({ resolveViewer: vi.fn() }))
vi.mock('@/lib/studio/handles', () => ({ rosterNames: vi.fn() }))

const { resolveViewer } = await import('@/lib/studio/context')
const { rosterNames } = await import('@/lib/studio/handles')
const { rosterNamesAction } = await import('@/app/(dashboard)/professor/courses/[sectionId]/studio/roster-actions')

function manifestWith(professor: string[]) {
  const parsed = parseManifest({ ...exitTicket, views: { ...exitTicket.views, professor: { ...exitTicket.views.professor, capabilities: professor } } })
  if (!parsed.ok) throw new Error(parsed.issues.join('; '))
  return parsed.manifest
}

const INSTALLATION = crypto.randomUUID()
const SECTION = crypto.randomUUID()
const NAMES = { st_0123456789abcdefghij: 'Ada Lovelace' }

function viewAs(role: ViewerRole, manifest = manifestWith(['course.roster'])) {
  vi.mocked(resolveViewer).mockResolvedValue({ role, installationId: INSTALLATION, sectionId: SECTION, manifest } as StudioViewer)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(rosterNames).mockResolvedValue(NAMES)
})

describe('rosterNamesAction', () => {
  it.each(['professor', 'ta', 'grader'] as const)('gives the %s the names, for the installation’s own section', async (role) => {
    viewAs(role)
    expect(await rosterNamesAction({ installationId: INSTALLATION })).toEqual({ names: NAMES })
    expect(resolveViewer).toHaveBeenCalledWith(INSTALLATION)
    expect(rosterNames).toHaveBeenCalledWith(INSTALLATION, SECTION)
  })

  it('refuses a student', async () => {
    viewAs('student')
    expect(await rosterNamesAction({ installationId: INSTALLATION })).toEqual({ error: expect.any(String) })
    expect(rosterNames).not.toHaveBeenCalled()
  })

  it('refuses when the professor view doesn’t declare course.roster', async () => {
    viewAs('professor', manifestWith(['context.get']))
    expect(await rosterNamesAction({ installationId: INSTALLATION })).toEqual({ error: expect.any(String) })
    expect(rosterNames).not.toHaveBeenCalled()
  })

  it('refuses an installation the viewer can’t reach, such as another section’s, the same way', async () => {
    vi.mocked(resolveViewer).mockResolvedValue(null)
    const missing = await rosterNamesAction({ installationId: crypto.randomUUID() })
    viewAs('student')
    const student = await rosterNamesAction({ installationId: INSTALLATION })
    expect(missing).toEqual(student)
    expect(rosterNames).not.toHaveBeenCalled()
  })

  it.each([
    ['a non-UUID installation', { installationId: 'x' }],
    ['a section or user named alongside it', { installationId: INSTALLATION, sectionId: SECTION }],
  ])('refuses %s before resolving anything', async (_label, input) => {
    expect(await rosterNamesAction(input as never)).toEqual({ error: expect.any(String) })
    expect(resolveViewer).not.toHaveBeenCalled()
  })

  it('reports a failed roster read as an error, not an empty class', async () => {
    viewAs('professor')
    vi.mocked(rosterNames).mockResolvedValue(null)
    expect(await rosterNamesAction({ installationId: INSTALLATION })).toEqual({ error: expect.any(String) })
  })
})
