/**
 * The retrieval eval gate — layer 1 of athena-students.md §11.
 *
 *   npm run eval:retrieval                    # measure, compare to baseline, exit 1 on regression
 *   npm run eval:retrieval -- --update-baseline
 *   npm run eval:retrieval -- --no-boost      # A/B the concept→page boost
 *   npm run eval:retrieval -- --case=kv-cache
 *   npm run eval:retrieval -- --json=tmp/eval.json
 *
 * It calls the REAL `student-qa-v1` profile (`searchMaterialPages`), so what it
 * measures is what a student's question runs through: namespace scoping,
 * visibility filtering at hydration, the concept→page boost, the locator
 * lookup, and the score floor. No LLM judge is involved — the golden set
 * labels which pages are correct, so every number is deterministic.
 *
 * Not a Vitest suite on purpose: it needs Pinecone, Supabase and an embedding
 * key, none of which CI has. `metrics.test.ts` covers the math in CI; this runs
 * locally (or in a keyed job) before any retrieval-knob change merges.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { STUDENT_QA_PROFILE, isRerankEnabled, studentQaTopK } from '@/lib/pinecone/config'
import { clearsRelevanceFloor } from '@/lib/pinecone/rerank'
import { retrieveForQuestion } from '@/lib/pinecone/retrieve'
import { searchMaterialPages } from '@/lib/pinecone/search'
import { createAdminClient } from '@/lib/supabase/admin'

import { loadGoldenSet, resolveGoldPages, type ResolvedCase } from './dataset'
import {
  contextPrecision,
  firstGoldRank,
  meanOf,
  mrr,
  pageKey,
  recallAtK,
  round4,
  type PageKey,
} from './metrics'

/** How far an aggregate may drift below the baseline before the gate fails.
 *  Two points of slack absorbs a single case wobbling; a real regression moves
 *  more than that, and the per-case check below catches the sharp ones anyway. */
const TOLERANCE = 0.02

/** Cases in flight at once — enough to keep the run short, low enough to stay
 *  polite to the embedding API (each case costs two embeddings). */
const CONCURRENCY = 4

const BASELINE_PATH = join(__dirname, 'baseline.json')

interface CaseResult {
  id: string
  category: string
  expected: 'answer' | 'refuse'
  /** Recall of gold pages in the wide candidate pool — "did it have a chance". */
  recallPool: number | null
  /** Recall of gold pages in what actually reaches the prompt. */
  recallContext: number | null
  mrr: number | null
  contextPrecision: number | null
  firstGoldRank: number | null
  /** Pages that cleared the score floor — 0 means Athena refuses this question. */
  contextSize: number
  topScore: number
  /** Sub-queries the decomposer produced — empty when the gate didn't fire. */
  subQueries: string[]
  /** Did the cross-encoder actually run for this case? A rerank that 429s or
   *  times out falls back to the dense order SILENTLY by design — so the run
   *  has to say so, or a whole eval reads as "reranked" when none of it was. */
  rerankRan: boolean
  /** Refusal cases: refused as expected. Answer cases: found at least one gold page. */
  ok: boolean
  top: string[]
}

interface Baseline {
  profile: string
  corpus: string
  recorded: string
  boost: boolean
  rerank: boolean
  scoreFloor: number
  aggregates: Record<string, number>
  cases: Record<string, { ok: boolean; firstGoldRank: number | null }>
}

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : undefined
}

/**
 * Refuse to evaluate against anything but a local/dev stack unless explicitly
 * overridden: the gate reads a whole section's material and writes usage-ledger
 * rows, and vector-db rule 12 puts eval runs off live tenant namespaces.
 */
function assertSafeTarget(): void {
  const url = env('NEXT_PUBLIC_SUPABASE_URL') ?? ''
  const local = /127\.0\.0\.1|localhost/.test(url)
  if (local || env('EVAL_ALLOW_REMOTE') === '1') {
    if (!local) console.warn(`⚠️  EVAL_ALLOW_REMOTE=1 — running against ${url}`)
    return
  }
  throw new Error(
    `refusing to run against ${url || '(no NEXT_PUBLIC_SUPABASE_URL)'} — the eval corpus is a local seed.\n` +
      `Point .env.local at the local stack, or set EVAL_ALLOW_REMOTE=1 if you really mean a remote dev project.`,
  )
}

/**
 * Warn when the corpus can't exercise the boost paths.
 *
 * `searchMaterialPages` builds its concept→page boost AND its explicit-locator
 * candidate list from materials that have stored `content.concepts`. A seeded
 * course with none silently disables both — so the locator case reads as a
 * retrieval regression when it is really a corpus gap. Say so out loud.
 */
async function reportCorpusCaveats(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  sectionId: string,
): Promise<void> {
  const { data } = await admin
    .from('module_items')
    .select('concepts:content->concepts, modules!inner(section_id, is_published)')
    .eq('modules.section_id', sectionId)
    .eq('modules.is_published', true)
    .eq('is_visible', true)
  const items = (data ?? []) as Array<{ concepts: unknown }>
  const withConcepts = items.filter((i) => Array.isArray(i.concepts) && i.concepts.length > 0).length
  if (withConcepts === 0) {
    console.warn(
      `\n⚠️  0 of ${items.length} visible materials carry stored content.concepts —\n` +
        `    the concept→page boost and the explicit-locator pin are INERT in this corpus,\n` +
        `    so cases that depend on them measure nothing. Re-run extraction on the eval\n` +
        `    course to cover those paths.`,
    )
  }
}

async function runCase(
  c: ResolvedCase,
  scope: { institutionId: string; sectionId: string },
  conceptBoost: boolean,
  scoreFloor: number | undefined,
  rerank: boolean,
  rerankTopN: number,
  decompose: boolean,
): Promise<CaseResult> {
  // Two calls on purpose: the wide pool localises an embedding/chunking miss
  // (the right page never surfaced at any depth) apart from a ranking miss (it
  // surfaced but lost the top slots) — §11's Recall@40 vs context precision.
  // The pool call never reranks: its job is to say what the EMBEDDING found.
  const [pool, retrieved] = await Promise.all([
    searchMaterialPages({
      ...scope,
      query: c.query,
      topK: STUDENT_QA_PROFILE.evalPoolTopK,
      conceptBoost,
    }),
    decompose
      ? retrieveForQuestion({ ...scope, query: c.query, rerank })
      : searchMaterialPages({
          ...scope,
          query: c.query,
          topK: studentQaTopK(),
          conceptBoost,
          rerank,
          rerankTopN,
        }).then((pages) => ({ pages, subQueries: [] as string[] })),
  ])

  const context = retrieved.pages
  const poolKeys: PageKey[] = pool.map((p) => pageKey(p.moduleItemId, p.pageNumber))
  // No --floor override ⇒ use the production rule, which picks the dense or the
  // cross-encoder threshold per result. An override forces one number so a
  // sweep can find the next one.
  const relevant = context.filter((p) => (scoreFloor === undefined ? clearsRelevanceFloor(p) : p.score >= scoreFloor))
  const contextKeys: PageKey[] = relevant.map((p) => pageKey(p.moduleItemId, p.pageNumber))

  const rank = firstGoldRank(contextKeys, c.gold)
  return {
    id: c.id,
    category: c.category,
    expected: c.expected_behavior,
    recallPool: recallAtK(poolKeys, c.gold, STUDENT_QA_PROFILE.evalPoolTopK),
    recallContext: recallAtK(contextKeys, c.gold, contextKeys.length),
    mrr: mrr(contextKeys, c.gold),
    contextPrecision: contextPrecision(contextKeys, c.gold),
    firstGoldRank: rank,
    rerankRan: context.some((p) => p.reranked),
    subQueries: retrieved.subQueries,
    contextSize: relevant.length,
    topScore: context.length > 0 ? round4(context[0].score) : 0,
    ok: c.expected_behavior === 'refuse' ? relevant.length === 0 : rank !== null,
    top: relevant.slice(0, 5).map((p) => `${p.title} p.${p.pageNumber} (${p.score.toFixed(3)})`),
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

function aggregate(results: CaseResult[]): Record<string, number> {
  const answers = results.filter((r) => r.expected === 'answer')
  const refusals = results.filter((r) => r.expected === 'refuse')
  return {
    recallPool: round4(meanOf(answers.map((r) => r.recallPool))),
    recallContext: round4(meanOf(answers.map((r) => r.recallContext))),
    mrr: round4(meanOf(answers.map((r) => r.mrr))),
    contextPrecision: round4(meanOf(answers.map((r) => r.contextPrecision))),
    goldFoundRate: round4(answers.length ? answers.filter((r) => r.ok).length / answers.length : 0),
    refusalAccuracy: round4(refusals.length ? refusals.filter((r) => r.ok).length / refusals.length : 0),
  }
}

function printReport(results: CaseResult[], agg: Record<string, number>): void {
  console.log('\nper case')
  console.log('─'.repeat(96))
  for (const r of results) {
    const mark = r.ok ? '✓' : '✗'
    const detail =
      r.expected === 'refuse'
        ? `refused=${r.contextSize === 0}  top score ${r.topScore}`
        : `pool ${fmt(r.recallPool)}  ctx ${fmt(r.recallContext)}  mrr ${fmt(r.mrr)}  ` +
          `prec ${fmt(r.contextPrecision)}  rank ${r.firstGoldRank ?? 'miss'}  of ${r.contextSize}`
    console.log(`  ${mark} ${r.id.padEnd(32)} ${detail}`)
    if (!r.ok && r.top.length > 0) console.log(`      got: ${r.top.slice(0, 3).join(' · ')}`)
  }
  console.log('─'.repeat(96))
  for (const [k, v] of Object.entries(agg)) console.log(`  ${k.padEnd(20)} ${v}`)

  const split = results.filter((r) => r.subQueries.length > 0)
  if (split.length > 0) {
    console.log(`\ndecomposed ${split.length} of ${results.length} questions:`)
    for (const r of split) console.log(`  · ${r.id} → ${r.subQueries.map((q) => `"${q}"`).join(' + ')}`)
  }

  // Failing cases are a ratchet, not a hard stop — the gate fails on REGRESSION,
  // so a case that is red today stays red silently unless it is named. Name it.
  const failing = results.filter((r) => !r.ok)
  if (failing.length > 0) {
    console.log(`\nknown failures carried in the baseline (${failing.length}) — debt, not noise:`)
    for (const r of failing) {
      console.log(
        `  · ${r.id} — ${
          r.expected === 'refuse'
            ? `answers an out-of-corpus question (top score ${r.topScore} clears the floor)`
            : 'no gold page reached the prompt'
        }`,
      )
    }
  }
}

function fmt(n: number | null): string {
  return n === null ? ' n/a' : n.toFixed(2)
}

/**
 * Compare against the committed baseline. Returns the failure lines (empty = green).
 *
 * `compareAggregates` is off for a filtered (`--case=`) run: the baseline's means
 * are over the whole set, so one case's numbers against them is a comparison
 * between different populations — it reported regressions that weren't there.
 * The per-case checks below still apply, and they're the sharp ones anyway.
 */
function compare(
  baseline: Baseline,
  agg: Record<string, number>,
  results: CaseResult[],
  compareAggregates: boolean,
): string[] {
  const failures: string[] = []
  if (compareAggregates) {
    for (const [metric, was] of Object.entries(baseline.aggregates)) {
      const now = agg[metric]
      if (now === undefined) continue
      if (now < was - TOLERANCE) {
        failures.push(`${metric}: ${now} < baseline ${was} (tolerance ${TOLERANCE})`)
      }
    }
  }
  for (const r of results) {
    const was = baseline.cases[r.id]
    if (!was) continue // new case — nothing to regress against
    if (was.ok && !r.ok) {
      failures.push(
        r.expected === 'refuse'
          ? `${r.id}: was refusing, now answers from ${r.contextSize} page(s)`
          : `${r.id}: gold page was retrieved, now missed entirely`,
      )
    }
  }
  return failures
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const flag = (name: string) => args.includes(`--${name}`)
  const value = (name: string) =>
    args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

  assertSafeTarget()
  const sectionId = env('EVAL_SECTION_ID')
  const institutionId = env('EVAL_INSTITUTION_ID')
  if (!sectionId || !institutionId) {
    throw new Error('set EVAL_SECTION_ID and EVAL_INSTITUTION_ID (the seeded eval course) in .env.local')
  }

  const conceptBoost = !flag('no-boost')
  const rerank = !flag('no-rerank')
  const decompose = !flag('no-decompose')
  // Calibration knob: the reranker's top-N is the single most consequential
  // number in the profile (it decides how many slots the answer gets), and
  // sweeping it is exactly what this gate is for.
  const topNArg = value('top-n')
  const rerankTopN = topNArg === undefined ? STUDENT_QA_PROFILE.rerankTopN : Number(topNArg)
  if (!Number.isInteger(rerankTopN) || rerankTopN < 1 || rerankTopN > 100) {
    throw new Error(`--top-n must be an integer 1..100, got "${topNArg}"`)
  }
  const floorArg = value('floor')
  const scoreFloor = floorArg === undefined ? undefined : Number(floorArg)
  if (scoreFloor !== undefined && (!Number.isFinite(scoreFloor) || scoreFloor < 0 || scoreFloor > 1)) {
    throw new Error(`--floor must be a score between 0 and 1, got "${floorArg}"`)
  }
  const set = loadGoldenSet()
  const admin = createAdminClient()
  let cases = await resolveGoldPages(admin, sectionId, set)
  const only = value('case')
  if (only) {
    cases = cases.filter((c) => c.id === only)
    if (cases.length === 0) throw new Error(`no case with id "${only}"`)
  }

  console.log(`profile ${STUDENT_QA_PROFILE.name}  ·  ${cases.length} cases  ·  ${set.corpus}`)
  // Name both stores every run. The safe-target guard can only pin Supabase —
  // index names carry no reliable dev/prod marker — so the vector target is
  // surfaced instead of asserted, and a run against the wrong index is visible
  // in the first two lines rather than discovered from odd numbers.
  console.log(
    `supabase ${env('NEXT_PUBLIC_SUPABASE_URL')} · pinecone index ${env('PINECONE_INDEX_MATERIALS') ?? '(unset)'} · section ${sectionId}`,
  )
  console.log(
    `pool topK ${STUDENT_QA_PROFILE.evalPoolTopK} · context topK ${studentQaTopK()} · ` +
      `floor ${scoreFloor}${floorArg === undefined ? '' : ' (OVERRIDE)'} · ` +
      `concept boost ${conceptBoost ? 'on' : 'OFF'}`,
  )
  await reportCorpusCaveats(admin, sectionId)

  const results = await mapWithConcurrency(cases, CONCURRENCY, (c) =>
    runCase(c, { institutionId, sectionId }, conceptBoost, scoreFloor, rerank, rerankTopN, decompose),
  )
  const agg = aggregate(results)
  printReport(results, agg)

  // The circuit-breaker is silent by design, so a quota-exhausted or timing-out
  // reranker produces a full green run of DENSE numbers labelled "rerank on".
  // Say how many cases the cross-encoder actually ranked.
  if (rerank && isRerankEnabled()) {
    const ran = results.filter((r) => r.rerankRan).length
    if (ran < results.length) {
      console.warn(
        `\n⚠️  the cross-encoder ran on only ${ran} of ${results.length} cases — the rest fell back to\n` +
          `    the dense order (see the [SCHOLERA WARN] lines above for why). These numbers are a\n` +
          `    MIXTURE of two profiles; do not read them as a rerank measurement.`,
      )
    } else {
      console.log(`\ncross-encoder ranked all ${ran} cases`)
    }
  }

  const jsonPath = value('json')
  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({ aggregates: agg, cases: results }, null, 2))
    console.log(`\nfull results → ${jsonPath}`)
  }

  const snapshot: Baseline = {
    profile: STUDENT_QA_PROFILE.name,
    corpus: set.corpus,
    recorded: new Date().toISOString().slice(0, 10),
    boost: conceptBoost,
    rerank,
    scoreFloor: scoreFloor ?? STUDENT_QA_PROFILE.rerankScoreFloor,
    aggregates: agg,
    cases: Object.fromEntries(results.map((r) => [r.id, { ok: r.ok, firstGoldRank: r.firstGoldRank }])),
  }

  if (flag('update-baseline')) {
    // A baseline recorded under experimental knobs would gate every later run
    // against numbers production never produces.
    if (!conceptBoost) throw new Error('refusing to write a baseline from a --no-boost run')
    if (!rerank) throw new Error('refusing to write a baseline from a --no-rerank run')
    if (!decompose) throw new Error('refusing to write a baseline from a --no-decompose run')
    if (topNArg !== undefined) throw new Error('refusing to write a baseline from a --top-n override run')
    if (floorArg !== undefined) throw new Error('refusing to write a baseline from a --floor override run')
    if (only) throw new Error('refusing to write a baseline from a single-case run')
    writeFileSync(BASELINE_PATH, JSON.stringify(snapshot, null, 2) + '\n')
    console.log(`\nbaseline updated → eval/retrieval/baseline.json  (commit it with the change that moved it)`)
    return 0
  }

  let baseline: Baseline
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline
  } catch {
    console.log('\nno baseline committed yet — run with --update-baseline to record this run')
    return 0
  }

  // Aggregates are means over a POPULATION. Comparing them across a different
  // set of cases compares different populations: adding a case the profile
  // handles poorly drags the mean down and reads as a regression the retrieval
  // never had. So the aggregate check runs only on an identical case set —
  // the per-case checks are id-keyed and keep working across set changes.
  const baselineIds = Object.keys(baseline.cases).sort().join(',')
  const runIds = results.map((r) => r.id).sort().join(',')
  const sameSet = baselineIds === runIds
  if (!sameSet) {
    console.log(
      only
        ? '\n(single-case run — aggregates are not compared to the baseline)'
        : '\n(case set differs from the baseline — aggregates are not comparable across\n' +
            ' different populations; per-case checks still apply. Re-record with --update-baseline.)',
    )
  }
  const failures = compare(baseline, agg, results, sameSet)
  if (failures.length > 0) {
    console.error(`\n✗ RETRIEVAL REGRESSION vs baseline recorded ${baseline.recorded}`)
    for (const f of failures) console.error(`  · ${f}`)
    console.error('\nFix it, or re-run with --update-baseline if the change is a deliberate improvement.')
    return 1
  }
  console.log(`\n✓ no regression vs baseline recorded ${baseline.recorded}`)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
