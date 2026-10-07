/**
 * The Step 12A baseline is honest only if the builder runs exactly as it did at Step 11
 * acceptance and learns nothing from the evaluation. These guards check the specific ways
 * it could: the builder and review instructions changing, the canonical prompts leaking
 * into the builder's instructions, evaluator hints or goals reaching a model input during
 * a build, and production code or the build importing the evaluator.
 *
 * They deliberately don't compare generic vocabulary: words like "attendance" belong in
 * both the hints and the builder's own patterns, and matching them would be noise.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACCEPTED, builderIdentity, builderThinkingLevel, freezeDrift } from '../../eval/studio-quality/freeze'
import { buildOnce, NEUTRAL_ANSWER } from '../../eval/studio-quality/build'
import { QUALITY_CASES } from '../../eval/studio-quality/cases'
import { BUILDER_INSTRUCTIONS } from '@/lib/studio/builder/instructions'
import { REVIEW_INSTRUCTIONS } from '@/lib/studio/builder/review'
import { call, finish, inProcessWorkerCheck, scriptedModel } from './helpers/builder-fixtures'

const ROOT = process.cwd()

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path)
    return /\.(ts|tsx|js|mjs)$/.test(name) ? [path] : []
  })
}

describe('the Step 11 builder stays frozen', () => {
  it('builder and review instructions, model and thinking level match what Step 11 accepted', () => {
    const id = builderIdentity()
    expect(id.instructionsSha256).toBe(ACCEPTED.instructionsSha256)
    expect(id.reviewSha256).toBe(ACCEPTED.reviewSha256)
    expect(id.instructionsVersion).toBe(ACCEPTED.instructionsVersion)
    expect(id.reviewVersion).toBe(ACCEPTED.reviewVersion)
    expect(id.model).toBe(ACCEPTED.model)
    expect(builderThinkingLevel()).toBe(ACCEPTED.thinkingLevel)
    expect(freezeDrift()).toEqual([])
  })

  it('reports a changed builder as drift', () => {
    expect(freezeDrift({ ...builderIdentity(), instructionsSha256: '0'.repeat(64), thinkingLevel: 'high' })).toEqual(['builder instructions changed', 'builder thinking level high'])
  })
})

describe('the evaluation can’t reach the builder', () => {
  it('no production source imports the quality eval', () => {
    const offenders = sourceFiles(join(ROOT, 'src')).filter((f) => /eval\/studio-quality|studio-quality\//.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('the build takes only the request: it imports no case, rubric, judge or result module', () => {
    const source = readFileSync(join(ROOT, 'eval', 'studio-quality', 'build.ts'), 'utf8')
    // Static imports, dynamic import() and require(), all of them.
    const imports = [...source.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1])
    expect(imports.length).toBeGreaterThan(5)
    expect(imports.filter((i) => i.startsWith('./') || i.startsWith('../studio-quality'))).toEqual([])
    expect(imports.every((i) => i.startsWith('../../src/') || i.startsWith('node:'))).toBe(true)
    // The test helpers that know about the eval are off limits too.
    expect(imports.filter((i) => /__tests__\/helpers\/quality-/.test(i))).toEqual([])
  })

  it('no canonical prompt appears in the builder’s or the reviewer’s instructions or prompt code', () => {
    const builderText = [
      BUILDER_INSTRUCTIONS,
      REVIEW_INSTRUCTIONS,
      readFileSync(join(ROOT, 'src', 'lib', 'studio', 'builder', 'context-builder.ts'), 'utf8'),
      readFileSync(join(ROOT, 'src', 'lib', 'studio', 'builder', 'tools.ts'), 'utf8'),
    ]
      .join('\n')
      .toLowerCase()
    expect(QUALITY_CASES.filter((c) => builderText.includes(c.prompt.toLowerCase())).map((c) => c.id)).toEqual([])
  })

  it('during a build, no hint or goal of any case reaches the model, and questions get only the neutral answer', async () => {
    const c = QUALITY_CASES.find((x) => x.id === 'Q04-peer-review')!
    const model = scriptedModel([{ calls: [call('ask_professor', { question: 'Should reviews be anonymous?' })] }, { calls: [finish('blocked', 'Stopping for the test.')] }])
    const outcome = await buildOnce(c.prompt, { model, budgetUsd: () => 10, renderer: 'off', workerCheck: inProcessWorkerCheck })
    expect(outcome.questionsAsked).toBe(1)
    expect(outcome.status).toBe('blocked')

    const seen = model.prompts.map((p) => `${p.system}\n${p.prompt}`).join('\n')
    expect(seen).toContain(c.prompt)
    expect(model.prompts.at(-1)!.prompt).toContain(NEUTRAL_ANSWER)
    // Distinctive phrases only (four words or more): a single word such as "totals" is ordinary
    // vocabulary the builder's own prompt uses, not a leak.
    const phrases = QUALITY_CASES.flatMap((q) => [q.professorGoal, q.studentGoal, ...q.hints]).filter((text) => text.split(/\s+/).length >= 4)
    expect(phrases.length).toBeGreaterThan(50)
    expect(phrases.filter((text) => seen.includes(text))).toEqual([])
  })
})
