/**
 * Evidence binding for the generation-quality eval: a Stage 2 report and a set of screenshots
 * count only when they are of exactly the payload this run sent. A report from an earlier run,
 * a report of another payload, or screenshots left over from an earlier capture are refused.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const runLocally = vi.fn()
vi.mock('@/lib/studio/validator/runtime-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/studio/validator/runtime-runner')>()),
  runLocally: (...args: unknown[]) => runLocally(...args),
}))

const { captureScreens, REQUIRED_SHOTS, runStage2 } = await import('../../eval/studio-quality/evidence')

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const BUNDLED = { manifest: { name: 'T' }, bundles: { student: 'S', professor: 'P' }, sample: null }

/** What an honest runner returns for the payload it was given. */
function envelopeFor(bytes: string, binding: Record<string, string> = {}) {
  const payload = JSON.parse(bytes) as { validationId: string; nonce: string }
  return {
    binding: { validationId: payload.validationId, nonce: payload.nonce, payloadSha256: sha256(bytes), runtimeVersion: 'v1', ...binding },
    report: { runner: { name: 'r', version: '1' }, browser: 'b', checks: [] },
  }
}

describe('a Stage 2 report is bound to its own run', () => {
  it('is bound when the runner reports on this run’s payload', async () => {
    runLocally.mockImplementation(async (_id: string, bytes: string) => envelopeFor(bytes))
    expect(await runStage2(BUNDLED)).toMatchObject({ bound: true, runner: { name: 'r', version: '1' } })
  })

  it('is not bound when the report is a stale one from an earlier run', async () => {
    let earlier: unknown = null
    runLocally.mockImplementation(async (_id: string, bytes: string) => (earlier ??= envelopeFor(bytes)))
    expect((await runStage2(BUNDLED))!.bound).toBe(true)
    // Same artifact, new run: the runner hands back the first run's report.
    expect((await runStage2(BUNDLED))!.bound).toBe(false)
  })

  it('is not bound when the report is of another payload', async () => {
    runLocally.mockImplementation(async (_id: string, bytes: string) => envelopeFor(bytes, { payloadSha256: sha256(`${bytes} `) }))
    expect((await runStage2(BUNDLED))!.bound).toBe(false)
  })
})

describe('screenshots are bound to their own capture', () => {
  /** A stand-in capture process that echoes `echo` as the hash of its input, or the real hash. */
  function fakeRoot(echo: 'input' | 'other'): string {
    const root = mkdtempSync(join(tmpdir(), 'sgq-cap-'))
    mkdirSync(join(root, 'eval', 'studio-quality'), { recursive: true })
    writeFileSync(
      join(root, 'eval', 'studio-quality', 'capture.mjs'),
      [
        "import { createHash } from 'node:crypto'",
        'const chunks = []',
        'for await (const c of process.stdin) chunks.push(c)',
        "const real = createHash('sha256').update(Buffer.concat(chunks)).digest('hex')",
        `const inputSha256 = ${echo === 'input' ? 'real' : "'a'.repeat(64)"}`,
        'process.stdout.write(JSON.stringify({ shots: [], failures: [], inputSha256 }), () => process.exit(0))',
      ].join('\n'),
    )
    return root
  }

  it('clears screenshots an earlier capture left behind, and is bound when the hash of what was sent comes back', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'sgq-shots-')), 'evidence')
    mkdirSync(out)
    writeFileSync(join(out, 'professor-desktop-normal.jpg'), 'stale')
    const r = await captureScreens(BUNDLED, out, fakeRoot('input'))
    expect(existsSync(join(out, 'professor-desktop-normal.jpg'))).toBe(false)
    expect(r).toEqual({ shots: [], failures: [], missing: [...REQUIRED_SHOTS], bound: true })
  })

  it('is not bound when the capture reports on another input', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'sgq-shots-')), 'evidence')
    expect((await captureScreens(BUNDLED, out, fakeRoot('other')))!.bound).toBe(false)
  })
})
