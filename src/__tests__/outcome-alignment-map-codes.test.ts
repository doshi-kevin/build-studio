import { describe, it, expect } from 'vitest'
import { canonCode } from '@/lib/jobs/pipelines/outcome-alignment/map'

// Regression guard: the Gemini map often echoes the prompt's list format and
// returns e.g. "PI 4.1 (SO-4)" instead of the bare "PI 4.1". An earlier
// exact-match dropped every such match, leaving coverage near-empty. canonCode
// must extract the PI token robustly so matching survives spacing/case/(SO-x).

describe('outcome-alignment canonCode', () => {
  it('canonicalizes the bare code', () => {
    expect(canonCode('PI 1.1')).toBe('PI1.1')
  })

  it('extracts the PI token when the model appends the outcome (the real bug)', () => {
    expect(canonCode('PI 4.1 (SO-4)')).toBe('PI4.1')
  })

  it('is tolerant of missing space and lowercase', () => {
    expect(canonCode('pi4.1')).toBe('PI4.1')
    expect(canonCode('Pi 4.1')).toBe('PI4.1')
  })

  it('handles two-digit indicators', () => {
    expect(canonCode('PI 6.10 (SO-6)')).toBe('PI6.10')
  })

  it('a bare code and its decorated form canonicalize equal (so they match)', () => {
    expect(canonCode('PI 2.3')).toBe(canonCode('PI 2.3 (SO-2)'))
  })
})
