/** Product ideation fixtures: three concepts that differ in mechanic, and a scripted model for them. */
import { vi } from 'vitest'
import type { Concept } from '@/lib/studio/builder/work'
import type { AgentModel, ModelStepResult } from '@/lib/studio/builder/model'

export const CONCEPTS: Concept[] = [
  {
    name: 'Reverse DCF', mechanic: 'reverse_reasoning',
    idea: 'Students get a market price and must recover the growth and discount rate it implies.',
    learningMechanic: 'Working backwards from a price to the assumptions that justify it exposes which inputs carry the valuation.',
    studentLoop: 'See a price, set growth and margin until the model matches, then say which assumption was least plausible.',
    professorValue: 'Shows which assumptions the class reaches for first.',
    dataProduced: 'Each attempt: the assumptions chosen and the gap to the price.',
    domainSpecificity: 'Uses terminal growth, WACC and free cash flow margins, not generic sliders.',
    whyBetterThanGenericLMS: 'A quiz cannot make a student feel how little a price constrains the inputs.',
    feasibility: 'feasible', limitations: 'None.',
  },
  {
    name: 'Scenario Stress Lab', mechanic: 'scenario_stress_test',
    idea: 'A fixed valuation is hit with a recession, a rate rise and a margin squeeze, one after another.',
    learningMechanic: 'Pushing one model through hostile conditions shows which assumption breaks it first.',
    studentLoop: 'Predict the value after each shock, apply it, compare, then rank the shocks by damage.',
    professorValue: 'Shows which shocks students underestimate.',
    dataProduced: 'Predicted against computed value per shock.',
    domainSpecificity: 'Shocks are valuation drivers: rates, margins and growth fade.',
    whyBetterThanGenericLMS: 'Students commit to a number before the consequence appears.',
    feasibility: 'feasible', limitations: 'The professor picks the shocks from a short list.',
  },
  {
    name: 'Analyst Dispute', mechanic: 'argument_evidence',
    idea: 'Two analysts reach different values from the same company; the student finds the assumption that explains the gap.',
    learningMechanic: 'Locating the single input that separates two valuations builds the habit of arguing from evidence.',
    studentLoop: 'Read two assumption sets, name the differing driver, defend it, then see the value gap it explains.',
    professorValue: 'Shows which drivers students mistake for the cause.',
    dataProduced: 'The driver each student blamed and their reason.',
    domainSpecificity: 'The disagreements are the ones real analysts have about discount rates and terminal value.',
    whyBetterThanGenericLMS: 'The task is a judgement, not a calculation.',
    feasibility: 'adapted', limitations: 'Analyst notes are written by the professor, since no AI can draft them.',
  },
]

export const callInput = (concepts: Concept[] = CONCEPTS, selectedIndex = 0) => ({
  teachingProblem: 'Students can calculate a DCF but do not see what drives the value.',
  domainContext: 'Corporate finance.',
  studentDifficulty: 'Treating every assumption as equally important.',
  professorGoal: 'Students can say which assumptions drive a valuation.',
  concepts, selectedIndex, selectionRationale: 'It forces the clearest commitment and is cheap to set up.',
})

/** A model that answers each call with the next scripted input, recording calls. */
export function ideationModel(replies: unknown[]): AgentModel & { step: ReturnType<typeof vi.fn> } {
  let i = 0
  const step = vi.fn(async (): Promise<ModelStepResult> => ({
    toolCalls: [{ name: 'submit_concepts', input: replies[i++], invalid: false }],
    textLength: 0, finishReason: 'tool-calls', timedOut: false, latencyMs: 1, modelId: 'claude-opus-5-5',
    usage: { input: 3000, cachedInput: 0, output: 5000, reasoning: 0 },
  }))
  return { id: 'claude-opus-5-5', step }
}
