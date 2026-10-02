/**
 * The live builder eval's baseline: safe per-case metrics from one run, and a comparison
 * of a later run against them. Pure. An entry is built field by field from counters,
 * enum values and check ids; the request, plan, working copy, questions, answers, the
 * model's summary and every prompt or reply stay out of it.
 *
 * A comparison fails only on outcome: a case that met its expected outcome in the
 * baseline and no longer does, or any broken invariant. Turns, tool calls, tokens and cost are reported as
 * deltas and never fail on their own; live-model runs vary.
 */
import type { BuilderRunRow } from '../../src/lib/studio/db'

export const BASELINE_FORMAT = 'studio-builder-eval-baseline-v1'

export interface BaselineEntry {
  id: string
  expect: string[]
  status: string
  endReason: string | null
  passed: boolean
  /** The runner's hard invariants (bounded end, approvals, two files, catalog capabilities). */
  invariantsHeld: boolean
  /** The run hit the eval's own total spend cap, so its outcome isn't comparable. */
  cappedByEval: boolean
  modelTurns: number
  toolCalls: number
  repairRounds: number
  checkRuns: number
  approvals: { requested: number; approved: number; declined: number }
  questionsAsked: number
  tokens: { input: number; cachedInput: number; output: number; reasoning: number }
  costUsd: number
  finalCheck: { passed: boolean; failing: string[] } | null
  /** Memory cases only: how many proposals the measured build raised, and each named check. */
  memory: { proposals: number; checks: Record<string, boolean> } | null
}

export interface BaselineMeta {
  modelIds: string[]
  instructionsVersion: string
  validatorVersion: string
  validatorRuleset: number
  compilerId: string
  limits: Record<string, number>
  maxUsd: number
  date: string
  git: { sha: string | null; dirty: boolean | null }
}

export interface Baseline extends BaselineMeta {
  format: typeof BASELINE_FORMAT
  totalCostUsd: number
  /** Live cases not run (the spend cap was reached before them). */
  skipped: string[]
  cases: BaselineEntry[]
}

export interface CaseFacts {
  run: Pick<BuilderRunRow, 'status' | 'errorCode' | 'counters' | 'questions' | 'result'>
  approvals: { approved: number; declined: number }
  tokens: { input: number; cachedInput: number; output: number; reasoning: number }
  invariantsHeld: boolean
  cappedByEval: boolean
  memory?: { proposals: number; checks: Record<string, boolean> }
}

const usd = (n: number) => Math.round(n * 1000) / 1000
const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0)
// Statuses, reason codes and check ids are fixed vocabularies; anything else is not one.
const code = (s: unknown) => (typeof s === 'string' && /^[a-z][a-z0-9_.]{0,63}$/.test(s) ? s : 'unrecognised')

function finalCheck(result: Record<string, unknown> | null): BaselineEntry['finalCheck'] {
  const checks = result?.checks as { passed?: unknown; unresolved?: { check_id?: unknown }[] } | null | undefined
  if (!checks || typeof checks !== 'object') return null
  const unresolved = Array.isArray(checks.unresolved) ? checks.unresolved : []
  return { passed: checks.passed === true, failing: [...new Set(unresolved.map((u) => code(u?.check_id)))].sort() }
}

/** Check names are fixed identifiers; the values are booleans. Nothing else gets in. */
function memoryEntry(m: CaseFacts['memory']): BaselineEntry['memory'] {
  if (!m) return null
  const checks = Object.fromEntries(Object.entries(m.checks).filter(([k]) => /^[a-z][a-z0-9_]{0,63}$/.test(k)).map(([k, v]) => [k, v === true]))
  return { proposals: count(m.proposals), checks }
}

export function toBaselineEntry(c: { id: string; expect: string[] }, facts: CaseFacts): BaselineEntry {
  const { run } = facts
  const status = code(run.status)
  const memory = memoryEntry(facts.memory)
  // A check dropped for its name still counts: the case fails closed.
  const allChecks = !facts.memory || Object.values(facts.memory.checks).every((v) => v === true)
  return {
    id: c.id,
    expect: [...c.expect],
    status,
    endReason: run.errorCode === null ? null : code(run.errorCode),
    passed: c.expect.includes(status) && allChecks,
    invariantsHeld: facts.invariantsHeld,
    cappedByEval: facts.cappedByEval,
    modelTurns: count(run.counters.modelTurns),
    toolCalls: count(run.counters.toolCalls),
    repairRounds: count(run.counters.repairRounds),
    checkRuns: count(run.counters.checkRuns),
    approvals: {
      requested: count(facts.approvals.approved) + count(facts.approvals.declined),
      approved: count(facts.approvals.approved),
      declined: count(facts.approvals.declined),
    },
    questionsAsked: count(run.questions.length),
    tokens: {
      input: count(facts.tokens.input),
      cachedInput: count(facts.tokens.cachedInput),
      output: count(facts.tokens.output),
      reasoning: count(facts.tokens.reasoning),
    },
    costUsd: usd(run.counters.costUsd),
    finalCheck: finalCheck(run.result),
    memory,
  }
}

export function buildBaseline(meta: BaselineMeta, cases: BaselineEntry[], skipped: string[]): Baseline {
  return { format: BASELINE_FORMAT, ...meta, totalCostUsd: usd(cases.reduce((sum, c) => sum + c.costUsd, 0)), skipped: [...skipped], cases }
}

/** Checks a parsed baseline file's format and shape, so --compare can refuse it before any money is spent. */
export function parseBaseline(raw: unknown, source: string): Baseline {
  const b = raw as Partial<Baseline> | null
  const problem =
    !b || typeof b !== 'object'
      ? 'not a JSON object'
      : b.format !== BASELINE_FORMAT
        ? `format is ${JSON.stringify(b.format)}, expected ${BASELINE_FORMAT}`
        : !Array.isArray(b.cases) || !b.cases.every((c) => c && typeof c.id === 'string' && Array.isArray(c.expect) && c.tokens && c.approvals)
          ? 'cases are missing or malformed'
          : !b.limits || typeof b.limits !== 'object' || !Array.isArray(b.modelIds) || !b.git || typeof b.totalCostUsd !== 'number'
            ? 'run-level fields are missing'
            : null
  if (problem) throw new Error(`${source} is not a usable baseline: ${problem}. Re-record it with --write-baseline.`)
  return b as Baseline
}

export interface Comparison {
  /** Met its expected outcome in the baseline and no longer does, or broke an invariant. */
  regressions: string[]
  /** Missed it in the baseline, and meets it now. */
  fixed: string[]
  /** Missed it in both. */
  stillFailing: string[]
  /** Status or end reason changed while still meeting the expected outcome. */
  outcomeChanges: string[]
  /** Per-case metric deltas, current minus baseline. */
  drift: string[]
  /** Not comparable: missing from one side, or cut short by the eval's spend cap. */
  notCompared: string[]
  /** Model, instructions, validator, compiler or limits differ from the baseline's. */
  contextChanges: string[]
  totalCostDeltaUsd: number
}

const signed = (n: number, digits = 0) => `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`
const outcome = (e: BaselineEntry) => (e.endReason ? `${e.status} (${e.endReason})` : e.status)

export function compareBaseline(base: Baseline, current: Baseline): Comparison {
  const out: Comparison = { regressions: [], fixed: [], stillFailing: [], outcomeChanges: [], drift: [], notCompared: [], contextChanges: [], totalCostDeltaUsd: usd(current.totalCostUsd - base.totalCostUsd) }

  const same = (label: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.contextChanges.push(`${label}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`)
  }
  same('model', base.modelIds, current.modelIds)
  same('instructions', base.instructionsVersion, current.instructionsVersion)
  same('validator', `${base.validatorVersion}/ruleset ${base.validatorRuleset}`, `${current.validatorVersion}/ruleset ${current.validatorRuleset}`)
  same('compiler', base.compilerId, current.compilerId)
  for (const key of new Set([...Object.keys(base.limits), ...Object.keys(current.limits)])) same(`limit ${key}`, base.limits[key], current.limits[key])

  const before = new Map(base.cases.map((c) => [c.id, c]))
  const now = new Map(current.cases.map((c) => [c.id, c]))
  for (const id of before.keys()) if (!now.has(id)) out.notCompared.push(`${id}: not in this run`)
  for (const [id, cur] of now) {
    const old = before.get(id)
    if (!old) {
      out.notCompared.push(`${id}: not in the baseline`)
      continue
    }
    // One regression line per case, however many reasons it has.
    const reasons = cur.invariantsHeld ? [] : ['a hard invariant failed']
    const capped = old.cappedByEval || cur.cappedByEval
    if (capped) out.notCompared.push(`${id}: cut short by the eval spend cap`)
    else if (old.passed && !cur.passed) reasons.push(`${outcome(old)} -> ${outcome(cur)}, expected ${cur.expect.join(' or ')}`)
    else if (!old.passed && cur.passed) out.fixed.push(`${id}: ${outcome(old)} -> ${outcome(cur)}`)
    else if (!old.passed) out.stillFailing.push(`${id}: ${outcome(cur)}, expected ${cur.expect.join(' or ')}`)
    else if (outcome(old) !== outcome(cur)) out.outcomeChanges.push(`${id}: ${outcome(old)} -> ${outcome(cur)}`)
    if (reasons.length > 0) out.regressions.push(`${id}: ${reasons.join('; ')}`)
    if (capped) continue

    const deltas = [
      ['turns', cur.modelTurns - old.modelTurns],
      ['tool calls', cur.toolCalls - old.toolCalls],
      ['repairs', cur.repairRounds - old.repairRounds],
      ['checks', cur.checkRuns - old.checkRuns],
      ['questions', cur.questionsAsked - old.questionsAsked],
      ['approvals requested', cur.approvals.requested - old.approvals.requested],
      ['approvals declined', cur.approvals.declined - old.approvals.declined],
      ['input tokens', cur.tokens.input - old.tokens.input],
      ['cached input tokens', cur.tokens.cachedInput - old.tokens.cachedInput],
      ['output tokens', cur.tokens.output - old.tokens.output],
      ['reasoning tokens', cur.tokens.reasoning - old.tokens.reasoning],
    ] as const
    const moved = deltas.filter(([, d]) => d !== 0).map(([label, d]) => `${label} ${signed(d)}`)
    const costDelta = usd(cur.costUsd - old.costUsd)
    if (costDelta !== 0) moved.push(`cost ${signed(costDelta, 3)} USD`)
    const failing = (e: BaselineEntry) => (e.finalCheck ? (e.finalCheck.failing.length > 0 ? e.finalCheck.failing.join(' ') : 'none') : 'no check')
    if (failing(old) !== failing(cur)) moved.push(`failing checks ${failing(old)} -> ${failing(cur)}`)
    if (moved.length > 0) out.drift.push(`${id}: ${moved.join(', ')}`)
  }
  return out
}

export function formatComparison(c: Comparison): string {
  const section = (title: string, lines: string[]) => (lines.length === 0 ? [] : [`${title}:`, ...lines.map((l) => `  ${l}`)])
  return [
    ...section('Context differs from the baseline', c.contextChanges),
    ...section('Regressions', c.regressions),
    ...section('Fixed', c.fixed),
    ...section('Still failing', c.stillFailing),
    ...section('Outcome changed, still expected', c.outcomeChanges),
    ...section('Drift (not a failure)', c.drift),
    ...section('Not compared', c.notCompared),
    `Total cost delta: ${signed(c.totalCostDeltaUsd, 3)} USD`,
    c.regressions.length === 0 ? 'No regressions.' : `${c.regressions.length} regression(s).`,
  ].join('\n')
}
