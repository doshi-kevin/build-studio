/**
 * Suite statistics and nondeterminism measures over studio-generation-quality-result-v1
 * rows. Pure.
 *
 * Primary quality statistics use comparable results only: live builds that passed every
 * gate, judged by a live judge on visual and code evidence. Code-only, imported and
 * scripted-judge results are counted and listed apart, never mixed in. The suite mean
 * counts a correctness-gate failure as 0.
 */
import { DIMENSIONS, LEVEL_FRACTION, type DimensionKey, type Level } from './rubric'
import type { QualityResult } from './schema'

// ── Basic statistics ──

export const mean = (xs: readonly number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Sample standard deviation; null with fewer than two values. */
export function sd(xs: readonly number[]): number | null {
  if (xs.length < 2) return null
  const m = mean(xs)!
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}

export interface Stats {
  n: number
  mean: number | null
  median: number | null
  sd: number | null
  min: number | null
  max: number | null
}

export function stats(xs: readonly number[]): Stats {
  return { n: xs.length, mean: mean(xs), median: median(xs), sd: sd(xs), min: xs.length ? Math.min(...xs) : null, max: xs.length ? Math.max(...xs) : null }
}

/** The 95% Wilson score interval for k successes in n trials. */
export function wilson(k: number, n: number, z = 1.96): { rate: number | null; low: number | null; high: number | null } {
  if (n === 0) return { rate: null, low: null, high: null }
  const p = k / n
  const denom = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
  return { rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) }
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let both = 0
  for (const x of a) if (b.has(x)) both += 1
  return both / (a.size + b.size - both)
}

/** Mean Jaccard similarity over every pair of sets; null with fewer than two. */
export function meanPairwiseJaccard(sets: readonly ReadonlySet<string>[]): number | null {
  const scores: number[] = []
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) scores.push(jaccard(sets[i], sets[j]))
  return mean(scores)
}

// ── Per-result facts ──

const usable = (r: QualityResult) => r.comparable && r.qualityScore !== null

/** A comparable key for an extracted action: its role and its first words, lowercased. */
export const actionKey = (role: string, text: string) => `${role}:${text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).slice(0, 6).join(' ')}`

export function actionSet(r: QualityResult, role: 'professor' | 'student'): Set<string> {
  const items = r.evaluation.extracted?.items ?? []
  return new Set(items.filter((i) => i.kind === 'action' && (i.role === role || i.role === 'both')).map((i) => actionKey(role, i.text)))
}

export const signatureKey = (r: QualityResult) =>
  `student[${r.build.signature.studentCapabilities.join(',')}] professor[${r.build.signature.professorCapabilities.join(',')}] access[${r.build.signature.accessModes.join(',')}]`

const fraction = (level: Level | null) => (level ? LEVEL_FRACTION[level] : null)

// ── Judge variance: several judge runs on one artifact ──

export function judgeVariance(r: QualityResult): { totalSd: number | null; meanDimensionSpread: number | null } {
  const totals = r.evaluation.passTotals.filter((t): t is number => t !== null)
  const spreads = r.evaluation.dimensions ? DIMENSIONS.filter((d) => r.evaluation.dimensions![d.key].assessed).map((d) => r.evaluation.dimensions![d.key].spread) : []
  return { totalSd: sd(totals), meanDimensionSpread: mean(spreads) }
}

// ── Generation variance: several builds of one case ──

export interface CaseVariance {
  caseId: string
  generations: number
  gatePass: ReturnType<typeof wilson>
  score: Stats
  dimensions: Record<DimensionKey, Stats>
  professorActionJaccard: number | null
  studentActionJaccard: number | null
  signatures: Record<string, number>
  coreActionPresent: { professor: number; student: number; of: number }
  costUsd: Stats
  modelTurns: Stats
  toolCalls: Stats
  /** Mean judge spread across this case's artifacts, to read beside the generation spread. */
  judgeTotalSd: number | null
}

const numbers = (xs: (number | null | undefined)[]) => xs.filter((x): x is number => typeof x === 'number')

/** Results of one case grouped by rerun group; each generation counted once. */
export function generationsOf(results: readonly QualityResult[], caseId: string): QualityResult[] {
  const seen = new Set<string>()
  return results
    .filter((r) => r.case.id === caseId)
    .sort((a, b) => a.rerun.generation - b.rerun.generation)
    .filter((r) => {
      const key = `${r.rerun.groupId}#${r.rerun.generation}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function caseVariance(results: readonly QualityResult[], caseId: string): CaseVariance {
  const gens = generationsOf(results, caseId)
  const scored = gens.filter(usable)
  const dimensions = Object.fromEntries(
    DIMENSIONS.map((d) => {
      const points = scored.map((r) => fraction(r.evaluation.dimensions?.[d.key].level ?? null)).map((f) => (f === null ? null : f * d.points))
      return [d.key, stats(numbers(points))]
    }),
  ) as Record<DimensionKey, Stats>
  const signatures: Record<string, number> = {}
  for (const r of gens) signatures[signatureKey(r)] = (signatures[signatureKey(r)] ?? 0) + 1
  const judged = gens.filter((r) => r.evaluation.extracted)
  return {
    caseId,
    generations: gens.length,
    gatePass: wilson(gens.filter((r) => r.gates.correctness === 'passed').length, gens.length),
    score: stats(numbers(scored.map((r) => r.qualityScore))),
    dimensions,
    professorActionJaccard: meanPairwiseJaccard(judged.map((r) => actionSet(r, 'professor'))),
    studentActionJaccard: meanPairwiseJaccard(judged.map((r) => actionSet(r, 'student'))),
    signatures,
    coreActionPresent: {
      professor: judged.filter((r) => r.evaluation.extracted!.core.professor.present).length,
      student: judged.filter((r) => r.evaluation.extracted!.core.student.present).length,
      of: judged.length,
    },
    costUsd: stats(numbers(gens.map((r) => r.build.costUsd))),
    modelTurns: stats(numbers(gens.map((r) => r.build.modelTurns))),
    toolCalls: stats(numbers(gens.map((r) => r.build.toolCalls))),
    judgeTotalSd: mean(numbers(gens.map((r) => judgeVariance(r).totalSd))),
  }
}

// ── The suite ──

export interface SuiteSummary {
  results: number
  byProvenance: Record<string, number>
  byMode: Record<string, number>
  failureClasses: Record<string, number>
  /** Correctness gates passed, over results whose gates could all be checked or failed. */
  gatePass: ReturnType<typeof wilson>
  publishable: { yes: number; of: number }
  comparable: Stats
  /** Mean of suite contributions: comparable scores, and 0 for each correctness failure. */
  suiteMean: number | null
  suiteCount: number
  dimensions: Record<DimensionKey, Stats>
  bySet: Record<string, { comparable: Stats; suiteMean: number | null }>
  byCategory: Record<string, { comparable: Stats; suiteMean: number | null }>
  judgeVariance: { totalSd: number | null; meanDimensionSpread: number | null }
  costUsd: Stats
  judgeCostUsd: Stats
  modelTurns: Stats
  toolCalls: Stats
  /** Results kept out of the primary statistics, and why. */
  notComparable: { caseId: string; generation: number; mode: string; failureClass: string; notes: string[] }[]
}

const tally = (xs: string[]) => xs.reduce<Record<string, number>>((acc, x) => ((acc[x] = (acc[x] ?? 0) + 1), acc), {})

function slice(rows: readonly QualityResult[]): { comparable: Stats; suiteMean: number | null } {
  return { comparable: stats(numbers(rows.filter(usable).map((r) => r.qualityScore))), suiteMean: mean(numbers(rows.map((r) => r.suiteContribution))) }
}

export function summarize(results: readonly QualityResult[]): SuiteSummary {
  const comparable = results.filter(usable)
  const decided = results.filter((r) => r.gates.correctness !== 'unknown')
  const contributions = numbers(results.map((r) => r.suiteContribution))
  const groupBy = (key: (r: QualityResult) => string) => {
    const out: Record<string, QualityResult[]> = {}
    for (const r of results) (out[key(r)] ??= []).push(r)
    return Object.fromEntries(Object.entries(out).map(([k, rows]) => [k, slice(rows)]))
  }
  const variances = results.filter((r) => r.evaluation.passTotals.length > 1).map(judgeVariance)
  return {
    results: results.length,
    byProvenance: tally(results.map((r) => r.provenance)),
    byMode: tally(results.map((r) => r.evaluation.mode)),
    failureClasses: tally(results.map((r) => r.failureClass)),
    gatePass: wilson(decided.filter((r) => r.gates.correctness === 'passed').length, decided.length),
    publishable: { yes: results.filter((r) => r.stage2.publishable === true).length, of: results.filter((r) => r.stage2.publishable !== null).length },
    comparable: stats(numbers(comparable.map((r) => r.qualityScore))),
    suiteMean: mean(contributions),
    suiteCount: contributions.length,
    dimensions: Object.fromEntries(DIMENSIONS.map((d) => [d.key, stats(numbers(comparable.map((r) => r.evaluation.dimensions?.[d.key].points)))])) as Record<DimensionKey, Stats>,
    bySet: groupBy((r) => r.case.set),
    byCategory: groupBy((r) => r.case.category),
    judgeVariance: { totalSd: mean(numbers(variances.map((v) => v.totalSd))), meanDimensionSpread: mean(numbers(variances.map((v) => v.meanDimensionSpread))) },
    costUsd: stats(numbers(results.map((r) => r.build.costUsd))),
    judgeCostUsd: stats(numbers(results.map((r) => r.evaluation.costUsd))),
    modelTurns: stats(numbers(results.map((r) => r.build.modelTurns))),
    toolCalls: stats(numbers(results.map((r) => r.build.toolCalls))),
    notComparable: results
      .filter((r) => !usable(r))
      .map((r) => ({ caseId: r.case.id, generation: r.rerun.generation, mode: r.evaluation.mode, failureClass: r.failureClass, notes: r.comparabilityNotes })),
  }
}

// ── Comparing two suites ──

/** A small deterministic generator, so a comparison gives the same interval every time. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A 95% bootstrap interval for mean(candidate) minus mean(baseline). */
export function bootstrapMeanDifference(baseline: readonly number[], candidate: readonly number[], iterations = 5000, seed = 12): { difference: number | null; low: number | null; high: number | null } {
  if (baseline.length === 0 || candidate.length === 0) return { difference: null, low: null, high: null }
  const rand = mulberry32(seed)
  const resample = (xs: readonly number[]) => {
    let s = 0
    for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rand() * xs.length)]
    return s / xs.length
  }
  const diffs: number[] = []
  for (let i = 0; i < iterations; i++) diffs.push(resample(candidate) - resample(baseline))
  diffs.sort((a, b) => a - b)
  return { difference: mean(candidate)! - mean(baseline)!, low: diffs[Math.floor(0.025 * iterations)], high: diffs[Math.ceil(0.975 * iterations) - 1] }
}

export interface SuiteComparison {
  suiteMean: ReturnType<typeof bootstrapMeanDifference>
  gatePassRate: { baseline: number | null; candidate: number | null }
  /** True only when the interval is above zero and the gate pass rate didn't fall. */
  improved: boolean
}

/** The Step 12 rule for calling a change an improvement (design section 8). */
export function compareSuites(baseline: readonly QualityResult[], candidate: readonly QualityResult[]): SuiteComparison {
  const contributions = (rows: readonly QualityResult[]) => numbers(rows.map((r) => r.suiteContribution))
  const suiteMean = bootstrapMeanDifference(contributions(baseline), contributions(candidate))
  const b = summarize(baseline).gatePass.rate
  const c = summarize(candidate).gatePass.rate
  return { suiteMean, gatePassRate: { baseline: b, candidate: c }, improved: suiteMean.low !== null && suiteMean.low > 0 && b !== null && c !== null && c >= b }
}
