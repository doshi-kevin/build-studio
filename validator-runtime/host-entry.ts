// Browser entry for the Stage 2 runner's host page: the real host controller and the
// real preview bridge, so a plugin under validation runs exactly as it would for a
// professor's preview. Bundled by runner.mjs with esbuild.
import { allowedBridgeMethods } from '@/lib/studio/bridge/catalog'
import { parseManifest } from '@/lib/studio/manifest'
import { mountPluginFrame, type FrameSnapshot, type RequestResult } from '@/lib/studio/runtime/host'
import { createPreviewBridge } from '@/lib/studio/runtime/preview-bridge'

type Scenario = 'normal' | 'empty' | 'slow' | 'failing'

/** A failure message no plugin should ever show on screen (rule 7.5). */
const SENTINEL = 'VALIDATOR-RAW-ERROR-7f3a91'

let frame: { snapshot(): FrameSnapshot; destroy(): void } | null = null

function mount(frameUrl: string, view: 'student' | 'professor', rawManifest: unknown, scenario: Scenario) {
  const parsed = parseManifest(rawManifest)
  if (!parsed.ok) throw new Error('manifest')
  const manifest = parsed.manifest
  const preview = createPreviewBridge(manifest, view)
  const handleRequest = async (method: string, args: unknown): Promise<RequestResult> => {
    if (scenario === 'failing') return { ok: false, code: 'failed', message: SENTINEL }
    if (scenario === 'slow') await new Promise((r) => setTimeout(r, 2500))
    if (scenario === 'empty' && method === 'records.list') return { ok: true, data: [] }
    return preview.handleRequest(method, args)
  }
  frame = mountPluginFrame({
    container: document.getElementById('mount')!,
    frameUrl,
    title: manifest.name,
    view,
    className: 'validator-frame',
    allowedMethods: allowedBridgeMethods(manifest, view),
    handleRequest,
  })
}

Object.assign(window as unknown as Record<string, unknown>, {
  validator: { mount, snapshot: () => frame?.snapshot() ?? null, sentinel: SENTINEL },
})
