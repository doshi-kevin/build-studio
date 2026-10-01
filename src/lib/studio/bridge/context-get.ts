/**
 * context.get: what a plugin may know about where it is running.
 *
 * Anything returned to a frame must be treated as leakable (rule 1.2), so this holds no
 * user, student, section, institution, installation or database ID, and no name or
 * email (rule 2.5). The locale and time zone are the viewer's own browser settings,
 * which the host read from Intl, never a value the plugin supplied.
 */
import 'server-only'
import type { StudioViewer } from '../context'
import { loadSectionCourse } from '../db'
import { slotSkillNames } from '../skill-bindings'
import { decide, viewOf } from '../policy'
import type { HostContext } from './envelope'

export interface PluginContext {
  plugin: { name: string; version: string }
  view: 'student' | 'professor'
  theme: 'light'
  locale: string
  timeZone: string
  course: { code: string; title: string }
  /** The viewer may not write (archived, entitlement lost, completed enrollment): reads
   * still work, writes are refused (rule 3.6). */
  readOnly: boolean
  /** Per collection, what this viewer may do, from the same policy the server enforces.
   * Lets a plugin hide controls it can't use; it grants nothing. */
  can: Record<string, { read: boolean; write: boolean }>
  /** Manifest v2 only: each skill slot's bound course skill, by name, or null when the
   * professor hasn't linked one. Names only, never IDs (rule 2.5). */
  skills?: Record<string, string | null>
}

export async function contextFor(viewer: StudioViewer, host: HostContext): Promise<PluginContext> {
  const [course, skills] = await Promise.all([
    loadSectionCourse(viewer.sectionId),
    viewer.manifest.manifestVersion === 2
      ? slotSkillNames({ id: viewer.installationId, sectionId: viewer.sectionId }, viewer.manifest)
      : Promise.resolve(undefined),
  ])
  const state = viewer.writable ? 'writable' : 'readOnly'
  const can = Object.fromEntries(
    Object.entries(viewer.manifest.collections).map(([name, collection]) => [
      name,
      {
        read: decide(viewer.role, collection.access, 'list', state).allow,
        write: decide(viewer.role, collection.access, 'create', state).allow,
      },
    ]),
  )
  return {
    plugin: { name: viewer.manifest.name, version: viewer.manifest.version },
    view: viewOf(viewer.role),
    theme: 'light',
    locale: host.locale,
    timeZone: host.timeZone,
    course: course ?? { code: '', title: '' },
    readOnly: !viewer.writable,
    can,
    ...(skills ? { skills } : {}),
  }
}
