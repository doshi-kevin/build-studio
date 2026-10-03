'use server'

/**
 * Student names for the roster table Scholera draws over a plugin's professor view
 * (docs/designs/studio/studio-builder-quality.md, 3.3 and 3.4). The names go to this page,
 * on the app origin, and never into the plugin frame: the frame only ever holds handles.
 *
 * Only a staff viewer of the installation (resolveViewer, the same check as every bridge
 * call), and only when the current version's professor view declares course.roster, the
 * capability the professor approved. A read path for staff, like the rest of the course
 * roster, so no audit event. Names are never logged.
 */

import { z } from 'zod'
import { resolveViewer } from '@/lib/studio/context'
import { rosterNames } from '@/lib/studio/handles'

const NOT_AVAILABLE = 'This isn’t available.'
const FAILED = 'Student names couldn’t be loaded. Try again.'

const input = z.strictObject({ installationId: z.uuid() })

export type RosterNamesResult = { names: Record<string, string> } | { error: string }

export async function rosterNamesAction(raw: { installationId: string }): Promise<RosterNamesResult> {
  const parsed = input.safeParse(raw)
  if (!parsed.success) return { error: NOT_AVAILABLE }

  const viewer = await resolveViewer(parsed.data.installationId)
  if (!viewer || viewer.role === 'student') return { error: NOT_AVAILABLE }
  if (!viewer.manifest.views.professor.capabilities.includes('course.roster')) return { error: NOT_AVAILABLE }

  const names = await rosterNames(viewer.installationId, viewer.sectionId)
  return names ? { names } : { error: FAILED }
}
