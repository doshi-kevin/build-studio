import { describe, it, expect } from 'vitest'
import { createTableRouter, buildFullChain } from './helpers/mock-supabase'
import { loadOutcomeCoverage } from '@/lib/ai/professor-assistant/outcome-coverage'

// loadOutcomeCoverage rolls the persisted ABET alignment rows up into the compact
// object the OutcomeCoverageCard renders AND that Athena keeps in context. The DB
// reads are dumb; the load-bearing logic is the rollup: bestLevel = highest level
// across an outcome's covered indicators (I<R<M), covered/gap counting, the overall
// totals, and gapOutcomes = outcomes with zero covered indicators. A silent flip in
// any of these would mis-report accreditation coverage without failing anything else,
// so guard the rollup directly by stubbing the three query results.

// Two outcomes: SO-1 has 2 indicators, SO-2 has 1. Indicators arrive out of
// order_index on purpose to prove the loader sorts them.
const OUTCOMES = [
  {
    id: 'o1',
    code: 'SO-1',
    name: 'Engineering knowledge',
    accreditation_indicators: [
      { id: 'i1b', code: 'SO-1.2', description: 'Applies math', order_index: 2 },
      { id: 'i1a', code: 'SO-1.1', description: 'Identifies problems', order_index: 1 },
    ],
  },
  {
    id: 'o2',
    code: 'SO-2',
    name: 'Design',
    accreditation_indicators: [
      { id: 'i2a', code: 'SO-2.1', description: 'Designs a system', order_index: 1 },
    ],
  },
]

function router(opts: {
  std?: unknown
  outcomes?: unknown
  alignments?: unknown
  jobs?: unknown
}) {
  return createTableRouter({
    accreditation_standards: buildFullChain({
      data: 'std' in opts ? opts.std : { id: 'std1', name: 'ABET Engineering', version: 'EAC 2025-2026' },
      error: null,
    }),
    accreditation_outcomes: buildFullChain({ data: opts.outcomes ?? OUTCOMES, error: null }),
    course_outcome_alignments: buildFullChain({ data: opts.alignments ?? [], error: null }),
    /* Default to one completed run so the existing rollup cases above keep describing a
       course that HAS been analysed — which is what they were written to check. */
    background_jobs: buildFullChain({
      data: opts.jobs ?? [{ status: 'done', summary: 'Covered 1 of 2 outcomes.', completed_at: '2026-03-01T00:00:00.000Z', result: {} }],
      error: null,
    }),
  })
}

/** One AI-written alignment row, enough to make a section look analysed. `source` matters:
 *  only an 'ai' row proves the pipeline ran (see the manual-entry test below). */
const ONE_ALIGNMENT = [
  { indicator_id: 'i1a', level: 'I', evidence_text: 'wk1', attainment: null, source: 'ai' },
]

describe('loadOutcomeCoverage rollup', () => {
  it('rolls up mixed levels, counts coverage, and derives the gap outcome', async () => {
    const result = await loadOutcomeCoverage(
      router({
        alignments: [
          { indicator_id: 'i1a', level: 'I', evidence_text: 'wk1 reading', attainment: 0.7 },
          { indicator_id: 'i1b', level: 'M', evidence_text: 'final project', attainment: 0.9 },
          // SO-2's only indicator (i2a) has no alignment → full gap
        ],
      }),
      'sec-1',
    )

    expect(result.available).toBe(true)
    expect(result.standard).toBe('ABET Engineering · EAC 2025-2026')

    // SO-1: both indicators covered, highest level M
    const so1 = result.outcomes.find((o) => o.code === 'SO-1')!
    expect(so1.bestLevel).toBe('M')
    expect(so1.covered).toBe(2)
    expect(so1.total).toBe(2)
    // indicators are sorted by order_index (SO-1.1 before SO-1.2 despite input order)
    expect(so1.indicators.map((i) => i.code)).toEqual(['SO-1.1', 'SO-1.2'])
    expect(so1.indicators[0]).toMatchObject({ level: 'I', evidence: 'wk1 reading', attainment: 0.7 })

    // SO-2: no evidence → full gap
    const so2 = result.outcomes.find((o) => o.code === 'SO-2')!
    expect(so2.bestLevel).toBeNull()
    expect(so2.covered).toBe(0)
    expect(so2.indicators[0]).toMatchObject({ level: null, evidence: null, attainment: null })

    // Overall totals
    expect(result.overall).toEqual({
      outcomesCovered: 1,
      outcomesTotal: 2,
      indicatorsCovered: 2,
      indicatorsTotal: 3,
      gapCount: 1,
    })
    expect(result.gapOutcomes).toEqual(['SO-2'])
  })

  it('bestLevel picks the highest level regardless of alignment order', async () => {
    // i1a = M, i1b = I → best must be M even though the lower level maps to the
    // later-sorted indicator.
    const result = await loadOutcomeCoverage(
      router({
        alignments: [
          { indicator_id: 'i1b', level: 'I', evidence_text: null, attainment: null },
          { indicator_id: 'i1a', level: 'M', evidence_text: null, attainment: null },
        ],
      }),
      'sec-1',
    )
    expect(result.outcomes.find((o) => o.code === 'SO-1')!.bestLevel).toBe('M')
  })

  it('a partially-covered outcome counts as covered, not a gap', async () => {
    // Only one of SO-1's two indicators has evidence.
    const result = await loadOutcomeCoverage(
      router({
        alignments: [{ indicator_id: 'i1a', level: 'R', evidence_text: 'lab', attainment: null }],
      }),
      'sec-1',
    )
    const so1 = result.outcomes.find((o) => o.code === 'SO-1')!
    expect(so1.covered).toBe(1)
    expect(so1.total).toBe(2)
    expect(so1.bestLevel).toBe('R')
    expect(result.overall.outcomesCovered).toBe(1)
    expect(result.gapOutcomes).not.toContain('SO-1')
  })

  it('returns the empty rollup when the ABET standard is not seeded', async () => {
    const result = await loadOutcomeCoverage(router({ std: null }), 'sec-1')
    expect(result.available).toBe(false)
    expect(result.outcomes).toEqual([])
    expect(result.gapOutcomes).toEqual([])
    expect(result.overall.indicatorsTotal).toBe(0)
  })
})

/*
 * Analysis state, and why the payload has to carry it.
 *
 * The rollup above cannot tell "we analysed this course and found no evidence" apart from
 * "nobody has ever analysed this course". Both are zeroes and a full gap list. That was
 * survivable while the tool lived on two surfaces a professor reaches deliberately. Putting
 * it on the About page, the quiz studio, the grader and the no-host panel would otherwise
 * make "your course covers none of the 7 ABET outcomes" the first thing a professor hears
 * about accreditation, on a course nobody has measured. So the loader reports which of the
 * two it is, and refuses to name gaps it has not measured.
 */
describe('loadOutcomeCoverage analysis state', () => {
  it('reports never_run and names no gaps when nothing has ever been analysed', async () => {
    const result = await loadOutcomeCoverage(router({ alignments: [], jobs: [] }), 'sec-1')

    expect(result.analysisState).toBe('never_run')
    // The reference data is still readable; it is THIS COURSE that is unmeasured.
    expect(result.available).toBe(true)
    expect(result.overall.indicatorsTotal).toBe(3)
    // The load-bearing assertion: three unmeasured indicators must not become three gaps.
    expect(result.gapOutcomes).toEqual([])
    expect(result.overall.gapCount).toBe(0)
    expect(result.lastAnalyzedAt).toBeNull()
    expect(result.lastSummary).toBeNull()
  })

  it('still reports real gaps once an analysis has completed', async () => {
    const result = await loadOutcomeCoverage(router({ alignments: ONE_ALIGNMENT }), 'sec-1')

    expect(result.analysisState).toBe('ready')
    // SO-1.2 and SO-2.1 have no evidence. That is a measured finding, not an assumption.
    expect(result.overall.gapCount).toBe(2)
    expect(result.gapOutcomes).toEqual(['SO-2'])
  })

  it('flags a run in flight without disturbing what the numbers are', async () => {
    const result = await loadOutcomeCoverage(
      router({
        alignments: ONE_ALIGNMENT,
        jobs: [
          { status: 'running', summary: null, completed_at: null, result: null },
          { status: 'done', summary: 'Covered 1 of 2 outcomes.', completed_at: '2026-03-01T00:00:00.000Z', result: {} },
        ],
      }),
      'sec-1',
    )

    expect(result.runInFlight).toBe(true)
    // The numbers came from a completed run, and a refresh starting does not un-complete it.
    expect(result.analysisState).toBe('ready')
    /* The previous numbers are still returned rather than blanked — they are the best
       answer available. runInFlight is what tells the model they may not be the new ones. */
    expect(result.overall.indicatorsCovered).toBe(1)
    expect(result.lastAnalyzedAt).toBe('2026-03-01T00:00:00.000Z')
  })

  it('stays never_run while the FIRST analysis is still running', async () => {
    /* The regression that matters most. These two facts are orthogonal, and folding them
       into one enum got this case backwards: in-flight won, the payload said 'running', and
       every never_run guard downstream missed it — so the card drew a full
       "0 of 3 covered, every outcome a Gap" report for a course nobody had measured yet,
       in the exact moment a professor goes looking. */
    const result = await loadOutcomeCoverage(
      router({
        alignments: [],
        jobs: [{ status: 'running', summary: null, completed_at: null, result: null }],
      }),
      'sec-1',
    )

    expect(result.analysisState).toBe('never_run')
    expect(result.runInFlight).toBe(true)
    expect(result.gapOutcomes).toEqual([])
    expect(result.overall.gapCount).toBe(0)
  })

  it('does not treat a hand-entered alignment as proof the analysis ran', async () => {
    /* A professor can write alignments themselves; the table carries source='manual' for
       exactly that. Counting one as proof of a completed AI run would report a section with
       a single hand-entered indicator as fully analysed, and then present the other two as
       measured gaps — the same false all-gap report this state exists to prevent, reached
       by a different door. */
    const result = await loadOutcomeCoverage(
      router({
        alignments: [
          { indicator_id: 'i1a', level: 'I', evidence_text: 'by hand', attainment: null, source: 'manual' },
        ],
        jobs: [],
      }),
      'sec-1',
    )

    expect(result.analysisState).toBe('never_run')
    expect(result.gapOutcomes).toEqual([])
    expect(result.overall.gapCount).toBe(0)
    // The manual row is still REPORTED, it just is not evidence that the pipeline ran.
    expect(result.overall.indicatorsCovered).toBe(1)
  })

  it('treats persisted alignments as proof of a past run when the job has aged out', async () => {
    /* The job window is bounded. A course analysed long enough ago still has its rows but
       no job row in range, and must not be reported as never analysed. */
    const result = await loadOutcomeCoverage(router({ alignments: ONE_ALIGNMENT, jobs: [] }), 'sec-1')

    expect(result.analysisState).toBe('ready')
    expect(result.gapOutcomes).toEqual(['SO-2'])
    expect(result.lastAnalyzedAt).toBeNull()
  })
})

/*
 * Age and summary. A re-run that changes nothing still writes a NEW job row: fresh
 * completed_at, the previous rollup copied over, and a summary prefixed with the re-run
 * notice. Quoting either raw misleads — completed_at about when the course was read, the
 * summary by opening an answer with "No changes since the last analysis" to a professor on
 * another screen who never asked for a re-run.
 */
describe('loadOutcomeCoverage age and summary', () => {
  it('prefers the rollup stamp over the job row, so a re-check does not read as a re-analysis', async () => {
    const result = await loadOutcomeCoverage(
      router({
        alignments: ONE_ALIGNMENT,
        jobs: [
          {
            status: 'done',
            summary: 'No changes since the last analysis — the report is unchanged. Covered 1 of 2 outcomes.',
            completed_at: '2026-09-01T00:00:00.000Z', // when we last CHECKED
            result: { analyzedAt: '2026-01-05T00:00:00.000Z' }, // when the course was READ
          },
        ],
      }),
      'sec-1',
    )

    expect(result.lastAnalyzedAt).toBe('2026-01-05T00:00:00.000Z')
  })

  it('falls back to completed_at for rollups written before the stamp existed', async () => {
    const result = await loadOutcomeCoverage(
      router({
        alignments: ONE_ALIGNMENT,
        jobs: [{ status: 'done', summary: 'Covered 1 of 2 outcomes.', completed_at: '2026-02-02T00:00:00.000Z', result: {} }],
      }),
      'sec-1',
    )

    expect(result.lastAnalyzedAt).toBe('2026-02-02T00:00:00.000Z')
  })

  it('strips the re-run notice so the quotable sentence is the finding itself', async () => {
    const result = await loadOutcomeCoverage(
      router({
        alignments: ONE_ALIGNMENT,
        jobs: [
          {
            status: 'done',
            summary: 'No changes since the last analysis — the report is unchanged. Covered 1 of 2 outcomes.',
            completed_at: '2026-09-01T00:00:00.000Z',
            result: {},
          },
        ],
      }),
      'sec-1',
    )

    expect(result.lastSummary).toBe('Covered 1 of 2 outcomes.')
    expect(result.lastSummary).not.toContain('No changes')
  })
})

/*
 * How the job row is SELECTED, not just what is done with it once selected.
 *
 * background_jobs is shared by every pipeline (embed_material, regenerate_student_insights,
 * render_scheduled_deck, ...), and several of those are section-scoped and write a summary
 * of their own. Two filters are the only thing separating this course's ABET run from all
 * of that, and the tool description tells the model lastSummary is "safe to quote verbatim".
 *
 * The mock chain ignores filters by design, so every assertion above passes whether or not
 * the filters are there — dropping either one is currently a silent change. Assert the
 * query as issued: without `type`, an in-flight material embed for this section reports
 * analysisState 'running' and hands back an embedding job's summary as the accreditation
 * finding; without `section_id`, on a service-role client, it reads another section's.
 */
describe('loadOutcomeCoverage job lookup scoping', () => {
  it('scopes the job read to this section and to the alignment pipeline', async () => {
    const jobs = buildFullChain({ data: [], error: null })
    const db = createTableRouter({
      accreditation_standards: buildFullChain({
        data: { id: 'std1', name: 'ABET Engineering', version: 'EAC 2025-2026' },
        error: null,
      }),
      accreditation_outcomes: buildFullChain({ data: OUTCOMES, error: null }),
      course_outcome_alignments: buildFullChain({ data: ONE_ALIGNMENT, error: null }),
      background_jobs: jobs,
    })

    await loadOutcomeCoverage(db, 'sec-1')

    const eqArgs = jobs.eq.mock.calls.map((c) => [c[0], c[1]])
    expect(eqArgs).toContainEqual(['section_id', 'sec-1'])
    expect(eqArgs).toContainEqual(['type', 'outcome_alignment'])
  })

  it('excludes failed runs in the query, so a burst of failures cannot hide the last good run', async () => {
    /* Taking the newest N rows and discarding failures afterwards would let ten failed
       re-runs push the last successful one out of the window, flipping a measured course
       back to never_run. The filter has to be in the query for the window to hold. */
    const jobs = buildFullChain({ data: [], error: null })
    const db = createTableRouter({
      accreditation_standards: buildFullChain({
        data: { id: 'std1', name: 'ABET Engineering', version: 'EAC 2025-2026' },
        error: null,
      }),
      accreditation_outcomes: buildFullChain({ data: OUTCOMES, error: null }),
      course_outcome_alignments: buildFullChain({ data: ONE_ALIGNMENT, error: null }),
      background_jobs: jobs,
    })

    await loadOutcomeCoverage(db, 'sec-1')

    expect(jobs.in).toHaveBeenCalledWith('status', ['pending', 'running', 'done'])
  })
})
