import { describe, it, expect } from 'vitest'
import { reduceAlignments, buildSummary } from '@/lib/jobs/pipelines/outcome-alignment/reduce'
import type { MappedCandidate } from '@/lib/jobs/pipelines/outcome-alignment/map'
import type { EvidenceCandidate, Indicator, Level } from '@/lib/jobs/pipelines/outcome-alignment/types'

const INDICATORS: Indicator[] = [
  { id: 'i11', code: 'PI 1.1', description: 'formulate', outcomeCode: 'SO-1' },
  { id: 'i12', code: 'PI 1.2', description: 'model', outcomeCode: 'SO-1' },
  { id: 'i41', code: 'PI 4.1', description: 'ethics', outcomeCode: 'SO-4' },
]
const OUTCOME_CODES = ['SO-1', 'SO-4']

function candidate(sourceType: EvidenceCandidate['sourceType'], sourceId: string | null, cap: Level): EvidenceCandidate {
  return { sourceType, sourceId, title: sourceType, signal: 's', cap }
}
function mapped(
  cand: EvidenceCandidate,
  matches: Array<{ indicator: Indicator; level: Level }>,
): MappedCandidate {
  return {
    candidate: cand,
    ok: true,
    matches: matches.map((m) => ({
      indicatorCode: m.indicator.code,
      level: m.level,
      justification: `because ${m.indicator.code}`,
      confidence: 'medium' as const,
      indicator: m.indicator,
    })),
  }
}

const base = {
  indicators: INDICATORS,
  outcomeCodes: OUTCOME_CODES,
  masteryBySkill: {} as Record<string, number>,
  quizResponseCount: 0,
  standardId: 'std-1',
}

describe('outcome-alignment reduce', () => {
  it('resolves an indicator to its highest justified level and keeps that evidence', () => {
    const lecture = candidate('module_item', 'lec-1', 'R')
    const quiz = candidate('quiz', null, 'M')
    const { rows } = reduceAlignments({
      ...base,
      mapped: [mapped(lecture, [{ indicator: INDICATORS[0], level: 'R' }]), mapped(quiz, [{ indicator: INDICATORS[0], level: 'M' }])],
    })
    const row = rows.find((r) => r.indicator_id === 'i11')!
    expect(row.level).toBe('M')
    expect(row.evidence_source_type).toBe('quiz') // evidence of the higher-level match
  })

  it('reports indicators with no matches as gaps and their outcome as uncovered', () => {
    const quiz = candidate('quiz', null, 'M')
    const { rollup } = reduceAlignments({
      ...base,
      mapped: [mapped(quiz, [{ indicator: INDICATORS[0], level: 'M' }])],
    })
    expect(rollup.gaps).toContain('PI 4.1')
    expect(rollup.gaps).toContain('PI 1.2')
    expect(rollup.outcomeLevels['SO-1']).toBe('M')
    expect(rollup.outcomeLevels['SO-4']).toBeNull()
  })

  it('attaches quiz attainment to a Mastered, quiz-evidenced indicator when responses suffice', () => {
    const quiz = candidate('quiz', null, 'M')
    const { rows } = reduceAlignments({
      ...base,
      mapped: [mapped(quiz, [{ indicator: INDICATORS[0], level: 'M' }])],
      masteryBySkill: { calc: 80, integ: 90 },
      quizResponseCount: 10,
    })
    expect(rows.find((r) => r.indicator_id === 'i11')!.attainment).toBe(85)
  })

  it('withholds attainment below the minimum response count (n too small)', () => {
    const quiz = candidate('quiz', null, 'M')
    const { rows } = reduceAlignments({
      ...base,
      mapped: [mapped(quiz, [{ indicator: INDICATORS[0], level: 'M' }])],
      masteryBySkill: { calc: 80 },
      quizResponseCount: 2,
    })
    expect(rows.find((r) => r.indicator_id === 'i11')!.attainment).toBeNull()
  })

  it('never attaches attainment to non-quiz evidence (assignment Mastered)', () => {
    const assignment = candidate('assignment', 'a-1', 'M')
    const { rows } = reduceAlignments({
      ...base,
      mapped: [mapped(assignment, [{ indicator: INDICATORS[1], level: 'M' }])],
      masteryBySkill: { calc: 80 },
      quizResponseCount: 50,
    })
    expect(rows.find((r) => r.indicator_id === 'i12')!.attainment).toBeNull()
  })

  it('buildSummary names covered counts and gap outcomes', () => {
    const { rollup } = reduceAlignments({
      ...base,
      mapped: [mapped(candidate('quiz', null, 'M'), [{ indicator: INDICATORS[0], level: 'M' }])],
    })
    const summary = buildSummary(rollup, INDICATORS)
    expect(summary).toContain('Covered 1 of 2 outcomes')
    expect(summary).toContain('SO-4')
  })
})
