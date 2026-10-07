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
const { RENDER_FORMAT } = await import('../../eval/studio-quality/render')
const { renderItem, renderShot } = await import('./helpers/quality-fixtures')

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const BUNDLED = { manifest: { name: 'T' }, bundles: { student: 'S', professor: 'P' }, sample: null }
const LEDGER = { format: RENDER_FORMAT, shots: [renderShot('professor-desktop-normal', [renderItem('button', 'Mark all present')])] }

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
  function fakeRoot(echo: 'input' | 'other', render: 'none' | 'valid' | 'invalid' | 'named-only' = 'none'): string {
    const root = mkdtempSync(join(tmpdir(), 'sgq-cap-'))
    mkdirSync(join(root, 'eval', 'studio-quality'), { recursive: true })
    writeFileSync(
      join(root, 'eval', 'studio-quality', 'capture.mjs'),
      [
        "import { createHash } from 'node:crypto'",
        "import { writeFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        'const chunks = []',
        'for await (const c of process.stdin) chunks.push(c)',
        "const real = createHash('sha256').update(Buffer.concat(chunks)).digest('hex')",
        `const inputSha256 = ${echo === 'input' ? 'real' : "'a'.repeat(64)"}`,
        "const { outDir } = JSON.parse(Buffer.concat(chunks).toString('utf8'))",
        render === 'valid' || render === 'invalid'
          ? `writeFileSync(join(outDir, 'render.json'), ${JSON.stringify(JSON.stringify(render === 'valid' ? LEDGER : { ...LEDGER, format: 'studio-quality-render-v0' }))})`
          : '',
        `const render = ${render === 'none' ? 'undefined' : "'render.json'"}`,
        'process.stdout.write(JSON.stringify({ shots: [], failures: [], inputSha256, render }), () => process.exit(0))',
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
    // No render.json came back, so the render evidence is missing too.
    expect(r).toEqual({ shots: [], failures: [], render: null, missing: [...REQUIRED_SHOTS, 'render evidence'], bound: true })
  })

  it('is not bound when the capture reports on another input', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'sgq-shots-')), 'evidence')
    expect((await captureScreens(BUNDLED, out, fakeRoot('other')))!.bound).toBe(false)
  })

  it('reads the render ledger the capture wrote, and counts it as missing when it is the wrong format', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'sgq-shots-')), 'evidence')
    const r = await captureScreens(BUNDLED, out, fakeRoot('input', 'valid'))
    expect(r!.render).toEqual(LEDGER)
    expect(r!.missing).toEqual([...REQUIRED_SHOTS])
    const bad = await captureScreens(BUNDLED, out, fakeRoot('input', 'invalid'))
    expect(bad!.render).toBeNull()
    expect(bad!.missing).toContain('render evidence')
  })

  it('never reads a render.json an earlier capture left behind', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'sgq-shots-')), 'evidence')
    mkdirSync(out)
    writeFileSync(join(out, 'render.json'), JSON.stringify(LEDGER))
    // This capture names render.json but never writes it.
    const r = await captureScreens(BUNDLED, out, fakeRoot('input', 'named-only'))
    expect(r!.render).toBeNull()
    expect(r!.missing).toContain('render evidence')
  })
})
