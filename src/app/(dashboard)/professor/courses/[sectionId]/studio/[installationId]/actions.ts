'use server'

/**
 * The professor's publication actions for one installed plugin: show it to students,
 * hide it, remove it from the course (archive).
 *
 * Thin on purpose. Every rule lives in the trusted services, which validate the input,
 * verify the section's professor again, re-run every publication check, write through
 * the database's own guards, and audit (student-visibility.ts, lifecycle.ts). These
 * actions only authenticate, refuse early, call one service, refresh the pages that
 * show the result, and return `{ success }` or `{ error }`.
 */

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireProfessor } from '@/lib/studio/context'
import { archiveInstallation } from '@/lib/studio/lifecycle'
import { bindSkillSlot } from '@/lib/studio/skill-bindings'
import { requestRuntimeValidation } from '@/lib/studio/validator/service'
import {
  hideFromStudents,
  showToStudents,
  VISIBILITY_NOT_AVAILABLE,
  type BlockerCode,
  type Issue,
  type WarningCode,
} from '@/lib/studio/student-visibility'

export type PublicationActionResult =
  | { success: true }
  | { error: string; blockers?: Issue<BlockerCode>[]; warnings?: Issue<WarningCode>[] }

/** Signed in, and the section's professor. The service checks both again. */
async function professorOf(sectionId: unknown): Promise<boolean> {
  if (typeof sectionId !== 'string') return false
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return false
  return (await requireProfessor(sectionId)) !== null
}

function refresh(sectionId: string, installationId: string) {
  revalidatePath(`/professor/courses/${sectionId}/studio/${installationId}`)
  revalidatePath(`/professor/courses/${sectionId}`, 'layout')
  revalidatePath(`/student/courses/${sectionId}`, 'layout')
}

export async function showToStudentsAction(
  sectionId: string,
  installationId: string,
  acknowledgeWarnings: boolean,
): Promise<PublicationActionResult> {
  if (!(await professorOf(sectionId))) return { error: VISIBILITY_NOT_AVAILABLE }
  const result = await showToStudents({ sectionId, installationId, acknowledgeWarnings: acknowledgeWarnings === true })
  if (!result.ok) return { error: result.error, blockers: result.blockers, warnings: result.warnings }
  refresh(sectionId, installationId)
  return { success: true }
}

export async function hideFromStudentsAction(sectionId: string, installationId: string): Promise<PublicationActionResult> {
  if (!(await professorOf(sectionId))) return { error: VISIBILITY_NOT_AVAILABLE }
  const result = await hideFromStudents({ sectionId, installationId })
  if (!result.ok) return { error: result.error }
  refresh(sectionId, installationId)
  return { success: true }
}

/** Removes the plugin from the course. Its records are kept, read-only. */
export async function archiveInstallationAction(sectionId: string, installationId: string): Promise<PublicationActionResult> {
  if (!(await professorOf(sectionId))) return { error: VISIBILITY_NOT_AVAILABLE }
  const result = await archiveInstallation({ sectionId, installationId })
  if (!result.ok) return { error: result.error }
  refresh(sectionId, installationId)
  return { success: true }
}

/** Runs Studio's browser checks on the installation's current version. They run only
 * after the static checks passed, and only where a runner exists. */
export async function requestRuntimeChecksAction(sectionId: string, installationId: string): Promise<PublicationActionResult> {
  if (!(await professorOf(sectionId))) return { error: VISIBILITY_NOT_AVAILABLE }
  const result = await requestRuntimeValidation({ sectionId, installationId })
  if (!result.ok) return { error: result.error }
  refresh(sectionId, installationId)
  return { success: true }
}

/** Links one of the tool's skill slots to one of this course's skills. */
export async function bindSkillSlotAction(
  sectionId: string,
  installationId: string,
  slotKey: string,
  skillId: string,
): Promise<PublicationActionResult> {
  if (!(await professorOf(sectionId))) return { error: VISIBILITY_NOT_AVAILABLE }
  const result = await bindSkillSlot({ sectionId, installationId, slotKey, skillId })
  if (!result.ok) return { error: result.error }
  refresh(sectionId, installationId)
  return { success: true }
}
