/**
 * studio-generation-quality-v1, from the command line (docs/designs/studio/studio-generation-quality.md).
 *
 *   npm run eval:studio-quality -- judge-only --from=tmp/product-bench4 --out=tmp/quality/trial --judge=plumbing
 *   npm run eval:studio-quality -- report --results=tmp/quality/trial
 *   npm run eval:studio-quality -- build --case=Q01-attendance --max-usd=1 --judge=none --yes
 *   npm run eval:studio-quality -- build --set=variance --group=<baseline group> --start-generation=2 --repeat=4 --max-usd=10 --judge=<provider>:<model> --yes
 *
 * build      Live generations by the frozen Step 11 builder, then evaluation. Spends real
 *            money: needs --max-usd (a hard cap on builds and judging together) and --yes,
 *            refuses to start if the builder differs from Step 11's, and refuses any
 *            Supabase secret in the environment. Needs GOOGLE_GENERATIVE_AI_API_KEY.
 * judge-only Evaluates saved artifact folders without building.
 * report     Summarises the result.json files under a folder.
 *
 * Cases: --case=ID[,ID] or --set=dev|holdout|variance|all. Judges: --judge=plumbing (a
 * pipeline check that spends nothing and means nothing), --judge=<provider>:<model> with
 * --judge-reasoning (live judges arrive in Step 12A.3), or --judge=none (build only).
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { leakedSecrets } from '../studio-builder/guard'
import { artifactDirs, loadArtifact, saveLiveArtifact } from './artifacts'
import { QUALITY_CASES, type QualityCase } from './cases'
import { realEvaluateDeps, evaluateArtifact } from './evaluate'
import { builderIdentity, freezeDrift } from './freeze'
import { caseVariance, summarize } from './aggregate'
import { createJudge, DEFAULT_JUDGE_PASSES, parseJudgeConfig, type JudgeModel } from './judge'
import { platformCardText } from './platform-card'
import { parseQualityResult, type QualityResult } from './schema'

const [command, ...rest] = process.argv.slice(2)
const args: Record<string, string> = Object.fromEntries(
  rest.map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=')
    return [k, v.length ? v.join('=') : 'true']
  }),
)

function selectCases(): QualityCase[] {
  if (args.case) {
    const ids = args.case.split(',')
    const unknown = ids.filter((id) => !QUALITY_CASES.some((c) => c.id === id))
    if (unknown.length) throw new Error(`Unknown case ${unknown.join(', ')}.`)
    return QUALITY_CASES.filter((c) => ids.includes(c.id))
  }
  switch (args.set) {
    case 'dev':
    case 'holdout':
      return QUALITY_CASES.filter((c) => c.set === args.set)
    case 'variance':
      return QUALITY_CASES.filter((c) => c.variance)
    case 'all':
      return [...QUALITY_CASES]
    default:
      throw new Error('Choose cases: --case=ID[,ID] or --set=dev|holdout|variance|all.')
  }
}

/** A hard spend cap from --max-usd: a finite, positive number of dollars. */
function spendCap(what: string): number {
  const usd = Number(args['max-usd'])
  if (!Number.isFinite(usd) || usd <= 0) throw new Error(`${what} needs --max-usd=<dollars>, a finite hard cap.`)
  return usd
}

/** What every command that can spend money checks first. */
function guardLiveSpend() {
  const leaked = leakedSecrets(process.env)
  if (leaked.length) throw new Error(`Refusing to run with ${leaked.join(', ')} in the environment: this needs only a model key.`)
}

function judgeFromArgs(): JudgeModel | null {
  if (args.judge === 'none') return null
  return createJudge(parseJudgeConfig(args.judge, args['judge-reasoning']))
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

const line = (r: QualityResult) =>
  `${r.case.id} g${r.rerun.generation}: ${r.failureClass}, gates ${r.gates.correctness}, ${r.evaluation.mode}, score ${r.qualityScore ?? '-'}${r.comparable ? '' : ' (not comparable)'}`

async function judgeOnly() {
  if (!args.from || !args.out) throw new Error('judge-only needs --from=<artifact folder or parent> and --out=<folder>.')
  const judge = judgeFromArgs()
  // Only a live judge spends money; it gets the same cap, confirmation and guard as a build.
  const live = judge?.identity.kind === 'live'
  let cap = Infinity
  if (live) {
    guardLiveSpend()
    cap = spendCap('A live judge')
    console.log(`Judge ${judge!.identity.provider}:${judge!.identity.model}, spend cap $${cap.toFixed(2)}.`)
    if (args.yes !== 'true') {
      console.log('Nothing was run. Add --yes to spend up to the cap.')
      return
    }
  }
  let spent = 0
  const deps = realEvaluateDeps(judge, platformCardText(), { judgePasses: passes(), allowCodeOnly: args['allow-code-only'] === 'true', judgeBudgetUsd: () => cap - spent })
  const results: QualityResult[] = []
  for (const dir of artifactDirs(args.from)) {
    const name = relative(args.from, dir).replace(/[\\/]+/g, '__') || dir.split(/[\\/]/).pop()!
    const artifact = loadArtifact(dir, join(args.out, name), QUALITY_CASES)
    const result = await evaluateArtifact(artifact, deps)
    spent += result.evaluation.costUsd ?? 0
    results.push(result)
    console.log(line(result))
  }
  writeFileSync(join(args.out, 'summary.json'), `${JSON.stringify(summarize(results), null, 2)}\n`)
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
  const judge = judgeFromArgs()
  const out = args.out ?? join('tmp', 'studio-quality', new Date().toISOString().replace(/[:.]/g, '-'))
  const group = args.group ?? randomUUID()
  const where = git()
  console.log(
    `Plan: ${cases.length} case(s) x ${repeat} generation(s) = ${cases.length * repeat} live build(s), generations ${startGeneration} to ${startGeneration + repeat - 1}, group ${group}.\n` +
      `Spend cap: $${maxUsd.toFixed(2)} across builds and judging. Judge: ${judge ? `${judge.identity.provider}:${judge.identity.model}` : 'none'}. Builder renderer: ${renderer}. Commit ${where.commit}${where.dirty ? ' (uncommitted changes)' : ''}. Output: ${out}`,
  )
  if (args.yes !== 'true') {
    console.log('Nothing was run. Add --yes to spend up to the cap.')
    return
  }

  const { createGeminiModel } = await import('../../src/lib/studio/builder/model')
  const { buildOnce } = await import('./build')
  const identity = builderIdentity()
  let spent = 0
  const deps = realEvaluateDeps(judge, platformCardText(), { judgePasses: passes(), allowCodeOnly: args['allow-code-only'] === 'true', judgeBudgetUsd: () => maxUsd - spent })
  const results: QualityResult[] = []
  generations: for (const c of cases) {
    for (let generation = startGeneration; generation < startGeneration + repeat; generation++) {
      if (spent >= maxUsd) {
        console.log(`Stopped: the $${maxUsd} cap is reached.`)
        break generations
      }
      const outcome = await buildOnce(c.prompt, { model: createGeminiModel(), budgetUsd: () => maxUsd - spent, renderer })
      spent += outcome.costUsd
      const artifact = saveLiveArtifact({
        dir: join(out, c.id, `g${generation}`),
        case: c,
        rerun: { groupId: group, generation },
        outcome,
        git: where,
        builder: { ...identity, rendererMode: renderer },
      })
      const result = await evaluateArtifact(artifact, deps)
      spent += result.evaluation.costUsd ?? 0
      results.push(result)
      console.log(`${line(result)}; build $${outcome.costUsd.toFixed(3)}, total $${spent.toFixed(3)}`)
    }
  }
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summarize(results), null, 2)}\n`)
}

function collectResults(root: string): QualityResult[] {
  const found: QualityResult[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name)
      if (e.isDirectory()) walk(path)
      else if (e.name === 'result.json') {
        const parsed = parseQualityResult(JSON.parse(readFileSync(path, 'utf8')))
        if (parsed.ok) found.push(parsed.result)
      }
    }
  }
  walk(root)
  return found
}

function report() {
  if (!args.results || !existsSync(args.results)) throw new Error('report needs --results=<folder of evaluated artifacts>.')
  const results = collectResults(args.results)
  const variance = [...new Set(results.filter((r) => r.case.variance).map((r) => r.case.id))].map((id) => caseVariance(results, id))
  const summary = { suite: summarize(results), variance }
  mkdirSync(args.results, { recursive: true })
  writeFileSync(join(args.results, 'report.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(summary.suite, null, 2))
}

async function main() {
  if (command === 'judge-only') return judgeOnly()
  if (command === 'build') return build()
  if (command === 'report') return report()
  throw new Error('Commands: build, judge-only, report. See the header of eval/studio-quality/run.ts.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
