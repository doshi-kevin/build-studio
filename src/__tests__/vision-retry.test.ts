// @vitest-environment node
//
// Retry/backoff in extractFormulasForPage (vision.ts) — the cost lever the gate
// protects: 429s get exponential-backoff retries, deterministic errors bail fast
// (one retry), a missing API key throws immediately, and the last error
// surfaces after retries are exhausted. Gemini is mocked; fake timers skip the
// real backoff sleeps.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('ai', () => ({ generateObject: vi.fn() }))
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: () => () => 'mock-model' }))

import { generateObject } from 'ai'
import { extractFormulasForPage } from '@/lib/document-parser/vision'

const gen = vi.mocked(generateObject)
const ok = { object: { formulas: [{ latex: 'x^2', surroundingText: '', kind: 'display' }], imageDescriptions: [], tables: [] } }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const okResult = ok as any

beforeEach(() => {
  gen.mockReset()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('extractFormulasForPage — retry/backoff', () => {
  it('retries a 429 with backoff, then returns the eventual success', async () => {
    gen.mockRejectedValueOnce(new Error('429 Too Many Requests')).mockResolvedValueOnce(okResult)
    const p = extractFormulasForPage(Buffer.from('png'), 1, { apiKey: 'test' })
    await vi.runAllTimersAsync() // flush the backoff sleep
    const res = await p
    expect(res.formulas).toHaveLength(1)
    expect(gen).toHaveBeenCalledTimes(2)
  })

  it('keeps retrying 429s up to maxRetries, then throws the last error', async () => {
    gen.mockRejectedValue(new Error('quota exceeded')) // 429-class every time
    const p = extractFormulasForPage(Buffer.from('png'), 1, { apiKey: 'test', maxRetries: 3 })
    const assertion = expect(p).rejects.toThrow(/quota/)
    await vi.runAllTimersAsync()
    await assertion
    expect(gen).toHaveBeenCalledTimes(4) // attempt 0 + 3 retries
  })

  it('gives a deterministic (non-429) error exactly ONE retry, then bails', async () => {
    gen.mockRejectedValue(new Error('bad input: malformed image'))
    const p = extractFormulasForPage(Buffer.from('png'), 1, { apiKey: 'test', maxRetries: 3 })
    const assertion = expect(p).rejects.toThrow(/bad input/)
    await vi.runAllTimersAsync()
    await assertion
    expect(gen).toHaveBeenCalledTimes(2) // one retry only — don't hammer on a deterministic failure
  })

  it('recovers when a deterministic error clears on the single retry', async () => {
    gen.mockRejectedValueOnce(new Error('transient blip')).mockResolvedValueOnce(okResult)
    const p = extractFormulasForPage(Buffer.from('png'), 1, { apiKey: 'test' })
    await vi.runAllTimersAsync()
    expect((await p).formulas).toHaveLength(1)
    expect(gen).toHaveBeenCalledTimes(2)
  })

  it('throws immediately (no call) when no API key is available', async () => {
    const saved = process.env.GOOGLE_GENERATIVE_AI_API_KEY
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
    try {
      await expect(extractFormulasForPage(Buffer.from('png'), 1, {})).rejects.toThrow(/API_KEY missing/)
      expect(gen).not.toHaveBeenCalled()
    } finally {
      if (saved !== undefined) process.env.GOOGLE_GENERATIVE_AI_API_KEY = saved
    }
  })
})
