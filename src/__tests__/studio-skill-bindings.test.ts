/**
 * Skill slots (manifest v2): the professor binds each slot of their installation to one
 * of the course's skills, and the tool only ever reads the skill's name. The database
 * guard (same section, same institution) is tested in db/studio-validator.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import exitTicket from '@/lib/studio/fixtures/exit-ticket/plugin.manifest.json'
import { GOOD_MANIFEST } from '@/lib/studio/validator/fixtures'
import { parseManifest } from '@/lib/studio/manifest'

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/studio/context', () => ({ requireProfessor: vi.fn() }))
vi.mock('@/lib/studio/access', () => ({ studioAccess: vi.fn(), STUDIO_PAUSED: 'Studio is paused right now. Try again later.' }))
vi.mock('@/lib/studio/db', () => ({
  loadInstallation: vi.fn(),
  loadVersion: vi.fn(),
  listSkillBindings: vi.fn(),
  listBindableSkills: vi.fn(),
  upsertSkillBinding: vi.fn(),
}))

const db = await import('@/lib/studio/db')
const { requireProfessor } = await import('@/lib/studio/context')
const { studioAccess } = await import('@/lib/studio/access')
const { logEvent } = await import('@/lib/supabase/event-logger')
const { bindSkillSlot, skillBindingIssues, slotSkillNames } = await import('@/lib/studio/skill-bindings')

const SECTION = crypto.randomUUID()
const PROFESSOR = { userId: crypto.randomUUID(), sectionId: SECTION, institutionId: crypto.randomUUID() }
const INSTALLATION = {
  id: crypto.randomUUID(), institutionId: PROFESSOR.institutionId, sectionId: SECTION, projectId: 'p',
  status: 'active' as const, currentVersionId: crypto.randomUUID(), studentVisibility: 'hidden' as const,
}
const SKILL = { id: crypto.randomUUID(), name: 'Photosynthesis' }
const input = { sectionId: SECTION, installationId: INSTALLATION.id, slotKey: 'topic', skillId: SKILL.id }

const v2 = (() => {
  const parsed = parseManifest(GOOD_MANIFEST)
  if (!parsed.ok || parsed.manifest.manifestVersion !== 2) throw new Error('fixture')
  return parsed.manifest
})()

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireProfessor).mockResolvedValue(PROFESSOR as never)
  vi.mocked(studioAccess).mockResolvedValue('full')
  vi.mocked(db.loadInstallation).mockResolvedValue(INSTALLATION)
  vi.mocked(db.loadVersion).mockResolvedValue({ id: INSTALLATION.currentVersionId, projectId: 'p', institutionId: PROFESSOR.institutionId, version: '1.0.0', bridgeVersion: 'v1', manifest: GOOD_MANIFEST })
  vi.mocked(db.listBindableSkills).mockResolvedValue([SKILL])
  vi.mocked(db.listSkillBindings).mockResolvedValue([])
  vi.mocked(db.upsertSkillBinding).mockResolvedValue({ ok: true, value: null })
})

describe('binding a slot', () => {
  it('saves the binding for the session professor and logs it', async () => {
    expect(await bindSkillSlot(input)).toEqual({ ok: true })
    expect(db.upsertSkillBinding).toHaveBeenCalledWith({
      installationId: INSTALLATION.id, slotKey: 'topic', skillId: SKILL.id, institutionId: PROFESSOR.institutionId, boundBy: PROFESSOR.userId,
    })
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'studio.skill_slot.bound', userId: PROFESSOR.userId }))
  })

  it.each([
    ['someone who isn’t the section’s professor', () => vi.mocked(requireProfessor).mockResolvedValue(null)],
    ['an installation in another section', () => vi.mocked(db.loadInstallation).mockResolvedValue({ ...INSTALLATION, sectionId: crypto.randomUUID() })],
    ['an archived installation', () => vi.mocked(db.loadInstallation).mockResolvedValue({ ...INSTALLATION, status: 'archived' })],
    ['a slot the tool doesn’t declare', () => vi.mocked(db.loadVersion).mockResolvedValue({ id: 'v', projectId: 'p', institutionId: 'i', version: '1.0.0', bridgeVersion: 'v1', manifest: exitTicket })],
    ['a skill outside this course', () => vi.mocked(db.listBindableSkills).mockResolvedValue([{ id: crypto.randomUUID(), name: 'Other' }])],
    ['unreadable course skills', () => vi.mocked(db.listBindableSkills).mockResolvedValue(null)],
    ['a school whose Studio is paused', () => vi.mocked(studioAccess).mockResolvedValue('off')],
    ['a school without Studio', () => vi.mocked(studioAccess).mockResolvedValue('read_only')],
  ])('refuses %s and saves nothing', async (_label, arrange) => {
    arrange()
    expect(await bindSkillSlot(input)).toEqual({ ok: false, error: expect.any(String) })
    expect(db.upsertSkillBinding).not.toHaveBeenCalled()
  })

  it('refuses a slot key that isn’t a name, before reading anything', async () => {
    expect(await bindSkillSlot({ ...input, slotKey: '../topic' })).toEqual({ ok: false, error: expect.any(String) })
    expect(requireProfessor).not.toHaveBeenCalled()
  })
})

describe('what the gate and the tool see', () => {
  it('a v1 tool, or a v2 tool without slots, needs no bindings', async () => {
    const v1 = parseManifest(exitTicket)
    if (!v1.ok) throw new Error('fixture')
    expect(await skillBindingIssues(INSTALLATION, v1.manifest)).toEqual({ ok: true })
    expect(await skillBindingIssues(INSTALLATION, { ...v2, skillSlots: [] })).toEqual({ ok: true })
  })

  it('an unbound slot, or one bound to a skill no longer in the course, blocks by its label', async () => {
    expect(await skillBindingIssues(INSTALLATION, v2)).toEqual({ ok: false, unbound: ['The topic this ticket is about'] })
    vi.mocked(db.listSkillBindings).mockResolvedValue([{ slotKey: 'topic', skillId: crypto.randomUUID() }])
    expect(await skillBindingIssues(INSTALLATION, v2)).toEqual({ ok: false, unbound: ['The topic this ticket is about'] })
    vi.mocked(db.listSkillBindings).mockResolvedValue([{ slotKey: 'topic', skillId: SKILL.id }])
    expect(await skillBindingIssues(INSTALLATION, v2)).toEqual({ ok: true })
  })

  it('unreadable bindings fail closed', async () => {
    vi.mocked(db.listSkillBindings).mockResolvedValue(null)
    expect(await skillBindingIssues(INSTALLATION, v2)).toEqual({ ok: false, unreadable: true })
  })

  it('the tool gets each slot’s skill name, never the skill’s ID', async () => {
    vi.mocked(db.listSkillBindings).mockResolvedValue([{ slotKey: 'topic', skillId: SKILL.id }])
    const names = await slotSkillNames(INSTALLATION, v2)
    expect(names).toEqual({ topic: 'Photosynthesis' })
    expect(JSON.stringify(names)).not.toContain(SKILL.id)
  })
})
