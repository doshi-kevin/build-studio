/**
 * Artifact folders for the generation-quality eval: a live build saved and read back,
 * and a Step 11 benchmark folder imported with only what it really recorded.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { artifactDirs, loadArtifact, saveLiveArtifact } from '../../eval/studio-quality/artifacts'
import { harnessInvariants, type BuildOutcome } from '../../eval/studio-quality/build'
import { QUALITY_CASES } from '../../eval/studio-quality/cases'
import { artifactHash } from '../../eval/studio-quality/evaluate'

const tmp = () => mkdtempSync(join(tmpdir(), 'sgq-art-'))

const OUTCOME: BuildOutcome = {
  status: 'preview_ready',
  errorCode: null,
  cappedByEval: false,
  snapshot: { hash: 'h'.repeat(64), manifest: { name: 'Attendance' }, files: { student: 'S', professor: 'P' }, sample: { marks: [] }, bundles: { student: 's', professor: 'p' }, compiler: 'c' },
  invariants: { terminal: true, onlyTwoFiles: true, catalogCapabilitiesOnly: true, noUnapprovedCapability: true, noUnapprovedMemory: true },
  costUsd: 0.25,
  tokens: { input: 10, cachedInput: 0, output: 5, reasoning: 1 },
  modelTurns: 7,
  toolCalls: 14,
  repairRounds: 1,
  checkRuns: 2,
  durationMs: 90000,
  questionsAsked: 0,
  approvalsGiven: 1,
  builderReview: { rounds: 1, rendered: true, verdict: 'ready' },
  refusals: ['write_sample_data: sample_invalid'],
}

describe('artifact folders', () => {
  it('a saved live build reads back with its case’s goals and hints from the current case list', () => {
    const dir = tmp()
    const c = QUALITY_CASES[0]
    saveLiveArtifact({ dir, case: c, rerun: { groupId: 'g', generation: 2 }, outcome: OUTCOME, git: { commit: 'abc', dirty: false }, builder: { model: 'm', thinkingLevel: 'low', maxOutputTokens: 1, instructionsVersion: 'v', instructionsSha256: 'x', reviewVersion: 'r', reviewSha256: 'y', rendererMode: 'local' } })
    const a = loadArtifact(dir, join(dir, 'out'), QUALITY_CASES)
    expect(a.provenance).toBe('live-build')
    expect(a.case.id).toBe(c.id)
    expect(a.judgeContext.hints).toEqual(c.hints)
    expect(a.rerun).toEqual({ groupId: 'g', generation: 2 })
    expect(a.files).toEqual({ student: 'S', professor: 'P' })
    expect(a.build).toMatchObject({ statuses: ['preview_ready'], snapshotHash: 'h'.repeat(64), toolCalls: 14, tokens: { input: 10 } })
    expect(() => loadArtifact(dir, join(dir, 'out'), [])).toThrow(/not in the canonical suite/)
  })

  it('a saved build records the hash of what it wrote, so a file from another generation is caught on reload', () => {
    const dir = tmp()
    const builder = { model: 'm', thinkingLevel: 'low', maxOutputTokens: 1, instructionsVersion: 'v', instructionsSha256: 'x', reviewVersion: 'r', reviewSha256: 'y', rendererMode: 'local' as const }
    const saved = saveLiveArtifact({ dir, case: QUALITY_CASES[0], rerun: { groupId: 'g', generation: 1 }, outcome: OUTCOME, git: { commit: 'abc', dirty: false }, builder })
    const a = loadArtifact(dir, join(dir, 'out'), QUALITY_CASES)
    expect(a.expectedArtifactSha256).toBe(saved.expectedArtifactSha256)
    expect(artifactHash(a.manifest, a.files, a.sample)).toBe(a.expectedArtifactSha256)
    expect(JSON.parse(readFileSync(join(dir, 'artifact.json'), 'utf8')).refusals).toEqual(['write_sample_data: sample_invalid'])
    // Generation 2's student view copied over generation 1's.
    writeFileSync(join(dir, 'student.tsx'), 'S from g2')
    const mixed = loadArtifact(dir, join(dir, 'out'), QUALITY_CASES)
    expect(artifactHash(mixed.manifest, mixed.files, mixed.sample)).not.toBe(mixed.expectedArtifactSha256)
    // A saved artifact with no recorded hash can't be checked, so it is refused.
    const record = JSON.parse(readFileSync(join(dir, 'artifact.json'), 'utf8'))
    delete record.artifactSha256
    writeFileSync(join(dir, 'artifact.json'), JSON.stringify(record))
    expect(() => loadArtifact(dir, join(dir, 'out'), QUALITY_CASES)).toThrow(/artifactSha256/)
  })

  it('finds artifact folders at any depth, as contrast pairs lay them out', () => {
    const root = tmp()
    for (const side of ['original', 'degraded']) {
      mkdirSync(join(root, 'A-x', side), { recursive: true })
      writeFileSync(join(root, 'A-x', side, 'result.json'), '{}')
    }
    expect(artifactDirs(root)).toEqual([join(root, 'A-x', 'degraded'), join(root, 'A-x', 'original')])
  })

  it('a Step 11 benchmark folder imports honestly: unknown stays null, and follow-ups join the prompt', () => {
    const root = tmp()
    const dir = join(root, 'G-attendance')
    mkdirSync(dir)
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'Attendance' }))
    writeFileSync(join(dir, 'professor.tsx'), 'P')
    writeFileSync(join(dir, 'student.tsx'), 'S')
    writeFileSync(join(dir, 'sample.json'), 'null')
    writeFileSync(
      join(dir, 'result.json'),
      JSON.stringify({
        id: 'G-attendance',
        costUsd: 0.29,
        seconds: 117,
        builds: [
          { request: 'Build an attendance tracker.', status: 'preview_ready', modelTurns: 10, repairRounds: 1, review: { rounds: 2, rendered: true, verdict: 'ready' } },
          { request: 'Professors should mark them.', status: 'completed', modelTurns: 3, repairRounds: 0, review: null },
        ],
      }),
    )
    expect(artifactDirs(root)).toEqual([dir])
    const a = loadArtifact(dir, join(root, 'out'), QUALITY_CASES)
    expect(a.provenance).toBe('imported-artifact')
    expect(a.case).toMatchObject({ id: 'import:G-attendance', set: 'imported', inPattern: null, prompt: 'Build an attendance tracker.\n\nThen: Professors should mark them.' })
    expect(a.judgeContext).toEqual({ professorGoal: null, studentGoal: null, hints: [] })
    expect(a.build).toMatchObject({ statuses: ['preview_ready', 'completed'], invariants: null, tokens: null, toolCalls: null, modelTurns: 13, repairRounds: 1, durationMs: 117000, costUsd: 0.29 })
    expect(a.builder.instructionsSha256).toBeNull()
    expect(a.git).toEqual({ commit: null, dirty: null })
  })

  it('refuses a folder that is neither kind', () => {
    expect(() => loadArtifact(tmp(), tmp(), QUALITY_CASES)).toThrow(/neither a quality artifact/)
  })
})

describe('the hard invariants of a build from nothing', () => {
  const snap = (caps: string[], files = ['views/professor.tsx', 'views/student.tsx']) => ({
    manifest: { views: { student: { capabilities: [] }, professor: { capabilities: caps } } },
    files: Object.fromEntries(files.map((f) => [f, 'x'])),
  })

  it('hold for an approved capability, and fail for an unapproved one, an extra file or an unknown capability', () => {
    expect(Object.values(harnessInvariants({ status: 'preview_ready', snapshot: snap(['course.roster']), approvedCapabilityCards: 1, memories: [] })).every(Boolean)).toBe(true)
    expect(harnessInvariants({ status: 'preview_ready', snapshot: snap(['course.roster']), approvedCapabilityCards: 0, memories: [] }).noUnapprovedCapability).toBe(false)
    expect(harnessInvariants({ status: 'preview_ready', snapshot: snap([], ['views/professor.tsx', 'views/student.tsx', 'views/extra.tsx']), approvedCapabilityCards: 0, memories: [] }).onlyTwoFiles).toBe(false)
    expect(harnessInvariants({ status: 'preview_ready', snapshot: snap(['course.weakSpots']), approvedCapabilityCards: 1, memories: [] }).catalogCapabilitiesOnly).toBe(false)
    expect(harnessInvariants({ status: 'queued', snapshot: undefined, approvedCapabilityCards: 0, memories: [] }).terminal).toBe(false)
  })
})
