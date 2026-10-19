/**
 * A server action on a draft or a candidate version, in preview: the plugin's real server
 * code, run by the same executor as a live call, against the preview's in-memory records
 * instead of the database. The records arrive from the previewing page and go back with
 * whatever the action wrote; the preview bridge (runtime/preview-bridge.ts) applies the
 * server's policy to them, so the code behaves as it will for real. The caller is the
 * synthetic class: preview student 0, or the professor.
 *
 * Nothing here touches a real record or a real student. The callers (the builder's preview
 * action, the design-review renderer) have already checked who may run this draft.
 */
import 'server-only'
import type { StudioManifest } from '../manifest'
import type { PluginView } from '../capabilities'
import { createPreviewBridge, type PreviewStore } from '../runtime/preview-bridge'
import { PREVIEW_ROSTER, PREVIEW_VIEWER_STUDENT } from '../runtime/preview-roster'
import type { RequestResult } from '../runtime/host'
import { CAPABILITY_PARAMS, type CapabilityResult } from './contract'
import { runServerAction } from './execute'

export interface PreviewCallInput {
  manifest: StudioManifest
  view: PluginView
  serverBundle: string | null
  action: string
  args: unknown
  store: PreviewStore | null
}

export async function previewServerCall(input: PreviewCallInput): Promise<{ result: RequestResult; store: PreviewStore | null }> {
  let records: ReturnType<typeof createPreviewBridge> | null = null
  const { result } = await runServerAction({
    manifest: input.manifest,
    view: input.view,
    action: input.action,
    args: input.args,
    bundle: async () => input.serverBundle,
    handle: async () => (input.view === 'student' ? PREVIEW_ROSTER[PREVIEW_VIEWER_STUDENT].handle : null),
    capability: (def) => {
      records = createPreviewBridge(input.manifest, input.view, { store: input.store ?? {}, serverReads: def.reads ?? [] })
      const bridge = records
      return async (method, params): Promise<CapabilityResult> => {
        if (!CAPABILITY_PARAMS[method].safeParse(params).success) return { ok: false, message: 'This request’s arguments aren’t valid.' }
        if (method === 'course.get') return { ok: true, data: { code: 'PREVIEW', title: 'Preview course' } }
        const r = await bridge.handleRequest(method, params)
        if (r.ok) return { ok: true, data: r.data }
        if (method === 'records.get' && r.code === 'not_available') return { ok: true, data: null }
        return { ok: false, message: r.issues?.length ? `${r.message} ${r.issues.slice(0, 3).join('; ')}` : r.message }
      }
    },
  })
  return { result, store: (records as ReturnType<typeof createPreviewBridge> | null)?.exportStore() ?? null }
}
