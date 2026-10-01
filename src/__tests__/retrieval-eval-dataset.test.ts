// Guards the golden set behind the retrieval eval gate (`eval/retrieval/`).
//
// Two jobs. First, `loadGoldenSet()` is run against the COMMITTED golden.json —
// that file is hand-edited data that grows a case at a time, and a duplicate id
// or a mislabelled refusal case would otherwise sit undetected until the next
// time someone remembers to run the gate locally with keys. Second, the three
// validation branches are pinned, because their whole purpose is to stop a
// dataset bug from scoring as a pass; a validator that silently lets one
// through makes the gate worse than no gate.
//
// `resolveGoldPages` is deliberately not covered here — it is a Supabase read
// whose failures are loud, immediate, and read by the human running the gate.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'

import { loadGoldenSet, type GoldenCase } from '../../eval/retrieval/dataset'

const answerCase = (over: Partial<GoldenCase> = {}): GoldenCase => ({
  id: 'a-case',
  category: 'single-source factual',
  query: 'what is a transformer?',
  expected_behavior: 'answer',
  gold_pages: [{ material: 'Lecture 6: Transformers', page: 22 }],
  ...over,
})

/** Write a golden set to a throwaway file and return its path. */
function fixture(cases: GoldenCase[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'golden-'))
  const path = join(dir, 'golden.json')
  writeFileSync(path, JSON.stringify({ corpus: 'fixture', cases }))
  return path
}

describe('the committed golden set', () => {
  it('is well-formed — every case passes the loader validation', () => {
    const set = loadGoldenSet()
    expect(set.cases.length).toBeGreaterThan(0)
  })

  it('labels both behaviours, so the gate measures refusal as well as recall', () => {
    const { cases } = loadGoldenSet()
    expect(cases.some((c) => c.expected_behavior === 'answer')).toBe(true)
    expect(cases.some((c) => c.expected_behavior === 'refuse')).toBe(true)
  })
})

describe('loadGoldenSet validation', () => {
  it('rejects a duplicate case id, which would silently overwrite a baseline entry', () => {
    // baseline.json keys cases by id, so a duplicate drops one case from the
    // per-case regression check without changing any aggregate.
    const path = fixture([answerCase({ id: 'dup' }), answerCase({ id: 'dup' })])
    expect(() => loadGoldenSet(path)).toThrow(/duplicate case id "dup"/)
  })

  it('rejects a refusal case carrying gold pages', () => {
    // A refusal case is scored on retrieving NOTHING; gold pages on it are a
    // contradiction the runner would score as a pass either way.
    const path = fixture([answerCase({ id: 'refuse-with-gold', expected_behavior: 'refuse' })])
    expect(() => loadGoldenSet(path)).toThrow(/refusal case "refuse-with-gold" must have no gold pages/)
  })

  it('rejects an answer case with no gold pages, which would score as a free pass', () => {
    // Unlabelled gold makes every metric n/a and drops the case out of the
    // mean — a case that can never fail is a case that measures nothing.
    const path = fixture([answerCase({ id: 'no-gold', gold_pages: [] })])
    expect(() => loadGoldenSet(path)).toThrow(/answer case "no-gold" has no gold pages/)
  })

  it('accepts a valid mixed set', () => {
    const path = fixture([
      answerCase({ id: 'ok-answer' }),
      answerCase({ id: 'ok-refusal', expected_behavior: 'refuse', gold_pages: [] }),
    ])
    expect(loadGoldenSet(path).cases).toHaveLength(2)
  })
})
