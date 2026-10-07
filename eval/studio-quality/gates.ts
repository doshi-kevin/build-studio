/**
 * The hard gates, kept apart from the quality score (design section 3). Pure.
 *
 *   1-5, correctness: the build ended preview_ready, the five harness invariants held,
 *        the committed snapshot passes the draft gate again, and Stage 2 runtime.boot and
 *        runtime.isolation passed in both views. Any failure: no quality score, and the
 *        case counts 0 in the suite mean.
 *   6,   evidence: the normal state of both views at desktop and phone width was captured.
 *        Without it the evaluation can only be a diagnostic code-only one, never comparable.
 *
 * A gate that couldn't be checked is "unknown", never assumed to pass.
 */
import type { FailureClass, GateStatus, QualityResult } from './schema'

export interface Stage2Check {
  checkId: string
  status: string
  views: Record<string, string>
  findings: { view: string; detail: string }[]
}

export interface GateFacts {
  provenance: 'live-build' | 'imported-artifact'
  /** Every build's end status, in order; the first is the canonical build. Null when unknown. */
  buildStatuses: string[] | null
  cappedByEval: boolean | null
  invariants: Record<string, boolean> | null
  /** Null when the draft gate couldn't run (a check-worker failure). */
  draftGate: { passed: boolean; failing: string[] } | null
  /** Null when Stage 2 didn't run. */
  stage2: Stage2Check[] | null
  /** Null when capture wasn't attempted. */
  capture: { missing: string[] } | null
}

export type Gates = QualityResult['gates']

const SUCCESS = ['preview_ready', 'completed']

function buildGate(facts: GateFacts): GateStatus {
  const s = facts.buildStatuses
  if (!s || s.length === 0) return 'unknown'
  // The canonical build must reach a preview; a later follow-up may find nothing to change.
  return s[0] === 'preview_ready' && s.every((x) => SUCCESS.includes(x)) ? 'passed' : 'failed'
}

function stage2Gate(stage2: Stage2Check[] | null, checkId: string): GateStatus {
  if (!stage2) return 'unknown'
  const check = stage2.find((c) => c.checkId === checkId)
  if (!check) return 'unknown'
  return check.views.student === 'passed' && check.views.professor === 'passed' ? 'passed' : 'failed'
}

const combine = (statuses: GateStatus[]): GateStatus => (statuses.includes('failed') ? 'failed' : statuses.includes('unknown') ? 'unknown' : 'passed')

export function computeGates(facts: GateFacts): Gates {
  const build = buildGate(facts)
  const invariants: GateStatus = facts.invariants === null ? 'unknown' : Object.values(facts.invariants).every(Boolean) ? 'passed' : 'failed'
  const draftGate: GateStatus = facts.draftGate === null ? 'unknown' : facts.draftGate.passed ? 'passed' : 'failed'
  const stage2Boot = stage2Gate(facts.stage2, 'runtime.boot')
  const stage2Isolation = stage2Gate(facts.stage2, 'runtime.isolation')
  const visual: GateStatus = facts.capture === null ? 'unknown' : facts.capture.missing.length === 0 ? 'passed' : 'failed'

  const failures: string[] = []
  if (build === 'failed') failures.push(`build ended ${facts.buildStatuses?.join(', then ')}`)
  if (invariants === 'failed') failures.push(...Object.entries(facts.invariants!).filter(([, ok]) => !ok).map(([name]) => `invariant ${name}`))
  if (draftGate === 'failed') failures.push(`draft gate: ${facts.draftGate!.failing.join(', ') || 'failed'}`)
  if (stage2Boot === 'failed') failures.push('Stage 2 runtime.boot')
  if (stage2Isolation === 'failed') failures.push('Stage 2 runtime.isolation')
  if (visual === 'failed') failures.push(`screenshots missing: ${facts.capture!.missing.join(', ')}`)

  return {
    build,
    invariants: { status: invariants, detail: facts.invariants },
    draftGate: { status: draftGate, failing: facts.draftGate?.failing ?? [] },
    stage2Boot,
    stage2Isolation,
    visualEvidence: { status: visual, missing: facts.capture?.missing ?? [] },
    correctness: combine([build, invariants, draftGate, stage2Boot, stage2Isolation]),
    failures,
  }
}

/** Every required Stage 2 check passed in both views; null when Stage 2 didn't run. */
export function publishable(stage2: Stage2Check[] | null): boolean | null {
  if (!stage2) return null
  return stage2.length > 0 && stage2.every((c) => c.status === 'passed')
}

/** The first thing that went wrong, in pipeline order. */
export function failureClassOf(facts: GateFacts, gates: Gates, judge: { ran: boolean; succeeded: boolean }): FailureClass {
  if (facts.cappedByEval) return 'capped_by_eval'
  if (gates.build === 'failed') {
    const first = facts.buildStatuses?.find((s) => !SUCCESS.includes(s)) ?? facts.buildStatuses?.[0]
    return first === 'blocked' ? 'build_blocked' : first === 'budget_exhausted' ? 'budget_exhausted' : 'build_failed'
  }
  if (gates.invariants.status === 'failed') return 'invariant_violation'
  if (gates.draftGate.status === 'failed') return 'draft_gate_failed'
  if (gates.stage2Boot === 'failed' || gates.stage2Isolation === 'failed') return 'stage2_failed'
  if (gates.visualEvidence.status === 'failed') return 'capture_failed'
  if (judge.ran && !judge.succeeded) return 'judge_failed'
  if (gates.correctness === 'unknown') return 'metadata_incomplete'
  return 'none'
}

export interface Comparability {
  comparable: boolean
  notes: string[]
  qualityScore: number | null
  suiteContribution: number | null
}

/**
 * Whether a result enters the primary quality statistics, and what it adds to the suite
 * mean. Only a live build that passed every gate, judged by a live judge on visual and
 * code evidence, is comparable. A correctness failure has no score and adds 0.
 */
export function comparability(input: {
  provenance: GateFacts['provenance']
  /** The eval's own spend cap stopped the build: its outcome says nothing about the builder. */
  cappedByEval: boolean | null
  gates: Gates
  mode: 'visual+code' | 'code-only' | 'none'
  judgeKind: 'scripted' | 'live' | null
  judgeSucceeded: boolean
  total: number | null
}): Comparability {
  const notes: string[] = []
  if (input.provenance !== 'live-build') notes.push('imported artifact: not built by this framework, metadata incomplete')
  if (input.cappedByEval) notes.push('the eval’s spend cap stopped the build')
  if (input.gates.correctness === 'failed') notes.push('a correctness gate failed')
  if (input.gates.correctness === 'unknown') notes.push('a correctness gate could not be checked')
  if (input.mode === 'code-only') notes.push('code-only evaluation: visual quality not measured')
  if (input.mode === 'none') notes.push('not judged')
  if (input.judgeKind === 'scripted') notes.push('scripted judge: pipeline check only, not a judgement')
  if (input.mode !== 'none' && !input.judgeSucceeded) notes.push('the judge did not return a valid judgement')

  // A build the eval's own cap cut short failed for the eval, not the builder: no score, and no 0.
  if (input.cappedByEval) return { comparable: false, notes, qualityScore: null, suiteContribution: null }
  if (input.gates.correctness === 'failed') return { comparable: false, notes, qualityScore: null, suiteContribution: 0 }
  const comparable =
    input.provenance === 'live-build' &&
    input.gates.correctness === 'passed' &&
    input.gates.visualEvidence.status === 'passed' &&
    input.mode === 'visual+code' &&
    input.judgeKind === 'live' &&
    input.judgeSucceeded &&
    input.total !== null
  return { comparable, notes, qualityScore: input.judgeSucceeded ? input.total : null, suiteContribution: comparable ? input.total : null }
}
