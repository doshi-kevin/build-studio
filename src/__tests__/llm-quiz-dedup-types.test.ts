// @vitest-environment node
//
// generateQuizQuestions runs chunks SEQUENTIALLY, feeding each the stems already
// produced so a big quiz stays diverse instead of collapsing to one chunk's
// worth of duplicates. It must (a) still drop duplicates via the safety-net
// dedup, (b) enforce the caller's requested types — the output schema accepts
// all six, so a stray AI-graded `explanation` on a non-adaptive quiz would
// otherwise slip through, (c) pass the avoid-list into later chunks' prompts,
// and (d) deliver the full count when chunks return distinct questions.
// Gemini is mocked; usage tracking is stubbed.
import { describe, it, expect, vi } from 'vitest'

// Keep the real module (NoObjectGeneratedError etc.), mock only the calls.
// embedMany is mocked with no implementation → SemanticDedup's catch fails
// open, so these tests exercise the lexical dedup deterministically (semantic
// dedup has its own unit tests in quiz-quality.test.ts).
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
  generateObject: vi.fn(),
  embedMany: vi.fn(),
}))
vi.mock('@ai-sdk/google', () => ({ google: () => 'mock-model' }))
vi.mock('@/lib/ai/usage', () => ({ recordAiUsage: vi.fn() }))

import { generateObject, NoObjectGeneratedError } from 'ai'
import { generateQuizQuestions, salvageRawQuestions, type GeneratedQuestion } from '@/lib/ai/llm-client'

const gen = vi.mocked(generateObject)

const mc = (text: string) => ({
  questionType: 'multiple_choice',
  questionText: text,
  choices: [
    { text: 'right', isCorrect: true },
    { text: 'wrong', isCorrect: false },
  ],
  difficulty: 'easy',
})
const explanation = (text: string) => ({
  questionType: 'explanation',
  questionText: text,
  rubric: [{ concept: 'the key idea a strong answer conveys' }],
  difficulty: 'medium',
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolve = (questions: unknown[]) => gen.mockResolvedValue({ object: { questions } } as any)

// NO beforeEach hook on the mock: with `beforeEach(() => gen.mockClear())` (or
// mockReset), vitest 4 (observed on 4.1.9) mis-attributes errors thrown by a
// mock implementation — and CAUGHT by the code under test — as test failures.
// The same mockClear() INSIDE a test body is fine, so tests that assert call
// counts clear at their own top. Every test sets its own implementation
// (mockResolvedValue/mockImplementation override), so no state leaks.

describe('generateQuizQuestions — dedup + type enforcement', () => {
  it('drops duplicate questions when every chunk returns the same stems', async () => {
    // 20 questions → two chunks of 10; every chunk returns the SAME 10 stems.
    resolve(Array.from({ length: 10 }, (_, i) => mc(`What is concept ${i}?`)))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: 'lecture text', questionCount: 20, questionTypes: ['multiple_choice'] } as any)
    const stems = res.questions.map((q) => q.questionText)
    expect(new Set(stems).size).toBe(stems.length) // zero duplicates survive
    expect(res.questions).toHaveLength(10) // 20 requested, only 10 unique exist
  })

  it('treats near-identical stems (punctuation/spacing) as duplicates', async () => {
    resolve([mc('What is 2 + 2?'), mc('what is 2+2'), mc('A genuinely different question')])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: 'x', questionCount: 10, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions).toHaveLength(2)
  })

  it('filters out a type the caller did not request (adaptive-only leak)', async () => {
    resolve([mc('Q1'), explanation('Explain gradient descent'), mc('Q2')])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: 'x', questionCount: 10, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions.every((q) => q.content.questionType === 'multiple_choice')).toBe(true)
    expect(res.questions).toHaveLength(2)
  })

  it('keeps an explanation when the caller DID request it', async () => {
    resolve([mc('Q1'), explanation('Explain gradient descent')])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: 'x', questionCount: 10, questionTypes: ['multiple_choice', 'explanation'] } as any)
    expect(res.questions.some((q) => q.content.questionType === 'explanation')).toBe(true)
  })

  it('delivers the full count when each chunk returns distinct questions', async () => {
    // The regression that motivated sequential generation: 30 requested must
    // yield 30 when the model (responding to the avoid-list) makes new ones.
    // Each generateObject call returns a distinct batch of 10.
    let call = 0
    gen.mockImplementation(async () => {
      const base = call++ * 10
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { object: { questions: Array.from({ length: 10 }, (_, i) => mc(`Distinct question ${base + i}`)) } } as any
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: 'x', questionCount: 30, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions).toHaveLength(30)
    expect(new Set(res.questions.map((q) => q.questionText)).size).toBe(30)
  })

  it('runs a top-up chunk to refill a mid-quiz dedup gap', async () => {
    gen.mockClear()
    // 20 requested → two planned chunks. Chunk 1: 10 distinct. Chunk 2: 5 of
    // those repeated + 5 new (→ 15 after the planned pass, not barren). The
    // top-up loop must then fetch the last 5. Call-count is the load-bearing
    // assertion: 3 calls proves the top-up chunk ran (2 would mean it didn't).
    let call = 0
    gen.mockImplementation(async () => {
      let qs: ReturnType<typeof mc>[]
      if (call === 0) qs = Array.from({ length: 10 }, (_, i) => mc(`A${i}`))
      else if (call === 1) qs = [...Array.from({ length: 5 }, (_, i) => mc(`A${i}`)), ...Array.from({ length: 5 }, (_, i) => mc(`B${i}`))]
      else qs = Array.from({ length: 5 }, (_, i) => mc(`C${i}`))
      call++
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { object: { questions: qs } } as any
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: 'x', questionCount: 20, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions).toHaveLength(20)
    expect(gen).toHaveBeenCalledTimes(3)
  })

  it('stops early (skips remaining chunks + top-up) when a chunk adds nothing new', async () => {
    gen.mockClear()
    // 30 requested → three planned chunks. Chunk 1: 10 distinct. Chunk 2: the
    // same 10 (0 fresh) → the source is exhausted, so chunk 3 and the top-up
    // pass must be skipped. Exactly 2 calls proves the early-barren break fired.
    resolve(Array.from({ length: 10 }, (_, i) => mc(`Fixed ${i}`)))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: 'x', questionCount: 30, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions).toHaveLength(10)
    expect(gen).toHaveBeenCalledTimes(2)
  })

  it('retries a chunk that errors instead of treating the flake as exhausted content', async () => {
    gen.mockClear()
    // The 100-question regression: chunk 1 threw AI_NoObjectGeneratedError
    // (Gemini returned unparseable JSON) → 0 fresh → old code declared the
    // content dry and aborted the whole run. An errored chunk must be retried.
    let call = 0
    gen.mockImplementation(async () => {
      const c = call++
      if (c === 0) throw new Error('No object generated: could not parse the response.')
      const base = (c - 1) * 10
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { object: { questions: Array.from({ length: 10 }, (_, i) => mc(`After retry ${base + i}`)) } } as any
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: 'x', questionCount: 20, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions).toHaveLength(20)
    expect(gen).toHaveBeenCalledTimes(3) // 1 failed + 2 successful
  })

  it('gives up after consecutive chunk failures with a friendly parse-error message', async () => {
    gen.mockClear()
    // mockImplementation-throw, NOT mockRejectedValue: the latter makes vitest
    // 4.1 report the (caught) rejection as an unhandled test failure.
    gen.mockImplementation(async () => {
      throw new Error('No object generated: could not parse the response.')
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: 'x', questionCount: 30, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions).toHaveLength(0)
    expect(res.error).toMatch(/temporary|try again/i) // friendly, not the raw SDK message
    expect(gen).toHaveBeenCalledTimes(3) // capped — no API hammering
  })

  it('reports a rate limit as "wait and retry", NOT as content-too-large', async () => {
    gen.mockClear()
    // The bug this guards: the old regex mapped every rate limit to "Content
    // too large… select fewer files" — the wrong fix. A bare 429 (no literal
    // "rate_limit" substring) must still be recognized as throttling.
    gen.mockImplementation(async () => {
      throw new Error('429 Too Many Requests')
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: 'x', questionCount: 30, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions).toHaveLength(0)
    expect(res.error).toMatch(/busy|wait a minute|try again/i)
    expect(res.error).not.toMatch(/content too large/i) // the old regex's wrong advice
  })

  it('flags a rate limit that strikes after partial success instead of swallowing the shortfall', async () => {
    gen.mockClear()
    // Chunk 1 succeeds (3 questions), then the API throttles. The old code
    // returned the partial set with NO signal — the professor silently got
    // fewer than requested. `rateLimited` must now mark it as throttling
    // (retry for the rest), distinct from exhausted material.
    let call = 0
    gen.mockImplementation(async () => {
      if (call++ === 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { object: { questions: [mc('a'), mc('b'), mc('c')] } } as any
      }
      throw new Error('RESOURCE_EXHAUSTED') // Gemini's 429 wording — no literal "rate_limit"
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: 'x', questionCount: 20, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions.length).toBeGreaterThan(0)
    expect(res.questions.length).toBeLessThan(20)
    expect(res.exhausted).toBe(true)
    expect(res.rateLimited).toBe(true)
  })

  it('keeps content-too-large distinct from a rate limit', async () => {
    gen.mockClear()
    gen.mockImplementation(async () => {
      throw new Error('Request too large for the model context')
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: 'x', questionCount: 30, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions).toHaveLength(0)
    expect(res.error).toMatch(/content too large/i)
    expect(res.error).not.toMatch(/busy|wait a minute/i)
  })

  it('salvages questions from a NoObjectGeneratedError instead of discarding the call', async () => {
    gen.mockClear()
    // Wires the whole seam: a REAL NoObjectGeneratedError carrying truncated-
    // but-repairable text must yield its complete questions (the plain-Error
    // tests above bypass isInstance and only exercise the retry path). The
    // 'Salvaged question?' stem in the result is the load-bearing assertion —
    // the retry path could never produce it (later calls return 'Rest N').
    const good = JSON.stringify(mc('Salvaged question?'))
    const truncated = `{"questions": [${good}, ${good.replace('Salvaged', 'Second salvaged')}, {"questionText": "cut off mid-`
    let call = 0
    gen.mockImplementation(async () => {
      if (call++ === 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        throw new NoObjectGeneratedError({ text: truncated, response: {} as any, usage: {} as any, finishReason: 'length' })
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { object: { questions: Array.from({ length: 10 }, (_, i) => mc(`Rest ${i}`)) } } as any
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: 'x', questionCount: 4, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions.map((q) => q.questionText)).toContain('Salvaged question?')
    expect(res.questions).toHaveLength(4)
    expect(gen).toHaveBeenCalledTimes(2) // salvage kept call 1's yield; one top-up filled the gap
  })

  it('overgenerates in the prompt but trims delivery to the requested count', async () => {
    gen.mockClear()
    // questionCount 5 → one chunk; the prompt must ask for 5 + QUIZ_OVERGEN(2)
    // = 7, and when the model really returns 7, the caller still gets only 5.
    // Each assertion can fail independently: one guards that overgen is being
    // requested at all, the other guards the trim safety property.
    resolve(Array.from({ length: 7 }, (_, i) => mc(`Overgen ${i}`)))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: 'x', questionCount: 5, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions).toHaveLength(5)
    const prompt = gen.mock.calls[0]?.[0]?.prompt ?? ''
    expect(prompt).toContain('exactly 7')
  })

  it('feeds already-generated stems into later chunks as an avoid-list', async () => {
    gen.mockClear()
    let call = 0
    gen.mockImplementation(async () => {
      const base = call++ * 10
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { object: { questions: Array.from({ length: 10 }, (_, i) => mc(`Unique stem ${base + i}`)) } } as any
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await generateQuizQuestions({ content: 'x', questionCount: 20, questionTypes: ['multiple_choice'] } as any)
    // The 2nd chunk's user prompt must name a stem from the 1st chunk (the
    // avoid-list rides the END of the user message, not the system prompt —
    // static-first split, design §11b).
    const secondPrompt = String(gen.mock.calls[1]?.[0]?.prompt ?? '')
    expect(secondPrompt).toContain('DO NOT REPEAT')
    expect(secondPrompt).toContain('Unique stem 0')
    // The 1st chunk had no prior stems → no avoid block.
    const firstPrompt = String(gen.mock.calls[0]?.[0]?.prompt ?? '')
    expect(firstPrompt).not.toContain('DO NOT REPEAT')
  })

  // The streaming route depends on onBatch receiving the FRESH (deduped, capped)
  // questions, not the raw chunk output — else duplicates would stream to the
  // studio. Chunk completion order is non-deterministic, so assert on the set.
  it('streams only fresh, deduped questions via onBatch', async () => {
    resolve(Array.from({ length: 10 }, (_, i) => mc(`Streamed concept ${i}?`)))
    const batches: GeneratedQuestion[][] = []
    const res = await generateQuizQuestions({
      content: 'x',
      questionCount: 20,
      questionTypes: ['multiple_choice'],
      onBatch: (qs: GeneratedQuestion[]) => {
        batches.push(qs)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    const streamed = batches.flat()
    expect(streamed).toHaveLength(res.questions.length)
    expect(new Set(streamed.map((q) => q.questionText)).size).toBe(10)
  })
})

describe('generateQuizQuestions — concept-first path', () => {
  // Real-shaped content: >2000 chars with [Title, page N] markers, so the
  // concept-path gate opens (short content stays on the chunked fallback,
  // which is what every test above exercises).
  const longContent =
    'Course header\n\n' +
    Array.from(
      { length: 12 },
      (_, i) => `[Doc, page ${i + 1}]\nBlock c${i} teaches concept number ${i}. ` + 'filler '.repeat(40),
    ).join('\n\n')
  const conceptsPayload = {
    concepts: Array.from({ length: 12 }, (_, i) => ({
      name: `c${i}`,
      importance: 12 - i,
      markers: [`[Doc, page ${i + 1}]`],
      summary: `understanding of concept ${i}`,
    })),
  }

  it('plans with a concept pass, then generates ramped batches from narrowed passages', async () => {
    gen.mockClear()
    const batchCalls: string[] = []
    const countBatches = route((call, batchNo) => {
      batchCalls.push(call)
      return { questions: Array.from({ length: batchNo === 1 ? 3 : 5 }, (_, i) => mc(`Call${batchNo} Q${i}`)) }
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: longContent, questionCount: 8, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions).toHaveLength(8)
    expect(countBatches()).toBe(2) // ramp batches [3, 5]
    // Batch 1 targets the top-3 concepts with content narrowed to THEIR blocks.
    expect(batchCalls[0]).toContain('ASSIGNED CONCEPTS')
    expect(batchCalls[0]).toContain('c0')
    expect(batchCalls[0]).toContain('Block c1 teaches')
    expect(batchCalls[0]).not.toContain('Block c7 teaches') // not this batch's concept
  })

  it('falls back to chunked generation when concept extraction fails', async () => {
    gen.mockClear()
    let call = 0
    gen.mockImplementation(async () => {
      if (call++ === 0) throw new Error('concept extraction flake')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { object: { questions: Array.from({ length: 8 }, (_, i) => mc(`Fallback Q${i}`)) } } as any
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: longContent, questionCount: 8, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions).toHaveLength(8) // professor sees no regression
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fallbackCall = gen.mock.calls[1]?.[0] as any
    expect(`${fallbackCall?.system ?? ''}\n${fallbackCall?.prompt ?? ''}`).not.toContain('ASSIGNED CONCEPTS')
  })

  // Concept-path tests route mock responses by INSPECTING the call's system
  // prompt (concept pass vs answerability audit vs generation batch) instead
  // of by call index — quality-gate calls interleave with batches, so index-
  // based mocks would be brittle. The audit branch returns all-ok verdicts.
  // Batch callbacks receive system + user prompt COMBINED: the per-call
  // assignment (assigned concepts, avoid-list) rides the END of the user
  // message (static-first split, design §11b), while stage identity stays in
  // the system prompt.
  const route = (
    onBatch: (call: string, batchNo: number) => unknown,
    concepts: unknown = conceptsPayload,
  ): (() => number) => {
    let batchNo = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gen.mockImplementation(async (args: any) => {
      const sys = String(args?.system ?? '')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (sys.includes('assessable CONCEPTS')) return { object: concepts } as any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (sys.includes('auditing quiz questions')) return { object: { verdicts: [] } } as any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { object: onBatch(`${sys}\n\n${String(args?.prompt ?? '')}`, ++batchNo) } as any
    })
    return () => batchNo
  }

  it('retries a batch that succeeds with zero valid questions (type drift), then delivers', async () => {
    gen.mockClear()
    // Batch 1's first attempt returns only explanation items on a multiple-
    // choice-only quiz → all filtered → 0 valid. That is NOT content
    // exhaustion (the batch's concepts are untried) — it must be retried.
    const countBatches = route((_sys, batchNo) =>
      batchNo === 1
        ? { questions: [explanation('Drift 1'), explanation('Drift 2'), explanation('Drift 3')] }
        : { questions: Array.from({ length: 8 }, (_, i) => mc(`B${batchNo} Q${i}`)) },
    )
    const statuses: string[] = []
    const res = await generateQuizQuestions({
      content: longContent,
      questionCount: 8,
      questionTypes: ['multiple_choice'],
      onStatus: (m: string) => statuses.push(m),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    expect(res.questions).toHaveLength(8)
    expect(res.exhausted).toBeFalsy() // full delivery — nothing to explain
    expect(countBatches()).toBe(3) // zero-yield + its retry + the second ramp batch
    // The retry surfaced a status note — a pause must never read as a hang.
    expect(statuses.some((s) => /retrying/i.test(s))).toBe(true)
  })

  it('recovers a twice-failed batch’s quota from the pool instead of losing it', async () => {
    gen.mockClear()
    const batchCalls: string[] = []
    route((call) => {
      batchCalls.push(call)
      // The batch targeting top concept c0 persistently drifts off-type …
      if (/1\. c0\b/.test(call)) return { questions: [explanation('persistent drift')] }
      return { questions: Array.from({ length: 8 }, (_, i) => mc(`S${batchCalls.length} Q${i}`)) }
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: longContent, questionCount: 8, questionTypes: ['multiple_choice'] } as any)
    // … yet the professor still gets the full count: the skipped batch's
    // quota was replaced from pool concepts (c8+).
    expect(res.questions).toHaveLength(8)
    expect(batchCalls.some((s) => s.includes('c8'))).toBe(true)
  })

  it('blacklists a twice-failed batch’s concepts — cycled makeup never revisits them', async () => {
    gen.mockClear()
    // 8 concepts / 8 questions → pool EMPTY, so all makeup is CYCLED. The
    // batch targeting c0 always fails; after two attempts its concepts
    // (c0,c1,c2) are blacklisted and cycling must draw from c3+ instead of
    // reliving the identical failure (the choiceless-MC coasting bug).
    const eight = {
      concepts: Array.from({ length: 8 }, (_, i) => ({
        name: `c${i}`,
        importance: 8 - i,
        markers: [`[Doc, page ${i + 1}]`],
        summary: `s${i}`,
      })),
    }
    const batchCalls: string[] = []
    let batchNo = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gen.mockImplementation(async (args: any) => {
      const sys = String(args?.system ?? '')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (sys.includes('assessable CONCEPTS')) return { object: eight } as any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (sys.includes('auditing quiz questions')) return { object: { verdicts: [] } } as any
      // Assigned concepts ride the user prompt (§11b) — match on the full call.
      const call = `${sys}\n\n${String(args?.prompt ?? '')}`
      batchCalls.push(call)
      batchNo++
      // The doomed batch: anything targeting c0 first returns nothing valid.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (/1\. c0\b/.test(call)) return { object: { questions: [explanation('coasting')] } } as any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { object: { questions: Array.from({ length: 8 }, (_, i) => mc(`B${batchNo} Q${i}`)) } } as any
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: longContent, questionCount: 8, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions).toHaveLength(8) // makeup covered the blacklisted quota
    // After the two failing attempts, NO later batch targets c0 again.
    const failing = batchCalls.filter((s) => /1\. c0\b/.test(s))
    expect(failing).toHaveLength(2) // attempt + one retry, never a third
  })

  it('converges to a shortfall when makeup is exhausted (no runaway loop)', async () => {
    gen.mockClear()
    // 8 concepts / 8 questions → pool EMPTY, makeup cap = ceil(8/2) = 4.
    // Every batch returns the same single stem → 1 fresh ever, then endless
    // deficits. The cap must bound the makeup calls and end the run.
    const eight = {
      concepts: Array.from({ length: 8 }, (_, i) => ({
        name: `c${i}`,
        importance: 8 - i,
        markers: [`[Doc, page ${i + 1}]`],
        summary: `s${i}`,
      })),
    }
    let batchNo = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gen.mockImplementation(async (args: any) => {
      const sys = String(args?.system ?? '')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (sys.includes('assessable CONCEPTS')) return { object: eight } as any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (sys.includes('auditing quiz questions')) return { object: { verdicts: [] } } as any
      batchNo++
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { object: { questions: [mc('The only stem the model knows')] } } as any
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: longContent, questionCount: 8, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions).toHaveLength(1) // what the "material" genuinely supports
    expect(res.exhausted).toBe(true) // …and the shortfall is EXPLAINED, not silent
    // Two independent bounds end this run: the makeup cap (ceil(8/2)=4 slots)
    // and the barren-streak break (3 consecutive zero-fresh batches).
    expect(batchNo).toBeLessThanOrEqual(5)
  })

  it('caps a single deficit larger than the remaining makeup budget instead of enqueueing nothing (benchmark s30)', async () => {
    gen.mockClear()
    // total 30 → ramp [3, 5, 22], makeupCap = ceil(30/2) = 15, pool EMPTY (12
    // concepts, all assigned) so any makeup must CYCLE. The big third batch
    // under-delivers by 20 in ONE shot — a deficit LARGER than the whole cap.
    // The old all-or-nothing gate (makeupUsed + deficit <= cap) enqueued
    // NOTHING for such a deficit and ended the run at 10/30; the fix takes as
    // many cyclable slots as remain (15) so delivery recovers.
    const countBatches = route((_call, batchNo) => {
      if (batchNo === 1) return { questions: Array.from({ length: 3 }, (_, i) => mc(`B1 Q${i}`)) }
      if (batchNo === 2) return { questions: Array.from({ length: 5 }, (_, i) => mc(`B2 Q${i}`)) }
      if (batchNo === 3) return { questions: [mc('B3 Q0'), mc('B3 Q1')] } // deficit 20 > cap 15
      return { questions: Array.from({ length: 15 }, (_, i) => mc(`B${batchNo} Q${i}`)) }
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: longContent, questionCount: 30, questionTypes: ['multiple_choice'] } as any)
    // Old behavior delivered exactly 10 (3 + 5 + 2, makeup skipped). Capped
    // makeup refills the 15-slot budget, so delivery lands well above 10.
    expect(res.questions.length).toBeGreaterThan(10)
    expect(countBatches()).toBeGreaterThanOrEqual(4) // a makeup batch actually ran
  })

  it('audit-dropped questions are refilled via makeup (audit is wired, not decorative)', async () => {
    gen.mockClear()
    // The first audit fails the batch's first question; later audits pass all.
    // Proves (1) verifyAnswerability actually runs inside the concept path —
    // deleting the call fails this test — and (2) its drops flow through the
    // same deficit→makeup accounting as dedup drops, so the count still lands.
    let audits = 0
    let batchNo = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gen.mockImplementation(async (args: any) => {
      const sys = String(args?.system ?? '')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (sys.includes('assessable CONCEPTS')) return { object: conceptsPayload } as any
      if (sys.includes('auditing quiz questions')) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { object: { verdicts: ++audits === 1 ? [{ index: 0, ok: false }] : [] } } as any
      }
      batchNo++
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { object: { questions: Array.from({ length: 8 }, (_, i) => mc(`B${batchNo} Q${i}`)) } } as any
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: longContent, questionCount: 8, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions).toHaveLength(8) // the audit drop was made up
    expect(res.questions.map((q) => q.questionText)).not.toContain('B1 Q0') // the flagged question is gone
    expect(audits).toBeGreaterThanOrEqual(2) // every delivering batch was audited
  })

  it('redundancy-flagged questions are dropped and refilled (same-fact gate is wired, not decorative)', async () => {
    gen.mockClear()
    // Same contract as the answerability test above, for the SAME-FACT
    // redundancy audit: the first redundancy call flags one candidate; that
    // stem must not ship, the deficit must be made up, and the count must
    // still land. Deleting either verifyDistinctFacts call site fails this.
    // The two audits share the 'auditing quiz questions' opener, so dispatch
    // on the redundancy prompt's distinctive phrase FIRST.
    let redundancyAudits = 0
    let batchNo = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gen.mockImplementation(async (args: any) => {
      const sys = String(args?.system ?? '')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (sys.includes('assessable CONCEPTS')) return { object: conceptsPayload } as any
      if (sys.includes('same-fact redundancy')) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { object: { verdicts: ++redundancyAudits === 1 ? [{ index: 1, ok: false }] : [] } } as any
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (sys.includes('auditing quiz questions')) return { object: { verdicts: [] } } as any // answerability: all ok
      batchNo++
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { object: { questions: Array.from({ length: 8 }, (_, i) => mc(`B${batchNo} Q${i}`)) } } as any
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: longContent, questionCount: 8, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions).toHaveLength(8) // the redundancy drop was made up
    expect(res.questions.map((q) => q.questionText)).not.toContain('B1 Q1') // the flagged candidate is gone
    expect(redundancyAudits).toBeGreaterThanOrEqual(2) // every delivering batch ran the gate
  })

  it('makes up a deficit from the LEAST-visited ranked concept when the pool is empty', async () => {
    gen.mockClear()
    // 8 concepts, 8 questions → every concept gets a slot, pool is EMPTY. A
    // deficit must then be made up by revisiting a ranked concept — and it
    // must be the LEAST-visited one, not the head of the ranking: the old
    // head-first cycling piled every refill onto the already-heaviest top
    // concepts (the s100 benchmark's same-fact clusters).
    const eight = {
      concepts: Array.from({ length: 8 }, (_, i) => ({
        name: `c${i}`,
        importance: 8 - i,
        markers: [`[Doc, page ${i + 1}]`],
        summary: `s${i}`,
      })),
    }
    const batchCalls: string[] = []
    route((call, batchNo) => {
      batchCalls.push(call)
      // Batch 1 (quota 3): one dedup casualty → deficit 1.
      if (batchNo === 1) return { questions: [mc('Dup stem?'), mc('dup stem'), mc('Fresh stem')] }
      return { questions: Array.from({ length: 6 }, (_, i) => mc(`Batch${batchNo} Q${i}`)) }
    }, eight)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: longContent, questionCount: 8, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions).toHaveLength(8)
    // The makeup batch (unshifted to the front → batch 2) targets c3 — the
    // most important concept with ZERO visits so far (c0–c2 were just
    // visited by batch 1) — never the already-visited head c0.
    expect(batchCalls[1]).toContain('ASSIGNED CONCEPTS')
    expect(batchCalls[1]).toMatch(/1\. c3\b/)
    expect(batchCalls[1]).not.toMatch(/1\. c0\b/)
  })

  it('replaces dedup-dropped questions from the unused-concept pool', async () => {
    gen.mockClear()
    const batchCalls: string[] = []
    route((call, batchNo) => {
      batchCalls.push(call)
      // Batch 1 (quota 3): two near-identical stems → one gets deduped.
      if (batchNo === 1) return { questions: [mc('Same stem?'), mc('same stem'), mc('Distinct stem')] }
      // Makeup + remaining batches: distinct questions, echo the batch number.
      return { questions: Array.from({ length: 6 }, (_, i) => mc(`Batch${batchNo} Q${i}`)) }
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: longContent, questionCount: 8, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions).toHaveLength(8) // shortfall was made up — exact count holds
    // The makeup batch (unshifted → batch 2) targets a POOL concept (c8+).
    expect(batchCalls[1]).toContain('c8')
  })

  it('uses stored concepts and SKIPS the whole-document extraction call (design §11a)', async () => {
    gen.mockClear()
    // The headline cost win: when the caller supplies concepts pre-extracted at
    // upload time, generation must plan from them directly — never re-run the
    // (slowest, most expensive-input) extraction pass. Any 'assessable CONCEPTS'
    // call would prove the gate leaked.
    const systems: string[] = []
    let batchNo = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gen.mockImplementation(async (args: any) => {
      const sys = String(args?.system ?? '')
      systems.push(sys)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (sys.includes('assessable CONCEPTS')) return { object: conceptsPayload } as any // only fires if the gate broke
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (sys.includes('auditing quiz questions')) return { object: { verdicts: [] } } as any
      batchNo++
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { object: { questions: Array.from({ length: batchNo === 1 ? 3 : 5 }, (_, i) => mc(`B${batchNo} Q${i}`)) } } as any
    })
    const res = await generateQuizQuestions({
      content: longContent,
      questionCount: 8,
      questionTypes: ['multiple_choice'],
      concepts: conceptsPayload.concepts, // 12 stored concepts ≥ CONCEPT_MIN_CONCEPTS
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    expect(res.questions).toHaveLength(8) // planned + generated straight from the stored concepts
    expect(systems.some((s) => s.includes('assessable CONCEPTS'))).toBe(false) // extraction skipped
  })

  it('falls through to extraction when FEWER than CONCEPT_MIN_CONCEPTS are stored', async () => {
    gen.mockClear()
    // A sub-threshold stored list is not enough coverage to plan from — the run
    // must ignore it and extract fresh (same bar the worker applies before
    // storing). Proves the gate is `>=`, not "any concepts present".
    let extracted = false
    let batchNo = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gen.mockImplementation(async (args: any) => {
      const sys = String(args?.system ?? '')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (sys.includes('assessable CONCEPTS')) { extracted = true; return { object: conceptsPayload } as any }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (sys.includes('auditing quiz questions')) return { object: { verdicts: [] } } as any
      batchNo++
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { object: { questions: Array.from({ length: batchNo === 1 ? 3 : 5 }, (_, i) => mc(`B${batchNo} Q${i}`)) } } as any
    })
    const res = await generateQuizQuestions({
      content: longContent,
      questionCount: 8,
      questionTypes: ['multiple_choice'],
      concepts: conceptsPayload.concepts.slice(0, 2), // only 2 — below the bar
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    expect(res.questions).toHaveLength(8)
    expect(extracted).toBe(true) // the thin stored list did NOT short-circuit extraction
  })

  it('scopes the avoid-list per concept — a disjoint later batch never sees an earlier batch stems (§11c)', async () => {
    gen.mockClear()
    const batchCalls: string[] = []
    route((call, batchNo) => {
      batchCalls.push(call)
      return { questions: Array.from({ length: batchNo === 1 ? 3 : 5 }, (_, i) => mc(`Batch${batchNo} stem ${i}?`)) }
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: longContent, questionCount: 8, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions).toHaveLength(8)
    // Ramp [3,5]: batch 1 covers c0–c2, batch 2 covers the DISJOINT c3–c7. Batch
    // 2's prompt must carry NO avoid-list — the OLD flat all-stems list injected
    // every earlier stem here regardless of which concept it belonged to.
    expect(batchCalls[0]).toMatch(/1\. c0\b/)
    expect(batchCalls[1]).toMatch(/1\. c3\b/)
    expect(batchCalls[1]).not.toContain('DO NOT REPEAT')
    expect(batchCalls[1]).not.toContain('Batch1 stem 0')
  })

  it('a makeup revisit carries the revisited concept OWN prior stems in its avoid-list (§11c)', async () => {
    gen.mockClear()
    // The complementary direction: per-concept scoping must still INJECT a
    // concept's own stems when that concept is revisited — otherwise a no-op
    // avoid-list would pass the isolation test above while silently killing the
    // diversity steering the feature exists for. The deficit lands AFTER every
    // concept has one visit, so least-visited falls back to the importance
    // tiebreak → the makeup genuinely REVISITS c0, which has prior stems.
    const eight = {
      concepts: Array.from({ length: 8 }, (_, i) => ({
        name: `c${i}`,
        importance: 8 - i,
        markers: [`[Doc, page ${i + 1}]`],
        summary: `s${i}`,
      })),
    }
    const batchCalls: string[] = []
    route((call, batchNo) => {
      batchCalls.push(call)
      // Batch 1 (quota 3, c0–c2): clean — c0 now owns the stem 'Keep this one?'.
      if (batchNo === 1) return { questions: [mc('Keep this one?'), mc('B1 second'), mc('B1 third')] }
      // Batch 2 (quota 5, c3–c7): one dedup casualty → deficit 1 → makeup.
      if (batchNo === 2) {
        return { questions: [mc('Drop dup?'), mc('drop dup'), mc('B2 a'), mc('B2 b'), mc('B2 c')] }
      }
      return { questions: Array.from({ length: 6 }, (_, i) => mc(`Later${batchNo} Q${i}`)) }
    }, eight)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateQuizQuestions({ content: longContent, questionCount: 8, questionTypes: ['multiple_choice'] } as any)
    expect(res.questions).toHaveLength(8)
    // The makeup batch (call 3) revisits c0 (all concepts tied at one visit →
    // importance wins) and MUST carry c0's already-generated stem so the
    // revisit produces a genuinely new question.
    expect(batchCalls[2]).toMatch(/1\. c0\b/)
    expect(batchCalls[2]).toContain('DO NOT REPEAT')
    expect(batchCalls[2]).toContain('Keep this one?')
  })
})

describe('generateQuizQuestions — thinking-level policy (§12 runaway fix)', () => {
  // The cost fix itself: 'low' thinking runaway-failed 5/9 structured-output
  // calls (each billing the full output ceiling), so 'low' is reserved for
  // requests that are ENTIRELY rubric types. A regression back to the old
  // "any-possibly-rubric → low" default would silently reintroduce the spend.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const levelOfCall = (i: number) => (gen.mock.calls[i]?.[0] as any)?.providerOptions?.google?.thinkingConfig?.thinkingLevel

  it("an unrestricted request (no questionTypes) runs 'minimal' — the old default was 'low'", async () => {
    gen.mockClear()
    resolve([mc('Q1')])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await generateQuizQuestions({ content: 'x', questionCount: 5 } as any)
    expect(levelOfCall(0)).toBe('minimal')
  })

  it("a mixed selection+rubric set runs 'minimal' — the old default was 'low'", async () => {
    gen.mockClear()
    resolve([mc('Q1')])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await generateQuizQuestions({ content: 'x', questionCount: 5, questionTypes: ['multiple_choice', 'explanation'] } as any)
    expect(levelOfCall(0)).toBe('minimal')
  })

  it("an all-rubric request still runs 'low'", async () => {
    gen.mockClear()
    resolve([explanation('Explain X')])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await generateQuizQuestions({ content: 'x', questionCount: 5, questionTypes: ['explanation', 'walkthrough'] } as any)
    expect(levelOfCall(0)).toBe('low')
  })

  it("a pure selection request runs 'minimal' (unchanged boundary)", async () => {
    gen.mockClear()
    resolve([mc('Q1')])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await generateQuizQuestions({ content: 'x', questionCount: 5, questionTypes: ['multiple_choice'] } as any)
    expect(levelOfCall(0)).toBe('minimal')
  })

  it("a failed chunk's retry drops from 'low' to 'minimal' instead of re-running the params that just failed", async () => {
    gen.mockClear()
    // All-rubric → first attempt runs 'low' and fails (the runaway shape);
    // the retry must NOT pay the same thinking level again.
    let call = 0
    gen.mockImplementation(async () => {
      if (call++ === 0) throw new Error('No object generated: could not parse the response.')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { object: { questions: [explanation('Explain Y')] } } as any
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await generateQuizQuestions({ content: 'x', questionCount: 5, questionTypes: ['explanation', 'walkthrough'] } as any)
    expect(levelOfCall(0)).toBe('low')
    expect(levelOfCall(1)).toBe('minimal')
  })
})

describe('salvageRawQuestions — recover valid prefix from truncated JSON', () => {
  const good = JSON.stringify(mc('Complete question?'))

  it('recovers complete elements from a mid-element truncation', async () => {
    // Truncated exactly how Gemini fails: array cut off inside element 3.
    const truncated = `{"questions": [${good}, ${good.replace('Complete', 'Second')}, {"questionType": "multiple_choice", "questionText": "Half a quest`
    const res = salvageRawQuestions(truncated)
    expect(res).not.toBeNull()
    // Two complete elements survive; the cut-off tail (no choices) is dropped.
    expect(res!.questions).toHaveLength(2)
    expect(res!.questions[0].questionText).toBe('Complete question?')
  })

  it('returns null when nothing valid can be recovered', async () => {
    expect(salvageRawQuestions('total garbage, not json at all }{')).toBeNull()
    expect(salvageRawQuestions('{"questions": []}')).toBeNull()
    expect(salvageRawQuestions(undefined)).toBeNull()
  })

  it('keeps title/description when present in the salvaged object', async () => {
    const res = salvageRawQuestions(`{"title": "NLP Quiz", "questions": [${good}], "descr`)
    expect(res!.title).toBe('NLP Quiz')
    expect(res!.questions).toHaveLength(1)
  })
})

// buildQuizResponse's metadata tail is the single funnel every generation path
// shares (direct + salvage, chunked + concept-first). cleanAiQuizMetadataField
// has its own pure tests in llm-quiz-metadata-clean.test.ts; these assert the
// WIRING — that a model-supplied title actually goes through the cleaner on its
// way to the studio, and what gets emitted when it does not survive (#102).
describe('generateQuizQuestions — includeMetadata tail', () => {
  const withMeta = (questions: unknown[], title?: unknown, description?: unknown) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gen.mockResolvedValue({ object: { questions, title, description } } as any)

  const run = (over: Record<string, unknown> = {}) =>
    generateQuizQuestions({
      content: 'x',
      questionCount: 2,
      questionTypes: ['multiple_choice'],
      includeMetadata: true,
      ...over,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

  it('routes the model title through the cleaner instead of passing it verbatim', async () => {
    // The exact #102 symptom, arriving as a plain (non-salvage) title: the model
    // closed the string with the wrong quote, so the value carries its sibling
    // key. Verbatim, this is what landed in the professor's title input.
    withMeta(
      [mc('Q1'), mc('Q2')],
      `ECE-322 Lesson 0: Course Syllabus Quiz', 'description': 'This quiz covers the requirements.`,
    )
    const res = await run()
    expect(res.metadata?.title).toBe('ECE-322 Lesson 0: Course Syllabus Quiz')
  })

  it('does not fabricate a "Covers: ." description when no question carries a tag', async () => {
    // Regression: the tag fallback used to run unguarded, so a tagless batch
    // produced the literal string "Covers: ." as the quiz description.
    withMeta([mc('Q1'), mc('Q2')], 'Kinematics Quiz')
    const res = await run()
    expect(res.metadata?.title).toBe('Kinematics Quiz')
    expect(res.metadata?.description).toBe('')
  })

  it('falls back to the tag list when the model returns no description', async () => {
    withMeta([{ ...mc('Q1'), tags: ['vectors'] }, { ...mc('Q2'), tags: ['vectors', 'forces'] }], 'Kinematics Quiz')
    const res = await run()
    expect(res.metadata?.description).toBe('Covers: vectors, forces.')
  })

  it('emits an empty title rather than junk, so a usable description still lands', async () => {
    // An unusable title must not block the description: the studio keeps its
    // "Untitled quiz" placeholder (it only applies a TRUTHY metadata.title).
    withMeta([mc('Q1'), mc('Q2')], `', 'description': 'junk`, 'Covers Newtonian mechanics.')
    const res = await run()
    expect(res.metadata).toEqual({ title: '', description: 'Covers Newtonian mechanics.' })
  })

  it('omits metadata entirely when nothing usable survives', async () => {
    withMeta([mc('Q1'), mc('Q2')], '   ')
    const res = await run()
    expect(res.metadata).toBeUndefined()
  })

  it('leaves metadata off when the caller did not ask for it', async () => {
    withMeta([mc('Q1'), mc('Q2')], 'Kinematics Quiz', 'A description.')
    const res = await run({ includeMetadata: false })
    expect(res.metadata).toBeUndefined()
  })
})
