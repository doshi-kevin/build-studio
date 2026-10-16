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
  const step = vi.fn(async (input: { tools: { name: string }[] }): Promise<ModelStepResult> => ({
    toolCalls: [{ name: input.tools[0].name, input: replies[i++], invalid: false }],
    textLength: 0, finishReason: 'tool-calls', timedOut: false, latencyMs: 1, modelId: 'claude-opus-5-5',
    usage: { input: 3000, cachedInput: 0, output: 5000, reasoning: 0 },
  }))
  return { id: 'claude-opus-5-5', step }
}

/** A specification submission for CONCEPTS[0] (Reverse DCF, reverse_reasoning). */
export const specInput = () => ({
  productGoal: 'Students recover the assumptions a market price implies and judge whether they are believable.',
  mechanic: 'reverse_reasoning',
  learningLoop: [
    'Read: a company, its price and every DCF input but one.',
    'Solve for: the missing input until the in-view DCF matches the price.',
    'Judge: mark the implied value plausible or not and pick the reason.',
    'Compare: see the professor benchmark range and the gap.',
    'Reflect: name which input the price depends on most.',
  ],
  professorWorkflow: {
    setup: 'Open the activity for the section and choose which inputs may be hidden.',
    contentCreation: 'Write each company case and its benchmark range as a record.',
    running: 'Open and close the activity; students work on their own.',
    interpreting: 'See which implied assumptions the class accepted as plausible and which reasons they gave.',
  },
  studentWorkflow: ['Open a case.', 'Solve for the hidden input.', 'Judge plausibility.', 'Compare with the benchmark.'],
  states: [{ name: 'open', meaning: 'Students can solve and judge.' }, { name: 'revealed', meaning: 'The benchmark range is shown after the judgement.' }],
  contentStrategy: { professorAuthored: ['Company cases with price, inputs and benchmark ranges, as records.'], generated: ['The DCF value for each trial input, computed from the formula.'] },
  computation: ['Discounted cash flow value from the inputs.', 'Gap between the model value and the price.'],
  professorInsight: ['Which implied assumptions the class wrongly accepts, such as terminal growth above nominal GDP.', 'How many students finished each case.'],
  dataModel: [
    { name: 'cases', access: 'shared', purpose: 'The company cases and benchmark ranges the professor writes.', writtenBy: 'professor' },
    { name: 'judgements', access: 'perStudent', purpose: 'Each student solved value, plausibility verdict and reason.', writtenBy: 'student' },
  ],
  relationships: ['A judgement belongs to one case by its case key.'],
  primaryInteractions: ['Solve for the hidden input until the model matches the price.', 'Judge whether the implied input is plausible, before seeing the benchmark.'],
  edgeStates: ['No cases written yet: the student sees what the professor must add.'],
  limitations: ['No live prices: the professor enters them.'],
})

/** A plan that keeps the Reverse DCF specification (helpers/ideation-fixtures.ts specInput). */
export const keptPlan = () => ({
  goal: 'Students solve for the input a price implies and judge whether it is plausible.',
  files_to_change: ['views/student.tsx', 'views/professor.tsx'],
  manifest_changes: ['Add cases and judgements collections'],
  capabilities_needed: [],
  checks: ['Both views show loading, empty and error states'],
  professor_view: ['Write company cases with a benchmark range', 'See which implied assumptions the class accepts'],
  student_view: ['Solve for the hidden input with the in-view DCF', 'Judge plausibility, then see the benchmark'],
  data: ['cases (shared): company cases and benchmark ranges the professor writes', 'judgements (perStudent): each student’s solved value and verdict'],
  requirements: [
    'Student can solve for the hidden input until the DCF value matches the price',
    'Student can judge whether the implied input is plausible before seeing the benchmark',
    'Professor sees which implied assumptions the class wrongly accepts, such as terminal growth above nominal GDP',
    'Professor can write company cases with a benchmark range',
  ],
  enhancements: [],
})

/** The same product collapsed into data entry: enter values, fill a form, see a table. */
export const crudPlan = () => ({
  ...keptPlan(),
  goal: 'A form for DCF values.',
  professor_view: ['Enter company values', 'View a table of submissions'],
  student_view: ['Fill in the form', 'Submit'],
  requirements: ['Professor can enter company values', 'Student can fill in the form and submit it', 'Professor sees a table of every submission'],
})
