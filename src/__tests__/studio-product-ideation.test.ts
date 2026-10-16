/**
 * Divergent product ideation (Step 12B.2): routing, three concepts, the divergence and
 * platform checks, the one repair, and what is kept. A scripted model; no network. How the
 * artifact persists through slices and crashes is in studio-builder-recovery.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { classifyRequest, ideate, validateConcepts } from '@/lib/studio/builder/ideation'
import { readProductIntelligence } from '@/lib/studio/builder/work'
import { callInput, CONCEPTS, ideationModel } from './helpers/ideation-fixtures'

const REQ = { request: 'My students can calculate a DCF but do not understand what drives the value.', course: null, skills: null }
const withConcept = (i: number, patch: Partial<(typeof CONCEPTS)[number]>) => CONCEPTS.map((c, k) => (k === i ? { ...c, ...patch } : c))

describe('routing', () => {
  it.each([
    ['Build an office-hours queue.', 'direct_build'],
    ['Make a quiz for week 3', 'direct_build'],
    ['My students struggle to understand confidence intervals.', 'teaching_problem'],
    ['My students know the formulas for hypothesis tests but keep choosing the wrong statistical test.', 'teaching_problem'],
  ])('%s is %s', (request, expected) => expect(classifyRequest(request)).toBe(expected))

  it('a direct build makes no model call and carries no concepts', async () => {
    const model = ideationModel([])
    const out = await ideate(model, { ...REQ, request: 'Build an office-hours queue.' })
    expect(model.step).not.toHaveBeenCalled()
    expect(out.artifact).toMatchObject({ requestType: 'direct_build', selectedConcept: null, ideation: null })
  })
})

describe('a teaching problem', () => {
  it('yields three candidates, the selection, and a valid artifact with model and cost recorded', async () => {
    const model = ideationModel([callInput(CONCEPTS, 1)])
    const out = await ideate(model, REQ)
    expect(model.step).toHaveBeenCalledTimes(1)
    const artifact = readProductIntelligence(out.artifact)
    expect(artifact?.ideation?.candidates.map((c) => c.name)).toEqual(['Reverse DCF', 'Scenario Stress Lab', 'Analyst Dispute'])
    expect(artifact?.selectedConcept?.title).toBe('Scenario Stress Lab')
    expect(artifact?.ideation).toMatchObject({ repaired: false, model: { provider: 'anthropic', id: 'claude-opus-5-5', calls: 1, inputTokens: 3000, outputTokens: 5000 } })
    // 3000 in at $4/MTok + 5000 out at $20/MTok
    expect(artifact?.ideation?.model.costUsd).toBeCloseTo(0.112, 6)
  })
})

const codes = (concepts: typeof CONCEPTS, selected = 0) => validateConcepts(concepts, selected).map((x) => x.code)

describe('divergence and platform checks', () => {
  it('refuses concepts that share a mechanic, and a mechanic written as a layout', () => {
    expect(codes(withConcept(1, { mechanic: 'reverse_reasoning' }))).toEqual(['duplicate_mechanic'])
    expect(codes(withConcept(1, { learningMechanic: 'A dashboard of tabs showing the shocks.' }))).toEqual(['layout_mechanic'])
    expect(codes(CONCEPTS)).toEqual([])
  })

  it('does not accept a missing capability as feasible, but accepts it negated or adapted', () => {
    const needsAi = withConcept(0, { idea: 'An AI tutor explains each wrong answer to the student.' })
    expect(codes(needsAi)).toEqual(['unsupported_capability:AI inside the tool'])
    expect(codes(withConcept(0, { idea: 'Rule-based hints with no AI involved.' }))).toEqual([])
    expect(codes(withConcept(0, { ...needsAi[0], feasibility: 'adapted', limitations: 'Hints are written by the professor.' }))).toEqual([])
    expect(codes(withConcept(0, { feasibility: 'adapted', limitations: 'None.' }))).toEqual(['invalid_feasibility'])
    expect(codes(withConcept(0, { feasibility: 'infeasible', limitations: 'Needs live market data.' }))).toEqual(['selected_infeasible'])
  })

  it('does not call a concept feasible when its content bank is built into the view code', () => {
    for (const limitations of ['Base cases live in code, so setup costs little.', 'A starter bank of 25 scenarios can ship in the view.']) {
      expect(codes(withConcept(0, { limitations }))).toEqual(['hardcoded_content_bank'])
    }
    expect(codes(withConcept(0, { limitations: 'The professor writes each case as a record. No content is embedded in code.' }))).toEqual([])
    expect(codes(withConcept(0, { feasibility: 'adapted', limitations: 'Cases are written by the professor as records, not built into the code.' }))).toEqual([])
  })

  it('reports why an attempt failed: field length from the schema, and the custom rules, as compact codes', async () => {
    const tooLong = callInput(withConcept(2, { studentLoop: 'x'.repeat(301) }))
    const dup = callInput(withConcept(1, { mechanic: 'reverse_reasoning' }))
    const model = ideationModel([tooLong, dup, dup])
    const out = await ideate(model, REQ)
    expect(out.rejections).toEqual([['field_too_long:studentLoop'], ['duplicate_mechanic']])
    expect(out.artifact).toBeNull()
  })

  it('repairs once: a bad first set is regenerated with its reasons, a second bad set means no artifact', async () => {
    const bad = callInput(withConcept(1, { mechanic: 'reverse_reasoning' }))
    const fixed = ideationModel([bad, callInput()])
    const out = await ideate(fixed, REQ)
    expect(fixed.step).toHaveBeenCalledTimes(2)
    expect(fixed.step.mock.calls[1][0].prompt).toContain('share the mechanic reverse_reasoning')
    expect(out.artifact?.ideation).toMatchObject({ repaired: true, model: { calls: 2, inputTokens: 6000 } })
    expect(out.rejections).toEqual([['duplicate_mechanic']])

    const stuck = ideationModel([bad, bad, bad])
    const none = await ideate(stuck, REQ)
    expect(stuck.step).toHaveBeenCalledTimes(2)
    expect(none.artifact).toBeNull()
    expect(none.calls).toHaveLength(2)
  })
})
