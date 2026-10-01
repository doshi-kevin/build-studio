/**
 * The server handlers for the catalog's server methods (catalog.ts holds every method's
 * definition). The type below requires exactly one handler per server method, typed
 * with that method's parsed arguments, so the catalog and the handlers can't drift.
 *
 * Handlers only route. Record methods call Step 3's records.ts, which alone decides
 * perStudent, shared, staffOnly, archived and ownership rules.
 */
import 'server-only'
import type { StudioViewer } from '../context'
import { loadSectionSkills } from '../db'
import * as records from '../records'
import type { BridgeErrorCode } from '../runtime/protocol'
import type { MethodArgs, ServerMethodName } from './catalog'
import { contextFor } from './context-get'
import type { HostContext } from './envelope'

export type MethodResult =
  | { ok: true; data: unknown }
  | { ok: false; code: BridgeErrorCode; message: string; issues?: string[] }

const FAILED = 'Something went wrong. Try again.'

/** Turns Step 3's result into a bridge result without inventing a new message. */
function fromRecords<T>(result: records.RecordResult<T>): MethodResult {
  if (result.ok) return { ok: true, data: result.value }
  if (result.issues) return { ok: false, code: 'invalid', message: result.error, issues: result.issues }
  if (result.error === records.RECORD_NOT_AVAILABLE) return { ok: false, code: 'not_available', message: result.error }
  if (result.error === records.RECORD_CONFLICT) return { ok: false, code: 'conflict', message: result.error }
  if (result.error === records.RECORD_FULL || result.error === records.RECORD_FULL_STUDENT) {
    return { ok: false, code: 'full', message: result.error }
  }
  return { ok: false, code: 'failed', message: FAILED }
}

type Handlers = {
  [K in ServerMethodName]: (viewer: StudioViewer, args: MethodArgs<K>, host: HostContext) => Promise<MethodResult>
}

export const SERVER_HANDLERS: Handlers = {
  'context.get': async (viewer, _args, host) => ({ ok: true, data: await contextFor(viewer, host) }),
  // Names, descriptions and parent names only: no skill, section or other IDs.
  'course.skills': async (viewer) => {
    const skills = await loadSectionSkills(viewer.sectionId)
    return skills ? { ok: true, data: skills } : { ok: false, code: 'failed', message: FAILED }
  },
  'records.list': async (viewer, args) => fromRecords(await records.listRecords({ ...args, installationId: viewer.installationId })),
  'records.get': async (viewer, args) => fromRecords(await records.getRecord({ ...args, installationId: viewer.installationId })),
  'records.create': async (viewer, args) => fromRecords(await records.createRecord({ ...args, installationId: viewer.installationId })),
  'records.update': async (viewer, args) => fromRecords(await records.updateRecord({ ...args, installationId: viewer.installationId })),
  'records.delete': async (viewer, args) => fromRecords(await records.deleteRecord({ ...args, installationId: viewer.installationId })),
}

export function serverHandler(name: string): Handlers[ServerMethodName] | null {
  return Object.hasOwn(SERVER_HANDLERS, name) ? SERVER_HANDLERS[name as ServerMethodName] : null
}
