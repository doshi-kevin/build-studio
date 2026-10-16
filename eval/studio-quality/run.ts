/**
 * studio-generation-quality-v1, from the command line (docs/designs/studio/studio-generation-quality.md).
 *
 *   build            Live generations by the frozen Step 11 builder, then evaluation.
 *   judge-only       Evaluates saved artifact folders without building.
 *   report           Summarises the result.json files under a folder.
 *   contrast-prepare Writes the Step 12A.3 contrast pairs (original and degraded) from saved artifacts.
 *   contrast-report  Scores judged contrast pairs: did each targeted dimension drop a level?
 *   repeatability    How much the judge's runs on the same artifacts disagree, and how many it needs.
 *   human-pack       A blind scoring pack and a blank human-scores.json, from judged results.
 *   human-compare    The AI's levels against a filled-in human-scores.json.
 *   render-diagnose  What the source claims and what actually rendered, for saved artifacts. No model.
 *
 * Anything that can spend money (a build, or a live judge) needs --max-usd (one hard cap over
 * everything the command spends) and --yes, refuses any Supabase secret in the environment,
 * and prints its plan and cap first. A build also refuses to start if the builder differs
 * from Step 11's. Holdout cases are refused unless --allow-holdout is given (Step 12A.4 only),
 * which also loads the sealed Tier 2 holdout guidance (--sealed-spec, default in sealed.ts).
 *
 * Cases: --case=ID[,ID] or --set=dev|holdout|variance|all, narrowed by --tier=core|deep.
 *
 * Judges: --judge=plumbing (no spend, no meaning), --judge=google:<model> --judge-reasoning=<low|medium|high>,
 * or --judge=none (build only). Never run with the root .env loaded.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { leakedSecrets } from '../studio-builder/guard'
import { artifactDirs, loadArtifact, saveLiveArtifact } from './artifacts'
import { QUALITY_CASES, type QualityCase } from './cases'
import { DEFAULT_SEALED_SPEC, loadSealedSpec, withSealedGuidance } from './sealed'
import { crossCheck, indexLedger, renderText, shotKey } from './render'
import { realEvaluateDeps, evaluateArtifact, type Artifact } from './evaluate'
import { builderIdentity, freezeDrift } from './freeze'
import { qualityFreezeDrift } from './quality-freeze'
import { caseVariance, summarize } from './aggregate'
import { assertCapCoversConcurrency, createJudge, createLedger, DEFAULT_JUDGE_PASSES, parseJudgeConfig, type JudgeModel, type SpendLedger } from './judge'
import { platformCardText } from './platform-card'
import { parseQualityResult, type QualityResult } from './schema'
import {
  analyseRepeatability,
  assertNoHoldout,
  compareWithHuman,
  CONTRASTS,
  contrastLinkSchema,
  humanScoresSchema,
  materializeContrast,
  packKeySchema,
  readResultsUnder,
  scoreContrast,
  writeHumanPack,
} from './calibration'

const [command, ...rest] = process.argv.slice(2)
const args: Record<string, string> = Object.fromEntries(
  rest.map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=')
    return [k, v.length ? v.join('=') : 'true']
  }),
)
const allowHoldout = args['allow-holdout'] === 'true'

/** The case list a command judges with: the sealed guidance joins it only for the baseline. */
let resolvedCases: readonly QualityCase[] | null = null
function canonicalCases(): readonly QualityCase[] {
  resolvedCases ??= allowHoldout ? withSealedGuidance(QUALITY_CASES, loadSealedSpec(args['sealed-spec'] ?? DEFAULT_SEALED_SPEC, QUALITY_CASES)) : QUALITY_CASES
  return resolvedCases
}

function selectCases(): QualityCase[] {
  const all = canonicalCases()
  let cases: QualityCase[]
  if (args.case) {
    const ids = args.case.split(',')
    const unknown = ids.filter((id) => !all.some((c) => c.id === id))
    if (unknown.length) throw new Error(`Unknown case ${unknown.join(', ')}.`)
    cases = all.filter((c) => ids.includes(c.id))
  } else if (args.set === 'dev' || args.set === 'holdout') cases = all.filter((c) => c.set === args.set)
  else if (args.set === 'variance') cases = all.filter((c) => c.variance)
  else if (args.set === 'all') cases = [...all]
  else throw new Error('Choose cases: --case=ID[,ID] or --set=dev|holdout|variance|all.')
  if (args.tier !== undefined) {
    if (args.tier !== 'core' && args.tier !== 'deep') throw new Error('--tier must be core or deep.')
    cases = cases.filter((c) => c.tier === args.tier)
  }
  assertNoHoldout(cases, allowHoldout)
  return cases
}

/** A hard spend cap from --max-usd: a finite, positive number of dollars. */
function spendCap(what: string): number {
  const usd = Number(args['max-usd'])
  if (!Number.isFinite(usd) || usd <= 0) throw new Error(`${what} needs --max-usd=<dollars>, a finite hard cap.`)
  return usd
}

function guardLiveSpend() {
  const leaked = leakedSecrets(process.env)
  if (leaked.length) throw new Error(`Refusing to run with ${leaked.join(', ')} in the environment: this needs only a model key.`)
}

async function judgeFromArgs(): Promise<JudgeModel | null> {
  if (args.judge === 'none') return null
  const judge = await createJudge(parseJudgeConfig(args.judge, args['judge-reasoning']))
  const drift = judge.identity.kind === 'live' ? qualityFreezeDrift() : []
  if (drift.length) throw new Error(`The rubric or judge prompt is not the frozen pair (${drift.join('; ')}). Bump the version and update quality-freeze.ts with the reason.`)
  return judge
}

function git(): { commit: string | null; dirty: boolean | null } {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0
    return { commit, dirty }
  } catch {
    return { commit: null, dirty: null }
  }
}

const passes = () => {
  const n = Number(args['judge-passes'] ?? DEFAULT_JUDGE_PASSES)
  if (!Number.isInteger(n) || n < 1 || n > 9) throw new Error('--judge-passes must be a whole number from 1 to 9.')
  return n
}

const concurrency = () => {
  const n = Number(args.concurrency ?? 1)
  if (!Number.isInteger(n) || n < 1) throw new Error('--concurrency must be a whole number of at least 1.')
  return n
}

const line = (r: QualityResult) =>
  `${r.case.id} g${r.rerun.generation}: ${r.failureClass}, gates ${r.gates.correctness}, ${r.evaluation.mode}, score ${r.qualityScore ?? '-'}${r.comparable ? '' : ' (not comparable)'}, judge $${(r.evaluation.costUsd ?? 0).toFixed(3)}`

/** Asks for --yes after printing what could be spent. Returns false when nothing may run. */
function confirmSpend(plan: string): boolean {
  console.log(plan)
  if (args.yes === 'true') return true
  console.log('Nothing was run. Add --yes to spend up to the cap.')
  return false
}

/** Runs `work` over `items`, at most `limit` at a time, in input order of results. */
async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await work(items[i])
      }
    }),
  )
  return out
}

/** Folder name for an artifact under --out. */
const outName = (from: string, dir: string) => relative(from, dir).replace(/[\\/]+/g, '__') || dir.split(/[\\/]/).pop()!

function holdoutOf(a: Artifact): boolean {
  return a.case.set === 'holdout'
}

async function judgeOnly() {
  if (!args.from || !args.out) throw new Error('judge-only needs --from=<artifact folder or parent> and --out=<folder>.')
  const judge = await judgeFromArgs()
  const dirs = args.from.split(',').flatMap((f) => artifactDirs(f).map((d) => ({ from: f, dir: d })))
  const artifacts = dirs.map(({ from, dir }) => loadArtifact(dir, join(args.out, outName(from, dir)), canonicalCases()))
  const overwrite = dirs.find(({ dir }, i) => resolve(dir) === resolve(artifacts[i].dir))
  if (overwrite) throw new Error(`--out would write over the artifact folder ${overwrite.dir}; choose another folder.`)
  const sealed = artifacts.filter(holdoutOf)
  if (sealed.length && !allowHoldout) throw new Error(`Holdout artifact(s) ${sealed.map((a) => a.case.id).join(', ')} are sealed until Step 12A.4.`)
  let ledger: SpendLedger | null = null
  if (judge?.identity.kind === 'live') {
    guardLiveSpend()
    const cap = spendCap('A live judge')
    assertCapCoversConcurrency(cap, judge.worstCaseCallUsd, Math.min(concurrency(), artifacts.length), passes())
    const calls = artifacts.length * passes() * 2
    const ok = confirmSpend(
      `Plan: judge ${artifacts.length} artifact(s), ${passes()} run(s) each: ${calls} calls with no retries, ${judge.identity.provider}:${judge.identity.model} (${judge.identity.reasoning}).\n` +
        `Each call reserves its worst case of $${judge.worstCaseCallUsd.toFixed(3)} (up to $${(calls * judge.worstCaseCallUsd).toFixed(2)} before retries); hard cap $${cap.toFixed(2)}.`,
    )
    if (!ok) return
    ledger = createLedger(cap)
  }
  const deps = realEvaluateDeps(judge, platformCardText(), { judgePasses: passes(), allowCodeOnly: args['allow-code-only'] === 'true', ledger })
  const results = await pool(artifacts, concurrency(), async (artifact) => {
    const result = await evaluateArtifact(artifact, deps)
    console.log(`${relative(args.out, artifact.dir)}: ${line(result)}`)
    return result
  })
  mkdirSync(args.out, { recursive: true })
  writeFileSync(join(args.out, 'summary.json'), `${JSON.stringify({ judgeSpentUsd: ledger?.spent() ?? 0, suite: summarize(results) }, null, 2)}\n`)
  if (ledger) console.log(`Judge spend: $${ledger.spent().toFixed(3)}.`)
}

async function build() {
  const maxUsd = spendCap('A live build')
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not set. Export the dedicated non-production key for this command only.')
  guardLiveSpend()
  const drift = freezeDrift()
  if (drift.length) throw new Error(`The builder is not the one accepted at Step 11 (${drift.join('; ')}). The baseline needs it frozen.`)
  const cases = selectCases()
  const repeat = Number(args.repeat ?? 1)
  const startGeneration = Number(args['start-generation'] ?? 1)
  if (!Number.isInteger(repeat) || repeat < 1 || !Number.isInteger(startGeneration) || startGeneration < 1) throw new Error('--repeat and --start-generation must be whole numbers from 1.')
  const renderer = (args['builder-renderer'] ?? 'local') as 'local' | 'off'
  if (renderer !== 'local' && renderer !== 'off') throw new Error('--builder-renderer must be local or off.')
  const judge = await judgeFromArgs()
  if (judge?.identity.kind === 'live') assertCapCoversConcurrency(maxUsd, judge.worstCaseCallUsd, 1, passes())
  const out = args.out ?? join('tmp', 'studio-quality', new Date().toISOString().replace(/[:.]/g, '-'))
  const group = args.group ?? randomUUID()
  const where = git()
  const ok = confirmSpend(
    `Plan: ${cases.length} case(s) x ${repeat} generation(s) = ${cases.length * repeat} live build(s), generations ${startGeneration} to ${startGeneration + repeat - 1}, group ${group}.\n` +
      `Hard cap: $${maxUsd.toFixed(2)} over builds and judging together. Judge: ${judge ? `${judge.identity.provider}:${judge.identity.model} (${judge.identity.reasoning ?? 'no reasoning setting'})` : 'none'}. Builder renderer: ${renderer}. Commit ${where.commit}${where.dirty ? ' (uncommitted changes)' : ''}. Output: ${out}`,
  )
  if (!ok) return

  const { createGeminiModel } = await import('../../src/lib/studio/builder/model')
  const { buildOnce } = await import('./build')
  const identity = builderIdentity()
  // One ledger for everything: builds settle what they spent, the judge reserves before each call.
  const ledger = createLedger(maxUsd)
  const deps = realEvaluateDeps(judge, platformCardText(), { judgePasses: passes(), allowCodeOnly: args['allow-code-only'] === 'true', ledger })
  let generationUsd = 0
  const results: QualityResult[] = []
  for (const c of cases) {
    for (let generation = startGeneration; generation < startGeneration + repeat; generation++) {
      const remaining = maxUsd - ledger.spent()
      const outcome = await buildOnce(c.prompt, { model: createGeminiModel(), budgetUsd: () => remaining, renderer })
      ledger.settle(0, outcome.costUsd)
      generationUsd += outcome.costUsd
      const artifact = saveLiveArtifact({
        dir: join(out, c.id, `g${generation}`),
        case: c,
        rerun: { groupId: group, generation },
        outcome,
        git: where,
        builder: { ...identity, rendererMode: renderer },
      })
      const result = await evaluateArtifact(artifact, deps)
      results.push(result)
      console.log(`${line(result)}; build $${outcome.costUsd.toFixed(3)}, total $${ledger.spent().toFixed(3)}`)
    }
  }
  const spend = { generationUsd, judgeUsd: ledger.spent() - generationUsd, totalUsd: ledger.spent() }
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify({ spend, suite: summarize(results) }, null, 2)}\n`)
  console.log(`Spend: generation $${spend.generationUsd.toFixed(3)}, judging $${spend.judgeUsd.toFixed(3)}, total $${spend.totalUsd.toFixed(3)}.`)
}

const parse = (raw: unknown) => {
  const p = parseQualityResult(raw)
  return p.ok ? p.result : null
}

function report() {
  if (!args.results || !existsSync(args.results)) throw new Error('report needs --results=<folder of evaluated artifacts>.')
  const results = [...readResultsUnder(args.results, parse).values()]
  const variance = [...new Set(results.filter((r) => r.case.variance).map((r) => r.case.id))].map((id) => caseVariance(results, id))
  const summary = { suite: summarize(results), variance }
  writeFileSync(join(args.results, 'report.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(summary.suite, null, 2))
}

function contrastPrepare() {
  const out = args.out ?? join('tmp', 'studio-quality', 'calibration', 'contrast')
  for (const pair of CONTRASTS) {
    const link = materializeContrast(pair, process.cwd(), out)
    console.log(`${link.id}: original ${link.original.artifactSha256.slice(0, 12)}, degraded ${link.degraded.artifactSha256.slice(0, 12)}, targets ${link.targeted.join(', ')}`)
  }
}

function contrastReport() {
  const contrasts = args.contrasts ?? join('tmp', 'studio-quality', 'calibration', 'contrast')
  const results = args.results
  if (!results) throw new Error('contrast-report needs --results=<the judge-only output for the contrast folder>.')
  const byDir = readResultsUnder(results, parse)
  const find = (dir: string) => [...byDir.entries()].find(([d]) => d.endsWith(outName(contrasts, dir)))?.[1] ?? null
  const outcomes = CONTRASTS.map((pair) => {
    const link = contrastLinkSchema.parse(JSON.parse(readFileSync(join(contrasts, pair.id, 'contrast.json'), 'utf8')))
    return scoreContrast(link, find(link.original.dir), find(link.degraded.dir))
  })
  writeFileSync(join(results, 'contrast-report.json'), `${JSON.stringify(outcomes, null, 2)}\n`)
  for (const o of outcomes) {
    console.log(`${o.passed ? 'PASS' : 'FAIL'} ${o.id}: ${o.targeted.map((t) => `${t.dimension} ${t.original} -> ${t.degraded} (spread ${t.originalSpread}/${t.degradedSpread})`).join('; ')}${o.problems.length ? `; ${o.problems.join('; ')}` : ''}`)
    if (o.collateral.length) console.log(`     also changed: ${o.collateral.map((c) => `${c.dimension} ${c.original} -> ${c.degraded}${c.expected ? '' : ' (unexpected)'}`).join('; ')}`)
  }
}

function repeatability() {
  if (!args.results) throw new Error('repeatability needs --results=<folder of judged results>.')
  const analysis = analyseRepeatability([...readResultsUnder(args.results, parse).values()])
  writeFileSync(join(args.results, 'repeatability.json'), `${JSON.stringify(analysis, null, 2)}\n`)
  console.log(JSON.stringify(analysis, null, 2))
}

function humanPack() {
  const from = args.items?.split(',')
  if (!from?.length || !args.out || !args.key) throw new Error('human-pack needs --items=<result folder>,<...> (in pack order), --out=<pack folder> and --key=<sealed key file outside the pack>.')
  const items = from.map((dir, i) => {
    const r = parse(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')))
    if (!r) throw new Error(`${dir}: no valid result.`)
    if (r.case.set === 'holdout' && !allowHoldout) throw new Error(`${dir}: holdout cases are sealed until Step 12A.4.`)
    return { id: `H${String(i + 1).padStart(2, '0')}`, result: r, resultDir: dir }
  })
  writeHumanPack(items, args.out, args.key)
  console.log(`Pack: ${args.out}/index.html, scores template ${args.out}/human-scores.json, sealed key ${args.key}.`)
}

/**
 * The render-grounded evidence for saved artifacts, with no judge: bundles each one, captures
 * it, and reports what the source claims beside what the screens show. Spends nothing.
 */
async function renderDiagnose() {
  if (!args.from || !args.out) throw new Error('render-diagnose needs --from=<artifact folder>,<...> and --out=<folder>.')
  const deps = realEvaluateDeps(null, '', { judgePasses: 1, allowCodeOnly: false, ledger: null })
  const report: Record<string, unknown> = {}
  for (const from of args.from.split(',')) {
    for (const dir of artifactDirs(from)) {
      const artifact = loadArtifact(dir, join(args.out, outName(from, dir)), canonicalCases())
      if (holdoutOf(artifact) && !allowHoldout) throw new Error(`${dir}: holdout cases are sealed until Step 12A.4.`)
      const name = `${artifact.case.id} (${relative(args.out, artifact.dir)})`
      const gate = await deps.draftGate(artifact)
      if (!gate?.bundles || !artifact.manifest || artifact.files.professor === null || artifact.files.student === null) {
        report[name] = { error: 'could not bundle' }
        continue
      }
      const capture = await deps.capture({ manifest: artifact.manifest, bundles: gate.bundles, sample: artifact.sample }, join(artifact.dir, 'evidence'))
      if (!capture?.render) {
        report[name] = { error: 'no render evidence', missing: capture?.missing ?? ['capture failed'] }
        continue
      }
      const cross = crossCheck(capture.render, { professor: artifact.files.professor, student: artifact.files.student })
      const items = indexLedger(capture.render)
      report[name] = {
        caseId: artifact.case.id,
        screens: capture.render.shots.map((s) => shotKey(s)),
        renderItems: items.length,
        controls: Object.fromEntries(
          (['professor', 'student'] as const).map((view) => [view, [...new Set(items.filter((x) => x.view === view && ['button', 'tab', 'control', 'option', 'link'].includes(x.item.kind)).map((x) => `${x.item.kind} “${x.item.text || x.item.label}”${x.item.disabled ? ' (disabled)' : ''}`))]]),
        ),
        tables: items.filter((x) => x.item.kind === 'table').map((x) => ({ id: x.id, label: x.item.label, headers: x.item.headers, rows: x.item.rowCount })),
        claims: cross.claims.map((c) => ({ view: c.view, line: c.line, component: c.component, kind: c.kind, text: c.text, conditional: c.conditional, rendered: c.seenIn.length > 0 })),
        checks: cross.checks,
        notSeen: cross.notSeen,
      }
      writeFileSync(join(artifact.dir, 'render-text.txt'), `${renderText(capture.render, cross)}\n`)
      console.log(`${name}: ${items.length} render items, ${cross.checks.length} check(s)${cross.checks.map((c) => `\n  ${c.id} ${c.kind}: ${c.detail}`).join('')}`)
    }
  }
  mkdirSync(args.out, { recursive: true })
  writeFileSync(join(args.out, 'render-diagnostic.json'), `${JSON.stringify(report, null, 2)}\n`)
}

function humanCompare() {
  if (!args.scores || !args.key) throw new Error('human-compare needs --scores=<human-scores.json> and --key=<sealed key file>.')
  const human = humanScoresSchema.parse(JSON.parse(readFileSync(args.scores, 'utf8')))
  const key = packKeySchema.parse(JSON.parse(readFileSync(args.key, 'utf8')))
  const results = Object.fromEntries(
    Object.entries(key.items).map(([id, k]) => [id, parse(JSON.parse(readFileSync(join(k.resultDir, 'result.json'), 'utf8')))!]),
  )
  const comparison = compareWithHuman(human, key, results)
  writeFileSync(join(args.key, '..', 'human-comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`)
  console.log(comparison.status === 'AWAITING HUMAN CALIBRATION' ? `AWAITING HUMAN CALIBRATION: no complete scores yet for ${comparison.missing.join(', ')}.` : JSON.stringify(comparison, null, 2))
}

async function main() {
  switch (command) {
    case 'judge-only':
      return judgeOnly()
    case 'build':
      return build()
    case 'report':
      return report()
    case 'contrast-prepare':
      return contrastPrepare()
    case 'contrast-report':
      return contrastReport()
    case 'repeatability':
      return repeatability()
    case 'human-pack':
      return humanPack()
    case 'human-compare':
      return humanCompare()
    case 'render-diagnose':
      return renderDiagnose()
    default:
      throw new Error('Commands: build, judge-only, report, contrast-prepare, contrast-report, repeatability, human-pack, human-compare, render-diagnose. See the header of eval/studio-quality/run.ts.')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
