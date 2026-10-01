/**
 * Skill slots (manifest v2) and their bindings (decision D5).
 *
 * A version declares reusable slots ("the concept this practices"), never a section's
 * skills, so one version works in any course (rule 2.4). Each installation binds its
 * slots to its own section's skills; the database checks the skill is in that section.
 * Publication, and activating a new version while students can see the tool, require
 * every slot bound to a skill that still exists and is visible. Plugin frames receive
 * skill names only, never IDs (rule 2.5).
 *
 * Plain server module, not 'use server'. Callers are actions and services.
 */
import 'server-only'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'
import { logEvent } from '@/lib/supabase/event-logger'
import { STUDIO_PAUSED, studioAccess } from './access'
import { requireProfessor } from './context'
import * as db from './db'
import { parseManifest, type StudioManifest } from './manifest'

export type BindingCheck = { ok: true } | { ok: false; unbound: string[] } | { ok: false; unreadable: true }

/** Which declared slots lack a binding to a visible skill of the section. */
export async function skillBindingIssues(installation: { id: string; sectionId: string }, manifest: StudioManifest): Promise<BindingCheck> {
  if (manifest.manifestVersion !== 2 || manifest.skillSlots.length === 0) return { ok: true }
  const [bindings, skills] = await Promise.all([db.listSkillBindings(installation.id), db.listBindableSkills(installation.sectionId)])
  if (!bindings || !skills) return { ok: false, unreadable: true }
  const visible = new Set(skills.map((s) => s.id))
  const bound = new Map(bindings.map((b) => [b.slotKey, b.skillId]))
  const unbound = manifest.skillSlots.filter((slot) => !visible.has(bound.get(slot.key) ?? '')).map((slot) => slot.label)
  return unbound.length === 0 ? { ok: true } : { ok: false, unbound }
}

/** Slot key to skill name, for the plugin (context.get). Unbound or hidden: null. */
export async function slotSkillNames(installation: { id: string; sectionId: string }, manifest: StudioManifest): Promise<Record<string, string | null>> {
  if (manifest.manifestVersion !== 2 || manifest.skillSlots.length === 0) return {}
  const [bindings, skills] = await Promise.all([db.listSkillBindings(installation.id), db.listBindableSkills(installation.sectionId)])
  const nameOf = new Map((skills ?? []).map((s) => [s.id, s.name]))
  const bound = new Map((bindings ?? []).map((b) => [b.slotKey, b.skillId]))
  return Object.fromEntries(manifest.skillSlots.map((slot) => [slot.key, nameOf.get(bound.get(slot.key) ?? '') ?? null]))
}

const bindInput = z.strictObject({
  sectionId: z.uuid(),
  installationId: z.uuid(),
  slotKey: z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/),
  skillId: z.uuid(),
})

const NOT_AVAILABLE = 'This isn’t available.'

/** The section's professor binds one slot of their installation's current version. */
export async function bindSkillSlot(raw: z.input<typeof bindInput>): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = bindInput.safeParse(raw)
  if (!parsed.success) return { ok: false, error: NOT_AVAILABLE }
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return { ok: false, error: NOT_AVAILABLE }
  const installation = await db.loadInstallation(parsed.data.installationId)
  if (!installation || installation.sectionId !== professor.sectionId || installation.status !== 'active') return { ok: false, error: NOT_AVAILABLE }
  const access = await studioAccess(professor.institutionId)
  if (access === 'off') return { ok: false, error: STUDIO_PAUSED }
  if (access === 'read_only') return { ok: false, error: entitlementRefusalMessage('studio') }

  const version = await db.loadVersion(installation.currentVersionId)
  const manifest = version ? parseManifest(version.manifest) : null
  if (!manifest?.ok || manifest.manifest.manifestVersion !== 2 || !manifest.manifest.skillSlots.some((s) => s.key === parsed.data.slotKey)) {
    return { ok: false, error: 'This tool has no such skill slot.' }
  }
  const skills = await db.listBindableSkills(professor.sectionId)
  if (!skills?.some((s) => s.id === parsed.data.skillId)) return { ok: false, error: 'Choose one of this course’s skills.' }

  const saved = await db.upsertSkillBinding({
    installationId: installation.id,
    slotKey: parsed.data.slotKey,
    skillId: parsed.data.skillId,
    institutionId: professor.institutionId,
    boundBy: professor.userId,
  })
  if (!saved.ok) return { ok: false, error: 'Something went wrong. Try again.' }
  logEvent({
    userId: professor.userId,
    eventType: 'studio.skill_slot.bound',
    eventCategory: 'studio',
    sectionId: professor.sectionId,
    metadata: { installationId: installation.id, slotKey: parsed.data.slotKey, skillId: parsed.data.skillId },
  })
  revalidatePath(`/professor/courses/${professor.sectionId}/studio/${installation.id}`)
  return { ok: true }
}
