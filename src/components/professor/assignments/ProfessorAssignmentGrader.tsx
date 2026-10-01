/**
 * ProfessorAssignmentGrader — segmented grading view.
 *
 * The roster is split into four intuitive buckets — Needs grading, Returned,
 * Graded, Not submitted — each a filter chip with a count. Picking a student
 * opens a detail panel with their text + files and a quick score/feedback form.
 * No student is auto-selected; the professor drives.
 *
 * Type: Client Component
 */
'use client'

import { useCallback, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { CircleDashed, CheckCircle2, Clock3, ChevronLeft, RotateCcw, Check, MessageSquareWarning, AlertTriangle, Clock, ChevronDown, ArrowRight, Bot, PenLine, Sparkles } from 'lucide-react'
import { SubmissionFileViewer } from '@/components/assignments/SubmissionFileViewer'
import { VerbalSubmissionReview } from '@/components/professor/assignments/verbal/VerbalSubmissionReview'
import { SubquestionCommentThread } from '@/components/assignments/SubquestionCommentThread'
import type { VerbalSubmissionAnswer, SubmissionCommentRow } from '@/lib/validations/assignment'
import type { ProctoringSummary } from '@/lib/validations/proctoring'
import { AssignmentProctoringReport, ProctoringBadge, type ProctoringSnapshotView } from '@/components/professor/assignments/AssignmentProctoringReport'
import { extensionOf } from '@/lib/assignments/zip'
import { resolveGradeValue } from '@/lib/assignments/grade-value'
import { isReopenWindowActive } from '@/lib/assignments/submissions'
import { GRADE_CONFLICT_MESSAGE, MAX_GRADE_FEEDBACK_LENGTH } from '@/lib/validations/assignment'
import type { SubmissionStatus, AssignmentRubric } from '@/lib/validations/assignment'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { gradeSubmission, requestChanges, resolveRegradeRequest, reopenSubmission, gradeStudent, suggestGrades } from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'
import { useAthenaSurface, type FillResult } from '@/components/professor/assignments/athena/AssignmentAthenaDock'
import { AthenaAskLine } from '@/components/professor/assignments/athena/AthenaAskLine'
import { GenerationProgress } from '@/components/professor/assignments/GenerationProgress'
import type { AssignmentFillTool, AssignmentScreen, FillFeedback } from '@/lib/ai/assignment-assistant/schemas'
import type { AiGradeSuggestion, SuggestedCriterion } from '@/lib/assignments/ai-grading/types'
import {
  EvidenceHighlightedText,
  computeEvidenceRanges,
  evidenceMarkId,
} from '@/components/professor/assignments/EvidenceHighlights'

export interface GradedFile {
  name: string
  path: string
  url: string | null
}

export interface StudentEntry {
  id: string
  name: string
  email: string
  /** Timestamp when this student requested a late submission, or null. */
  lateRequestAt?: string | null
  submission: {
    id: string
    status: SubmissionStatus
    text: string
    files: GradedFile[]
    score: number | null
    feedback: string
    submittedAt: string | null
    /** Concurrency token for the grade save — see expectedUpdatedAt in gradeSubmission. */
    updatedAt?: string | null
    rubricScores: string[]
    /** True when the grade was saved while a rubric existed (even with zero criteria ticked);
     *  false/absent = manual score field or a grade that predates the rubric. */
    gradedWithRubric?: boolean
    /** Inline instructor comments saved at grade time, keyed by question index. */
    rubricComments?: Record<string, string> | null
    answers?: VerbalSubmissionAnswer[]
    /** Assessment proctoring summary (advisory); null for non-assessment submissions. */
    proctoring?: ProctoringSummary | null
    snapshots?: ProctoringSnapshotView[]
    /** True when submitted_at > due_at. */
    isLate?: boolean
    /** Professor-granted resubmission window end time, or null. */
    resubmitUntil?: string | null
    /** AI grade suggestion for this submission (professor-only). */
    suggestion?: AiGradeSuggestion
    /** Draft version (suggestion row updated_at) — echoed back on grade save so the server
     *  can prove the professor reviewed THIS draft before capturing correction data. */
    suggestionUpdatedAt?: string
  } | null
  /** True when the submission was graded before a rubric existed (no rubric_scores). */
  gradedByOldRubric?: boolean
  /** True when the stored score now exceeds the assignment total (rubric/points shrunk after grading). */
  scoreExceedsTotal?: boolean
  /** Open regrade request for this submission (null if none). */
  regradeRequest?: {
    id: string
    reason: string
    questions: { index: number; label: string }[]
    oldScore: number | null
    createdAt: string
  } | null
  /** Per-subquestion comment threads on this submission. */
  comments?: SubmissionCommentRow[]
}

export interface GraderSegments {
  needsGrading: StudentEntry[]
  returned: StudentEntry[]
  graded: StudentEntry[]
  notSubmitted: StudentEntry[]
}

type SegmentKey = keyof GraderSegments

const SEGMENT_META: Record<
  SegmentKey,
  { label: string; icon: typeof CircleDashed }
> = {
  needsGrading: { label: 'Needs grading', icon: Clock3 },
  returned: { label: 'Returned', icon: RotateCcw },
  graded: { label: 'Graded', icon: CheckCircle2 },
  notSubmitted: { label: 'Not submitted', icon: CircleDashed },
}

/** Fraction of graded questions the AI must fail to grade for a submission to count as
 *  SEVERE (the loud "requires manual grading" tag + top of the pile). Relative, not an
 *  absolute count — E3: a 1-question essay flags on its one bad answer, while a 20-question
 *  exam needs a real cluster, not a single unmappable part. */
export const MANUAL_GRADING_SEVERE_FRACTION = 1 / 3

/** A criterion worth at least this many points is high-stakes: its AI verdict is withheld
 *  until the professor decides (selective cognitive forcing). Matches the manual-review
 *  sizing philosophy: big binary chunks are where a wrong draft silently costs the most. */
export const HIGH_STAKES_POINTS = 3

/**
 * Criteria whose AI verdict is WITHHELD behind evidence-first review: flagged, part of a
 * low-confidence suggestion, or worth >= HIGH_STAKES_POINTS. These are never pre-ticked;
 * the professor sees the evidence, decides, and may reveal the AI's verdict on demand.
 * Research basis: reviewers approve ~half of wrong AI drafts when the verdict leads
 * (automation bias); showing evidence before the verdict is the validated counter, and
 * applying it selectively keeps the low-stakes fast path fast. Exported for tests.
 */
export function computeWithheldKeys(
  rubric: AssignmentRubric | null,
  suggestion: AiGradeSuggestion | undefined,
): Set<string> {
  const withheld = new Set<string>()
  if (!rubric || !suggestion) return withheld
  for (const c of suggestion.criteria) {
    const [qi, ci] = c.key.split(':').map(Number)
    const criterion = Number.isInteger(qi) && Number.isInteger(ci)
      ? rubric.questions[qi]?.criteria[ci]
      : undefined
    if (!criterion) continue
    if (c.flagged || suggestion.confidence === 'low' || criterion.points >= HIGH_STAKES_POINTS) {
      withheld.add(c.key)
    }
  }
  return withheld
}
export function requiresManualGrading(s: AiGradeSuggestion, gradedQuestionCount: number): boolean {
  const manual = s.unmappedQuestionIndexes?.length ?? 0
  const threshold = Math.max(1, Math.ceil(gradedQuestionCount * MANUAL_GRADING_SEVERE_FRACTION))
  return manual >= threshold
}

/**
 * Stable-sort the "needs grading" entries so the professor sees the most attention-worthy
 * submissions first:
 *  0. Requires manual grading (severe) — the AI can't be trusted here, hand-grade it
 *  1. Flagged suggestions (low confidence or flagged_count > 0) — needs careful review
 *  2. Unflagged suggestions — has an AI suggestion but looks clean
 *  3. No suggestion — grade manually with no AI help
 *
 * Exported so it can be reused or tested independently.
 */
export function orderForReview(entries: StudentEntry[], gradedQuestionCount: number): StudentEntry[] {
  return [...entries].sort((a, b) => {
    const rankEntry = (e: StudentEntry): number => {
      const s = e.submission?.suggestion
      if (!s) return 3
      if (requiresManualGrading(s, gradedQuestionCount)) return 0
      if (s.flaggedCount > 0 || s.confidence === 'low') return 1
      return 2
    }
    return rankEntry(a) - rankEntry(b)
  })
}

interface ProfessorAssignmentGraderProps {
  sectionId: string
  assignmentId: string
  points: number
  segments: GraderSegments
  /** false ⇒ ungraded: show Submitted/Not submitted, no score form. */
  isGraded?: boolean
  /** True when due_at is set and now > due_at. Enables "Reopen for 24h" button. */
  isPastDue?: boolean
  /** Saved rubric, shown beside the submission while grading. */
  rubric?: AssignmentRubric | null
  /** Link to the studio so the professor can add a rubric when none exists. */
  studioPath?: string
  /** True when the assignment's AI grading reference index is ready. */
  aiGradingReady?: boolean
  /** True when grades are released to students — lowering a released grade asks for confirmation. */
  gradesPublished?: boolean
  /** True for timed/proctored assessments. Only these WIPE the submission on reopen; a
   *  non-assessment reopen just stamps a resubmit window, so the confirm copy differs. */
  isAssessment?: boolean
  /** AI-vs-professor agreement so far on this assignment (calibration telemetry). */
  aiAgreement?: { total: number; agreed: number; aiHigher: number; aiLower: number }
}

export function ProfessorAssignmentGrader({
  sectionId,
  assignmentId,
  points,
  segments,
  isGraded = true,
  isPastDue = false,
  rubric = null,
  studioPath,
  aiGradingReady = false,
  gradesPublished = false,
  isAssessment = false,
  aiAgreement,
}: ProfessorAssignmentGraderProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Streaming bulk suggest state.
  const [isBulkStreaming, setIsBulkStreaming] = useState(false)
  const [bulkSuggestedCount, setBulkSuggestedCount] = useState(0)
  const bulkGuard = useRef(false)

  // Live suggestions merged from the stream, keyed by submissionId. The version
  // (suggestion updated_at) rides along so a grade saved from a live panel can echo it.
  const [streamedSuggestions, setStreamedSuggestions] = useState<
    Record<string, { suggestion: AiGradeSuggestion; suggestionUpdatedAt?: string }>
  >({})

  // Merge streamed suggestions into each segment entry so panels pre-fill live.
  const segmentsWithSuggestions = useMemo(() => {
    if (Object.keys(streamedSuggestions).length === 0) return segments
    function mergeEntry(entry: StudentEntry): StudentEntry {
      if (!entry.submission) return entry
      const live = streamedSuggestions[entry.submission.id]
      if (!live) return entry
      return {
        ...entry,
        submission: {
          ...entry.submission,
          suggestion: live.suggestion,
          suggestionUpdatedAt: live.suggestionUpdatedAt,
        },
      }
    }
    return {
      needsGrading: segments.needsGrading.map(mergeEntry),
      returned: segments.returned.map(mergeEntry),
      graded: segments.graded.map(mergeEntry),
      notSubmitted: segments.notSubmitted,
    }
  }, [segments, streamedSuggestions])

  async function handleBulkSuggest() {
    if (bulkGuard.current) return
    bulkGuard.current = true
    setIsBulkStreaming(true)
    setBulkSuggestedCount(0)

    try {
      const res = await fetch('/api/assignments/ai-suggest-stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sectionId, assignmentId }),
      })

      if (!res.ok) {
        toast.error('Could not start AI grading. Please try again.')
        return
      }

      if (!res.body) {
        toast.error('No response stream. Please try again.')
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // Keep any incomplete trailing line in the buffer.
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          let event: {
            type: string
            message?: string
            submissionId?: string
            suggestion?: AiGradeSuggestion
            suggestionUpdatedAt?: string
            count?: number
            skipped?: number
            reason?: string
          }
          try {
            event = JSON.parse(trimmed) as typeof event
          } catch {
            continue
          }

          if (event.type === 'suggestion' && event.submissionId && event.suggestion) {
            const sid = event.submissionId
            const s = event.suggestion
            const v = event.suggestionUpdatedAt
            setStreamedSuggestions((prev) => ({
              ...prev,
              [sid]: { suggestion: s, suggestionUpdatedAt: v },
            }))
            setBulkSuggestedCount((n) => n + 1)
          } else if (event.type === 'done') {
            const count = event.count ?? 0
            const skipped = event.skipped ?? 0
            // E9: report drops honestly — "27 of 30, 3 couldn't be graded" is not the
            // same as 27 students who never submitted.
            toast.success(
              `Suggested ${count} grade${count === 1 ? '' : 's'}` +
                (skipped > 0 ? `. ${skipped} couldn't be graded — grade those by hand.` : ''),
            )
            router.refresh()
          } else if (event.type === 'error' && event.message) {
            toast.error(event.message)
          }
        }
      }
    } catch (err) {
      toast.error('AI grading failed. Please try again.')
      // err is only logged server-side; no stack trace to client
      void err
    } finally {
      bulkGuard.current = false
      setIsBulkStreaming(false)
    }
  }

  // Ungraded assignments never enter the grading queue — collapse the four buckets to
  // "Submitted" (the needsGrading set, since ungraded submissions stay 'submitted') and
  // "Not submitted", and relabel accordingly.
  const visibleSegments: SegmentKey[] = isGraded
    ? (Object.keys(SEGMENT_META) as SegmentKey[])
    : ['needsGrading', 'notSubmitted']
  // A graded student with an open regrade is surfaced in the "returned" bucket — relabel it so
  // the professor knows the bucket now also holds appeals to action.
  const hasOpenRegrade = segmentsWithSuggestions.returned.some((e) => !!e.regradeRequest)
  const segmentLabel = (key: SegmentKey) =>
    !isGraded && key === 'needsGrading'
      ? 'Submitted'
      : key === 'returned' && hasOpenRegrade
        ? 'Returned & regrades'
        : SEGMENT_META[key].label

  // Default to the actionable bucket if it has anyone, else the first non-empty.
  const initialSegment: SegmentKey =
    segments.needsGrading.length > 0
      ? 'needsGrading'
      : segments.returned.length > 0
        ? 'returned'
        : segments.graded.length > 0
          ? 'graded'
          : 'notSubmitted'
  const [segment, setSegment] = useState<SegmentKey>(initialSegment)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Once a student is selected the roster shrinks to an avatar rail; hovering it expands.
  const [rosterExpanded, setRosterExpanded] = useState(false)

  // Graded-question count drives the relative "requires manual grading" threshold (E3).
  const gradedQuestionCount = useMemo(
    () => rubric?.questions.filter((q) => q.graded !== false).length ?? 0,
    [rubric],
  )

  // Apply flagged-first ordering to the "needs grading" bucket; other buckets keep stable order.
  const list = useMemo(
    () =>
      segment === 'needsGrading'
        ? orderForReview(segmentsWithSuggestions[segment], gradedQuestionCount)
        : segmentsWithSuggestions[segment],
    [segment, segmentsWithSuggestions, gradedQuestionCount],
  )
  const selected = useMemo(
    () => list.find((s) => s.id === selectedId) ?? null,
    [list, selectedId],
  )

  // Keep the grade surface active on the grading tab even before a student is
  // picked, so Athena shows its "Summaries & feedback · never grades" subtitle
  // (not the create one) throughout grading. Once a student is selected,
  // GradePanel re-registers on top with the actual submission. There's nothing
  // to fill without a selection, so a fill is declined honestly (applied:false).
  useAthenaSurface({
    active: !selected,
    surface: 'grade',
    assignmentId,
    getScreen: () => ({ grade: {} }),
    onFill: () => ({
      summary: 'Pick a student’s submission first, then I can summarize it or draft feedback.',
      applied: false,
    }),
  })

  function pickSegment(key: SegmentKey) {
    setSegment(key)
    setSelectedId(null)
  }

  return (
    <div className="space-y-4">
      {/* Athena is reachable here at all only because of this. The grade surface registers
          its own tools (summarize_submission, fill_feedback) but rendered no trigger, so
          unless the professor happened to leave the dock open on a previous screen the whole
          grading assistant was unreachable. */}
      <AthenaAskLine />
      {/* Segment tabs + bulk AI suggest */}
      <div className="flex flex-wrap items-center gap-2">
        {visibleSegments.map((key) => {
          const meta = SEGMENT_META[key]
          const Icon = meta.icon
          const count = segmentsWithSuggestions[key].length
          const active = segment === key
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              onClick={() => pickSegment(key)}
              className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-card text-muted-foreground hover:bg-muted/50'
              }`}
            >
              <Icon className="h-4 w-4" />
              {segmentLabel(key)}
              <span
                className={`rounded-full px-1.5 text-xs tabular-nums ${
                  active ? 'bg-primary-foreground/20' : 'bg-muted'
                }`}
              >
                {count}
              </span>
            </button>
          )
        })}
        {aiGradingReady && isGraded && segments.needsGrading.length > 0 && (
          <button
            type="button"
            onClick={handleBulkSuggest}
            disabled={isBulkStreaming}
            className="ml-auto inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Bot className="h-4 w-4" />
            {isBulkStreaming
              ? `Suggested ${bulkSuggestedCount} of ${segments.needsGrading.length}...`
              : 'Suggest for whole class'}
          </button>
        )}
      </div>

      {/* Whole-class drafting loader — same treatment as the rubric editor, but with
          REAL progress since the stream reports one suggestion per student. */}
      <GenerationProgress
        active={isBulkStreaming}
        value={
          segments.needsGrading.length > 0
            ? (bulkSuggestedCount / segments.needsGrading.length) * 100
            : undefined
        }
        message="Drafting grades for the class. Nothing is sent to students until you review and publish."
        aria-label="Whole-class grading progress"
      />

      {/* Master–detail */}
      <div className="flex gap-4">
        {/* Roster list — once a student is selected it collapses to an avatar rail on desktop,
            expanding back to full names/emails while the pointer hovers over it. */}
        {(() => {
          const showNames = !selected || rosterExpanded
          return (
            <div
              onMouseEnter={() => setRosterExpanded(true)}
              onMouseLeave={() => setRosterExpanded(false)}
              onFocus={() => setRosterExpanded(true)}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setRosterExpanded(false)
              }}
              className={cn(
                'shrink-0',
                selected
                  ? cn('hidden transition-[width] duration-200 md:block', rosterExpanded ? 'w-72' : 'w-16')
                  : 'w-full md:w-[280px]',
              )}
            >
              {list.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                  No students here.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {list.map((s) => {
                    const isSel = s.id === selectedId
                    return (
                      <li key={s.id}>
                        <button
                          onClick={() => setSelectedId(s.id)}
                          title={s.name}
                          aria-label={s.name}
                          className={cn(
                            'flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors',
                            !showNames && 'justify-center',
                            isSel
                              ? 'border-primary bg-primary/5'
                              : 'border-border bg-card hover:bg-muted/50',
                          )}
                        >
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground">
                            {s.name.slice(0, 1).toUpperCase()}
                          </div>
                          {showNames && (
                            <>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <p className="truncate text-sm font-medium text-foreground">{s.name}</p>
                                  {s.submission?.isLate && (
                                    <LateBadge />
                                  )}
                                  {s.lateRequestAt && !s.submission?.submittedAt && (
                                    <LateRequestBadge />
                                  )}
                                  {s.submission?.suggestion &&
                                    (requiresManualGrading(s.submission.suggestion, gradedQuestionCount) ? (
                                      // Severe: the loud tag owns the card; suppress the redundant confidence chip.
                                      <ManualGradingBadge />
                                    ) : (
                                      // Otherwise show confidence only when it's worth attention (medium/low).
                                      s.submission.suggestion.confidence !== 'high' && (
                                        <ConfidenceBadge confidence={s.submission.suggestion.confidence} />
                                      )
                                    ))}
                                  {s.gradedByOldRubric && (
                                    <Badge variant="outline" className="shrink-0 text-xs">Graded by old rubric</Badge>
                                  )}
                                  {s.scoreExceedsTotal && (
                                    <Badge variant="outline" className="shrink-0 text-xs">Score over new total</Badge>
                                  )}
                                </div>
                                <p className="truncate text-xs text-muted-foreground">{s.email}</p>
                                {s.submission?.proctoring && (
                                  <span className="mt-1 inline-flex"><ProctoringBadge summary={s.submission.proctoring} /></span>
                                )}
                              </div>
                              {s.submission?.score != null && (
                                <span className="shrink-0 text-xs font-semibold tabular-nums text-primary">
                                  {s.submission.score}/{points}
                                </span>
                              )}
                            </>
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })()}

        {/* Detail panel */}
        <div className={cn('min-w-0 flex-1', selected ? '' : 'hidden md:block')}>
          {selected ? (
            <GradePanel
              key={selected.id}
              sectionId={sectionId}
              assignmentId={assignmentId}
              points={points}
              entry={selected}
              isGraded={isGraded}
              isPastDue={isPastDue}
              rubric={rubric}
              studioPath={studioPath}
              aiGradingReady={aiGradingReady}
              aiAgreement={aiAgreement}
              gradesPublished={gradesPublished}
              isAssessment={isAssessment}
              isPending={isPending}
              onBack={() => setSelectedId(null)}
              onSaved={() => router.refresh()}
              startTransition={startTransition}
            />
          ) : (
            <div className="flex h-full min-h-48 items-center justify-center rounded-2xl border border-dashed border-border p-8 text-center">
              <p className="text-sm text-muted-foreground">
                Select a student to review their submission.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function GradePanel({
  sectionId,
  assignmentId,
  points,
  entry,
  isGraded,
  isPastDue,
  rubric,
  studioPath,
  aiGradingReady,
  aiAgreement,
  gradesPublished,
  isAssessment,
  isPending,
  onBack,
  onSaved,
  startTransition,
}: {
  sectionId: string
  assignmentId: string
  points: number
  entry: StudentEntry
  isGraded: boolean
  isPastDue: boolean
  rubric: AssignmentRubric | null
  studioPath?: string
  aiGradingReady: boolean
  aiAgreement?: { total: number; agreed: number; aiHigher: number; aiLower: number }
  gradesPublished: boolean
  isAssessment: boolean
  isPending: boolean
  onBack: () => void
  onSaved: () => void
  startTransition: (cb: () => void) => void
}) {
  // GradePanel is keyed by student id in the parent, so it remounts per
  // selection — these initializers run fresh each time; no sync effect needed.
  const sub = entry.submission

  // Track the live suggestion: prefer fresh data returned from suggestGrades over the
  // page-load / streamed prop. Falls through to the prop so a bulk-streamed suggestion
  // arriving while this panel is open still shows.
  const [liveSuggestion, setLiveSuggestion] = useState<AiGradeSuggestion | undefined>(
    sub?.suggestion,
  )
  const suggestion = liveSuggestion ?? sub?.suggestion
  // The draft version the professor is reviewing — echoed back on save so correction
  // capture can prove the committed decisions were made against THIS draft.
  const [liveSuggestionVersion, setLiveSuggestionVersion] = useState<string | undefined>(
    sub?.suggestionUpdatedAt,
  )
  const suggestionVersion = liveSuggestionVersion ?? sub?.suggestionUpdatedAt

  const [score, setScore] = useState(sub?.score != null ? String(sub.score) : '')
  // Feedback pre-fills from the AI draft on a page-loaded suggestion too (not only after an
  // in-panel Suggest click) — the bulk-suggest-then-review flow otherwise never shows the
  // draft. Saved feedback always wins, and the box is never overwritten once non-empty.
  const [feedback, setFeedback] = useState(() => {
    if (sub?.feedback) return sub.feedback
    if (sub && sub.score == null && sub.suggestion?.feedback) return sub.suggestion.feedback
    return ''
  })

  // The stored score came from the MANUAL field, not ticked criteria: a rubric exists, the score is
  // positive, and no criteria are ticked. This is true for BOTH a pre-rubric grade AND a later
  // "Keep this score" (which stamps graded_with_rubric=true with empty rubric_scores) — so it does
  // NOT key off gradedWithRubric. In both, the grader must re-render the keep/re-grade choice and
  // treat the score as manual; otherwise a feedback-only Save resolves to rubricTotal=0 and silently
  // zeroes the kept grade. A genuine rubric 0 (0 ticks, score 0) is excluded, since re-resolving it
  // to 0 loses nothing.
  const scoreFromManualField =
    !!rubric && (sub?.score ?? 0) > 0 && (sub?.rubricScores?.length ?? 0) === 0

  // The saved ticks no longer line up with the rubric. Ticks are stored as POSITIONAL keys
  // ("<qIdx>:<cIdx>"), and the rubric editor deletes questions/criteria by filtering — which
  // reindexes everything after the deleted entry. So an edit after grading can silently re-point
  // or orphan a student's ticks, and the next save of any kind would resolve to a different (often
  // 0) score with no warning. Detect it and fall back to the same explicit Keep / re-grade choice
  // used for pre-rubric grades, so the professor decides instead of losing the grade silently.
  const rubricTicksStale =
    !!rubric &&
    (sub?.rubricScores?.length ?? 0) > 0 &&
    (sub?.rubricScores ?? []).some((key) => {
      const [qi, ci] = key.split(':').map(Number)
      return !Number.isInteger(qi) || !Number.isInteger(ci) || !rubric.questions[qi]?.criteria[ci]
    })

  // A returned submission is waiting on the student — every grade-mutating affordance is hidden
  // until they resubmit. gradeSubmission has no status precondition, so leaving any save control
  // (including "Keep this score") reachable here would flip the row back to `graded` and silently
  // cancel the change request the student was asked to act on.
  const isReturned = sub?.status === 'returned'

  // Show the explicit choice for a pre-rubric grade OR a grade whose ticks the rubric no longer
  // matches. Never while the submission is returned.
  const needsGradeChoice = !isReturned && (scoreFromManualField || rubricTicksStale)

  // Reopen is offered when the assignment is past its global due date, a reopen window is already
  // active, OR the student has a completed attempt (submitted/graded). The last case matters for
  // timed assessments: their window is per-student and closes minutes after the student starts, so
  // gating on the global due_at alone would hide Reopen for exactly the student who needs it.
  const canReopen =
    !sub || // a student who never submitted — offer a late-attempt window
    isPastDue ||
    isReopenWindowActive(sub?.resubmitUntil) ||
    sub?.status === 'draft' || // started-but-abandoned attempt
    sub?.status === 'submitted' ||
    sub?.status === 'graded'

  // What a reopen actually does, so the confirm dialog tells the truth per case:
  //  - assessment            → wipes the attempt (files + grade), unrecoverable → destructive
  //  - graded, never submitted → a placeholder grade (auto-zero / direct grade); reopen clears it,
  //                              which is the professor's intent, and there's no submitted work to lose
  //  - real submission        → reopen only opens a resubmit window; submission + grade are preserved
  //  - never submitted        → just opens a submission window
  const reopenCopy = isAssessment
    ? {
        title: 'Reopen this assessment?',
        description: `This deletes ${entry.name}'s attempt (files and grade) and lets them start over. This can't be undone.`,
        destructive: true,
        action: 'Reopen and delete attempt',
      }
    : sub?.status === 'graded' && !sub?.submittedAt
      ? {
          title: 'Reopen this submission?',
          description: `This clears the grade you entered so ${entry.name} can submit their work. There's no submitted work to lose.`,
          destructive: false,
          action: 'Clear grade and reopen',
        }
      : sub?.submittedAt
        ? {
            title: 'Reopen this submission?',
            description: `This lets ${entry.name} submit again. Their current submission and grade stay in place until they resubmit.`,
            destructive: false,
            action: 'Reopen for resubmission',
          }
        : {
            title: 'Reopen this submission?',
            description: `This lets ${entry.name} submit this assignment.`,
            destructive: false,
            action: 'Reopen for submission',
          }

  // Athena (grade surface): snapshot the on-screen grading state (submissionId
  // lets summarize_submission load the work server-side; the rest is context).
  // NOTE: the score is sent as read-only context — Athena never sets it.
  const getGradeScreen = useCallback(
    (): AssignmentScreen => ({
      grade: {
        submissionId: sub?.id,
        studentName: entry.name,
        points,
        hasRubric: !!rubric,
        currentScore: score || undefined,
        currentFeedback: feedback ? feedback.slice(0, 2000) : undefined,
      },
    }),
    [sub?.id, entry.name, points, rubric, score, feedback],
  )

  // Only fill_feedback reaches here (the grade surface exposes no score tool).
  // Fills the feedback box; the score field is never touched.
  const onFillFeedback = useCallback(
    (_tool: AssignmentFillTool, payload: unknown): FillResult => {
      const before = feedback
      /* Athena writes state directly, so the textarea's maxLength does not apply here — an
         over-long draft would sail through and then be rejected by the schema at save time
         (#611). Truncate at the same ceiling and say so, rather than handing back feedback
         that cannot be saved. */
      const drafted = (payload as FillFeedback).feedback ?? ''
      const truncated = drafted.length > MAX_GRADE_FEEDBACK_LENGTH
      setFeedback(truncated ? drafted.slice(0, MAX_GRADE_FEEDBACK_LENGTH) : drafted)
      return {
        summary: truncated
          ? `Drafted feedback, trimmed to the ${MAX_GRADE_FEEDBACK_LENGTH.toLocaleString()}-character limit — review, edit, and set the score yourself`
          : 'Drafted feedback — review, edit, and set the score yourself',
        undo: () => setFeedback(before),
      }
    },
    [feedback],
  )

  // Register this submission as Athena's active surface while it's shown.
  useAthenaSurface({
    active: !!sub,
    surface: 'grade',
    assignmentId,
    getScreen: getGradeScreen,
    onFill: onFillFeedback,
  })
  // Track whether the professor has manually edited the criteria (disables auto-apply).
  const [professorEdited, setProfessorEdited] = useState(false)

  // High-stakes criteria whose AI verdict is withheld (evidence-first forcing). Derived,
  // not state: a suggestion can arrive after mount (bulk stream) and this must follow it.
  const withheldKeys = useMemo(
    () => computeWithheldKeys(rubric, suggestion),
    [rubric, suggestion],
  )
  // Forcing applies only while drafting a fresh grade against a live suggestion. Graded,
  // returned, and no-suggestion flows are untouched.
  const forcingActive = !!rubric && !!suggestion && sub != null && sub.score == null
  // Withheld criteria the professor has resolved — by ticking (award) or explicit no-credit.
  const [decidedKeys, setDecidedKeys] = useState<Set<string>>(new Set())
  // Withheld criteria whose AI verdict the professor asked to see. Revealing shows the
  // verdict + rationale ONLY — it never applies the tick (reveal-then-rubber-stamp guard).
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set())

  // Evidence highlighting: locate each criterion's verbatim quote in the typed response.
  // Unlocated evidence (from uploaded files) degrades to a non-clickable quote chip.
  const [activeEvidenceKey, setActiveEvidenceKey] = useState<string | null>(null)
  const subText = sub?.text ?? ''
  const evidenceRanges = useMemo(
    () => (subText && suggestion ? computeEvidenceRanges(subText, suggestion.criteria) : []),
    [subText, suggestion],
  )
  const locatedEvidenceKeys = useMemo(
    () => new Set(evidenceRanges.map((r) => r.key)),
    [evidenceRanges],
  )
  function focusEvidence(key: string) {
    setActiveEvidenceKey(key)
    // Scroll-to-highlight only on the two-column layout (lg+): below it the rubric stacks
    // under the submission, so centering the mark would fling the professor away from the
    // criterion they're deciding. The highlight itself still marks on mobile.
    if (window.matchMedia('(min-width: 1024px)').matches) {
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      document
        .getElementById(evidenceMarkId(key))
        ?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' })
    }
  }

  // Ticked rubric criteria ("<qIdx>:<cIdx>") — restored from the saved grade.
  // When no saved grade exists and a suggestion is present, pre-fill from the suggestion —
  // MINUS withheld criteria, which start undecided (never pre-ticked).
  const [selected, setSelected] = useState<Set<string>>(() => {
    if (sub?.score != null) {
      // Already graded — restore the saved ticks
      return new Set(sub.rubricScores ?? [])
    }
    if (suggestion) {
      const withheld = computeWithheldKeys(rubric, suggestion)
      return new Set(suggestion.suggestedRubricScores.filter((k) => !withheld.has(k)))
    }
    return new Set(sub?.rubricScores ?? [])
  })
  // Per-question inline comments saved with the grade.
  const [rubricCommentDraft, setRubricCommentDraft] = useState<Record<string, string>>(
    () => sub?.rubricComments ?? {},
  )

  function updateRubricComment(qi: number, value: string) {
    setRubricCommentDraft((prev) => ({ ...prev, [String(qi)]: value }))
  }

  // When a rubric exists, the score IS the sum of the ticked criteria's points.
  const rubricTotal = useMemo(() => {
    if (!rubric) return 0
    let t = 0
    rubric.questions.forEach((q, qi) =>
      q.criteria.forEach((c, ci) => {
        if (selected.has(`${qi}:${ci}`)) t += c.points
      }),
    )
    return Math.round(t * 100) / 100
  }, [rubric, selected])

  // Pre-rubric submissions offer an explicit choice (Keep score / Grade with the rubric); this flips
  // true once the professor picks the rubric, so a stray tick can't silently overwrite the old score.
  const [pickedRubricMode, setPickedRubricMode] = useState(false)

  /** Enter rubric grading from the Keep/re-grade choice. Clears any saved ticks first: when the
   *  choice appeared BECAUSE the rubric changed, those ticks are positional keys pointing at
   *  criteria that have shifted, so carrying them in would pre-tick the wrong rows and show a
   *  running total the professor never chose. Re-grading starts from a clean slate. */
  function switchToRubricGrading() {
    if (rubricTicksStale) setSelected(new Set())
    setPickedRubricMode(true)
  }

  function toggle(key: string) {
    setProfessorEdited(true)
    // Ticking (either way) IS a decision for a withheld criterion.
    setDecidedKeys((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** Explicit "no credit" decision on a withheld criterion — same one-click cost as
   *  awarding (symmetric effort), so deciding against is never harder than accepting. */
  function decideNoCredit(key: string) {
    setProfessorEdited(true)
    setDecidedKeys((prev) => new Set(prev).add(key))
    setSelected((prev) => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }

  /** Show a withheld criterion's AI verdict. Display only — never applies the tick. */
  function revealVerdict(key: string) {
    setRevealedKeys((prev) => new Set(prev).add(key))
  }

  // Withheld criteria still awaiting a decision. Gates Save while forcing is active so a
  // half-reviewed draft can't be committed as a finished grade (the partial-grade trap).
  const undecidedCount = forcingActive
    ? Array.from(withheldKeys).filter((k) => !decidedKeys.has(k)).length
    : 0

  // ── AI Suggest ────────────────────────────────────────────────────────────
  const [isSuggestPending, startSuggestTransition] = useTransition()

  function applyPreFill(s: AiGradeSuggestion, version?: string) {
    setLiveSuggestion(s)
    setLiveSuggestionVersion(version)
    // A fresh draft restarts the review: prior reveals/decisions were about the old draft.
    setDecidedKeys(new Set())
    setRevealedKeys(new Set())
    if (!professorEdited) {
      const withheld = computeWithheldKeys(rubric, s)
      setSelected(new Set(s.suggestedRubricScores.filter((k) => !withheld.has(k))))
    }
    // Only pre-fill feedback when the box is currently empty
    if (!feedback.trim()) {
      setFeedback(s.feedback)
    }
  }

  function handleSuggest() {
    if (!sub) return
    startSuggestTransition(async () => {
      const result = await suggestGrades(sectionId, sub.id)
      if ('error' in result) {
        toast.error(result.error)
      } else {
        applyPreFill(result.suggestion, result.suggestionUpdatedAt)
        toast.success('AI suggestion applied. Review every line before saving.')
      }
    })
  }

  // Show the Suggest button when: AI is ready, there's a submission, it's graded, and unscored.
  const showSuggestButton =
    aiGradingReady && isGraded && sub != null && sub.score == null

  // A save that would LOWER an already-released grade awaits confirmation here.
  const [pendingLower, setPendingLower] = useState<{ value: number; resolveRegrade: boolean } | null>(null)

  // Reopen confirmation: holds the chosen window until the professor confirms.
  const [pendingReopen, setPendingReopen] = useState<{ hours: number } | { until: string } | undefined>(undefined)
  const [reopenDialogOpen, setReopenDialogOpen] = useState(false)

  // True when the save comes from the manual score field: no rubric at all, or a pre-rubric
  // submission where the professor chose "Keep this score" (hasn't switched to rubric grading).
  // Manual saves send rubricScores: undefined.
  const usesManualField = !rubric || (needsGradeChoice && !pickedRubricMode)

  /** Validate the pending grade; returns the score to save, or null after showing a toast. */
  function resolveValidatedValue(): number | null {
    const value = resolveGradeValue({
      useManualField: usesManualField,
      manualScore: Number(score),
      rubricTotal,
    })
    if (usesManualField && score === '') {
      toast.error(`Enter a score between 0 and ${points}.`)
      return null
    }
    if (Number.isNaN(value) || value < 0 || value > points) {
      toast.error(`Score must be between 0 and ${points}.`)
      return null
    }
    return value
  }

  /** Commit the grade (and optionally resolve the open regrade after it succeeds). */
  function commit(value: number, resolveRegrade: boolean) {
    if (!sub) return
    startTransition(async () => {
      const graded = await gradeSubmission(sectionId, {
        submissionId: sub.id,
        score: value,
        feedback,
        /* The row as THIS page saw it. Without it the server cannot tell a first grade from
           one that silently overwrites a colleague's — its own read would already be fresh. */
        expectedUpdatedAt: sub.updatedAt ?? undefined,
        // Keeping a score against a rubric whose shape changed must CLEAR the stale positional
        // keys, not leave them: sending undefined leaves rubric_scores as-is, every other field
        // already matches, so gradeSubmission's no-op guard writes nothing — and the professor is
        // re-asked "the rubric changed…" on every visit, forever. An empty array is a real change,
        // and it resolves the row to the ordinary kept-manual-score state.
        rubricScores: rubric && !usesManualField ? [...selected] : rubricTicksStale ? [] : undefined,
        rubricComments: rubric ? rubricCommentDraft : undefined,
        /* The AI draft version this review was made against — lets the server capture the
           criterion-level correction diff, and skip capture if the draft was re-generated
           since (ghost-diff guard). Sent only when a suggestion was actually shown. */
        suggestionUpdatedAt: suggestion ? suggestionVersion : undefined,
      })
      if ('error' in graded) {
        /* The conflict message asks the grader to rescue their feedback before reloading —
           that is unreadable-and-actionable in sonner's ~4s default, so give it room. */
        toast.error(graded.error, {
          duration: graded.error === GRADE_CONFLICT_MESSAGE ? 12000 : undefined,
        })
        return
      }
      if (resolveRegrade && entry.regradeRequest) {
        // The current feedback rides along as the resolution note the student sees.
        const resolved = await resolveRegradeRequest(sectionId, entry.regradeRequest.id, feedback)
        if ('error' in resolved) {
          toast.error(resolved.error)
          return
        }
        toast.success('Regrade resolved')
      } else {
        toast.success('Grade saved')
      }
      onSaved()
    })
  }

  /** Save entry point (also used for save-and-resolve on regrades): validates, then either
   *  commits or, when lowering a grade the student can already see, asks for confirmation. */
  function requestSave(resolveRegrade: boolean) {
    if (!sub) return
    // Evidence-first forcing: every withheld criterion needs an explicit decision before a
    // grade can be saved (the Save button is already disabled; this is the belt to its
    // braces for keyboard/programmatic paths).
    if (undecidedCount > 0) {
      toast.error(
        `${undecidedCount} ${undecidedCount === 1 ? 'criterion is' : 'criteria are'} awaiting your judgment — decide each one first.`,
      )
      return
    }
    const value = resolveValidatedValue()
    if (value == null) return
    if (gradesPublished && sub.score != null && value < sub.score) {
      setPendingLower({ value, resolveRegrade })
      return
    }
    commit(value, resolveRegrade)
  }

  const save = () => requestSave(false)
  // Regrade submissions: the primary grade button commits the grade AND closes the
  // appeal in one action — grade first, resolve only if the grade succeeds.
  const saveAndResolve = () => requestSave(true)

  function sendBack() {
    if (!sub) return
    startTransition(async () => {
      const result = await requestChanges(sectionId, sub.id, feedback)
      if ('error' in result) toast.error(result.error)
      else {
        toast.success('Sent back to the student for changes')
        onSaved()
      }
    })
  }

  const hasOpenRegrade = !!entry.regradeRequest

  function saveNonSubmitter() {
    // The non-submitter panel only shows the numeric Score field (no rubric selector, since
    // there is no work to grade against), so always grade by the typed score.
    if (score === '') {
      toast.error(`Enter a score between 0 and ${points}.`)
      return
    }
    const value = Number(score)
    if (Number.isNaN(value) || value < 0 || value > points) {
      toast.error(`Score must be between 0 and ${points}.`)
      return
    }
    startTransition(async () => {
      const result = await gradeStudent(sectionId, assignmentId, entry.id, {
        score: value,
        feedback,
      })
      if ('error' in result) toast.error(result.error)
      else {
        toast.success('Grade saved')
        onSaved()
      }
    })
  }

  function reopen(window?: { hours: number } | { until: string }) {
    // Confirm before executing. For an assessment this wipes the attempt (unrecoverable); for a
    // non-assessment it only opens a resubmit window — the dialog copy reflects which.
    setPendingReopen(window)
    setReopenDialogOpen(true)
  }

  function confirmReopen() {
    const window = pendingReopen
    setReopenDialogOpen(false)
    setPendingReopen(undefined)
    startTransition(async () => {
      const result = await reopenSubmission(sectionId, assignmentId, entry.id, window)
      if ('error' in result) {
        toast.error(result.error)
      } else {
        const untilDate = window && 'until' in window
          ? new Date(window.until).toLocaleString()
          : window && 'hours' in window
            ? new Date(Date.now() + window.hours * 3600000).toLocaleString()
            : new Date(Date.now() + 86400000).toLocaleString()
        toast.success(`Reopened until ${untilDate}`)
        onSaved()
      }
    })
  }

  return (
    // max-md:pb-28 — on mobile the Ask-Athena pill floats fixed over the bottom of the
    // viewport (bottom-12, z-40) and swallowed taps on the Save-gating decision buttons
    // (runtime-qa 🟠). Bottom clearance lets every control scroll above the pill.
    <div className="rounded-2xl border border-border bg-card p-5 max-md:pb-28">
      <div className="mb-4 flex items-center gap-3">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="truncate font-medium text-foreground">{entry.name}</p>
            {sub?.isLate && <LateBadge />}
            {entry.lateRequestAt && !sub?.submittedAt && <LateRequestBadge />}
          </div>
          <p className="truncate text-xs text-muted-foreground">{entry.email}</p>
        </div>
        {sub?.submittedAt && (
          <span className="ml-auto text-xs text-muted-foreground">
            Submitted {new Date(sub.submittedAt).toLocaleDateString()}
          </span>
        )}
      </div>
      {!sub ? (
        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/40 p-3 text-sm">
            <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">
              This student hasn&rsquo;t submitted. You can record a score without a submission, or reopen it for a late attempt.
            </span>
          </div>
          {isGraded && (
            <div className="border-t border-border pt-4 space-y-4">
              <GradeControls
                showScore
                score={score}
                setScore={setScore}
                points={points}
                feedback={feedback}
                setFeedback={setFeedback}
                isPending={isPending}
                alreadyGraded={false}
                hasOpenRegrade={false}
                onSave={saveNonSubmitter}
                onSendBack={() => undefined}
                hideSendBack
              />
            </div>
          )}
          {canReopen && (
            <div className="flex justify-end">
              <ReopenControl onReopen={reopen} disabled={isPending} />
            </div>
          )}
        </div>
      ) : (
        <>
        <div className={rubric ? 'grid gap-5 lg:grid-cols-[1fr_20rem]' : 'space-y-5'}>
          {/* Submission — rendered inline so the rubric stays in view while grading. */}
          <div className="min-w-0 space-y-5">
            {entry.regradeRequest && (
              <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 font-medium text-foreground">
                    <MessageSquareWarning className="h-4 w-4 text-primary" />
                    Regrade requested
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {entry.regradeRequest.questions.length > 0
                      ? `Questions: ${entry.regradeRequest.questions.map((q) => q.label).join(', ')}`
                      : 'Whole submission'}
                    {entry.regradeRequest.oldScore != null && ` · was ${entry.regradeRequest.oldScore} / ${points}`}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-foreground">{entry.regradeRequest.reason}</p>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Adjust the grade if needed, then use the &ldquo;Mark resolved&rdquo; button below. The student is notified with your feedback.
                </p>
              </div>
            )}
            {entry.scoreExceedsTotal && (
              <div className="rounded-xl border border-warning/30 bg-warning-muted p-4 text-sm text-warning-muted-foreground">
                <p className="flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="h-4 w-4" />
                  Score above the current total
                </p>
                <p className="mt-1">
                  This was scored {sub.score}, above the assignment&apos;s current total of {points} (the rubric or points was reduced after grading). Re-grade to bring it within range.
                </p>
              </div>
            )}
            {sub.status === 'returned' && (
              <div className="rounded-xl border border-border bg-muted/40 p-4 text-sm">
                <p className="font-medium text-foreground">
                  Changes requested — waiting for the student to resubmit.
                </p>
                {sub.feedback && (
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{sub.feedback}</p>
                )}
              </div>
            )}
            {sub.answers && sub.answers.length > 0 ? (
              <VerbalSubmissionReview videoUrl={sub.files[0]?.url ?? null} answers={sub.answers} />
            ) : (
              <>
                {sub.files.length > 0 && <InlineSubmission submissionId={sub.id} files={sub.files} />}
                {sub.text && (
                  <div className="rounded-xl border border-border bg-muted/20 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Written response
                    </p>
                    {/* Criterion-tagged evidence highlights (text nodes only — student-authored
                        content must never pass through HTML). Renders plain when no evidence. */}
                    <EvidenceHighlightedText
                      text={sub.text}
                      ranges={evidenceRanges}
                      activeKey={activeEvidenceKey}
                    />
                  </div>
                )}
                {!sub.text && sub.files.length === 0 && (
                  <p className="text-sm text-muted-foreground">Empty submission.</p>
                )}
              </>
            )}
            {sub.proctoring && (
              <AssignmentProctoringReport summary={sub.proctoring} snapshots={sub.snapshots ?? []} />
            )}
            {!isGraded && (
              <p className="rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
                This assignment isn&apos;t graded — the submission is recorded as complete, with no score.
              </p>
            )}
            {/* No rubric → grade form sits under the submission (manual score).
                Prompt the professor to add a rubric if they want Gradescope-style grading. */}
            {!rubric && isGraded && sub.status !== 'returned' && (
              <div className="border-t border-border pt-4 space-y-4">
                {studioPath && (
                  <div className="flex items-center justify-between rounded-xl border border-border bg-muted/30 px-4 py-3">
                    <p className="text-sm text-muted-foreground">
                      No rubric — grading manually. Add criteria in the studio for Gradescope-style grading.
                    </p>
                    <a
                      href={studioPath}
                      className="ml-4 shrink-0 text-sm font-medium text-primary hover:underline"
                    >
                      Add rubric
                    </a>
                  </div>
                )}
                <GradeControls
                  showScore
                  score={score}
                  setScore={setScore}
                  points={points}
                  feedback={feedback}
                  setFeedback={setFeedback}
                  isPending={isPending}
                  alreadyGraded={sub.score != null}
                  hasOpenRegrade={hasOpenRegrade}
                  onSave={hasOpenRegrade ? saveAndResolve : save}
                  onSendBack={sendBack}
                />
              </div>
            )}
          </div>

          {/* Rubric → clickable criteria on the side; score is their points summed. */}
          {rubric && (
            <aside className="min-w-0 space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto lg:border-l lg:border-border lg:pl-5 lg:pr-1">
              {suggestion && (
                <div className="space-y-1 rounded-xl border border-border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
                  <p>AI suggestion. Review every line. Nothing is sent to the student until you save and publish.</p>
                  {undecidedCount > 0 && (
                    <p className="font-medium text-foreground">
                      {/* Say WHY criteria are withheld — a low-confidence draft withholds
                          everything, and calling ordinary criteria "high-stakes" then is a lie. */}
                      {suggestion.confidence === 'low'
                        ? `This draft came back low-confidence, so all ${undecidedCount === 1 ? 'remaining criteria need' : `${undecidedCount} criteria need`} your decision`
                        : `${undecidedCount} high-stakes ${undecidedCount === 1 ? 'criterion needs' : 'criteria need'} your decision`}{' '}
                      — evidence is shown, the AI verdict stays hidden until you ask.
                    </p>
                  )}
                  {aiAgreement && aiAgreement.total > 0 && (
                    <p>
                      AI matched your decisions on {aiAgreement.agreed} of {aiAgreement.total} criteria graded so far.
                      {(aiAgreement.aiHigher > 0 || aiAgreement.aiLower > 0) && (
                        <>
                          {' '}Where you differed, it was
                          {aiAgreement.aiHigher > 0 && ` more generous ${aiAgreement.aiHigher}×`}
                          {aiAgreement.aiHigher > 0 && aiAgreement.aiLower > 0 && ' and'}
                          {aiAgreement.aiLower > 0 && ` stricter ${aiAgreement.aiLower}×`}
                          .
                        </>
                      )}
                    </p>
                  )}
                </div>
              )}
              {showSuggestButton && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSuggest}
                  disabled={isSuggestPending}
                  className="w-full"
                >
                  <Bot className="h-4 w-4" />
                  {isSuggestPending ? 'Generating...' : 'Suggest grades'}
                </Button>
              )}
              {isReturned ? (
                // Waiting on the student's revision: show the rubric for reference only. No ticking,
                // no inline comments, no save — none of it could be persisted from this state.
                <div className="space-y-3">
                  <p className="rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                    You asked {entry.name} to revise this. Grading reopens once they resubmit.
                  </p>
                  <RubricGrader
                    rubric={rubric}
                    selected={selected}
                    onToggle={toggle}
                    total={rubricTotal}
                    points={points}
                    currentScore={scoreFromManualField ? sub.score : null}
                    comments={entry.comments ?? []}
                    rubricComments={rubricCommentDraft}
                    onCommentChange={updateRubricComment}
                    readOnly
                  />
                </div>
              ) : needsGradeChoice && !pickedRubricMode ? (
                // Either a manually-entered score with no criteria ticked (pre-rubric grade, or a
                // prior "Keep this score"), or saved ticks the rubric no longer matches after an
                // edit. Present an explicit choice so ticking a criterion — or a feedback-only
                // save — can never silently overwrite the stored score.
                <div className="space-y-3 rounded-xl border border-border bg-muted/40 p-4">
                  {sub.score != null && sub.score > points ? (
                    // The rubric now totals less than the stored score, so keeping it would exceed
                    // the new max — force a re-grade with the rubric.
                    <>
                      <p className="text-sm text-muted-foreground">
                        The rubric totals {points} pts, but this has a score of {sub.score}, above the new total. Re-grade with the rubric.
                      </p>
                      <Button variant="outline" className="w-full" onClick={switchToRubricGrading} disabled={isPending}>
                        Grade with the rubric
                      </Button>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-muted-foreground">
                        {rubricTicksStale
                          ? `The rubric changed since this was graded, so the saved selections no longer match it. Keep the ${sub.score} / ${points} already recorded, or grade again with the current rubric (its total replaces the score).`
                          : `Scored ${sub.score} / ${points} with no rubric criteria selected. Keep that score, or grade with the rubric (its total replaces the score).`}
                      </p>
                      <div className="flex flex-col gap-2">
                        <Button onClick={hasOpenRegrade ? saveAndResolve : save} disabled={isPending}>
                          Keep this score ({sub.score})
                        </Button>
                        <Button variant="outline" onClick={switchToRubricGrading} disabled={isPending}>
                          Grade with the rubric
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <>
                  <RubricGrader
                    rubric={rubric}
                    selected={selected}
                    onToggle={toggle}
                    total={rubricTotal}
                    points={points}
                    currentScore={scoreFromManualField ? sub.score : null}
                    comments={entry.comments ?? []}
                    rubricComments={rubricCommentDraft}
                    onCommentChange={updateRubricComment}
                    suggestionMap={
                      suggestion
                        ? new Map(suggestion.criteria.map((c) => [c.key, c]))
                        : undefined
                    }
                    unmappedQuestionIndexes={suggestion?.unmappedQuestionIndexes}
                    withheldKeys={forcingActive ? withheldKeys : undefined}
                    decidedKeys={decidedKeys}
                    revealedKeys={revealedKeys}
                    onReveal={revealVerdict}
                    onNoCredit={decideNoCredit}
                    locatedEvidenceKeys={locatedEvidenceKeys}
                    activeEvidenceKey={activeEvidenceKey}
                    onEvidenceClick={focusEvidence}
                  />
                  {isGraded && sub.status !== 'returned' && (
                    <GradeControls
                      showScore={false}
                      score={score}
                      setScore={setScore}
                      points={points}
                      feedback={feedback}
                      setFeedback={setFeedback}
                      isPending={isPending}
                      alreadyGraded={sub.score != null}
                      hasOpenRegrade={hasOpenRegrade}
                      onSave={hasOpenRegrade ? saveAndResolve : save}
                      onSendBack={sendBack}
                      saveDisabledReason={
                        undecidedCount > 0
                          ? `Decide the ${undecidedCount} remaining ${undecidedCount === 1 ? 'criterion' : 'criteria'} to save`
                          : undefined
                      }
                      feedbackIsAiDraft={
                        !!suggestion &&
                        feedback.trim() !== '' &&
                        feedback.trim() === suggestion.feedback.trim()
                      }
                    />
                  )}
                </>
              )}
              {canReopen && (
                <div className="flex justify-end">
                  <ReopenControl onReopen={reopen} disabled={isPending} />
                </div>
              )}
            </aside>
          )}
        </div>
        {/* Reopen button (no-rubric layout): sits below the grade controls. */}
        {!rubric && canReopen && (
          <div className="mt-3 flex justify-end">
            <ReopenControl onReopen={reopen} disabled={isPending} />
          </div>
        )}
        </>
      )}

      {/* Friction before lowering a grade the student can already see. */}
      <AlertDialog open={!!pendingLower} onOpenChange={(open) => { if (!open) setPendingLower(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Lower a released grade?</AlertDialogTitle>
            <AlertDialogDescription>
              This grade is already visible to {entry.name}. Saving changes it from{' '}
              {sub?.score} to {pendingLower?.value} out of {points}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
            variant="destructive"
              onClick={() => {
                if (pendingLower) commit(pendingLower.value, pendingLower.resolveRegrade)
                setPendingLower(null)
              }}
            >
              Save lower grade
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm before reopening. Only an ASSESSMENT reopen wipes the attempt (files + grade,
          unrecoverable); a non-assessment reopen just opens a resubmit window and keeps the
          current work, so the copy + button are non-destructive in that case. */}
      <AlertDialog open={reopenDialogOpen} onOpenChange={(open) => { if (!open) { setReopenDialogOpen(false); setPendingReopen(undefined) } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{reopenCopy.title}</AlertDialogTitle>
            <AlertDialogDescription>{reopenCopy.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={reopenCopy.destructive ? 'destructive' : 'default'}
              onClick={confirmReopen}
            >
              {reopenCopy.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** Submission files rendered inline (no focus-stealing modal) so the rubric stays visible. */
function InlineSubmission({ submissionId, files }: { submissionId: string; files: GradedFile[] }) {
  return (
    <div className="space-y-3">
      {files.map((f, i) => {
        const ext = extensionOf(f.name)
        if (ext === 'pdf' && f.url) {
          return (
            <iframe
              key={i}
              src={f.url}
              title={f.name}
              className="h-[70vh] w-full rounded-xl border border-border"
            />
          )
        }
        if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext) && f.url) {
          return (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={f.url}
              alt={f.name}
              className="max-h-[70vh] w-full rounded-xl border border-border object-contain"
            />
          )
        }
        // zip / notebook render inline already; other types fall back to the popup viewer.
        return (
          <SubmissionFileViewer
            key={i}
            submissionId={submissionId}
            file={{ name: f.name, path: f.path, url: f.url }}
          />
        )
      })}
    </div>
  )
}

/** Clickable rubric: tick the criteria earned → their points sum to the score. */
function RubricGrader({
  rubric,
  selected,
  onToggle,
  total,
  points,
  currentScore = null,
  comments = [],
  rubricComments,
  onCommentChange,
  suggestionMap,
  unmappedQuestionIndexes,
  withheldKeys,
  decidedKeys,
  revealedKeys,
  onReveal,
  onNoCredit,
  locatedEvidenceKeys,
  activeEvidenceKey,
  onEvidenceClick,
  readOnly = false,
}: {
  rubric: AssignmentRubric
  selected: Set<string>
  onToggle: (key: string) => void
  total: number
  points: number
  /** The submission's saved pre-rubric score. When set, it is the grade of record (the rubric
   *  total is only a working sum), so the header leads with it instead of the rubric total. */
  currentScore?: number | null
  comments?: SubmissionCommentRow[]
  /** Draft inline comments per question index (stringified key). */
  rubricComments: Record<string, string>
  onCommentChange: (qi: number, value: string) => void
  /** Per-criterion AI suggestion, keyed by "<qIdx>:<cIdx>". */
  suggestionMap?: Map<string, SuggestedCriterion>
  /** Question indexes that the AI could not map to student content. */
  unmappedQuestionIndexes?: number[]
  /** High-stakes criteria whose AI verdict is withheld until the professor decides
   *  (evidence-first forcing). Absent/undefined = forcing not active on this panel. */
  withheldKeys?: Set<string>
  /** Withheld criteria the professor has resolved (ticked or explicit no-credit). */
  decidedKeys?: Set<string>
  /** Withheld criteria whose AI verdict was revealed on request (display only). */
  revealedKeys?: Set<string>
  onReveal?: (key: string) => void
  onNoCredit?: (key: string) => void
  /** Criteria whose evidence quote was located in the typed response (clickable chips). */
  locatedEvidenceKeys?: Set<string>
  activeEvidenceKey?: string | null
  onEvidenceClick?: (key: string) => void
  /** Reference-only rendering: no ticking and no comment box, for states where nothing here
   *  could be saved (a returned submission awaiting the student's revision). */
  readOnly?: boolean
}) {
  // Quotes render clamped to two lines; clicking one expands it (and jumps to its
  // highlight). Local display state only — nothing here persists.
  const [expandedQuotes, setExpandedQuotes] = useState<Set<string>>(new Set())
  const threadsByQuestion = new Map<number, SubmissionCommentRow[]>()
  for (const c of comments) {
    const list = threadsByQuestion.get(c.question_index) ?? []
    list.push(c)
    threadsByQuestion.set(c.question_index, list)
  }
  return (
    <div>
      <div className="mb-2 flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 pr-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Rubric</p>
        {readOnly && currentScore == null && selected.size === 0 ? (
          /* Returned before any grading happened: `total` would render a bold "0 / points", which
             reads as "this student scored zero" rather than "not graded yet". */
          <p className="text-sm text-muted-foreground">Not graded yet</p>
        ) : currentScore != null ? (
          /* Pre-rubric grade: the saved score is the grade of record; the rubric sum is secondary. */
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <p className="text-sm font-semibold tabular-nums text-foreground">
              Current score {currentScore} / {points}
            </p>
            <p className="text-xs tabular-nums text-muted-foreground">
              Rubric sum {total}
            </p>
          </div>
        ) : (
          <p className="text-sm font-semibold tabular-nums text-foreground">
            {total} / {points}
          </p>
        )}
      </div>
      {/* The whole aside (this rubric + the grade controls) scrolls as one bounded sticky panel,
          so a long rubric never runs off screen and never strands the controls. */}
      <div className="space-y-3 pr-1">
        {rubric.questions.map((q, qi) => (
          <div key={qi} className="rounded-xl border border-border p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
              <p className="min-w-0 break-words text-sm font-medium text-foreground">{q.label || `Question ${qi + 1}`}</p>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{q.points} pts</span>
            </div>
            {unmappedQuestionIndexes?.includes(qi) && (
              <p className="mt-1 rounded-xl bg-muted px-2 py-1 text-xs text-muted-foreground">
                Needs manual grading
              </p>
            )}
            <ul className="mt-2 space-y-1">
              {q.criteria.map((c, ci) => {
                const key = `${qi}:${ci}`
                const on = selected.has(key)
                const aiCriterion = suggestionMap?.get(key)
                const isFlagged = aiCriterion?.flagged ?? false
                const flagReason = isFlagged
                  ? aiCriterion?.rationale.startsWith('Missing required')
                    ? 'Missing required term'
                    : aiCriterion?.rationale.startsWith('Model returned')
                      ? 'Needs manual grading'
                      : 'Low similarity'
                  : null
                // Evidence-first forcing state for this criterion.
                const isWithheld = withheldKeys?.has(key) ?? false
                const isDecided = decidedKeys?.has(key) ?? false
                const isRevealed = revealedKeys?.has(key) ?? false
                const verdictVisible = !!aiCriterion && (!isWithheld || isRevealed)
                const evidenceText = aiCriterion?.evidence?.trim() ?? ''
                const evidenceLocated = locatedEvidenceKeys?.has(key) ?? false
                // Read-only renders a plain div, not a disabled button: a disabled button looks
                // pixel-identical to the interactive rubric here, and clicking criteria is exactly
                // the professor's muscle memory in this panel. Nothing should invite the click.
                const Row = readOnly ? 'div' : 'button'
                const needsDecision = !readOnly && isWithheld && !isDecided
                // The AI sub-panel exists only when there is AI content to show — manual
                // review renders plain rows with zero extra scaffolding.
                const hasAiPanel =
                  !!aiCriterion && (evidenceText !== '' || verdictVisible || isFlagged || (!readOnly && isWithheld))
                const quoteExpanded = expandedQuotes.has(key)
                return (
                  // One bounded unit per criterion: row + indented AI sub-panel, grouped by
                  // proximity and indentation (not a group-wide tint — stacking tinted
                  // blocks reads as noise once several criteria are awarded). The only
                  // group-level tint is the amber undecided state, which is the one state
                  // that must be findable from across the panel.
                  <li
                    key={ci}
                    // Full-strength warning tokens + border (the file's own precedent for
                    // warning panels): the /40 tint computed at 1.06:1 against the card —
                    // invisible from across the panel, which defeats its findability job.
                    className={`rounded-xl border transition-colors ${
                      needsDecision ? 'border-warning/30 bg-warning-muted' : 'border-transparent'
                    }`}
                  >
                    <Row
                      {...(readOnly
                        ? {}
                        : { type: 'button' as const, onClick: () => onToggle(key), 'aria-pressed': on })}
                      className={`flex w-full items-start gap-2 rounded-xl p-2 text-left text-xs transition-colors ${
                        on ? 'bg-primary/10' : readOnly ? '' : 'hover:bg-muted/50'
                      }`}
                    >
                      <span
                        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                          on ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                        }`}
                      >
                        {on && <Check className="h-3 w-3" />}
                      </span>
                      <span className="min-w-0 flex-1 break-words text-foreground">{c.description}</span>
                      <span
                        className={`shrink-0 tabular-nums ${on ? 'font-semibold text-primary' : 'text-muted-foreground'}`}
                      >
                        {c.points >= 0 ? `+${c.points}` : c.points}
                      </span>
                    </Row>
                    {hasAiPanel && (
                      // Single AI sub-panel, indented to the description's left edge (8px row
                      // padding + 16px check + 8px gap). Fixed internal order: quote →
                      // verdict → flag → decision actions. AI attribution lives once in the
                      // panel banner; inline markers are reserved for exceptions (flags).
                      <div className="ml-8 mr-2 space-y-1.5 pb-2">
                        {/* Verbatim evidence — the primary review artifact, shown BEFORE any
                            verdict. Substring-verified server-side. Clamped to two lines;
                            clicking expands it AND jumps to its highlight in the response. */}
                        {evidenceText !== '' &&
                          (evidenceLocated ? (
                            <button
                              type="button"
                              aria-expanded={quoteExpanded}
                              onClick={() => {
                                // Toggle expansion (one-way expand left long quotes stuck
                                // inflating the panel); jump to the highlight either way.
                                setExpandedQuotes((prev) => {
                                  const next = new Set(prev)
                                  if (next.has(key)) next.delete(key)
                                  else next.add(key)
                                  return next
                                })
                                onEvidenceClick?.(key)
                              }}
                              className={`block w-full border-l-2 py-0.5 pl-2 pr-1 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
                                activeEvidenceKey === key
                                  ? 'border-primary text-foreground'
                                  : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                              }`}
                            >
                              <span className="sr-only">Show this quote in the submission. </span>
                              <span className={quoteExpanded ? '' : 'line-clamp-2'}>
                                &ldquo;{evidenceText}&rdquo;
                              </span>
                            </button>
                          ) : (
                            // Unlocated quotes still expand (a button, not a dead div) — on
                            // file-only submissions this clamped text is the ONLY evidence
                            // the professor gets before a forced decision, so hiding lines
                            // 3+ behind nothing defeated the feature (UX review, Critical).
                            // Honest caption: unlocated evidence may be from an uploaded
                            // file, but it can also be an unverified model quote — never
                            // assert a provenance the substring check didn't prove.
                            <button
                              type="button"
                              aria-expanded={quoteExpanded}
                              onClick={() =>
                                setExpandedQuotes((prev) => {
                                  const next = new Set(prev)
                                  if (next.has(key)) next.delete(key)
                                  else next.add(key)
                                  return next
                                })
                              }
                              className="block w-full border-l-2 border-border py-0.5 pl-2 pr-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                            >
                              <span className="sr-only">Expand this quote. </span>
                              <span className={quoteExpanded ? '' : 'line-clamp-2'}>
                                &ldquo;{evidenceText}&rdquo;
                              </span>
                              <span>Not found in the typed response.</span>
                            </button>
                          ))}
                        {verdictVisible && (
                          <p className="px-2 text-xs text-muted-foreground">
                            {/* Withheld criteria aren't pre-ticked, so a revealed verdict must SAY
                                what the AI decided — the tick state can't imply it here. */}
                            {isWithheld && (
                              <span className="font-medium text-foreground">
                                {/* Sign-aware: negative criteria are deductions. */}
                                Suggests{' '}
                                {aiCriterion.tick
                                  ? aiCriterion.suggestedPoints >= 0
                                    ? `+${aiCriterion.suggestedPoints}`
                                    : `applying ${aiCriterion.suggestedPoints}`
                                  : c.points >= 0
                                    ? 'no credit'
                                    : 'not applying the deduction'}
                                .{' '}
                              </span>
                            )}
                            {aiCriterion.rationale}
                          </p>
                        )}
                        {/* Flag reason inline, never tooltip-only — it is grading-critical
                            and must survive touch devices and screen readers. */}
                        {isFlagged && (
                          <p className="flex items-center gap-1 px-2 text-xs font-medium text-warning-muted-foreground">
                            <AlertTriangle className="h-3 w-3 shrink-0" />
                            {flagReason}
                          </p>
                        )}
                        {/* A no-credit decision leaves the row identical to an untouched
                            one — record it, so the professor's own call survives scrolling. */}
                        {!readOnly && isWithheld && isDecided && !on && (
                          <p className="px-2 text-xs text-muted-foreground">
                            {c.points >= 0 ? 'No credit' : 'Deduction not applied'} — your decision.
                          </p>
                        )}
                        {/* Forced decision: two equal-weight buttons (symmetric effort — a
                            cheaper Award than No-credit manufactures rubber-stamping).
                            Reveal is the quiet right-aligned tertiary action and never
                            applies the tick. */}
                        {!readOnly && isWithheld && (needsDecision || !isRevealed) && (
                          <div className="flex flex-wrap items-center gap-1.5 px-2 pt-0.5">
                            {/* max-md:h-11 — a Save-gating action deserves a 44px touch
                                target on mobile; sm height returns on desktop. */}
                            {needsDecision && (
                              <>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="max-md:h-11 max-md:px-4"
                                  onClick={() => onToggle(key)}
                                >
                                  {/* Sign-aware: a negative criterion is a deduction — "Award
                                      +-1" is malformed and "Award" inverts the meaning. */}
                                  {c.points >= 0 ? `Award +${c.points}` : `Apply ${c.points}`}
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="max-md:h-11 max-md:px-4"
                                  onClick={() => onNoCredit?.(key)}
                                >
                                  {c.points >= 0 ? 'No credit' : "Don't apply"}
                                </Button>
                              </>
                            )}
                            {!isRevealed && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="ml-auto text-muted-foreground max-md:h-11"
                                onClick={() => onReveal?.(key)}
                              >
                                <Sparkles className="h-3.5 w-3.5" />
                                AI verdict
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>

            {/* Legacy per-question comment threads — read-only for reference. */}
            {threadsByQuestion.get(qi)?.length ? (
              <SubquestionCommentThread
                comments={threadsByQuestion.get(qi)!}
                canComment={false}
                onPost={async () => ({ success: true as const })}
              />
            ) : null}

            {/* Inline comment box: saved with the grade, not a separate post — so it is hidden
                wherever the grade can't be saved, rather than silently discarding what's typed. */}
            {readOnly ? (
              // Read-only: render any saved note as text. Hiding the box entirely also hid the
              // professor's own saved comments, which are the most useful thing on a reference view.
              rubricComments[String(qi)]?.trim() ? (
                <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">
                  {rubricComments[String(qi)]}
                </p>
              ) : null
            ) : (
              <InlineCommentBox
                value={rubricComments[String(qi)] ?? ''}
                onChange={(v) => onCommentChange(qi, v)}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Collapsed "Add comment" link that expands to a Textarea for inline per-question grading comments. */
function InlineCommentBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  if (!open && !value) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        + Add comment
      </button>
    )
  }
  return (
    <div className="mt-2">
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        maxLength={5000}
        placeholder="Leave a comment for this question (saved with grade)…"
        className="text-xs"
        autoFocus={open && !value}
        onBlur={() => { if (!value) setOpen(false) }}
      />
    </div>
  )
}

/** Score (optional manual input) + feedback + Save / Request-changes. */
function GradeControls({
  showScore,
  score,
  setScore,
  points,
  feedback,
  setFeedback,
  isPending,
  alreadyGraded,
  hasOpenRegrade,
  onSave,
  onSendBack,
  hideSendBack,
  saveDisabledReason,
  feedbackIsAiDraft,
}: {
  showScore?: boolean
  score: string
  setScore: (v: string) => void
  points: number
  feedback: string
  setFeedback: (v: string) => void
  isPending: boolean
  alreadyGraded: boolean
  hasOpenRegrade?: boolean
  onSave: () => void
  onSendBack: () => void
  hideSendBack?: boolean
  /** When set, Save is disabled and this explains why (e.g. undecided high-stakes criteria). */
  saveDisabledReason?: string
  /** True while the feedback box still holds the untouched AI draft — provenance the
   *  professor should know before the text reaches a student. Clears on any edit. */
  feedbackIsAiDraft?: boolean
}) {
  return (
    <div className="space-y-3">
      {showScore && (
        <div className="w-32 space-y-2">
          <Label htmlFor="score">Score</Label>
          <div className="flex items-center gap-2">
            <Input
              id="score"
              type="number"
              min={0}
              max={points}
              value={score}
              onChange={(e) => setScore(e.target.value)}
              className="tabular-nums"
            />
            <span className="shrink-0 text-sm text-muted-foreground">/ {points}</span>
          </div>
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="feedback">
          Feedback <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        {feedbackIsAiDraft && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Sparkles className="h-3 w-3 shrink-0" />
            Drafted by AI — review before saving. Edits are yours.
          </p>
        )}
        {/* maxLength matches the schema's 10,000-char bound. The field previously let a
            professor type past it and only found out on save, when the server rejected the
            whole grade — the Score field beside it validates client-side, so the two halves
            of one form behaved differently. Stopping at the limit beats reporting it after
            the fact; the counter below makes the limit visible before it's reached. */}
        <Textarea
          id="feedback"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={4}
          maxLength={MAX_GRADE_FEEDBACK_LENGTH}
          placeholder="Share feedback, or describe the changes you want…"
        />
        {feedback.length > MAX_GRADE_FEEDBACK_LENGTH * 0.9 && (
          <p className="text-xs text-muted-foreground">
            {feedback.length.toLocaleString()} / {MAX_GRADE_FEEDBACK_LENGTH.toLocaleString()} characters
          </p>
        )}
      </div>
      {saveDisabledReason && (
        <p className="flex items-center justify-end gap-1 text-right text-xs font-medium text-warning-muted-foreground">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          {saveDisabledReason}
        </p>
      )}
      {/* flex-wrap keeps both buttons fully visible on narrow (390px) viewports. */}
      <div className="flex flex-wrap justify-end gap-2">
        {!hideSendBack && (
          <Button variant="outline" onClick={onSendBack} disabled={isPending}>
            <RotateCcw className="h-4 w-4" />
            Request changes
          </Button>
        )}
        <Button onClick={onSave} disabled={isPending || !!saveDisabledReason}>
          <CheckCircle2 className="h-4 w-4" />
          {hasOpenRegrade ? 'Mark resolved' : alreadyGraded ? 'Update grade' : 'Save grade'}
        </Button>
      </div>
    </div>
  )
}

/** Small "Late" badge for submissions that arrived after the deadline. */
function LateBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/30 bg-warning-muted px-2 py-0.5 text-xs font-medium text-warning-muted-foreground">
      <AlertTriangle className="h-3 w-3" />
      Late
    </span>
  )
}

/** Loud tag for a submission the AI couldn't grade reliably (severe) — hand-grade it.
 *  Destructive tone so it reads apart from the amber Late badge. */
function ManualGradingBadge() {
  return (
    <span
      title="The AI couldn't reliably grade several questions on this submission. Grade it by hand."
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-destructive/30 bg-destructive-muted px-2 py-0.5 text-xs font-medium text-destructive-muted-foreground"
    >
      <PenLine className="h-3 w-3" />
      Requires manual grading
    </span>
  )
}

// Borders use the base token at /30, NOT the -muted family (which has no border shade)
// so the chips read as chips on the near-white roster card, not floating text.
const CONFIDENCE_STYLE: Record<'high' | 'medium' | 'low', string> = {
  high: 'border border-success/30 bg-success-muted text-success-muted-foreground',
  medium: 'border border-border bg-muted text-muted-foreground',
  low: 'border border-warning/30 bg-warning-muted text-warning-muted-foreground',
}
/** The AI's overall confidence in its suggested grade, shown per card. */
function ConfidenceBadge({ confidence }: { confidence: 'high' | 'medium' | 'low' }) {
  return (
    <span
      title={`AI grading confidence: ${confidence}`}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium capitalize',
        CONFIDENCE_STYLE[confidence],
      )}
    >
      <Bot className="h-3 w-3" />
      {confidence} confidence
    </span>
  )
}

/** Badge shown when a student has requested a late submission but not yet submitted. */
function LateRequestBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      <Clock className="h-3 w-3" />
      Late submission requested
    </span>
  )
}

const REOPEN_PRESETS = [
  { label: '2h', hours: 2 },
  { label: '4h', hours: 4 },
  { label: '24h', hours: 24 },
] as const

/**
 * Single "Reopen" popover: presets (24h/48h/72h/1 week) + optional custom datetime-local.
 * Default action (clicking "Reopen" without expanding) reopens for 24h.
 */
function ReopenControl({
  onReopen,
  disabled,
}: {
  onReopen: (window?: { hours: number } | { until: string }) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState('')

  function pick(hours: number) {
    setOpen(false)
    onReopen({ hours })
  }

  function pickCustom() {
    if (!custom) return
    setOpen(false)
    onReopen({ until: new Date(custom).toISOString() })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <RotateCcw className="h-4 w-4" />
          Reopen
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <div className="space-y-1">
          {REOPEN_PRESETS.map((p) => (
            <button
              key={p.hours}
              type="button"
              onClick={() => pick(p.hours)}
              className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-foreground hover:bg-muted/60"
            >
              <Clock className="h-4 w-4 text-muted-foreground" />
              {p.label}
            </button>
          ))}
          <div className="my-1 border-t border-border" />
          <div className="space-y-2 px-1">
            <p className="text-xs text-muted-foreground">Custom deadline</p>
            <div className="flex items-center gap-1">
              <input
                type="datetime-local"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                className="min-w-0 flex-1 rounded-xl border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                min={(() => { const d = new Date(); d.setSeconds(0, 0); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) })()}
              />
              <button
                type="button"
                onClick={pickCustom}
                disabled={!custom}
                aria-label="Set custom deadline"
                className="shrink-0 rounded-xl bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
              >
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
