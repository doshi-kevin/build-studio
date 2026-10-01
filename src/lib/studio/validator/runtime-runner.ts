/**
 * Hands a Stage 2 run to a runner. Stage 2 executes plugin code, so it never runs in
 * the Scholera server process: the runner launches a browser, and the plugin runs inside
 * the Step 4 sandbox there.
 *
 *   unavailable (default, and production today)
 *       No runner is wired. The run ends as `error` ("runtime checks can't run here"),
 *       which blocks publication. Production needs an isolated container per run (Cloud
 *       Run Job): pinned image, non-root, no credentials, no network egress, time and
 *       memory limits, reporting only through the run's own callback token. Not built.
 *   local (STUDIO_VALIDATOR_RUNNER=local, refused in production)
 *       Spawns validator-runtime/cli.mjs as a child process with a minimal environment
 *       (no Scholera secrets), which runs Playwright's Chromium on this machine and
 *       prints a report. For development and tests only: a developer machine is not an
 *       isolated environment.
 */
import 'server-only'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { logger } from '@/lib/logger'
import { STUDIO_VALIDATOR_RUNTIME_TIMEOUT_MS } from '../limits'

export interface RuntimeJob {
  validationId: string
  token: string
  artifact: { manifest: unknown; studentBundle: string; professorBundle: string }
}

export type RunnerMode = 'unavailable' | 'local'

export function runnerMode(env: Record<string, string | undefined> = process.env): RunnerMode {
  if (env.STUDIO_VALIDATOR_RUNNER === 'local' && env.NODE_ENV !== 'production') return 'local'
  return 'unavailable'
}

/** The child's whole environment: enough to find node and a browser, nothing secret. */
export function runnerEnvironment(env: Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'PLAYWRIGHT_BROWSERS_PATH']
  return {
    ...Object.fromEntries(keep.filter((k) => typeof env[k] === 'string').map((k) => [k, env[k] as string])),
    NODE_ENV: 'production',
  }
}

/** Runs the local runner and resolves with its parsed stdout, or null on any failure. */
export function runLocally(job: RuntimeJob): Promise<unknown | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'validator-runtime', 'cli.mjs')], {
      env: runnerEnvironment(),
      stdio: 'pipe',
      windowsHide: true,
    })
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), STUDIO_VALIDATOR_RUNTIME_TIMEOUT_MS + 15_000)
    child.stdout.on('data', (chunk) => {
      if (out.length < 256 * 1024) out += chunk
    })
    child.stderr.resume()
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        logger.warn('studio/validator.runLocally: runner exited', { code, validationId: job.validationId })
        return resolve(null)
      }
      try {
        resolve(JSON.parse(out))
      } catch {
        resolve(null)
      }
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.stdin.end(JSON.stringify(job.artifact))
  })
}
