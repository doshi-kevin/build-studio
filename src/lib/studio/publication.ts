/**
 * Whether students can reach an installation (rule 8.6), as resolveViewer asks it after
 * confirming the student is enrolled in the installation's section. Two conditions,
 * both required:
 *   - the deployment's release gate is open (STUDIO_STUDENT_ACCESS, access.ts);
 *   - the section's professor showed this installation to students.
 * The installation's current version is what students get; it is always approved
 * (the storage migration's deferred approval key). The kill switch is checked by
 * resolveViewer for every viewer, not here. Navigation settings are never read.
 */
import 'server-only'
import { studentAccessReleased } from './access'

export function isPublishedToStudents(installation: { studentVisibility: 'hidden' | 'visible' }): boolean {
  return studentAccessReleased() && installation.studentVisibility === 'visible'
}
