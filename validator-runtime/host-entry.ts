// Browser entry for the Stage 2 runner's and the preview renderer's host page: the real
// host controller and the real preview bridge, with the synthetic class's names for the
// host-drawn roster, so a plugin under validation runs exactly as it would for a
// professor's preview. Bundled by runner.mjs with esbuild.
import { allowedBridgeMethods } from '@/lib/studio/bridge/catalog'
import { parseManifest } from '@/lib/studio/manifest'
import { mountPluginFrame, type FrameSnapshot, type RequestResult } from '@/lib/studio/runtime/host'
import { createPreviewBridge, type PreviewSample } from '@/lib/studio/runtime/preview-bridge'
import { previewRosterNames } from '@/lib/studio/runtime/preview-roster'

type Scenario = 'normal' | 'empty' | 'slow' | 'failing'

/** A failure message no plugin should ever show on screen (rule 7.5). */
const SENTINEL = 'VALIDATOR-RAW-ERROR-7f3a91'

const EMPTY: Record<string, unknown> = { 'records.list': [], 'course.roster': { students: [] }, 'course.assignments': { assignments: [] } }

let frame: { snapshot(): FrameSnapshot; destroy(): void } | null = null

interface MountOptions {
  /** The draft's sample data (renderer). The validator uses placeholders. */
  sample?: PreviewSample | null
  className?: string
}

function mount(frameUrl: string, view: 'student' | 'professor', rawManifest: unknown, scenario: Scenario, options: MountOptions = {}) {
  const parsed = parseManifest(rawManifest)
  if (!parsed.ok) throw new Error('manifest')
  const manifest = parsed.manifest
  const preview = createPreviewBridge(manifest, view, { sample: options.sample ?? null })
  const handleRequest = async (method: string, args: unknown): Promise<RequestResult> => {
    if (scenario === 'failing') return { ok: false, code: 'failed', message: SENTINEL }
    if (scenario === 'slow') await new Promise((r) => setTimeout(r, 2500))
    // Empty means no data of any kind: no records, no class, no assignments.
    if (scenario === 'empty' && Object.hasOwn(EMPTY, method)) return { ok: true, data: EMPTY[method] }
    return preview.handleRequest(method, args)
  }
  frame = mountPluginFrame({
    container: document.getElementById('mount')!,
    frameUrl,
    title: manifest.name,
    view,
    className: options.className ?? 'validator-frame',
    allowedMethods: allowedBridgeMethods(manifest, view),
    handleRequest,
    rosterNames: async () => previewRosterNames(),
  })
}

Object.assign(window as unknown as Record<string, unknown>, {
  validator: { mount, snapshot: () => frame?.snapshot() ?? null, sentinel: SENTINEL },
})
