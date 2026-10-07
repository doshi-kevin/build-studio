/**
 * Runtime evidence for one artifact: Stage 2 through the real local runner (cli.mjs, the
 * same path a professor's Save uses on this machine), and screenshots through capture.mjs.
 * Both run in child processes with a minimal environment, so plugin code never shares a
 * process with a model key.
 */
import { spawn } from 'node:child_process'
import { randomUUID, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { buildPayload, runLocally, runnerEnvironment } from '../../src/lib/studio/validator/runtime-runner'
import { runtimeEnvelopeSchema, summarizeRuntimeReport } from '../../src/lib/studio/validator/runtime-report'
import type { Stage2Check } from './gates'
import type { EvidenceSource } from './schema'

export interface Bundled {
  manifest: unknown
  bundles: { student: string; professor: string }
  sample: unknown
}

export interface Stage2Outcome {
  checks: Stage2Check[]
  runner: { name: string; version: string }
}

/** Stage 2 on one artifact, or null when the runner itself failed (no browser, a crash). */
export async function runStage2(artifact: Bundled): Promise<Stage2Outcome | null> {
  const validationId = randomUUID()
  const payload = buildPayload(validationId, randomBytes(24).toString('base64url'), {
    manifest: artifact.manifest,
    studentBundle: artifact.bundles.student,
    professorBundle: artifact.bundles.professor,
  })
  const raw = await runLocally(validationId, payload.bytes)
  const envelope = runtimeEnvelopeSchema.safeParse(raw)
  if (!envelope.success) return null
  return { checks: summarizeRuntimeReport(envelope.data.report), runner: envelope.data.report.runner }
}

/** The shots every comparable evaluation needs: the normal state of both views at both widths. */
export const REQUIRED_SHOTS = ['professor-desktop-normal', 'professor-phone-normal', 'student-desktop-normal', 'student-phone-normal'] as const

const shotSchema = z.strictObject({
  id: z.string().regex(/^[a-z]+-[a-z]+-[a-z]+$/),
  file: z.string().regex(/^[a-z-]+\.jpg$/),
  view: z.enum(['student', 'professor']),
  device: z.enum(['desktop', 'phone']),
  width: z.number().int(),
  scenario: z.enum(['normal', 'empty', 'slow', 'failing']),
  height: z.number().int(),
  truncated: z.boolean(),
  stateShown: z.boolean().nullable(),
})
export type Shot = z.infer<typeof shotSchema>
const captureOutput = z.strictObject({ shots: z.array(shotSchema), failures: z.array(z.strictObject({ id: z.string(), reason: z.string() })) })
export type CaptureOutcome = z.infer<typeof captureOutput> & { missing: string[] }

const CAPTURE_TIMEOUT_MS = 200_000

/** Screenshots into `outDir`. Null when the capture process failed outright. */
export function captureScreens(artifact: Bundled, outDir: string, root = process.cwd()): Promise<CaptureOutcome | null> {
  const input = JSON.stringify({ manifest: artifact.manifest, studentBundle: artifact.bundles.student, professorBundle: artifact.bundles.professor, sample: artifact.sample ?? null, outDir })
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: CaptureOutcome | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const child = spawn(process.execPath, [join(root, 'eval', 'studio-quality', 'capture.mjs')], { cwd: root, env: runnerEnvironment(), stdio: 'pipe', windowsHide: true })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null)
    }, CAPTURE_TIMEOUT_MS)
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (out += chunk))
    child.stderr.resume()
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      if (code !== 0) return finish(null)
      try {
        const parsed = captureOutput.parse(JSON.parse(out))
        const have = new Set(parsed.shots.map((s) => s.id))
        finish({ ...parsed, missing: REQUIRED_SHOTS.filter((id) => !have.has(id)) })
      } catch {
        finish(null)
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

const SCENARIO_LABEL: Record<Shot['scenario'], string> = { normal: 'on sample data', empty: 'with no data', slow: 'while loading', failing: 'when every request fails' }

/** Everything the judge may cite, in a fixed order. */
export function evidenceCatalog(input: { files: { student: string; professor: string }; sample: unknown; shots: Shot[]; stage2: Stage2Check[] | null }): EvidenceSource[] {
  const lines = (text: string) => text.split(/\r?\n/).length
  return [
    ...input.shots.map((s) => ({
      id: `shot:${s.id}`,
      kind: 'screenshot' as const,
      label: `${s.view} view, ${s.device} (${s.width}px), ${SCENARIO_LABEL[s.scenario]}${s.truncated ? ', cut at the frame’s maximum height' : ''}`,
      file: s.file,
      lines: null,
    })),
    { id: 'views/professor.tsx', kind: 'source' as const, label: 'The professor view’s source', file: null, lines: lines(input.files.professor) },
    { id: 'views/student.tsx', kind: 'source' as const, label: 'The student view’s source', file: null, lines: lines(input.files.student) },
    { id: 'manifest', kind: 'manifest' as const, label: 'The manifest', file: null, lines: null },
    ...(input.sample ? [{ id: 'sample', kind: 'sample' as const, label: 'The sample data', file: null, lines: null }] : []),
    ...(input.stage2 ?? []).map((c) => ({ id: `stage2:${c.checkId}`, kind: 'stage2' as const, label: `Stage 2 ${c.checkId}: ${c.status}`, file: null, lines: null })),
  ]
}
