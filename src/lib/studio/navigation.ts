/**
 * Which Studio plugins appear as course tabs. Display only: a tab grants nothing, and a
 * missing tab blocks nothing. Whether someone may open a plugin is decided per request
 * by resolveViewer (context.ts), which never reads navigation settings.
 *
 * Students see active installations shown to them, filtered in SQL so hidden ones never
 * reach the page. Nothing at all while the release gate is closed or the kill switch is
 * engaged. Professors see every active installation, marked when hidden from students.
 * Archived installations leave both sidebars; students find the ones they could see
 * under "Past tools" (studentPastTools), read-only.
 */
import 'server-only'
import type { StudioTool } from '@/lib/course-features'
import { studentAccessReleased, studioKillSwitchEngaged } from './access'
import { listSectionInstallations } from './db'

const UNNAMED = 'Course tool'

async function shownToStudents(sectionId: string, status: 'active' | 'archived'): Promise<StudioTool[]> {
  if (!studentAccessReleased() || (await studioKillSwitchEngaged())) return []
  const rows = await listSectionInstallations(sectionId, { status, onlyVisible: true })
  return rows.map((r) => ({ installationId: r.id, name: r.name ?? UNNAMED, hiddenFromStudents: false }))
}

/** The caller has already confirmed the student is enrolled in the section. */
export function studentToolTabs(sectionId: string): Promise<StudioTool[]> {
  return shownToStudents(sectionId, 'active')
}

/** Archived installations that were visible to students when archived: history, not
 * navigation. Never one that was hidden. The caller has already confirmed enrollment. */
export function studentPastTools(sectionId: string): Promise<StudioTool[]> {
  return shownToStudents(sectionId, 'archived')
}

/** The caller has already confirmed the viewer is the section's professor. */
export async function professorToolTabs(sectionId: string): Promise<StudioTool[]> {
  const rows = await listSectionInstallations(sectionId, { status: 'active', onlyVisible: false })
  return rows.map((r) => ({
    installationId: r.id,
    name: r.name ?? UNNAMED,
    hiddenFromStudents: r.studentVisibility !== 'visible',
  }))
}

/** How many active tools the course has, hidden or not, for course assistants' Studio
 * page. The caller has already confirmed section staff access. */
export async function sectionToolCount(sectionId: string): Promise<number> {
  return (await listSectionInstallations(sectionId, { status: 'active', onlyVisible: false })).length
}
