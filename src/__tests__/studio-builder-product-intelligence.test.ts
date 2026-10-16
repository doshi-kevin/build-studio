/**
 * The Product Intelligence artifact's schema (Step 12B.1): what a build carries about the
 * educational product it is for. How the harness persists and resumes it is in
 * studio-builder-recovery.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { initialWork, PRODUCT_INTELLIGENCE_FORMAT, PRODUCT_INTELLIGENCE_MAX_BYTES, productIntelligenceSchema, readProductIntelligence, type ProductIntelligence } from '@/lib/studio/builder/work'

const TEACHING: ProductIntelligence = {
  format: PRODUCT_INTELLIGENCE_FORMAT,
  requestType: 'teaching_problem',
  teachingProblem: 'Students memorise equilibrium shifts without reasoning about Q against K.',
  domainContext: 'General chemistry, second semester.',
  studentDifficulty: 'Predicting the direction of a shift after a stress.',
  professorGoal: 'See which stresses the class still gets wrong.',
  studentGoal: 'Predict, commit, then check against the outcome.',
  platformConstraints: ['No AI inside the plugin.', 'Students read only their own records.'],
  selectedConcept: { title: 'Equilibrium shift predictor', summary: 'Students predict how a system responds to a stress before seeing the result.' },
  learningLoop: ['Predict', 'Commit', 'Reveal', 'Reflect'],
  professorWorkflow: ['Choose the stresses', 'Review the class misconceptions'],
  studentWorkflow: ['Predict a shift', 'Compare with the outcome'],
}

// A request that already names the tool: nothing about a teaching problem is known yet.
const DIRECT: ProductIntelligence = {
  format: PRODUCT_INTELLIGENCE_FORMAT,
  requestType: 'direct_build',
  teachingProblem: null,
  domainContext: null,
  studentDifficulty: null,
  professorGoal: 'Take attendance each lecture.',
  studentGoal: null,
  platformConstraints: [],
  selectedConcept: null,
  learningLoop: [],
  professorWorkflow: [],
  studentWorkflow: [],
}

describe('the Product Intelligence schema', () => {
  it('accepts a teaching problem and a direct build, unknowns as null or empty', () => {
    expect(productIntelligenceSchema.parse(TEACHING)).toEqual(TEACHING)
    expect(productIntelligenceSchema.parse(DIRECT)).toEqual(DIRECT)
  })

  it.each([
    ['an unknown field', { ...TEACHING, ideas: ['x'] }],
    ['a missing field', Object.fromEntries(Object.entries(TEACHING).filter(([k]) => k !== 'studentWorkflow'))],
    ['another format', { ...TEACHING, format: 'studio-product-intelligence-v0' }],
    ['a request type that is neither', { ...TEACHING, requestType: 'guess' }],
    ['an empty text', { ...TEACHING, teachingProblem: '' }],
    ['a control character', { ...TEACHING, domainContext: 'Chemistry\u0007' }],
    ['a bidirectional override', { ...TEACHING, studentGoal: 'Predict ‮evil' }],
    ['a field over its length', { ...TEACHING, professorGoal: 'x'.repeat(401) }],
    ['too many steps', { ...TEACHING, learningLoop: Array.from({ length: 9 }, (_, i) => `Step ${i}`) }],
    ['a concept without a summary', { ...TEACHING, selectedConcept: { title: 'Predictor' } }],
  ])('refuses %s', (_name, value) => {
    expect(productIntelligenceSchema.safeParse(value).success).toBe(false)
  })

  it('refuses an artifact over its byte limit even when every field is within its own', () => {
    const long = (n: number) => Array.from({ length: n }, (_, i) => `${i} ${'w'.repeat(230)}`)
    const big = { ...TEACHING, platformConstraints: long(8), learningLoop: long(8), professorWorkflow: long(10), studentWorkflow: long(10) }
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(PRODUCT_INTELLIGENCE_MAX_BYTES)
    expect(productIntelligenceSchema.safeParse(big)).toMatchObject({ success: false })
  })

  it('reads a stored value back, and anything else as none', () => {
    expect(readProductIntelligence(structuredClone(TEACHING))).toEqual(TEACHING)
    for (const raw of [undefined, null, 'teaching_problem', 42, [], {}, { ...TEACHING, format: 'v0' }]) expect(readProductIntelligence(raw)).toBeNull()
  })

  it('a new working copy has none', () => {
    expect(initialWork(null).product_intelligence).toBeNull()
    expect(initialWork({ manifest: null, files: {} }).product_intelligence).toBeNull()
  })
})
