/**
 * Whether students can reach an installation (rule 8.6). The publication slice owns
 * how that is represented and replaces this module. Until then, no installation is
 * published, so every student request is refused.
 */
import 'server-only'

export async function isPublishedToStudents(installation: { id: string; sectionId: string }): Promise<boolean> {
  void installation
  return false
}
