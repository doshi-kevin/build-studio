// Runs the Stage 2 runner (validator-runtime/) on the shared fixtures: the known-good tool
// must pass every runtime check in both views, through the same CLI contract and report
// schema the server uses, and each bad fixture must fail the check it was built to break.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { GOOD, RUNTIME_BAD, type FixtureArtifact } from '../../src/lib/studio/validator/fixtures'
import { runtimeReportSchema, summarizeRuntimeReport } from '../../src/lib/studio/validator/runtime-report'

// runner.mjs uses top-level await, and Playwright compiles specs to CommonJS: load it lazily.
const runRuntimeValidation = async (artifact: unknown): Promise<unknown> =>
  (await import(pathToFileURL(join(process.cwd(), 'validator-runtime', 'runner.mjs')).href)).runRuntimeValidation(artifact)

const toJob = (a: FixtureArtifact) => ({ manifest: a.manifest, studentBundle: a.studentBundle, professorBundle: a.professorBundle })

/** Spawns the CLI the way runtime-runner.ts does: stdin in, JSON report out, no app secrets. */
function runCli(artifact: unknown): Promise<{ code: number | null; out: string }> {
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
    child.stdin.end(JSON.stringify(artifact))
  })
}

test('the known-good tool passes every runtime check in both views, through the CLI', async () => {
  const { code, out } = await runCli(toJob(GOOD))
  expect(code).toBe(0)
  const parsed = runtimeReportSchema.safeParse(JSON.parse(out))
  expect(parsed.success).toBe(true)
  if (!parsed.success) return
  const results = summarizeRuntimeReport(parsed.data)
  expect(results.map((r) => [r.checkId, r.status, r.views])).toEqual(
    results.map((r) => [r.checkId, 'passed', { student: 'passed', professor: 'passed' }]),
  )
})

test('the CLI refuses input that is not an artifact', async () => {
  const { code, out } = await runCli({ manifest: {} })
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
