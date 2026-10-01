// Browser entry for the isolation harness: bundles the real host-side Studio modules
// (host controller, bridge client, preview bridge) so the host page runs exactly the code
// the app ships. Built by harness.mjs with esbuild.
import exitTicket from '@/lib/studio/fixtures/exit-ticket/plugin.manifest.json'
import { parseManifest } from '@/lib/studio/manifest'
import { createBridgeClient } from '@/lib/studio/runtime/bridge-client'
import { mountPluginFrame } from '@/lib/studio/runtime/host'
import { createPreviewBridge } from '@/lib/studio/runtime/preview-bridge'

const manifest = parseManifest(exitTicket)
if (!manifest.ok) throw new Error('fixture manifest is invalid')

Object.assign(window as unknown as Record<string, unknown>, {
  studio: { mountPluginFrame, createBridgeClient, createPreviewBridge, previewManifest: manifest.manifest },
})
