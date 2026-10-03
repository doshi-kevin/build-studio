/**
 * The professor's publication actions and the super-admin Studio kill switch and
 * validator-ruleset actions.
 * They are thin: authenticate, refuse early, call one trusted service (or the database
 * function), refresh, normalize. The services' own rules are tested in
 * studio-student-visibility.test.ts and the database tests; here we check the wrapping.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const user: { id: string | null } = { id: null }
const rpc = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: user.id ? { id: user.id } : null } }) },
    rpc,
  }),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/studio/context', () => ({ requireProfessor: vi.fn() }))
vi.mock('@/lib/studio/lifecycle', () => ({ archiveInstallation: vi.fn(), approveAndActivateVersion: vi.fn() }))
vi.mock('@/lib/studio/student-visibility', () => ({
  showToStudents: vi.fn(),
  hideFromStudents: vi.fn(),
  VISIBILITY_NOT_AVAILABLE: 'This isn’t available.',
}))
vi.mock('@/lib/auth/super-admin-context', () => ({ verifySuperAdmin: vi.fn() }))
vi.mock('@/lib/studio/validator/service', () => ({ requestRuntimeValidation: vi.fn(), enqueueRevalidation: vi.fn(), loadAcceptedMinimum: vi.fn() }))
vi.mock('@/lib/studio/skill-bindings', () => ({ bindSkillSlot: vi.fn() }))

const { revalidatePath } = await import('next/cache')
const { logEvent } = await import('@/lib/supabase/event-logger')
const { requireProfessor } = await import('@/lib/studio/context')
const { archiveInstallation, approveAndActivateVersion } = await import('@/lib/studio/lifecycle')
const visibility = await import('@/lib/studio/student-visibility')
const { verifySuperAdmin } = await import('@/lib/auth/super-admin-context')
const { requestRuntimeValidation, enqueueRevalidation, loadAcceptedMinimum } = await import('@/lib/studio/validator/service')
const { bindSkillSlot } = await import('@/lib/studio/skill-bindings')
const actions = await import('@/app/(dashboard)/professor/courses/[sectionId]/studio/[installationId]/actions')
const { setStudioKillSwitch, raiseValidatorRuleset, queueRevalidationAgain } = await import('@/app/(dashboard)/super-admin/ai-controls/studio-actions')
const { STUDIO_VALIDATOR_RULESET } = await import('@/lib/studio/validator/ruleset')

const SECTION = crypto.randomUUID()
const INSTALLATION = crypto.randomUUID()
const PROFESSOR = { userId: crypto.randomUUID(), sectionId: SECTION, institutionId: crypto.randomUUID() }
const DENIED = { error: 'This isn’t available.' }

beforeEach(() => {
  vi.clearAllMocks()
  user.id = PROFESSOR.userId
  vi.mocked(requireProfessor).mockResolvedValue(PROFESSOR as never)
  vi.mocked(visibility.showToStudents).mockResolvedValue({ ok: true, value: { changed: true } })
  vi.mocked(visibility.hideFromStudents).mockResolvedValue({ ok: true, value: { changed: true } })
  vi.mocked(archiveInstallation).mockResolvedValue({ ok: true, value: null })
  vi.mocked(approveAndActivateVersion).mockResolvedValue({ ok: true, value: null })
  vi.mocked(requestRuntimeValidation).mockResolvedValue({ ok: true, status: 'running' })
  vi.mocked(bindSkillSlot).mockResolvedValue({ ok: true })
})

const SKILL = crypto.randomUUID()
const VERSION = crypto.randomUUID()

const all: [string, () => Promise<unknown>][] = [
  ['show', () => actions.showToStudentsAction(SECTION, INSTALLATION, false)],
  ['hide', () => actions.hideFromStudentsAction(SECTION, INSTALLATION)],
  ['archive', () => actions.archiveInstallationAction(SECTION, INSTALLATION)],
  ['run checks', () => actions.requestRuntimeChecksAction(SECTION, INSTALLATION)],
  ['bind a skill slot', () => actions.bindSkillSlotAction(SECTION, INSTALLATION, 'topic', SKILL)],
  ['switch version', () => actions.switchVersionAction(SECTION, INSTALLATION, VERSION, true)],
]

describe('who may call the publication actions', () => {
  it.each(all)('%s: refused without a session, before any service runs', async (_label, act) => {
    user.id = null
    expect(await act()).toEqual(DENIED)
    expect(visibility.showToStudents).not.toHaveBeenCalled()
    expect(visibility.hideFromStudents).not.toHaveBeenCalled()
    expect(archiveInstallation).not.toHaveBeenCalled()
    expect(approveAndActivateVersion).not.toHaveBeenCalled()
    expect(requestRuntimeValidation).not.toHaveBeenCalled()
    expect(bindSkillSlot).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it.each(all)('%s: refused for anyone but the section’s professor (TA, grader, student)', async (_label, act) => {
    vi.mocked(requireProfessor).mockResolvedValue(null)
    expect(await act()).toEqual(DENIED)
    expect(requireProfessor).toHaveBeenCalledWith(SECTION)
    expect(archiveInstallation).not.toHaveBeenCalled()
    expect(approveAndActivateVersion).not.toHaveBeenCalled()
    expect(requestRuntimeValidation).not.toHaveBeenCalled()
    expect(bindSkillSlot).not.toHaveBeenCalled()
  })

  it('refuses a section ID that isn’t a string, without asking anyone', async () => {
    expect(await actions.hideFromStudentsAction(42 as never, INSTALLATION)).toEqual(DENIED)
    expect(requireProfessor).not.toHaveBeenCalled()
  })
})

describe('what the actions do', () => {
  it('show passes the request to the service unchanged, and refreshes the course and runtime pages', async () => {
    expect(await actions.showToStudentsAction(SECTION, INSTALLATION, true)).toEqual({ success: true })
    expect(visibility.showToStudents).toHaveBeenCalledWith({ sectionId: SECTION, installationId: INSTALLATION, acknowledgeWarnings: true })
    expect(revalidatePath).toHaveBeenCalledWith(`/professor/courses/${SECTION}/studio/${INSTALLATION}`)
    expect(revalidatePath).toHaveBeenCalledWith(`/student/courses/${SECTION}`, 'layout')
  })

  it('show acknowledges warnings only when the client sent exactly true', async () => {
    await actions.showToStudentsAction(SECTION, INSTALLATION, 'yes' as never)
    expect(visibility.showToStudents).toHaveBeenCalledWith(expect.objectContaining({ acknowledgeWarnings: false }))
  })

  it('show passes the service’s blockers and warnings back, and refreshes nothing', async () => {
    const blockers = [{ code: 'validator_unavailable' as const, message: 'Automatic checks aren’t available yet.' }]
    vi.mocked(visibility.showToStudents).mockResolvedValue({ ok: false, error: blockers[0].message, blockers, warnings: [] })
    expect(await actions.showToStudentsAction(SECTION, INSTALLATION, true)).toEqual({ error: blockers[0].message, blockers, warnings: [] })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('hide and archive call their services for this section and installation', async () => {
    expect(await actions.hideFromStudentsAction(SECTION, INSTALLATION)).toEqual({ success: true })
    expect(visibility.hideFromStudents).toHaveBeenCalledWith({ sectionId: SECTION, installationId: INSTALLATION })
    expect(await actions.archiveInstallationAction(SECTION, INSTALLATION)).toEqual({ success: true })
    expect(archiveInstallation).toHaveBeenCalledWith({ sectionId: SECTION, installationId: INSTALLATION })
  })

  it('running checks and binding a slot pass the request through unchanged and refresh on success', async () => {
    expect(await actions.requestRuntimeChecksAction(SECTION, INSTALLATION)).toEqual({ success: true })
    expect(requestRuntimeValidation).toHaveBeenCalledWith({ sectionId: SECTION, installationId: INSTALLATION })
    expect(await actions.bindSkillSlotAction(SECTION, INSTALLATION, 'topic', SKILL)).toEqual({ success: true })
    expect(bindSkillSlot).toHaveBeenCalledWith({ sectionId: SECTION, installationId: INSTALLATION, slotKey: 'topic', skillId: SKILL })
    expect(revalidatePath).toHaveBeenCalledWith(`/professor/courses/${SECTION}/studio/${INSTALLATION}`)
  })

  it('a refusal from checks or binding comes back as an error, with no refresh', async () => {
    vi.mocked(requestRuntimeValidation).mockResolvedValue({ ok: false, error: 'The checks just ran. Try again in a minute.' })
    vi.mocked(bindSkillSlot).mockResolvedValue({ ok: false, error: 'This tool has no such skill slot.' })
    expect(await actions.requestRuntimeChecksAction(SECTION, INSTALLATION)).toEqual({ error: 'The checks just ran. Try again in a minute.' })
    expect(await actions.bindSkillSlotAction(SECTION, INSTALLATION, 'topic', SKILL)).toEqual({ error: 'This tool has no such skill slot.' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('a service refusal comes back as an error, with no refresh', async () => {
    vi.mocked(archiveInstallation).mockResolvedValue({ ok: false, error: 'This isn’t available.' })
    expect(await actions.archiveInstallationAction(SECTION, INSTALLATION)).toEqual({ error: 'This isn’t available.' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe('switching or rolling back a version', () => {
  it('acknowledges warnings only when the client sent exactly true, then starts the browser checks', async () => {
    expect(await actions.switchVersionAction(SECTION, INSTALLATION, VERSION, 'yes' as never)).toEqual({ success: true, checks: undefined })
    expect(approveAndActivateVersion).toHaveBeenCalledWith({ sectionId: SECTION, installationId: INSTALLATION, versionId: VERSION, acknowledgeWarnings: false })
    expect(requestRuntimeValidation).toHaveBeenCalledWith({ sectionId: SECTION, installationId: INSTALLATION })
  })

  it('a refused switch passes its blockers and warnings back, starts no checks and refreshes nothing', async () => {
    const warnings = [{ code: 'unreleased_material' as const, message: 'Athena read course material students can’t see yet.' }]
    vi.mocked(approveAndActivateVersion).mockResolvedValue({ ok: false, error: 'Read the warnings before students see this version.', warnings })
    expect(await actions.switchVersionAction(SECTION, INSTALLATION, VERSION, false)).toEqual({ error: 'Read the warnings before students see this version.', blockers: undefined, warnings })
    expect(requestRuntimeValidation).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('checks that can’t start never undo the switch; the professor is told why', async () => {
    vi.mocked(requestRuntimeValidation).mockResolvedValue({ ok: false, error: 'Your school has used today’s browser checks. They’re available again tomorrow.' })
    expect(await actions.switchVersionAction(SECTION, INSTALLATION, VERSION, true)).toEqual({
      success: true,
      checks: 'Your school has used today’s browser checks. They’re available again tomorrow.',
    })
    expect(revalidatePath).toHaveBeenCalledWith(`/professor/courses/${SECTION}/studio/${INSTALLATION}`)
  })
})

describe('the Studio kill switch action', () => {
  beforeEach(() => {
    vi.mocked(verifySuperAdmin).mockResolvedValue({ userId: 'admin', isPlatformOwner: false })
    rpc.mockResolvedValue({ data: null, error: null })
  })

  it('refuses anyone but a super admin, before calling the database', async () => {
    vi.mocked(verifySuperAdmin).mockResolvedValue({ error: 'Unauthorized — super_admin access required' })
    expect(await setStudioKillSwitch(true)).toEqual({ error: 'Unauthorized — super_admin access required' })
    expect(rpc).not.toHaveBeenCalled()
    expect(logEvent).not.toHaveBeenCalled()
  })

  it('refuses anything but a boolean', async () => {
    expect(await setStudioKillSwitch('true' as never)).toEqual({ error: 'Invalid setting.' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each([
    [true, 'studio.kill_switch.engaged'],
    [false, 'studio.kill_switch.released'],
  ])('sets %s through the user’s own client, so the database checks the role too, and audits it', async (engaged, eventType) => {
    expect(await setStudioKillSwitch(engaged)).toEqual({ success: true })
    expect(rpc).toHaveBeenCalledWith('set_studio_kill_switch', { p_disabled: engaged })
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin', eventType }))
  })

  it('reports a database refusal without saying why, and audits nothing', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'permission_denied' } })
    expect(await setStudioKillSwitch(true)).toEqual({ error: 'Couldn’t change Studio. Try again.' })
    expect(logEvent).not.toHaveBeenCalled()
  })
})

describe('raising the validator’s accepted checks', () => {
  beforeEach(() => {
    vi.mocked(verifySuperAdmin).mockResolvedValue({ userId: 'admin', isPlatformOwner: false })
    rpc.mockResolvedValue({ data: { ok: true, previous: STUDIO_VALIDATOR_RULESET - 1 }, error: null })
    vi.mocked(enqueueRevalidation).mockResolvedValue(3)
    vi.mocked(loadAcceptedMinimum).mockResolvedValue(STUDIO_VALIDATOR_RULESET - 1)
  })

  it('raises one step at a time, and refuses when already at the code’s ruleset', async () => {
    vi.mocked(loadAcceptedMinimum).mockResolvedValue(STUDIO_VALIDATOR_RULESET)
    expect(await raiseValidatorRuleset()).toEqual({ error: 'The accepted checks are already newer than this.' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('queues the re-checks again at the minimum as it is now, only for a super admin', async () => {
    expect(await queueRevalidationAgain()).toEqual({ success: true, queued: 3 })
    expect(enqueueRevalidation).toHaveBeenCalledWith('admin', STUDIO_VALIDATOR_RULESET - 1)
    vi.mocked(verifySuperAdmin).mockResolvedValue({ error: 'Unauthorized — super_admin access required' })
    expect(await queueRevalidationAgain()).toEqual({ error: 'Unauthorized — super_admin access required' })
    expect(enqueueRevalidation).toHaveBeenCalledTimes(1)
  })

  it('refuses anyone but a super admin, before the database or any re-check', async () => {
    vi.mocked(verifySuperAdmin).mockResolvedValue({ error: 'Unauthorized — super_admin access required' })
    expect(await raiseValidatorRuleset()).toEqual({ error: 'Unauthorized — super_admin access required' })
    expect(rpc).not.toHaveBeenCalled()
    expect(enqueueRevalidation).not.toHaveBeenCalled()
  })

  it.each([
    ['refuses the call', { data: null, error: { message: 'permission_denied' } }, 'Couldn’t change the accepted checks. Try again.'],
    ['refuses a decrease', { data: { ok: false, reason: 'lower' }, error: null }, 'The accepted checks are already newer than this.'],
  ])('queues no re-checks when the database %s', async (_label, answer, message) => {
    rpc.mockResolvedValue(answer)
    expect(await raiseValidatorRuleset()).toEqual({ error: message })
    expect(enqueueRevalidation).not.toHaveBeenCalled()
    expect(logEvent).not.toHaveBeenCalled()
  })

  it('raises to the code’s ruleset through the user’s own client, then queues the re-checks as that super admin', async () => {
    expect(await raiseValidatorRuleset()).toEqual({ success: true, queued: 3 })
    expect(rpc).toHaveBeenCalledWith('studio_set_min_accepted_ruleset', { p_ruleset: STUDIO_VALIDATOR_RULESET, p_max: STUDIO_VALIDATOR_RULESET })
    expect(enqueueRevalidation).toHaveBeenCalledWith('admin', STUDIO_VALIDATOR_RULESET)
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(enqueueRevalidation).mock.invocationCallOrder[0])
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin', eventType: 'studio.validator.ruleset_raised' }))
  })
})
