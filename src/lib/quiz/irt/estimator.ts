// CCAT IRT estimator — pure functions, ported from `CCAT demo/server/estimator.py`.
// See docs/designs/quizzes/ccat-system-design.md §4. Replaces the heuristic Elo engine.
//
//   Response model (unified 2PL/3PL):
//     3PL (mcq/tf):       P(θ) = c + (1−c)·σ(a(θ−b))
//     2PL (constructed):  P(θ) =        σ(a(θ−b))          [c = 0]
//
//   Soft-label likelihood — one form for every item type:
//     L(θ) = P(θ)^g · (1−P(θ))^(1−g),   g ∈ [0,1]
//   Selected-response uses g = y ∈ {0,1}; fill-in-blank uses the fraction of
//   blanks correct; explanation/walkthrough use g = nodes_met / total.
//
//   EAP over a fixed θ-grid:
//     θ̂  = Σ θ_k · π(θ_k) · Π_j L_j(θ_k) / Σ π · Π L
//     SE = √( Σ (θ_k − θ̂)² · posterior(θ_k) )
//
//   Selection: max difficulty-tempered Fisher information (§5).
//   Stop when SE < τ or item cap / fixed length reached.

import type { QuizItemType } from '@/lib/validations/quiz'

/** Discrimination used for questions with no stored/authored `a` — the engine
 *  fallback (irtItemFromQuestion) and the sidebar's displayed default share it. */
export const DEFAULT_IRT_A = 1.2

// ── Item shape the engine needs (answer key NOT required here) ─────────────
export interface IrtItem {
  id: string
  itemType: QuizItemType
  a: number // discrimination
  b: number // difficulty
  c: number // guessing (derived from type; see guessingFor)
}

export interface IrtResponse {
  item: IrtItem
  g: number // soft correctness in [0,1]
}

export interface AbilityGrid {
  theta: number[] // grid points
  prior: number[] // normalized prior over the grid (same length)
}

export interface PosteriorResult {
  theta: number // θ̂ (EAP)
  se: number // standard error of θ̂
  posterior: number[] // normalized posterior over the grid
}

export interface SelectionRow {
  item: IrtItem
  info: number // raw Fisher information at θ̂
  score: number // difficulty-tempered selection score
}

// ── Defaults (design doc) ──────────────────────────────────────────────────
export const GRID_MIN = -4.0
export const GRID_MAX = 4.0
export const GRID_N = 81
export const SE_STOP = 0.3 // stop when SE(θ̂) < τ
export const MAX_ITEMS = 12 // safety cap on items per session
export const EXPOSURE_TOPK = 3 // sample among the top-k most-informative items
export const SELECT_LAMBDA = 0.5 // difficulty-matching strength (0 = pure max-info)

// ── The standard 81-point ability grid, −4…4, with a standard-normal prior ──
export const STANDARD_GRID: AbilityGrid = buildNormalGrid(GRID_MIN, GRID_MAX, GRID_N)

/** Build a θ-grid with a normalized standard-normal prior. Exposed so tests can
 *  reproduce the design doc's coarse hand-computed example exactly. */
export function buildNormalGrid(min: number, max: number, n: number): AbilityGrid {
  const theta = linspace(min, max, n)
  const raw = theta.map((t) => Math.exp(-(t * t) / 2) / Math.sqrt(2 * Math.PI))
  const sum = raw.reduce((s, v) => s + v, 0)
  return { theta, prior: raw.map((v) => v / sum) }
}

function linspace(min: number, max: number, n: number): number[] {
  if (n <= 1) return [min]
  const step = (max - min) / (n - 1)
  return Array.from({ length: n }, (_, i) => min + i * step)
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

const EPS = 1e-9
const clampP = (p: number) => Math.min(Math.max(p, EPS), 1 - EPS)

// ── Response model ──────────────────────────────────────────────────────────

/** P_j(θ): 3PL for mcq/tf (c>0), 2PL for constructed-response (c=0). */
export function pCorrect(item: IrtItem, theta: number): number {
  return item.c + (1 - item.c) * sigmoid(item.a * (theta - item.b))
}

/** Derive the 3PL guessing parameter `c` from item type (design §3). */
export function guessingFor(itemType: QuizItemType, numChoices = 4): number {
  if (itemType === 'true_false') return 0.5
  if (itemType === 'multiple_choice') return numChoices > 0 ? 1 / numChoices : 0.25
  return 0 // short_answer / fill_in_blank / explanation / walkthrough → 2PL
}

/** Fisher information I_j(θ) at a scalar θ (design §5). */
export function fisherInfo(item: IrtItem, theta: number): number {
  const P = clampP(pCorrect(item, theta))
  const num = (item.a * item.a * (P - item.c) * (P - item.c)) / ((1 - item.c) * (1 - item.c))
  return (num * (1 - P)) / P
}

// ── Soft-label likelihood + EAP posterior ───────────────────────────────────

/** L_j(θ) = P^g (1−P)^(1−g) across the whole grid (soft-label form). */
function itemLikelihood(item: IrtItem, g: number, grid: AbilityGrid): number[] {
  return grid.theta.map((t) => {
    const P = clampP(pCorrect(item, t))
    return Math.pow(P, g) * Math.pow(1 - P, 1 - g)
  })
}

/** EAP update over the grid. Returns θ̂, SE, and the normalized posterior.
 *  Anomaly-resistant: the product over all items dominates any single response. */
export function computePosterior(
  responses: IrtResponse[],
  grid: AbilityGrid = STANDARD_GRID,
): PosteriorResult {
  let unnorm = grid.prior.slice()
  for (const r of responses) {
    const L = itemLikelihood(r.item, r.g, grid)
    unnorm = unnorm.map((v, k) => v * L[k])
  }
  const Z = unnorm.reduce((s, v) => s + v, 0)
  const posterior =
    Z > 0 && Number.isFinite(Z) ? unnorm.map((v) => v / Z) : grid.prior.slice()

  const theta = grid.theta.reduce((s, t, k) => s + t * posterior[k], 0)
  const variance = grid.theta.reduce((s, t, k) => s + (t - theta) * (t - theta) * posterior[k], 0)
  return { theta, se: Math.sqrt(Math.max(variance, 0)), posterior }
}

// ── Item selection (difficulty-tempered max Fisher info, §5) ─────────────────

/** Unanswered items ranked by selection score at θ (descending).
 *  score = Fisher info · exp(−λ(b−θ)²). λ=0 → classic max-information rule;
 *  λ>0 tempers toward items whose difficulty sits near the current ability. */
export function selectionTable(
  bank: IrtItem[],
  answeredIds: Set<string>,
  theta: number,
  lam: number = SELECT_LAMBDA,
): SelectionRow[] {
  const lambda = Math.max(0, lam)
  const rows: SelectionRow[] = []
  for (const item of bank) {
    if (answeredIds.has(item.id)) continue
    const info = fisherInfo(item, theta)
    const penalty = lambda ? Math.exp(-lambda * (item.b - theta) * (item.b - theta)) : 1
    rows.push({ item, info, score: info * penalty })
  }
  rows.sort((x, y) => y.score - x.score)
  return rows
}

/** Pick the next item: sample uniformly among the top-k most informative
 *  (exposure control). Returns the chosen row + the full ranking, or null when
 *  the bank is exhausted. `rand` defaults to deterministic top-1. */
export function selectNext(
  bank: IrtItem[],
  answeredIds: Set<string>,
  theta: number,
  opts: { topk?: number; lam?: number; rand?: () => number } = {},
): { chosen: SelectionRow; table: SelectionRow[] } | null {
  const { topk = EXPOSURE_TOPK, lam = SELECT_LAMBDA, rand } = opts
  const table = selectionTable(bank, answeredIds, theta, lam)
  if (table.length === 0) return null
  const pool = table.slice(0, Math.max(1, Math.min(topk, table.length)))
  const chosen = rand ? pool[Math.floor(rand() * pool.length)] : pool[0]
  return { chosen, table }
}

// ── Stopping rule + score mapping ───────────────────────────────────────────

export type StopMode = 'fixed' | 'precision'
export type StopReason = '' | 'length' | 'se' | 'max'

export interface StopRule {
  mode: StopMode
  length?: number // fixed-length target
  targetSe?: number // precision target SE
  maxItems?: number // precision safety cap
}

/** Return [stopped, reason]. 'fixed' stops after `length` items; 'precision'
 *  stops when SE < targetSe, with a maxItems safety cap. */
export function shouldStop(se: number, nAnswered: number, rule: StopRule): [boolean, StopReason] {
  if (rule.mode === 'fixed') {
    const length = rule.length ?? 8
    return nAnswered >= length ? [true, 'length'] : [false, '']
  }
  if (se < (rule.targetSe ?? SE_STOP)) return [true, 'se']
  if (nAnswered >= (rule.maxItems ?? MAX_ITEMS)) return [true, 'max']
  return [false, '']
}
