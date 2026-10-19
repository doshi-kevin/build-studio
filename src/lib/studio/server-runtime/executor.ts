/**
 * Which executor runs plugin server code on this server.
 *
 *   local        LocalProcessExecutor (local-executor.ts): a child process per call. Only with
 *                STUDIO_PLUGIN_EXECUTOR=local AND the database on loopback, whatever NODE_ENV
 *                says: a dev server pointed at a hosted project, or a deployment that reaches its
 *                database through a localhost proxy, never runs plugin code by default.
 *   unavailable  everywhere else. Server actions answer "unavailable" and nothing runs.
 *
 * A deployed server gets no executor until the container executor exists: a Cloud Run
 * service per call (gVisor sandbox, no service account, egress denied) speaking the same
 * contract (contract.ts) over HTTP. Until then production fails closed rather than run
 * plugin code beside the app's own secrets.
 */
import 'server-only'
import type { PluginExecutor } from './contract'
import { LocalProcessExecutor } from './local-executor'

export type ExecutorMode = 'local' | 'unavailable'

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]']

export function executorMode(env: Record<string, string | undefined> = process.env): ExecutorMode {
  if (env.STUDIO_PLUGIN_EXECUTOR !== 'local') return 'unavailable'
  try {
    return LOOPBACK.includes(new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? '').hostname) ? 'local' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

let local: LocalProcessExecutor | null = null

export function pluginExecutor(env: Record<string, string | undefined> = process.env): PluginExecutor | null {
  return executorMode(env) === 'local' ? (local ??= new LocalProcessExecutor()) : null
}
