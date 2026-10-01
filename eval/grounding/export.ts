/**
 * Layer 2, step 1 — produce the answers, then score what can be scored in code.
 *
 *   npm run eval:grounding                     # answer + deterministic gate + judge
 *   npm run eval:grounding -- --no-judge       # skip the Python step
 *   npm run eval:grounding -- --case=attention-formula
 *   npm run eval:grounding -- --update-baseline
 *
 * Layer 1 asks whether the right pages reached the prompt. This layer asks what
 * the model then DID with them, which needs an actual answer — so this step runs
 * the real path (`retrieveForQuestion` → the real `buildAiTutorPrompt` → one
 * Gemini call) over the same golden set and writes `records.jsonl`.
 *
 * Two kinds of metric come out, and the split is deliberate:
 *
 *  - **Deterministic, and therefore a gate.** Citations are machine-checkable:
 *    a `[Title, page N]` marker either names a page that was in the context or
 *    it doesn't, and it either names a gold page or it doesn't. No judge, no
 *    variance, so a regression here fails the run.
 *  - **Judged, and therefore a report.** Faithfulness and relevancy need an LLM
 *    and move a couple of points between identical runs; gating on them would
 *    train everyone to re-run until green. `judge.py` prints them against the
 *    baseline and never fails the build.
 *
 * What this deliberately does NOT run: tools and the drive channel. The golden
 * set is retrieval-shaped (see eval/README.md), the eval has no enrolled student
 * to scope a tool to, and a tool call would put text in the answer that came
 * from neither the model's reasoning nor the retrieved pages — which is exactly
 * what faithfulness is measuring.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { generateText } from 'ai'
import { google } from '@ai-sdk/google'

import { AI_TUTOR_MODEL } from '@/lib/ai/config'
import { buildAiTutorPrompt } from '@/lib/ai/student-tutor/prompt'
import { clearsRelevanceFloor } from '@/lib/pinecone/rerank'
import { retrieveForQuestion } from '@/lib/pinecone/retrieve'
import { createAdminClient } from '@/lib/supabase/admin'

import { loadGoldenSet, resolveGoldPages, type ResolvedCase } from '../retrieval/dataset'
import { round4 } from '../retrieval/metrics'
import { scoreAnswer, type Citation, type CitationScores } from './scoring'

const HERE = __dirname
const RECORDS_PATH = join(HERE, 'records.jsonl')
/** A `--case=` run writes here instead: it holds ONE record, and overwriting the
 *  full set with it would silently reduce the judge's next run to that case. */
const CASE_RECORDS_PATH = join(HERE, 'records.case.jsonl')
const BASELINE_PATH = join(HERE, 'baseline.json')
const JUDGE_PATH = join(HERE, 'judge.py')
const VENV_PYTHON = join(HERE, '.venv', 'bin', 'python')

/** Answers are ~1-2k output tokens each; four at a time keeps the run short. */
const CONCURRENCY = 4
/** Deterministic metrics still wobble with the model's own sampling, so leave room. */
const TOLERANCE = 0.05

interface ContextPage {
  material: string
  page: number
  moduleItemId: string
  text: string
  spoken: boolean
}

interface Record_ extends CitationScores {
  id: string
  use_case?: string
  category: string
  question: string
  expected_behavior: 'answer' | 'refuse'
  /** The page texts that were in the prompt — RAGAS's `contexts`. */
  contexts: string[]
  /** Same pages, as labels, so citation checks don't have to parse the text back. */
  context_pages: Citation[]
  gold_pages: Citation[]
  answer: string
  /** Why the model stopped, and what it spent. An empty answer is meaningless
   *  without these two: 'length' with a big reasoningTokens count says the model
   *  thought until it ran out of room, which is a product bug, while 'stop' with
   *  no text says it chose to say nothing, which is a prompt bug. */
  finish_reason: string
  usage: { output: number | undefined; reasoning: number | undefined }
}

/**
 * The model ended its turn by calling a tool instead of writing an answer.
 *
 * This harness deliberately passes no tools, so such a turn produces no text —
 * which is a fact about the eval, not about grounding. These records are carried
 * (so the case list stays complete) but kept out of every aggregate.
 */
function toolStarved(r: Record_): boolean {
  return r.finish_reason === 'tool-calls' && r.answer.length === 0
}

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : undefined
}

function assertSafeTarget(): void {
  const url = env('NEXT_PUBLIC_SUPABASE_URL') ?? ''
  if (/127\.0\.0\.1|localhost/.test(url) || env('EVAL_ALLOW_REMOTE') === '1') return
  throw new Error(
    `refusing to run against ${url || '(no NEXT_PUBLIC_SUPABASE_URL)'} — the eval corpus is a local seed.\n` +
      `Point .env.local at the local stack, or set EVAL_ALLOW_REMOTE=1 if you really mean a remote dev project.`,
  )
}

async function runCase(
  c: ResolvedCase,
  scope: { institutionId: string; sectionId: string },
  header: { courseTitle: string; courseCode: string; sectionCode: string },
  goldLabels: Citation[],
  temperature: number,
): Promise<Record_> {
  const retrieved = await retrieveForQuestion({ ...scope, query: c.query, rerank: true })
  const relevant = retrieved.pages.filter(clearsRelevanceFloor)

  const pages: ContextPage[] = relevant.map((r) => ({
    material: r.title,
    page: r.pageNumber,
    moduleItemId: r.moduleItemId,
    text: r.text,
    spoken: !!r.spoken,
  }))

  // Byte-identical to what the route assembles (student-tutor/context.ts) — the
  // marker format is the thing under test, so it cannot be re-implemented here.
  const content = pages
    .map((p) =>
      p.spoken
        ? `[${p.material} (spoken), slide ${p.page}]\n${p.text}`
        : `[${p.material}, page ${p.page}]\n${p.text}`,
    )
    .join('\n\n')

  const systemPrompt = buildAiTutorPrompt(
    { ...header, content },
    {
      // Retrieval found nothing above the floor ⇒ the honest-refusal branch, the
      // same switch the route makes. This is what G1/G2 is measured against.
      insufficientContext: pages.length === 0,
      // No enrolled student in the eval corpus, so the state lane is off. Its
      // effect is on study-plan phrasing, not on grounding.
      hasAttachments: false,
      canLeaveArtifacts: false,
    },
  )

  const result = await generateText({
    model: google(AI_TUTOR_MODEL),
    system: systemPrompt,
    prompt: c.query,
    temperature,
    // The route's real budget. Deliberately not raised for the eval: a long-form
    // request that runs out of room here runs out of room for a student too, and
    // that is a finding rather than a nuisance to configure away.
    maxOutputTokens: 4096,
  })
  const answer = result.text.trim()

  const contextLabels: Citation[] = pages.map((p) => ({ material: p.material, page: p.page }))
  const scored = scoreAnswer(answer, contextLabels, goldLabels)

  return {
    id: c.id,
    use_case: c.use_case,
    category: c.category,
    question: c.query,
    expected_behavior: c.expected_behavior,
    contexts: pages.map((p) => p.text),
    context_pages: pages.map((p) => ({ material: p.material, page: p.page })),
    gold_pages: goldLabels,
    answer,
    finish_reason: result.finishReason,
    usage: { output: result.usage?.outputTokens, reasoning: result.usage?.reasoningTokens },
    ...scored,
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

function meanOf(values: Array<number | null>): number {
  const applicable = values.filter((v): v is number => v !== null)
  return applicable.length ? applicable.reduce((a, b) => a + b, 0) / applicable.length : 0
}

function aggregate(records: Record_[]): Record<string, number> {
  const answers = records.filter((r) => r.expected_behavior === 'answer' && !toolStarved(r))
  const refusals = records.filter((r) => r.expected_behavior === 'refuse')
  // A metric with no cases behind it is ABSENT, never 0 — a `--case=` run has no
  // refusal cases, and "refusalNoFabrication 0" reads as every guardrail failing.
  const agg: Record<string, number> = {}
  if (answers.length > 0) {
    Object.assign(agg, {
      citationValidity: round4(meanOf(answers.map((r) => r.citation_validity))),
      citationCorrectness: round4(meanOf(answers.map((r) => r.citation_correctness))),
      // Share of answer cases that cited anything at all. Under-citation is the
      // other way to be ungrounded, and it doesn't show up in the two means above
      // (an answer with zero citations scores null, not 0).
      citedAnything: round4(answers.filter((r) => r.citations.length > 0).length / answers.length),
      // Every answer the student would have seen as a blank reply.
      answered: round4(answers.filter((r) => r.answer.length > 0).length / answers.length),
    })
  }
  if (refusals.length > 0) {
    // G1: an out-of-corpus question has an EMPTY context, so any citation in the
    // answer was invented. The sharpest deterministic guardrail there is.
    agg.refusalNoFabrication = round4(
      refusals.filter((r) => r.fabricated_citations.length === 0).length / refusals.length,
    )
  }
  return agg
}

function printReport(records: Record_[], agg: Record<string, number>): void {
  console.log('\nper case')
  console.log('─'.repeat(96))
  for (const r of records) {
    const bad = r.fabricated_citations.length > 0
    const mark = bad ? '✗' : '✓'
    const detail =
      r.expected_behavior === 'refuse'
        ? `context ${r.contexts.length} pages · ${r.citations.length} citation(s)${bad ? ' — INVENTED' : ''}`
        : `${r.citations.length} cite(s) · valid ${fmt(r.citation_validity)} · gold ${fmt(r.citation_correctness)} · ` +
          `${r.answer.split(/\s+/).length} words`
    console.log(`  ${mark} ${r.id.padEnd(32)} ${detail}`)
    if (bad) {
      console.log(`      invented: ${r.fabricated_citations.map((c) => `[${c.material}, p.${c.page}]`).join(' · ')}`)
    }
  }
  console.log('─'.repeat(96))
  for (const [k, v] of Object.entries(agg)) console.log(`  ${k.padEnd(22)} ${v}`)

  const wantedTool = records.filter(toolStarved)
  if (wantedTool.length > 0) {
    /* Not a bug and not an empty answer: this harness passes NO tools (see the
       header), so a question the model would answer by calling one ends the turn
       with a tool call and no text. In production the tool runs and the answer
       follows it. Scoring these as "said nothing" would be measuring the eval. */
    console.log(`\nended in a tool call (${wantedTool.length}) — not measurable here, this harness passes no tools:`)
    for (const r of wantedTool) console.log(`  · ${r.id} — "${r.question}"`)
  }

  const empty = records.filter((r) => r.answer.length === 0 && !toolStarved(r))
  if (empty.length > 0) {
    console.log(`\nEMPTY ANSWER (${empty.length}) — the student would see nothing at all:`)
    for (const r of empty) {
      console.log(
        `  · ${r.id} — finish "${r.finish_reason}", ${r.usage.reasoning ?? '?'} reasoning + ` +
          `${r.usage.output ?? '?'} output tokens against a 4096 budget`,
      )
    }
  }

  const uncited = records.filter((r) => r.expected_behavior === 'answer' && r.citations.length === 0)
  if (uncited.length > 0) {
    console.log(`\nanswered with no citation at all (${uncited.length}) — grounded or not, nothing is checkable:`)
    for (const r of uncited) console.log(`  · ${r.id}`)
  }
}

function fmt(n: number | null): string {
  return n === null ? ' n/a' : n.toFixed(2)
}

interface Baseline {
  model: string
  corpus: string
  recorded: string
  aggregates: Record<string, number>
  cases: Record<string, { fabricated: number; citations: number }>
  /** Written by judge.py after it runs, so both halves share one file. */
  judged?: Record<string, number>
}

function compare(
  baseline: Baseline,
  agg: Record<string, number>,
  records: Record_[],
  compareAggregates: boolean,
  strict: boolean,
): string[] {
  const failures: string[] = []
  if (compareAggregates) {
    for (const [metric, was] of Object.entries(baseline.aggregates)) {
      const now = agg[metric]
      if (now === undefined) continue
      if (now < was - TOLERANCE) failures.push(`${metric}: ${now} < baseline ${was} (tolerance ${TOLERANCE})`)
    }
  }
  /* Per-case fabrication is a WARNING by default, and that is a deliberate
     concession to how this run is produced: answers are generated at the
     production temperature (0.7), so one case inventing a citation on one run
     and not the next is sampling, not a regression — gating on it would make red
     runs meaningless and teach everyone to re-run until green. The aggregate
     citationValidity above still gates, the offending citation is printed in
     full, and `--strict` promotes these to failures for a run you intend to
     scrutinise. */
  for (const r of records) {
    const was = baseline.cases[r.id]
    if (!was) continue
    if (was.fabricated === 0 && r.fabricated_citations.length > 0) {
      const line = `${r.id}: invented ${r.fabricated_citations.length} citation(s) — none in the baseline`
      if (strict) failures.push(line)
      else console.warn(`\n⚠️  ${line} (warning — pass --strict to fail on this)`)
    }
  }
  return failures
}

/** Hand the records to the Python judge, if it's installed. Never fails the run. */
function runJudge(recordsPath: string): void {
  if (!existsSync(VENV_PYTHON)) {
    console.log(
      `\njudged metrics skipped — no Python env at eval/grounding/.venv\n` +
        `  python3 -m venv eval/grounding/.venv && eval/grounding/.venv/bin/pip install -r eval/grounding/requirements.txt`,
    )
    return
  }
  console.log('\nhanding records.jsonl to the RAGAS judge…\n')
  /* A narrowed environment, not `process.env`. The judge needs one API key; the
     venv behind it is ~200 transitive packages, and there is no reason for any
     of them to be holding SUPABASE_SERVICE_ROLE_KEY or PINECONE_API_KEY. Blast
     radius, not access control — this runs on a machine that can read
     .env.local anyway. */
  const judgeEnv = {
    // NODE_ENV is carried only because this repo's ProcessEnv type requires it;
    // the judge itself has no use for it.
    NODE_ENV: process.env.NODE_ENV,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) =>
          k.startsWith('EVAL_JUDGE_') ||
          k === 'GOOGLE_GENERATIVE_AI_API_KEY' ||
          k === 'OPENAI_API_KEY' ||
          k === 'ANTHROPIC_API_KEY',
      ),
    ),
  }
  const res = spawnSync(VENV_PYTHON, [JUDGE_PATH, recordsPath], { stdio: 'inherit', env: judgeEnv })
  if (res.status !== 0) {
    console.warn(`\n⚠️  the judge exited ${res.status} — deterministic results above still stand.`)
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const flag = (name: string) => args.includes(`--${name}`)
  const value = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

  assertSafeTarget()
  const sectionId = env('EVAL_SECTION_ID')
  const institutionId = env('EVAL_INSTITUTION_ID')
  if (!sectionId || !institutionId) {
    throw new Error('set EVAL_SECTION_ID and EVAL_INSTITUTION_ID (the seeded eval course) in .env.local')
  }

  /* Production temperature by default. A 0-temperature run would be more
     repeatable and would measure a model the students never talk to; the
     variance is real and belongs in the numbers. */
  const temperature = Number(value('temperature') ?? 0.7)

  const set = loadGoldenSet()

  /* Re-derive the deterministic metrics from the LAST run's answers. No model
     call, no retrieval, no cost — for when the metric definition changed rather
     than the system under test. */
  if (flag('rescore')) {
    const stored = readFileSync(RECORDS_PATH, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record_)
    const rescored = stored.map((r) => ({ ...r, ...scoreAnswer(r.answer, r.context_pages, r.gold_pages) }))
    writeFileSync(RECORDS_PATH, rescored.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const reagg = aggregate(rescored)
    printReport(rescored, reagg)
    console.log(`\nrescored ${rescored.length} stored records — no model calls made`)
    if (flag('update-baseline')) {
      let judged: Record<string, number> | undefined
      try {
        judged = (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline).judged
      } catch {
        /* first baseline */
      }
      writeFileSync(
        BASELINE_PATH,
        JSON.stringify(
          {
            model: AI_TUTOR_MODEL,
            corpus: set.corpus,
            recorded: new Date().toISOString().slice(0, 10),
            aggregates: reagg,
            cases: Object.fromEntries(
              rescored.map((r) => [r.id, { fabricated: r.fabricated_citations.length, citations: r.citations.length }]),
            ),
            ...(judged ? { judged } : {}),
          },
          null,
          2,
        ) + '\n',
      )
      console.log('baseline updated → eval/grounding/baseline.json')
    }
    return 0
  }

  const admin = createAdminClient()
  let cases = await resolveGoldPages(admin, sectionId, set)
  const only = value('case')
  if (only) {
    cases = cases.filter((c) => c.id === only)
    if (cases.length === 0) throw new Error(`no case with id "${only}"`)
  }

  const { data: section } = await admin
    .from('course_sections')
    .select('section_code, course:courses(code, title)')
    .eq('id', sectionId)
    .single()
  const course = Array.isArray(section?.course) ? section?.course[0] : section?.course
  const header = {
    courseTitle: course?.title ?? 'Unknown Course',
    courseCode: course?.code ?? '',
    sectionCode: section?.section_code ?? '',
  }

  console.log(
    `grounding eval · ${cases.length} cases · model ${AI_TUTOR_MODEL} · temperature ${temperature}\n` +
      `supabase ${env('NEXT_PUBLIC_SUPABASE_URL')} · section ${sectionId} · ${header.courseCode} ${header.courseTitle}`,
  )

  const records = await mapWithConcurrency(cases, CONCURRENCY, (c) =>
    runCase(
      c,
      { institutionId, sectionId },
      header,
      c.gold_pages.map((g) => ({ material: g.material, page: g.page })),
      temperature,
    ),
  )

  const recordsPath = only ? CASE_RECORDS_PATH : RECORDS_PATH
  writeFileSync(recordsPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const agg = aggregate(records)
  printReport(records, agg)
  console.log(`\nrecords → ${recordsPath.replace(`${process.cwd()}/`, '')} (${records.length})`)

  const snapshot: Baseline = {
    model: AI_TUTOR_MODEL,
    corpus: set.corpus,
    recorded: new Date().toISOString().slice(0, 10),
    aggregates: agg,
    cases: Object.fromEntries(records.map((r) => [r.id, { fabricated: r.fabricated_citations.length, citations: r.citations.length }])),
  }

  if (flag('update-baseline')) {
    if (only) throw new Error('refusing to write a baseline from a single-case run')
    // Keep whatever judge.py last recorded — it owns that half of the file and
    // writes it after its own run.
    let judged: Record<string, number> | undefined
    try {
      judged = (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline).judged
    } catch {
      /* first baseline */
    }
    writeFileSync(BASELINE_PATH, JSON.stringify({ ...snapshot, ...(judged ? { judged } : {}) }, null, 2) + '\n')
    console.log('\nbaseline updated → eval/grounding/baseline.json (commit it with the change that moved it)')
    if (!flag('no-judge')) runJudge(recordsPath)
    return 0
  }

  let baseline: Baseline | null = null
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline
  } catch {
    console.log('\nno baseline committed yet — run with --update-baseline to record this run')
  }

  const failures = baseline ? compare(baseline, agg, records, !only, flag('strict')) : []
  if (!flag('no-judge')) runJudge(recordsPath)

  if (failures.length > 0) {
    console.error(`\n✗ grounding regressed vs baseline (${baseline?.recorded}):`)
    for (const f of failures) console.error(`  · ${f}`)
    return 1
  }
  if (baseline) console.log(`\n✓ no deterministic regression vs baseline (${baseline.recorded})`)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
