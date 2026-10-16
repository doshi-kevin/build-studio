/**
 * Product Specification (Step 12B.3): the selected concept elaborated into a specification,
 * the check that it keeps the concept's mechanic, the content rule, one repair, and that a
 * finished stage is not asked for again. A scripted model; no network. Persistence through
 * slices is in studio-builder-recovery.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { productIntelligence, specify, validateSpecification, specificationCallSchema } from '@/lib/studio/builder/specification'
import { readProductIntelligence } from '@/lib/studio/builder/work'
import { callInput, CONCEPTS, ideationModel, specInput } from './helpers/ideation-fixtures'

const REQ = { request: 'My students can calculate a DCF but do not understand what drives the value.', course: null, skills: null }
const spec = (patch: Record<string, unknown> = {}) => ({ ...specInput(), ...patch })
const codes = (patch: Record<string, unknown>) => validateSpecification(specificationCallSchema.parse(spec(patch)), CONCEPTS[0]).map((i) => i.code)

describe('the specification stage', () => {
  it('turns the selected concept into a valid specification, recording its cost, and never asks about the other concepts', async () => {
    const model = ideationModel([callInput(), spec()])
    const out = await productIntelligence(model, REQ)
    expect(model.step).toHaveBeenCalledTimes(2)
    const artifact = readProductIntelligence(out.artifact)
    expect(artifact?.specification?.mechanic).toBe('reverse_reasoning')
    expect(artifact?.specification?.model).toMatchObject({ calls: 1, inputTokens: 3000, outputTokens: 5000 })
    expect(artifact?.specification?.model.costUsd).toBeCloseTo(0.112, 6)
    expect(out.calls).toHaveLength(2)
    const prompt: string = model.step.mock.calls[1][0].prompt
    expect(prompt).toContain('Reverse DCF')
    expect(prompt).not.toContain('Analyst Dispute')
  })

  it('keeps the concept: a form-and-table specification fails, and so does a changed mechanic', () => {
    expect(codes({})).toEqual([])
    const form = { learningLoop: ['Enter: the professor enters values.', 'Fill: the student fills a form.', 'View: the professor views a table.'], primaryInteractions: ['Fill the form.', 'Submit the answers.'] }
    expect(codes(form)).toEqual(['mechanic_missing_from_loop', 'mechanic_missing_from_interactions'])
    expect(codes({ mechanic: 'diagnosis' })).toContain('mechanic_changed')
  })

  it('keeps a reverse-reasoning specification that names its action as finding the hidden cause (live chemistry rejection, 2026-10-16)', () => {
    // The specification's own loop and interactions from the rejected live attempt, abridged.
    const concept = { ...CONCEPTS[0], mechanic: 'reverse_reasoning' as const }
    const chemistry = specificationCallSchema.parse(spec({
      learningLoop: [
        'Inspect: read the before and after equilibrium concentrations of each species, and K before and after.',
        'Check K: decide whether K increased, decreased or stayed the same.',
        'Commit: choose the cause (add or remove a species, compress, heat, catalyst or inert gas), the K claim and the shift direction.',
        'Reveal: see the true perturbation and the Q right after the disturbance compared with the new K.',
      ],
      primaryInteractions: [
        'Student chooses the cause, K claim and shift direction for a generated before/after case, then commits, and the answer locks.',
        'The New case button creates a distinct hidden perturbation on a professor-written reaction.',
      ],
    }))
    expect(validateSpecification(chemistry, concept).map((i) => i.code)).toEqual([])
    // Still strict: "because" is not "cause", and a loop with no backward step fails.
    const forward = specificationCallSchema.parse(spec({
      learningLoop: ['Read: the reaction.', 'Answer: a question because it is set.', 'Submit: the answer.'],
      primaryInteractions: ['Student answers questions because they are assigned.', 'Professor sees scores.'],
    }))
    expect(validateSpecification(forward, concept).map((i) => i.code)).toEqual(['mechanic_missing_from_loop', 'mechanic_missing_from_interactions'])
  })

  it('refuses a fixed content bank built into the code, and generic-only professor insight', () => {
    expect(codes({ contentStrategy: { professorAuthored: ['A bank of twenty cases ships in the view code.'], generated: [] } })).toEqual(['hardcoded_content_bank'])
    expect(codes({ professorInsight: ['Average score across the class.', 'Number of submissions.'] })).toEqual(['generic_insight'])
    expect(codes({ professorInsight: ['Average score across the class.', 'Which implied inputs the class accepts that a benchmark would reject.'] })).toEqual([])
    expect(codes({ dataModel: [{ name: 'judgements', access: 'perStudent', purpose: 'Student answers.', writtenBy: 'student' }] })).toEqual(['no_data_model'])
  })

  it('repairs once, with the reasons and the previous answer; two bad answers keep the ideation and drop the specification', async () => {
    const bad = spec({ professorInsight: ['Average score across the class.'] })
    const fixed = ideationModel([callInput(), bad, spec()])
    const out = await productIntelligence(fixed, REQ)
    expect(fixed.step).toHaveBeenCalledTimes(3)
    expect(fixed.step.mock.calls[2][0].prompt).toContain('Every professor insight is a count or an average')
    expect(out.artifact?.specification?.model.calls).toBe(2)
    expect(out.specificationRejections).toEqual([['generic_insight']])

    const stuck = await productIntelligence(ideationModel([callInput(), bad, bad]), REQ)
    expect(stuck.artifact?.ideation?.candidates).toHaveLength(3)
    expect(stuck.artifact?.specification).toBeNull()
    expect(stuck.specificationRejections).toEqual([['generic_insight'], ['generic_insight']])
  })

  it('reports a schema failure as a code, and never regenerates a finished stage', async () => {
    const long = ideationModel([callInput(), spec({ productGoal: 'x'.repeat(301) }), spec()])
    expect((await productIntelligence(long, REQ)).specificationRejections).toEqual([['field_too_long:productGoal']])

    const done = (await productIntelligence(ideationModel([callInput(), spec()]), REQ)).artifact!
    const again = ideationModel([])
    expect((await productIntelligence(again, REQ, done)).artifact).toEqual(done)
    expect(again.step).not.toHaveBeenCalled()

    // Ideation finished but the specification did not: only the specification is asked for.
    const half = { ...done, specification: null }
    const resume = ideationModel([spec()])
    expect((await productIntelligence(resume, REQ, half)).artifact?.specification?.mechanic).toBe('reverse_reasoning')
    expect(resume.step).toHaveBeenCalledTimes(1)
    expect((await specify(ideationModel([]), REQ, { ...done, ideation: null })).specification).toBeNull()
  })

  it('a direct build asks for nothing', async () => {
    const model = ideationModel([])
    const out = await productIntelligence(model, { ...REQ, request: 'Build an office-hours queue.' })
    expect(model.step).not.toHaveBeenCalled()
    expect(out.artifact?.specification).toBeUndefined()
  })
})
