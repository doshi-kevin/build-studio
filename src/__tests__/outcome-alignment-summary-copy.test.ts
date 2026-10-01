/**
 * #633 — two wording defects in the ABET alignment output. The numbers were always
 * right; the prose around them was not, and a professor who reads a false sentence
 * reasonably stops trusting the numbers too.
 *
 * Part 2 here: given only "No evidence for SO-1, SO-2…", Athena narrated that the
 * course "doesn't have any modules or assignments built out yet" — on a section with a
 * published assignment. The model wasn't wrong to summarise; it was filling a gap the
 * summary left. Naming what WAS analysed removes the gap, which is a deterministic fix
 * for a generation problem rather than another prompt instruction.
 *
 * The oracle is that the counts appear and the "no evidence" phrasing cannot be read as
 * "nothing exists". Asserting the summary is non-empty would pass against the old code.
 */

import { describe, it, expect } from 'vitest'
import { buildSummary } from '@/lib/jobs/pipelines/outcome-alignment/reduce'
import type { AlignmentRollup, Indicator } from '@/lib/jobs/pipelines/outcome-alignment/types'

const INDICATORS = [
  { id: 'i1', code: 'PI 1.1', description: 'x', outcomeCode: 'SO-1' },
  { id: 'i2', code: 'PI 2.1', description: 'y', outcomeCode: 'SO-2' },
] as Indicator[]

/** A thin course: nothing mapped, so every outcome is a gap. */
const THIN = {
  standardId: 's1',
  aligned: 0,
  gaps: ['SO-1', 'SO-2'],
  outcomeLevels: { 'SO-1': null, 'SO-2': null },
} as unknown as AlignmentRollup

describe('#633 part 2 — the summary must not imply the course is empty', () => {
  it('names what was analysed when evidence is zero but artifacts exist', () => {
    const summary = buildSummary(THIN, INDICATORS, { assignment: 1, module_item: 3 })

    // The facts that stop the narration inventing an absence.
    expect(summary).toMatch(/1 assignment\b/)
    expect(summary).toMatch(/3 course materials/)
    // And it says explicitly that they were examined, not missing.
    expect(summary).toMatch(/examined and did not map, rather than being absent/i)
  })

  it('pluralises honestly', () => {
    const one = buildSummary(THIN, INDICATORS, { quiz: 1 })
    const many = buildSummary(THIN, INDICATORS, { quiz: 4 })
    expect(one).toContain('1 quiz')
    expect(one).not.toContain('1 quizs')
    expect(many).toContain('4 quizs')
  })

  it('omits the sentence entirely when nothing was analysed', () => {
    // A genuinely empty course must NOT claim to have analysed anything.
    const summary = buildSummary(THIN, INDICATORS, {})
    expect(summary).not.toMatch(/Analysed/)
    expect(summary).toContain('No evidence for SO-1, SO-2.')
  })

  it('still works with no counts supplied at all (older callers)', () => {
    const summary = buildSummary(THIN, INDICATORS)
    expect(summary).toContain('Covered 0 of 2 outcomes')
    expect(summary).not.toMatch(/Analysed/)
  })

  it('keeps the existing covered/gap reporting intact', () => {
    const summary = buildSummary(THIN, INDICATORS, { assignment: 1 })
    expect(summary).toContain('Covered 0 of 2 outcomes (0/2 indicators).')
  })
})
