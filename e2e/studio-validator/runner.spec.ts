// Runs the Stage 2 runner (validator-runtime/) on the shared fixtures: the known-good tool
// must pass every runtime check in both views, through the same CLI contract and report
// schema the server uses, and each bad fixture must fail the check it was built to break.
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { GOOD, RUNTIME_BAD, type FixtureArtifact } from '../../src/lib/studio/validator/fixtures'
import { runtimeEnvelopeSchema, runtimeReportSchema, summarizeRuntimeReport } from '../../src/lib/studio/validator/runtime-report'

// runner.mjs uses top-level await, and Playwright compiles specs to CommonJS: load it lazily.
const runRuntimeValidation = async (artifact: unknown): Promise<unknown> =>
  (await import(pathToFileURL(join(process.cwd(), 'validator-runtime', 'runner.mjs')).href)).runRuntimeValidation(artifact)

const toJob = (a: FixtureArtifact) => ({ manifest: a.manifest, studentBundle: a.studentBundle, professorBundle: a.professorBundle })

/** The payload bytes runtime-runner.ts's buildPayload produces for a run. */
const toPayload = (artifact: unknown, validationId = randomUUID(), nonce = randomBytes(32).toString('base64url')) =>
  JSON.stringify({ format: 'studio-validator-payload-v1', validationId, nonce, ...(artifact as object) })

/** Spawns the CLI the way runtime-runner.ts does: payload on stdin, envelope out, no app secrets. */
function runCli(payload: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' }
    for (const k of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'PLAYWRIGHT_BROWSERS_PATH']) {
      if (process.env[k]) env[k] = process.env[k]
    }
    const child = spawn(process.execPath, [join(process.cwd(), 'validator-runtime', 'cli.mjs')], { env, stdio: 'pipe', windowsHide: true })
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.resume()
    child.on('close', (code) => resolve({ code, out }))
    child.stdin.end(payload)
  })
}

test('the known-good tool passes every runtime check in both views, through the CLI', async () => {
  const validationId = randomUUID()
  const nonce = randomBytes(32).toString('base64url')
  const payload = toPayload(toJob(GOOD), validationId, nonce)
  const { code, out } = await runCli(payload)
  expect(code).toBe(0)
  const parsed = runtimeEnvelopeSchema.safeParse(JSON.parse(out))
  expect(parsed.success).toBe(true)
  if (!parsed.success) return
  // The envelope is bound to exactly the payload it was given.
  expect(parsed.data.binding).toEqual({ validationId, nonce, payloadSha256: createHash('sha256').update(payload).digest('hex'), runtimeVersion: 'v1' })
  const results = summarizeRuntimeReport(parsed.data.report)
  expect(results.map((r) => [r.checkId, r.status, r.views])).toEqual(
    results.map((r) => [r.checkId, 'passed', { student: 'passed', professor: 'passed' }]),
  )
})

test('the CLI refuses input that is not a payload', async () => {
  const { code, out } = await runCli(JSON.stringify(toJob(GOOD)))
  expect(code).not.toBe(0)
  expect(out).toBe('')
})

for (const fixture of RUNTIME_BAD) {
  test(`${fixture.name} fails ${fixture.check}`, async () => {
    const report = runtimeReportSchema.parse(await runRuntimeValidation(toJob(fixture.artifact)))
    const result = summarizeRuntimeReport(report).find((r) => r.checkId === fixture.check)
    expect(result?.views.student).toBe('failed')
    expect(result?.status).toBe('failed')
  })
}

test('self-navigation is caught twice over: the host stops the frame, and the network block records the request', async () => {
  const fixture = RUNTIME_BAD.find((f) => f.name === 'self-navigation')!
  const report = runtimeReportSchema.parse(await runRuntimeValidation(toJob(fixture.artifact)))
  const details = summarizeRuntimeReport(report).find((r) => r.checkId === 'runtime.isolation')!.findings.map((f) => f.detail)
  expect(details).toContain('frame navigated')
  expect(details.some((d) => d.startsWith('request to https://evil.example'))).toBe(true)
})
