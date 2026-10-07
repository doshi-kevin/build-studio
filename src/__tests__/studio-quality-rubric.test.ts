/**
 * studio-generation-quality-v1: the rubric's arithmetic, the canonical case set as approved
 * in Step 12A.1, and the platform card the judge reads, derived from the platform's own
 * constants.
 */
import { describe, expect, it } from 'vitest'
import { DIMENSIONS, DIMENSION_KEYS, LEVEL_FRACTION, LEVELS, MAX_SCORE, levelSpread, medianLevel, pointsFor, totalScore, type Level } from '../../eval/studio-quality/rubric'
import { QUALITY_CASES } from '../../eval/studio-quality/cases'
import { platformCardText, platformFacts } from '../../eval/studio-quality/platform-card'
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
  it('are the 20 approved cases, with five variance cases and six holdouts', () => {
    expect(QUALITY_CASES.map((c) => c.id)).toEqual([
      'Q01-attendance', 'Q02-office-hours-booking', 'Q03-participation', 'Q04-peer-review', 'Q05-exit-ticket',
      'Q06-vocab-study', 'Q07-lab-checkoff', 'Q08-group-formation', 'Q09-reading-reflections', 'Q10-extension-requests',
      'Q11-anonymous-qa', 'Q12-project-milestones', 'Q13-equipment-booking', 'Q14-help-queue', 'Q15-rubric-scoring',
      'Q16-course-pulse', 'Q17-student-progress', 'Q18-presentation-signup', 'Q19-discussion', 'Q20-predict-reveal',
    ])
    expect(QUALITY_CASES.filter((c) => c.variance).map((c) => c.id)).toEqual(['Q01-attendance', 'Q02-office-hours-booking', 'Q04-peer-review', 'Q05-exit-ticket', 'Q08-group-formation'])
    expect(QUALITY_CASES.filter((c) => c.set === 'holdout').map((c) => c.id)).toEqual([
      'Q07-lab-checkoff', 'Q10-extension-requests', 'Q13-equipment-booking', 'Q15-rubric-scoring', 'Q17-student-progress', 'Q20-predict-reveal',
    ])
    // The variance subset is measured on development cases only.
    expect(QUALITY_CASES.filter((c) => c.variance && c.set === 'holdout')).toEqual([])
  })

  it('each has a professor and a student goal and at least two hints, and a unique prompt', () => {
    for (const c of QUALITY_CASES) {
      expect(c.professorGoal.length).toBeGreaterThan(5)
      expect(c.studentGoal.length).toBeGreaterThan(5)
      expect(c.hints.length).toBeGreaterThanOrEqual(2)
    }
    expect(new Set(QUALITY_CASES.map((c) => c.prompt)).size).toBe(QUALITY_CASES.length)
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
