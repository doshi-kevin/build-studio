import { describe, it, expect } from 'vitest'
import {
  attainmentHash,
  candidateHash,
  contentHash,
  indicatorListHash,
} from '@/lib/jobs/pipelines/outcome-alignment/cache'
import { matchesFromCached, matchesToCached, type MappedCandidate } from '@/lib/jobs/pipelines/outcome-alignment/map'
import { reduceAlignments } from '@/lib/jobs/pipelines/outcome-alignment/reduce'
import type { EvidenceCandidate, Indicator, Level } from '@/lib/jobs/pipelines/outcome-alignment/types'

const INDICATORS: Indicator[] = [
  { id: 'i11', code: 'PI 1.1', description: 'formulate', outcomeCode: 'SO-1' },
  { id: 'i12', code: 'PI 1.2', description: 'model', outcomeCode: 'SO-1' },
]

const cand = (over: Partial<EvidenceCandidate> = {}): EvidenceCandidate => ({
  sourceType: 'module_item',
  sourceId: 'm-1',
  title: 'Lecture 1',
  signal: 'Newton laws\nTopics: dynamics',
  cap: 'R',
  ...over,
})

describe('outcome-alignment cache hashing', () => {
  const indHash = indicatorListHash(INDICATORS)

  it('is stable for identical inputs', () => {
    expect(candidateHash(cand(), indHash)).toBe(candidateHash(cand(), indHash))
  })

  it('changes when the material signal changes', () => {
    expect(candidateHash(cand(), indHash)).not.toBe(candidateHash(cand({ signal: 'Newton laws v2' }), indHash))
  })

  it('changes when the indicator list changes', () => {
    const other = indicatorListHash(INDICATORS.slice(0, 1))
    expect(candidateHash(cand(), indHash)).not.toBe(candidateHash(cand(), other))
  })

  it('changes when the material is renamed', () => {
    /* The title is IN the prompt (mapCandidate writes "Title: ..."), but it was missing
       from the key. So renaming a lecture from "Thermodynamics" to "Engineering Ethics"
       without touching its extracted summary changed what the model was asked about while
       the fingerprint stayed put: the next run early-aborted as "no changes" and kept the
       old mapping forever. The rule this pins: if the model sees it, it is in the key. */
    expect(candidateHash(cand({ title: 'Thermodynamics' }), indHash)).not.toBe(
      candidateHash(cand({ title: 'Engineering Ethics' }), indHash),
    )
  })

  it('a rename moves the whole-run fingerprint, so the run is not skipped', () => {
    /* The per-artifact key is only half of it — the early abort compares contentHash, so
       the rename has to reach that too or the run still never happens. */
    const before = contentHash([candidateHash(cand({ title: 'Thermodynamics' }), indHash)])
    const after = contentHash([candidateHash(cand({ title: 'Engineering Ethics' }), indHash)])
    expect(before).not.toBe(after)
  })

  it('ignores the source id, which the model never sees', () => {
    /* The counterpart to the rename rule. sourceId is not in the prompt, so two identical
       artifacts must still share one cached answer rather than paying for the same call
       twice. */
    expect(candidateHash(cand({ sourceId: 'm-1' }), indHash)).toBe(
      candidateHash(cand({ sourceId: 'm-2' }), indHash),
    )
  })

  it('indicator list hash ignores DB row order', () => {
    expect(indicatorListHash(INDICATORS)).toBe(indicatorListHash([...INDICATORS].reverse()))
  })

  it('content fingerprint ignores candidate order', () => {
    expect(contentHash(['a', 'b', 'c'])).toBe(contentHash(['c', 'a', 'b']))
    expect(contentHash(['a', 'b'])).not.toBe(contentHash(['a', 'b', 'c']))
  })

  it('attainment fingerprint ignores object key order but tracks values', () => {
    expect(attainmentHash({ x: 50, y: 80 }, 10)).toBe(attainmentHash({ y: 80, x: 50 }, 10))
    expect(attainmentHash({ x: 50 }, 10)).not.toBe(attainmentHash({ x: 51 }, 10))
    expect(attainmentHash({ x: 50 }, 10)).not.toBe(attainmentHash({ x: 50 }, 11))
  })
})

describe('cached match round-trip', () => {
  it('survives store + rehydrate, dropping codes that no longer exist', () => {
    const matches = [
      { indicatorCode: 'PI 1.1', level: 'R' as Level, justification: 'j1', confidence: 'high' as const, indicator: INDICATORS[0] },
      { indicatorCode: 'PI 1.2', level: 'I' as Level, justification: 'j2', confidence: 'low' as const, indicator: INDICATORS[1] },
    ]
    const stored = matchesToCached(matches)
    expect(matchesFromCached(stored, INDICATORS)).toEqual(matches)
    // Indicator removed from the seed → its cached match is dropped, not crashed on.
    expect(matchesFromCached(stored, INDICATORS.slice(0, 1))).toHaveLength(1)
  })
})

describe('reduce tie-break determinism', () => {
  const mapped = (c: EvidenceCandidate, indicator: Indicator, level: Level): MappedCandidate => ({
    candidate: c,
    ok: true,
    matches: [{ indicatorCode: indicator.code, level, justification: `via ${c.title}`, confidence: 'medium', indicator }],
  })

  it('the representative evidence does not depend on candidate array order', () => {
    const a = cand({ sourceId: 'aaa', title: 'Assignment A', sourceType: 'assignment', cap: 'M' })
    const b = cand({ sourceId: 'bbb', title: 'Assignment B', sourceType: 'assignment', cap: 'M' })
    const base = {
      indicators: INDICATORS,
      outcomeCodes: ['SO-1'],
      masteryBySkill: {},
      quizResponseCount: 0,
      standardId: 'std-1',
    }
    // Same indicator, same level, from two artifacts — in both orders.
    const r1 = reduceAlignments({ ...base, mapped: [mapped(a, INDICATORS[0], 'M'), mapped(b, INDICATORS[0], 'M')] })
    const r2 = reduceAlignments({ ...base, mapped: [mapped(b, INDICATORS[0], 'M'), mapped(a, INDICATORS[0], 'M')] })
    expect(r1.rows).toEqual(r2.rows)
  })
})

/**
 * #631 — editing a module's Description did not invalidate the cache, so a re-run
 * early-aborted with "No changes since the last analysis." The early-abort is the
 * determinism feature working correctly, which is what made the failure quiet and
 * convincing.
 *
 * The cause was not a hash that forgot a field. The gather step selected only `modules.id`,
 * purely to reach that module's items, so a module's own title and description were never
 * map inputs at all — nothing about them COULD change the hash. A module carrying a real
 * description is exactly the artifact a professor edits to improve mapping, so it is now its
 * own candidate.
 *
 * The invariant these cases pin: if changing a field can change the report, that field must
 * move the hash.
 */
describe('#631 — a module description must move the content hash', () => {
  const indHash = indicatorListHash(INDICATORS)
  const moduleCand = (signal: string): EvidenceCandidate => ({
    sourceType: 'module',
    sourceId: 'mod-1',
    title: 'Week 3',
    signal,
    cap: 'R',
  })

  it('treats the module itself as a distinct evidence source', () => {
    /* Same id, same text, different KIND. A module and one item inside it are different
       artifacts and must not collide in the cache. */
    const asModule = candidateHash({ ...moduleCand('Week 3\nGraph algorithms'), sourceType: 'module' }, indHash)
    const asItem = candidateHash({ ...moduleCand('Week 3\nGraph algorithms'), sourceType: 'module_item' }, indHash)
    expect(asModule).not.toBe(asItem)
  })

  it('changes the candidate hash when the description changes', () => {
    const before = candidateHash(moduleCand('Week 3\nIntro to graphs'), indHash)
    const after = candidateHash(moduleCand('Week 3\nDijkstra, BFS and DFS on weighted graphs'), indHash)
    expect(before).not.toBe(after)
  })

  it('changes the whole-run content hash, which is what gates the early abort', () => {
    /* candidateHash moving is necessary but not sufficient: the early-abort compares the
       RUN hash, so the module has to be part of that set. */
    const items = [candidateHash(cand(), indHash)]
    const before = contentHash([...items, candidateHash(moduleCand('Intro to graphs'), indHash)])
    const after = contentHash([...items, candidateHash(moduleCand('Dijkstra and BFS'), indHash)])
    expect(before).not.toBe(after)
  })

  it('stays stable when nothing changed, so the early abort still works', () => {
    const run = () => contentHash([candidateHash(cand(), indHash), candidateHash(moduleCand('Intro'), indHash)])
    expect(run()).toBe(run())
  })
})
