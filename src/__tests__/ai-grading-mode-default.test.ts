/**
 * `AI_GRADING_MODE` is not set on prod Cloud Run, and the fallback used to be
 * 'default' — the superseded v4 pipeline — while docs/designs/assignments-grading/ai-grading-eval-reports.md
 * § FINAL states the contract as "unset → 'v9'". So production silently graded on
 * a less accurate pipeline than the one the team believed had shipped.
 *
 * The oracle is the UNSET case. Asserting that each named mode round-trips would
 * pass against the old code too, since only the fallback was wrong.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { aiGradingMode } from '@/lib/assignments/ai-grading/mode'

const KEY = 'AI_GRADING_MODE'

describe('aiGradingMode', () => {
  let original: string | undefined

  beforeEach(() => {
    original = process.env[KEY]
  })
  afterEach(() => {
    if (original === undefined) delete process.env[KEY]
    else process.env[KEY] = original
  })

  it('defaults to v9 — the shipping pipeline — when the var is not set', () => {
    delete process.env[KEY]
    expect(aiGradingMode()).toBe('v9')
  })

  it('defaults to v9 when the var is present but empty', () => {
    process.env[KEY] = ''
    expect(aiGradingMode()).toBe('v9')
  })

  it('falls back to v9 rather than an older pipeline on an unrecognised value', () => {
    process.env[KEY] = 'v42-typo'
    expect(aiGradingMode()).toBe('v9')
  })

  // The older pipelines must stay reachable by name for eval comparisons —
  // only the fallback changed, not the selection.
  it.each(['default', 'similarity-only', 'llm-only', 'hybrid', 'v9'] as const)(
    'honours an explicit %s',
    (mode) => {
      process.env[KEY] = mode
      expect(aiGradingMode()).toBe(mode)
    },
  )
})
