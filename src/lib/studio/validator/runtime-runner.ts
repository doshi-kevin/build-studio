/**
 * Hands a Stage 2 run to a runner. Stage 2 executes plugin code, so it never runs in the
 * Scholera server process: the runner launches a browser, and the plugin runs inside the
 * Step 4 sandbox there. The runner only measures; the server decides the verdict.
 *
 *   unavailable (the default)
 *       No runner is configured. The run ends as `error`, which blocks publication.
 *   local (STUDIO_VALIDATOR_RUNNER=local, refused in production)
 *       Spawns validator-runtime/cli.mjs as a child process with a minimal environment (no
 *       Scholera secrets), which runs Playwright's Chromium on this machine. For development
 *       and tests only: a developer machine is not an isolated environment.
 *   cloud (STUDIO_VALIDATOR_RUNNER=cloud with every STUDIO_VALIDATOR_* setting present)
 *       One Cloud Run Job execution per run, dispatched by the studio_validator_runtime job
 *       (cloud-runner.ts). See infra/validator-runner/README.md.
 *
 * Both runners receive the same payload (built here) and return the same envelope:
 * {binding: {validationId, nonce, payloadSha256, runtimeVersion}, report}.
 */
import 'server-only'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { logger } from '@/lib/logger'
import { STUDIO_VALIDATOR_RUNTIME_TIMEOUT_MS } from '../limits'

export type RunnerMode = 'unavailable' | 'local' | 'cloud'

/** Settings the cloud runner needs; all must be present for `cloud` mode. */
export const CLOUD_SETTINGS = [
  'STUDIO_VALIDATOR_GCP_PROJECT',
  'STUDIO_VALIDATOR_REGION',
  'STUDIO_VALIDATOR_JOB',
  'STUDIO_VALIDATOR_BUCKET',
  'STUDIO_VALIDATOR_RUNNER_DIGEST',
] as const

export function runnerMode(env: Record<string, string | undefined> = process.env): RunnerMode {
  if (env.STUDIO_VALIDATOR_RUNNER === 'local' && env.NODE_ENV !== 'production') return 'local'
  if (env.STUDIO_VALIDATOR_RUNNER === 'cloud' && CLOUD_SETTINGS.every((k) => typeof env[k] === 'string' && env[k]!.length > 0)) return 'cloud'
  return 'unavailable'
}

export interface RunnerArtifact {
  manifest: unknown
  studentBundle: string
  professorBundle: string
}

/** The payload bytes a runner receives, and their SHA-256, recorded on the run at dispatch. */
export function buildPayload(validationId: string, nonce: string, artifact: RunnerArtifact): { bytes: string; sha256: string } {
  const bytes = JSON.stringify({
    format: 'studio-validator-payload-v1',
    validationId,
    nonce,
    manifest: artifact.manifest,
    studentBundle: artifact.studentBundle,
    professorBundle: artifact.professorBundle,
  })
  return { bytes, sha256: createHash('sha256').update(bytes, 'utf8').digest('hex') }
}

/** The child's whole environment: enough to find node and a browser, nothing secret. */
export function runnerEnvironment(env: Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'PLAYWRIGHT_BROWSERS_PATH']
  return {
    ...Object.fromEntries(keep.filter((k) => typeof env[k] === 'string').map((k) => [k, env[k] as string])),
    NODE_ENV: 'production',
  }
}

/** Runs the local runner on one payload and resolves with its parsed envelope, or null on any failure. */
export function runLocally(validationId: string, payloadBytes: string): Promise<unknown | null> {
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
        logger.warn('studio/validator.runLocally: runner exited', { code, validationId })
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
    child.stdin.end(payloadBytes)
  })
}
