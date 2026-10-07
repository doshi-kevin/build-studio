/**
 * studio-generation-quality-v1: the rubric's arithmetic, the canonical case set (Tier 1 as
 * approved in Step 12A.1, Tier 2 in Step 12A.3, with its sealed holdouts), and the platform card the judge reads, derived from the platform's own
 * constants.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DIMENSIONS, DIMENSION_KEYS, LEVEL_FRACTION, LEVELS, MAX_SCORE, levelSpread, medianLevel, pointsFor, totalScore, type Level } from '../../eval/studio-quality/rubric'
import { QUALITY_CASES, qualityCase, type Reasoning } from '../../eval/studio-quality/cases'
import { judgeContextOf } from '../../eval/studio-quality/artifacts'
import { KIT_RECORDS_LOAD_MAX, platformCardText, platformFacts } from '../../eval/studio-quality/platform-card'
import { DEFAULT_SEALED_SPEC, loadSealedSpec, parseSealedSpec, withSealedGuidance } from '../../eval/studio-quality/sealed'
import { parseManifest } from '@/lib/studio/manifest'
import { AVAILABLE_CAPABILITIES } from '@/lib/studio/builder/manifest-delta'
import { CAPABILITY_NAMES } from '@/lib/studio/capabilities'
import { KIT_IMPORTS } from '@/lib/studio/kit/plugin-kit-types'

const all = (level: Level) => Object.fromEntries(DIMENSION_KEYS.map((k) => [k, level]))

describe('the rubric', () => {
  it('has the nine approved dimensions, weighted to exactly 100', () => {
    expect(DIMENSIONS.map((d) => [d.key, d.points])).toEqual([
      ['problem_understanding', 15],
      ['workflow_completeness', 20],
      ['professor_experience', 15],
      ['student_experience', 15],
      ['interaction_design', 10],
      ['visual_quality', 10],
      ['information_design', 5],
      ['edge_states', 5],
      ['responsiveness_accessibility', 5],
    ])
    expect(MAX_SCORE).toBe(100)
  })

  it('maps each level to a fixed share of the dimension, never a judge’s number', () => {
    expect(LEVELS).toEqual(['none', 'weak', 'acceptable', 'excellent'])
    expect(LEVEL_FRACTION).toEqual({ none: 0, weak: 0.4, acceptable: 0.7, excellent: 1 })
    expect(LEVELS.map((l) => pointsFor('workflow_completeness', l))).toEqual([0, 8, 14, 20])
    expect(LEVELS.map((l) => pointsFor('edge_states', l))).toEqual([0, 2, 3.5, 5])
  })

  it('totals from 0 to 100, and gives no total when any dimension is unassessed', () => {
    expect(totalScore(all('none'))).toBe(0)
    expect(totalScore(all('excellent'))).toBe(100)
    expect(totalScore(all('acceptable'))).toBe(70)
    expect(totalScore({ ...all('excellent'), visual_quality: null })).toBeNull()
  })

  it('every dimension defines all four levels, its evidence and what not to reward', () => {
    for (const d of DIMENSIONS) {
      for (const l of LEVELS) expect(d.levels[l].length).toBeGreaterThan(10)
      expect(d.evidence.length).toBeGreaterThan(5)
      expect(d.mustNotReward.length).toBeGreaterThan(5)
    }
    expect(DIMENSIONS.filter((d) => d.visualOnly).map((d) => d.key)).toEqual(['visual_quality'])
  })

  it('takes the median level, the lower one on an even split, and measures the spread', () => {
    expect(medianLevel(['weak', 'excellent', 'acceptable'])).toBe('acceptable')
    expect(medianLevel(['excellent', 'weak'])).toBe('weak')
    expect(medianLevel(['none'])).toBe('none')
    expect(medianLevel([])).toBeNull()
    expect(levelSpread(['weak', 'excellent', 'acceptable'])).toBe(2)
    expect(levelSpread(['acceptable', 'acceptable'])).toBe(0)
  })
})

describe('the canonical cases', () => {
  const core = QUALITY_CASES.filter((c) => c.tier === 'core')
  const deep = QUALITY_CASES.filter((c) => c.tier === 'deep')

  it('are 28: the 20 Tier 1 cases of Step 12A.1 and the 8 Tier 2 cases of Step 12A.3', () => {
    expect(QUALITY_CASES).toHaveLength(28)
    expect(core.map((c) => c.id)).toEqual([
      'Q01-attendance', 'Q02-office-hours-booking', 'Q03-participation', 'Q04-peer-review', 'Q05-exit-ticket',
      'Q06-vocab-study', 'Q07-lab-checkoff', 'Q08-group-formation', 'Q09-reading-reflections', 'Q10-extension-requests',
      'Q11-anonymous-qa', 'Q12-project-milestones', 'Q13-equipment-booking', 'Q14-help-queue', 'Q15-rubric-scoring',
      'Q16-course-pulse', 'Q17-student-progress', 'Q18-presentation-signup', 'Q19-discussion', 'Q20-predict-reveal',
    ])
    expect(deep.map((c) => c.id)).toEqual([
      'D01-form-builder', 'D02-branching-stories', 'D03-spaced-practice', 'D04-staged-case',
      'D05-review-game', 'D06-final-grade-calculator', 'D07-peer-feedback', 'D08-lab-notebook',
    ])
    expect(new Set(QUALITY_CASES.map((c) => c.id)).size).toBe(28)
  })

  it('Tier 1 is exactly as approved in Step 12A.1: prompts, goals, hints, sets and variance unchanged', () => {
    const definitions = core.map(({ id, prompt, category, inPattern, professorGoal, studentGoal, hints, set, variance }) => ({ id, prompt, category, inPattern, professorGoal, studentGoal, hints, set, variance }))
    expect(createHash('sha256').update(JSON.stringify(definitions)).digest('hex')).toBe('dd02bea98ab5eb514f2ff52a8f51e3df6d69ad12468f2e3af293cd098b3ae191')
    expect(core.filter((c) => c.set === 'holdout').map((c) => c.id)).toEqual([
      'Q07-lab-checkoff', 'Q10-extension-requests', 'Q13-equipment-booking', 'Q15-rubric-scoring', 'Q17-student-progress', 'Q20-predict-reveal',
    ])
  })

  it('Tier 2 seals exactly D02, D05 and D06 as holdouts, and every reasoning kind has a development and a holdout case', () => {
    expect(deep.filter((c) => c.set === 'holdout').map((c) => c.id)).toEqual(['D02-branching-stories', 'D05-review-game', 'D06-final-grade-calculator'])
    expect(deep.filter((c) => c.sealed).map((c) => c.id)).toEqual(['D02-branching-stories', 'D05-review-game', 'D06-final-grade-calculator'])
    expect(core.some((c) => c.sealed)).toBe(false)
    const kinds: Reasoning[] = ['runtime-structure', 'branching', 'algorithmic', 'multi-role', 'longitudinal', 'phases', 'synthesis', 'platform-limits']
    for (const kind of kinds) {
      expect(deep.some((c) => c.set === 'dev' && c.reasoning?.includes(kind)), `${kind} in development`).toBe(true)
      expect(deep.some((c) => c.set === 'holdout' && c.reasoning?.includes(kind)), `${kind} in the holdout`).toBe(true)
    }
  })

  it('a sealed case keeps only what running it needs: no goal, hint or guidance in the development-facing list', () => {
    for (const c of deep.filter((x) => x.sealed)) {
      expect(c).toMatchObject({ professorGoal: null, studentGoal: null, hints: [] })
      expect(c.guidance).toBeUndefined()
      expect(c.prompt.length).toBeGreaterThan(40)
      expect(() => judgeContextOf(c)).toThrow(/sealed/)
    }
  })

  it('the six variance cases are the five Tier 1 cases and D01, all in development: 52 builds for the baseline', () => {
    const variance = QUALITY_CASES.filter((c) => c.variance)
    expect(variance.map((c) => c.id)).toEqual(['Q01-attendance', 'Q02-office-hours-booking', 'Q04-peer-review', 'Q05-exit-ticket', 'Q08-group-formation', 'D01-form-builder'])
    expect(variance.every((c) => c.set === 'dev')).toBe(true)
    // One initial build per case, plus four repeats of each variance case.
    expect(QUALITY_CASES.length + 4 * variance.length).toBe(52)
  })

  it('every case open to development has goals and hints, every Tier 2 development case its review guidance, and prompts are unique', () => {
    for (const c of QUALITY_CASES.filter((x) => !x.sealed)) {
      expect(c.professorGoal!.length).toBeGreaterThan(5)
      expect(c.studentGoal!.length).toBeGreaterThan(5)
      expect(c.hints.length).toBeGreaterThanOrEqual(2)
    }
    for (const c of deep.filter((x) => x.set === 'dev')) {
      expect(c.guidance!.constraints.length).toBeGreaterThan(0)
      expect(c.guidance!.shallow.length).toBeGreaterThan(40)
      expect(c.guidance!.strong.length).toBeGreaterThan(40)
    }
    expect(new Set(QUALITY_CASES.map((c) => c.prompt)).size).toBe(QUALITY_CASES.length)
  })

  it('the record-load limit the hints quote is the kit’s own', () => {
    const kit = readFileSync(join(process.cwd(), 'src', 'lib', 'studio', 'kit', 'v2', 'components.tsx'), 'utf8')
    expect(kit).toContain(`const RECORDS_MAX = ${KIT_RECORDS_LOAD_MAX}`)
    expect(qualityCase('D03-spaced-practice')!.hints.join(' ')).toContain(String(KIT_RECORDS_LOAD_MAX))
  })
})

describe('the sealed Tier 2 holdout guidance', () => {
  const entry = (id: string) => ({
    professorGoal: `Professor goal for ${id}.`,
    studentGoal: `Student goal for ${id}.`,
    hints: [`hint one for ${id}`, `hint two for ${id}`],
    guidance: { constraints: ['a rule'], shallow: 'shallow', strong: 'strong', capabilities: [], mustNotAssume: [] },
  })
  const spec = (ids: string[]) => ({ format: 'studio-quality-sealed-holdouts-v1', cases: Object.fromEntries(ids.map((id) => [id, entry(id)])) })
  const SEALED = ['D02-branching-stories', 'D05-review-game', 'D06-final-grade-calculator']

  it('joins the case list only when loaded, and then the judge can read it', () => {
    const merged = withSealedGuidance(QUALITY_CASES, parseSealedSpec(spec(SEALED), QUALITY_CASES))
    const d05 = merged.find((c) => c.id === 'D05-review-game')!
    expect(judgeContextOf(d05)).toEqual({ professorGoal: 'Professor goal for D05-review-game.', studentGoal: 'Student goal for D05-review-game.', hints: ['hint one for D05-review-game', 'hint two for D05-review-game'] })
    // The shared list is untouched.
    expect(qualityCase('D05-review-game')!.hints).toEqual([])
    expect(merged.filter((c) => !c.sealed)).toEqual(QUALITY_CASES.filter((c) => !c.sealed))
  })

  it('refuses a file that misses a sealed case, names another case, has the wrong format, or is missing', () => {
    expect(() => parseSealedSpec(spec(SEALED.slice(0, 2)), QUALITY_CASES)).toThrow(/sealed cases are/)
    expect(() => parseSealedSpec(spec([...SEALED, 'D01-form-builder']), QUALITY_CASES)).toThrow(/sealed cases are/)
    expect(() => parseSealedSpec({ ...spec(SEALED), format: 'v0' }, QUALITY_CASES)).toThrow()
    expect(() => loadSealedSpec(join(tmpdir(), 'no-such-sealed-file.json'), QUALITY_CASES)).toThrow(/isn’t at/)
  })

  it('the sealed file’s default path is one git ignores and doesn’t track', () => {
    // check-ignore exits 0 only for an ignored path that isn't tracked; anything else throws.
    expect(() => execFileSync('git', ['check-ignore', '-q', DEFAULT_SEALED_SPEC], { cwd: process.cwd(), stdio: 'ignore' })).not.toThrow()
  })

  it.skipIf(!existsSync(DEFAULT_SEALED_SPEC))('the local sealed file is valid, and none of its goals, hints or review notes sit in the eval code or its tests', () => {
    const local = loadSealedSpec(DEFAULT_SEALED_SPEC, QUALITY_CASES)
    const evalDir = join(process.cwd(), 'eval', 'studio-quality')
    const testDir = join(process.cwd(), 'src', '__tests__')
    const tracked = [
      ...readdirSync(evalDir).filter((f) => /\.(ts|md)$/.test(f)).map((f) => join(evalDir, f)),
      ...readdirSync(testDir).filter((f) => f.startsWith('studio-quality-')).map((f) => join(testDir, f)),
      ...readdirSync(join(testDir, 'helpers')).filter((f) => f.startsWith('quality-')).map((f) => join(testDir, 'helpers', f)),
    ].map((f) => readFileSync(f, 'utf8'))
    // Labels only, so a failure never prints the sealed text.
    const leaks = Object.entries(local.cases).flatMap(([id, c]) =>
      [['professorGoal', c.professorGoal], ['studentGoal', c.studentGoal], ['shallow', c.guidance.shallow], ['strong', c.guidance.strong], ...c.hints.map((h, i) => [`hints[${i}]`, h])]
        .filter(([, text]) => tracked.some((source) => source.includes(text)))
        .map(([field]) => `${id}.${field}`),
    )
    expect(leaks).toEqual([])
  })
})

describe('the platform card', () => {
  const facts = platformFacts()

  it('reads the access modes and field types the manifest validator accepts, each of which it does accept', () => {
    expect(facts.accessModes.map((a) => a.mode)).toEqual(['perStudent', 'staffPerStudent', 'shared', 'staffOnly'])
    expect(facts.fieldTypes).toEqual(['text', 'number', 'boolean'])
    for (const a of facts.accessModes) {
      expect(a.label.length).toBeGreaterThan(10)
      expect(a.staff.length).toBeGreaterThan(3)
    }
    expect(facts.accessModes.find((a) => a.mode === 'staffOnly')!.students).toMatch(/never sent/i)
    const probe = parseManifest({ manifestVersion: 2, collections: { x: { access: 'everyone', fields: { a: 'text' } } } })
    expect(probe.ok).toBe(false)
  })

  it('lists every registered capability and marks the ones with no Bridge method unavailable', () => {
    expect(facts.capabilities.map((c) => c.name).sort()).toEqual([...CAPABILITY_NAMES].sort())
    for (const c of facts.capabilities) expect(c.available).toBe((AVAILABLE_CAPABILITIES as string[]).includes(c.name))
    expect(facts.capabilities.find((c) => c.name === 'course.weakSpots')!.available).toBe(false)
  })

  it('names the kit’s components and the frame’s restrictions from the code', () => {
    expect(facts.kit).toEqual([...KIT_IMPORTS['@scholera/plugin-kit']])
    expect(facts.frameRestrictions).toEqual(expect.arrayContaining(["connect-src 'none'", "img-src 'none'", "form-action 'none'", 'sandbox allow-scripts']))
    const text = platformCardText(facts)
    expect(text).toContain('Students never read another student’s records')
    expect(text).toContain('This tool doesn’t use AI.')
  })
})
