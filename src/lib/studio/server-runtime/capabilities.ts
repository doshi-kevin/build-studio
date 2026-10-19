/**
 * The trusted side of a live server action's capabilities: what the plugin's code gets
 * when it calls ctx.records.* or ctx.course.get. Runs in the Scholera server, for the
 * viewer resolveViewer built for this call and the action's manifest declaration. Every
 * request is plugin input: parsed strictly here, then decided by records.ts under
 * decideForServer (policy.ts), so a student's call never reaches another student's records.
 */
import 'server-only'
import type { StudioViewer } from '../context'
import { loadSectionCourse } from '../db'
import type { ServerActionDef } from '../manifest'
import { RECORD_NOT_AVAILABLE, serverRecords, type RecordResult } from '../records'
import { CAPABILITY_PARAMS, type CapabilityHandler, type CapabilityResult } from './contract'

const INVALID = 'This request’s arguments aren’t valid.'

/** A refusal keeps records.ts's own message; field issues help the code that sent the data. */
export function fromRecordResult<T>(result: RecordResult<T>): CapabilityResult {
  if (result.ok) return { ok: true, data: result.value }
  return { ok: false, message: result.issues?.length ? `${result.error} ${result.issues.slice(0, 3).join('; ')}` : result.error }
}

export function liveCapabilities(viewer: StudioViewer, action: ServerActionDef): CapabilityHandler {
  const records = serverRecords(viewer, action.reads ?? [])
  return async (method, params) => {
    const parsed = CAPABILITY_PARAMS[method].safeParse(params)
    if (!parsed.success) return { ok: false, message: INVALID }
    const p = parsed.data as never
    switch (method) {
      case 'records.list':
        return fromRecordResult(await records.list(p))
      case 'records.get': {
        // Missing and not permitted read the same, as in the frame: null.
        const r = await records.get(p)
        return !r.ok && r.error === RECORD_NOT_AVAILABLE ? { ok: true, data: null } : fromRecordResult(r)
      }
      case 'records.create':
        return fromRecordResult(await records.create(p))
      case 'records.update':
        return fromRecordResult(await records.update(p))
      case 'records.delete':
        return fromRecordResult(await records.remove(p))
      case 'course.get': {
        const course = await loadSectionCourse(viewer.sectionId)
        return { ok: true, data: course ?? { code: '', title: '' } }
      }
    }
  }
}
