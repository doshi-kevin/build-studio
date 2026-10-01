// Adaptive (CCAT) quiz results — ports the demo's Results screen. Shows the
// deterministic GRADE (weighted % of ideas correct) prominently, the IRT ability
// estimate θ̂±SE as a *separate* diagnostic, a per-topic mastery map, and any
// misconceptions diagnosed on hard misses. Falls back to the linear results view
// for non-adaptive attempts. See docs/designs/quizzes/ccat-system-design.md §8.
'use client'

import { useEffect, useState } from 'react'
import { Loader2, Compass } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'
import { QuizResults } from '@/components/student/quizzes/QuizResults'
import { QuestionReviewCard } from '@/components/student/quizzes/QuestionReviewCard'
import type { TranscriptTurn } from '@/lib/quiz/irt/grader'
import { getUnifiedResult } from '@/app/(dashboard)/student/courses/[sectionId]/quizzes/actions'
import { logger } from '@/lib/logger'
import { formatDate, isPastDue } from '@/lib/quiz/utils'
import type { Question, Answer, ExplanationTiming } from '@/lib/validations/quiz'
import type { UnifiedResult } from '@/lib/quiz/unified-result'

type Misconception = { node: string; topic: string }

interface Props {
  sectionId: string
  quizId: string
  attemptId: string
}

// Bell-curve visual for the ability estimate: the student's N(θ̂, SE²) drawn
// bright over a dim standard-normal N(0,1) — the engine's prior — so the shift
// from the base distribution is visible at a glance. Matches the −4…+4 grid
// used by the IRT estimator. Each curve is scaled to its own peak; the
// student's curve communicates SE through its width, not its height.
function AbilityCurve({ theta, se }: { theta: number; se: number }) {
  const W = 560
  const H = 110
  const PAD = 6
  const x = (t: number) => PAD + ((Math.min(4, Math.max(-4, t)) + 4) / 8) * (W - 2 * PAD)
  const sigma = Math.max(se, 0.08) // avoid a degenerate spike at very low SE

  const curve = (mu: number, s: number) => {
    const pts: string[] = []
    for (let i = 0; i <= 96; i++) {
      const t = -4 + (i / 96) * 8
      const p = Math.exp(-((t - mu) ** 2) / (2 * s * s)) // own-peak normalized
      const yv = H - PAD - p * (H - 2 * PAD)
      pts.push(`${i === 0 ? 'M' : 'L'}${x(t).toFixed(1)},${yv.toFixed(1)}`)
    }
    return pts.join(' ')
  }
  const baseline = H - PAD

  return (
    <div className="mt-4">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Your ability estimate ${theta.toFixed(2)}, with a standard error of ${se.toFixed(2)}, on a normal distribution compared with the baseline centred at 0`}>
        {/* base distribution — dim, the prior every student starts from */}
        <path d={`${curve(0, 1)} L${x(4)},${baseline} L${x(-4)},${baseline} Z`} fill="currentColor" className="text-background/10" />
        <path d={curve(0, 1)} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-background/30" />
        <line x1={x(0)} x2={x(0)} y1={PAD} y2={baseline} stroke="currentColor" strokeWidth="1" strokeDasharray="3 4" className="text-background/30" />

        {/* student distribution — CCAT demo violet (#7d7bf0/#cfcdfa), deliberately
            off-token: the warm-ink palette has no violet and this dark card ports
            the demo's ability-estimate visual identity */}
        <path d={`${curve(theta, sigma)} L${x(theta + 4)},${baseline} L${x(theta - 4)},${baseline} Z`} fill="#7d7bf0" fillOpacity="0.22" />
        <path d={curve(theta, sigma)} fill="none" stroke="#7d7bf0" strokeWidth="2" />
        <line x1={x(theta)} x2={x(theta)} y1={PAD} y2={baseline} stroke="#cfcdfa" strokeWidth="1.5" />
      </svg>
      <div className="flex justify-between font-mono text-[10px] text-background/50">
        <span>−4</span>
        <span>0 · baseline</span>
        <span>+4</span>
      </div>
    </div>
  )
}

// Plain-language read of the ability estimate relative to the average test-taker
// (baseline θ = 0). Only claim above/below when the whole ±SE confidence band
// clears the baseline — otherwise the honest read is "around average".
export function abilityLabel(theta: number, se: number): string {
  if (theta - se > 0) return 'Above average'
  if (theta + se < 0) return 'Below average'
  return 'Around average'
}

export function AdaptiveResults({ sectionId, quizId, attemptId }: Props) {
  const [state, setState] = useState<'loading' | 'adaptive' | 'linear' | 'error'>('loading')
  const [result, setResult] = useState<UnifiedResult | null>(null)
  const [misconceptions, setMisconceptions] = useState<Misconception[]>([])
  // Full per-question data for the review section — the same payload the linear
  // view feeds QuestionReviewCard, so adaptive reviews show answers identically.
  const [review, setReview] = useState<{
    questions: Question[]
    answers: Record<string, Answer>
    showExplanations: ExplanationTiming
    dueDate: string | null
    /* Keyed by questionId. Guided Walkthrough answers live here, not in `answers` (#379 part 1). */
    walkthroughTranscripts: Record<string, TranscriptTurn[]>
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      const res = await getUnifiedResult(sectionId, attemptId)
      if ('error' in res) {
        setError(res.error ?? 'Could not load results')
        setState('error')
        return
      }
      // Standard attempts fall back to the linear results view.
      if (!res.result.isAdaptive) {
        setState('linear')
        return
      }
      setResult(res.result)
      setMisconceptions(res.misconceptions)
      setReview({
        questions: res.questions,
        answers: res.answers,
        showExplanations: res.showExplanations,
        dueDate: res.dueDate,
        walkthroughTranscripts: res.walkthroughTranscripts ?? {},
      })
      setState('adaptive')
    })()
  }, [sectionId, attemptId])

  if (state === 'loading') {
    return (
      <div className="flex min-h-[40vh] items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading results…
      </div>
    )
  }
  if (state === 'linear') {
    return <QuizResults sectionId={sectionId} quizId={quizId} attemptId={attemptId} />
  }
  if (state === 'error' || !result) {
    return <div className="py-12 text-center text-sm text-destructive">{error ?? 'Could not load results'}</div>
  }

  const ability = result.ability
  const itemCount = result.questionReview.length
  const questionsById = new Map((review?.questions ?? []).map((q) => [q.id, q]))
  const stopText =
    ability?.stopReason === 'se'
      ? 'the estimate reached the target precision'
      : ability?.stopReason === 'length'
        ? 'you answered every question'
        : 'the question bank was exhausted'

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-8">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Results</p>

      {/* Headline GRADE — deterministic */}
      <Card className="p-6">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Grade</span>
          <span className="text-[11px] text-muted-foreground">
            weighted % correct · {itemCount} item{itemCount === 1 ? '' : 's'}
          </span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-5xl font-semibold tabular-nums tracking-tight text-foreground">{result.grade}</span>
          <span className="text-base tabular-nums text-muted-foreground">/ 100</span>
        </div>
        <Progress value={result.grade} className="mt-3" />
      </Card>

      {/* Ability estimate — diagnostic, deliberately distinct from the grade. IRT
          leads with a plain "vs. average" read + the bell curve; the legacy Elo
          path shows just the rating. */}
      {ability && (
        <Card className="bg-foreground p-5 text-background">
          <div className="mb-2 flex items-center gap-2">
            <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-background/80">
              Ability estimate
            </span>
            <span className="rounded-full bg-background/20 px-2 py-0.5 text-[10px] font-bold">diagnostic</span>
          </div>
          {ability.engine === 'irt' && ability.theta != null ? (
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold tracking-tight">
                  {abilityLabel(ability.theta, ability.se ?? 1)}
                </span>
                <span className="font-mono text-xs tabular-nums text-background/50">
                  θ̂ {ability.theta >= 0 ? '+' : ''}{ability.theta.toFixed(2)} ± {(ability.se ?? 1).toFixed(2)}
                </span>
              </div>
              <AbilityCurve theta={ability.theta} se={ability.se ?? 1} />
            </>
          ) : (
            <div className="flex items-baseline gap-2 font-mono tabular-nums">
              <span className="text-3xl font-bold tracking-tight">{ability.rating}</span>
              <span className="text-sm text-background/60">rating</span>
            </div>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-background/70">
            How you compare with the average test-taker{ability.engine === 'irt' ? ' (the center line)' : ''}. This
            decided which questions you saw and when the quiz stopped — it is <b>not your grade</b>.
          </p>
        </Card>
      )}

      {/* Skill breakdown — per-tag accuracy, shared with the standard results view */}
      {result.topics.topics.length > 0 && (
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-foreground">Skill breakdown</h3>
          <p className="mb-4 mt-1 text-xs text-muted-foreground">
            Per-topic accuracy (share you got right). Your <b>{result.grade}/100</b> grade is the overall average.
          </p>
          <div className="space-y-3.5">
            {result.topics.topics.map((t) => (
              <div key={t.tag}>
                <div className="mb-1 flex justify-between text-sm">
                  <span className="font-medium text-foreground">{t.tag}</span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {t.accuracy}% · {t.totalCount} item{t.totalCount === 1 ? '' : 's'}
                  </span>
                </div>
                <Progress value={t.accuracy} />
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Misconceptions — only shown when some were diagnosed; an empty card is
          noise (nothing missed is already implied by the grade). */}
      {misconceptions.length > 0 && (
        <Card className="p-5">
          <div className="mb-1 flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">Misconceptions diagnosed</h3>
            <Badge variant="outline" className="text-muted-foreground">diagnostic</Badge>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Flagged from hard items you missed — used to target remediation.
          </p>
          <div className="space-y-2">
            {misconceptions.map((m, i) => (
              <div key={i} className="flex items-start gap-2.5 rounded-xl border border-border bg-muted/30 p-3">
                <Compass className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div>
                  <MarkdownLatex content={m.node} variant="compact" className="text-sm text-foreground" />
                  {m.topic && <p className="mt-0.5 text-[11px] text-muted-foreground">skill: {m.topic}</p>}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Per-question review — same card the linear results use, so answers and
          correct answers show identically (gated by the quiz's show_explanations
          timing). AI feedback (rationale + rubric coverage) is passed through for
          AI-graded items (issue #174). Iterates questionReview to keep the
          adaptive served order. */}
      {result.questionReview.length > 0 && review && (
        <div>
          <h3 className="mb-3 text-sm font-semibold text-foreground">Question review</h3>
          {/* Same reveal-timing hints the linear results show, so a gated student
              understands why correctness/answers are hidden (not a bug). */}
          {review.showExplanations === 'never' && (
            <p className="mb-3 text-xs text-muted-foreground">Explanations are not available for this quiz.</p>
          )}
          {/* Mirrors QuizResults — same predicate and formatter as the reveal gate (#311). */}
          {review.showExplanations === 'after_due_date' && review.dueDate && !isPastDue(review.dueDate) && (
            <p className="mb-3 text-xs text-muted-foreground">
              Explanations unlock after the due date ({formatDate(review.dueDate)}).
            </p>
          )}
          <div className="space-y-3">
            {result.questionReview.map((item, i) => {
              const question = questionsById.get(item.questionId)
              if (!question) {
                // Server invariant: every reviewed item resolves to a question.
                // Log rather than silently drop so a violation is observable.
                logger.warn('AdaptiveResults.review', { missingQuestionId: item.questionId })
                return null
              }
              return (
                <QuestionReviewCard
                  key={item.questionId}
                  question={question}
                  answer={review.answers[item.questionId]}
                  walkthroughTranscript={review.walkthroughTranscripts[item.questionId]}
                  questionNumber={i + 1}
                  showExplanations={review.showExplanations}
                  dueDate={review.dueDate}
                  aiFeedback={{
                    rationale: item.rationale,
                    nodesMet: item.nodesMet,
                    nodesTotal: item.nodesTotal,
                  }}
                />
              )
            })}
          </div>
        </div>
      )}

      {ability?.engine === 'irt' && (
        <p className="px-1 text-xs text-muted-foreground">
          Items were selected adaptively to be most informative about your ability; the quiz stopped because {stopText}.
        </p>
      )}
    </div>
  )
}
