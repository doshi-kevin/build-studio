// Quiz Studio — single-screen quiz authoring (docs/designs/quizzes/quiz-editor-studio.md).
// Three panes: question rail (left), the selected question in the canvas (center),
// quiz-wide settings in a drawer, plus a student preview toggle. Manages form
// state via react-hook-form and the save/publish/schedule actions.

'use client'

import { useState, useEffect, useCallback, useMemo, useTransition, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  ArrowLeft,
  Save,
  Send,
  Loader2,
  AlertTriangle,
  CircleCheck,
  Pencil,
  Settings2,
  Eye,
  PanelLeft,
  SlidersHorizontal,
  Bot,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
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
import { QuizReviewStep } from './QuizReviewStep'
import {
  QuestionEditorCard,
  createBlankQuestion,
  type WizardQuestion,
  questionToWizard,
} from './QuestionEditorCard'
import { QuizStudioRail } from './QuizStudioRail'
import { QuizStudioQuestionSidebar } from './QuizStudioQuestionSidebar'
import { AddQuestionHub } from './AddQuestionHub'
import { QuizSettingsDrawer } from './QuizSettingsDrawer'
import { DeleteQuizDialog } from '@/components/professor/quizzes/DeleteQuizDialog'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { PickFromBankDialog } from './PickFromBankDialog'
import { UploadJSONDialog } from './UploadJSONDialog'
import { DocumentPagePreview } from '@/components/shared/DocumentPagePreview'
import { generateId } from '@/lib/quiz/utils'
import { uploadFile, deleteFile } from '@/lib/supabase/storage'
import {
  useAthenaDock,
  useAthenaSurface,
  useAthenaNotify,
  type AttachResult,
  type FillResult,
} from '@/components/professor/assignments/athena/AssignmentAthenaDock'
import { AthenaAskLine } from '@/components/professor/assignments/athena/AthenaAskLine'
import {
  applyQuizOps,
  applyQuizSettings,
  serializeQuizForAthena,
  type QuizAthenaSettings,
} from '@/lib/quiz/athena-quiz-adapter'
import type { AssignmentFillTool, AssignmentScreen } from '@/lib/ai/assignment-assistant/schemas'
import type {
  GenerateQuestionsPayload,
  QuizOp,
  QuizSettingsPayload,
} from '@/lib/ai/assignment-assistant/templates/registry'
import type { GeneratedQuestion } from '@/lib/ai/llm-client'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  createQuizFull,
  updateQuiz,
  updateQuizQuestions,
  publishQuiz,
  unpublishQuiz,
  deleteQuiz,
  bulkCreateQuestions,
  bulkUpdateQuestionContent,
  getQuestions,
  getQuizGenerationState,
  registerQuizUpload,
} from '@/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions'
import { getPlacementModules, getResourcePlacement, setResourcePlacement } from '@/lib/roadmap/placement-actions'
import { SetupSpotlight } from '@/components/professor/roadmap/SetupSpotlight'
import type {
  Quiz,
  Question,
  CreateQuestionServerInput,
  QuizItemType,
  SourceCitation,
  GenerationNotice,
} from '@/lib/validations/quiz'
import { EXPLANATION_TIMINGS, MAX_ATTEMPTS_CEILING } from '@/lib/validations/quiz'
import { toLocalDateTimeInput, fromLocalDateTimeInput } from '@/lib/datetime'
import {
  validateWizardQuestions,
  wizardQuestionUnsavable,
  wizardQuestionUnsavableReason,
} from '@/lib/quiz/wizard-validation'

// Matches a v4-style UUID (what generateId() / crypto.randomUUID() produce).
/** Ceiling on one Athena generation call. Matches generateQuestionsSchema's cap: it bounds
 *  the per-turn screen snapshot, and a second call appends rather than restarting. */
const ATHENA_MAX_GENERATED = 50

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Form Schema ──────────────────────────────────────────────────

const wizardFormSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  // 2000 matches the server schema (createQuizFull/updateQuiz) and the
  // textarea's maxLength — a higher client cap silently failed server-side.
  description: z.string().max(2000, 'Description must be under 2000 characters').default(''),
  timeLimitMinutes: z.number().int().min(1).max(480).nullable(),
  shuffleQuestions: z.boolean(),
  shuffleAnswers: z.boolean(),
  // null = no limit; the ceiling matches the server so a too-big value is caught here
  // as a clamp rather than as a raw validator toast on save — see quizSchema (#43)
  maxAttempts: z.number().int().min(1).max(MAX_ATTEMPTS_CEILING).nullable(),
  passThreshold: z.number().min(0).max(100),
  dueDate: z.string().nullable(),
  // publishMode is UI-only — not persisted to DB. Controls save behavior.
  publishMode: z.enum(['draft', 'published', 'scheduled']),
  // scheduledPublishAt is persisted to DB as scheduled_publish_at (UTC ISO string)
  scheduledPublishAt: z.string().nullable(),
  showExplanations: z.enum(EXPLANATION_TIMINGS),
  showLeaderboard: z.boolean(),
  allowFormulaSheet: z.boolean(),
  formulaSheetUrl: z.string().nullable(),
  formulaSheetPath: z.string().nullable(),
  negativeMarking: z.boolean(),
  negativeMarkingPenalty: z.number().min(0).max(1),
  proctoringEnabled: z.boolean(),
  videoProctoringEnabled: z.boolean(),
  // Adaptive (CCAT v2) config
  adaptiveMode: z.boolean(),
  adaptiveQuestionCount: z.number().int().min(1).max(50),
  selectLambda: z.number().min(0).max(2),
  stopMode: z.enum(['fixed', 'precision']),
  targetSe: z.number().min(0.1).max(2),
  showRatingToStudents: z.boolean(),
})

export type WizardFormValues = z.infer<typeof wizardFormSchema>

// ── Props ────────────────────────────────────────────────────────

interface QuizStudioProps {
  sectionId: string
  mode: 'create' | 'edit'
  quizId?: string
  initialQuiz?: Quiz
  initialQuestions?: Question[]
  allBankQuestions: Question[]
  /** Deep-link: question ID to select in the rail (from insights dashboard) */
  focusQuestion?: string
  /** Open with the student preview showing (?preview=1 — the quiz card's Preview entry) */
  initialPreview?: boolean
  /** Server truth (at page load) that an AI generation is still running for this
   *  quiz — resumes the "still generating" banner + poll even without this tab's
   *  client marker (a fresh tab, another device, or after the marker expired). */
  initiallyGenerating?: boolean
  /** Fallback for the "just created" intent when the draft was created server-side
   *  (dashboard quick action → redirect, via `?intent=`) rather than by the quiz
   *  list's own button (sessionStorage) — see the page's docstring. */
  initialIntent?: string
  /** Submitted attempts on this quiz — named in the unpublish confirmation, because
   *  withdrawing a quiz students have already sat is a different decision (#615).
   *  `null` means the count could not be read: say so rather than imply there are none. */
  attemptCount?: number | null
}

// ── Helpers ──────────────────────────────────────────────────────

function quizToFormValues(quiz?: Quiz): WizardFormValues {
  if (!quiz) {
    return {
      title: '',
      description: '',
      timeLimitMinutes: null,
      shuffleQuestions: false,
      shuffleAnswers: false,
      // 1, not null: a professor who never opens Quiz Rules should not ship an
      // unlimited-retake quiz by accident. "No limit" is one keystroke away (clear
      // the field) — see the note on quizSchema.maxAttempts.
      maxAttempts: 1,
      passThreshold: 60,
      dueDate: null,
      publishMode: 'draft',
      scheduledPublishAt: null,
      showExplanations: 'after_submission',
      showLeaderboard: false,
      allowFormulaSheet: false,
      formulaSheetUrl: null,
      formulaSheetPath: null,
      negativeMarking: false,
      negativeMarkingPenalty: 0.25,
      proctoringEnabled: false,
      videoProctoringEnabled: false,
      adaptiveMode: false,
      adaptiveQuestionCount: 10,
      selectLambda: 0.5,
      stopMode: 'fixed',
      targetSe: 0.3,
      showRatingToStudents: false,
    }
  }
  const hasSchedule = !!quiz.scheduledPublishAt
  return {
    // "Untitled quiz" is the sentinel an unnamed draft is stored under (so the
    // list/reuse logic has something to key on) — show it as an EMPTY field so
    // the "Untitled quiz" placeholder reads as a prompt, not typed text the
    // professor has to clear. Autosave writes the sentinel back if left blank.
    title: quiz.title === 'Untitled quiz' ? '' : quiz.title,
    description: quiz.description,
    timeLimitMinutes: quiz.timeLimitMinutes,
    shuffleQuestions: quiz.shuffleQuestions,
    shuffleAnswers: quiz.shuffleAnswers,
    maxAttempts: quiz.maxAttempts,
    passThreshold: quiz.passThreshold,
    dueDate: quiz.dueDate ? quiz.dueDate.slice(0, 10) : null,
    publishMode: quiz.status === 'published' ? 'published' : hasSchedule ? 'scheduled' : 'draft',
    scheduledPublishAt: quiz.scheduledPublishAt ?? null,
    showExplanations: quiz.showExplanations,
    showLeaderboard: quiz.showLeaderboard,
    allowFormulaSheet: quiz.allowFormulaSheet,
    formulaSheetUrl: quiz.formulaSheetUrl,
    formulaSheetPath: quiz.formulaSheetPath,
    negativeMarking: quiz.negativeMarking,
    negativeMarkingPenalty: quiz.negativeMarkingPenalty,
    proctoringEnabled: quiz.proctoringEnabled,
    videoProctoringEnabled: quiz.videoProctoringEnabled,
    adaptiveMode: quiz.adaptiveMode,
    adaptiveQuestionCount: quiz.adaptiveQuestionCount,
    selectLambda: quiz.selectLambda,
    stopMode: quiz.stopMode,
    targetSe: quiz.targetSe,
    showRatingToStudents: quiz.showRatingToStudents,
  }
}

/** Convert a WizardQuestion to CreateQuestionServerInput for DB insertion */
// Exported for the walkthrough round-trip regression test — hardcoded
// walkthrough content here once wiped stored openings on autosave.
export function wizardToServerInput(q: WizardQuestion): CreateQuestionServerInput {
  const tags = q.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)

  let content: CreateQuestionServerInput['content']
  switch (q.questionType) {
    case 'multiple_choice':
      content = {
        questionType: 'multiple_choice',
        choices: q.choices.filter((c) => c.text.trim()),
        allowMultiple: q.allowMultiple,
      }
      break
    case 'true_false':
      content = { questionType: 'true_false', correctAnswer: q.correctAnswer }
      break
    case 'short_answer':
      content = {
        questionType: 'short_answer',
        acceptedAnswers: q.acceptedAnswers.map((a) => a.value).filter(Boolean),
        caseSensitive: q.caseSensitive,
      }
      break
    case 'fill_in_blank':
      content = {
        questionType: 'fill_in_blank',
        blanks: q.blanks.map((b) => ({
          id: b.id,
          acceptedAnswers: b.acceptedAnswers.split(',').map((a) => a.trim()).filter(Boolean),
          caseSensitive: b.caseSensitive,
        })),
      }
      break
    case 'explanation':
      content = { questionType: 'explanation' }
      break
    case 'walkthrough':
      // Carry the authored/AI-seeded conversation config — hardcoding these
      // used to wipe a stored opening on every autosave. Clamped to schema.
      content = {
        questionType: 'walkthrough',
        opening: q.opening.slice(0, 1000),
        maxTurns: Math.min(8, Math.max(2, Math.round(q.maxTurns) || 4)),
      }
      break
  }

  // Preserve existing Elo/time for DB questions; auto-set for new ones
  const eloRating = q.eloRating ?? (q.difficulty === 'easy' ? 800 : q.difficulty === 'hard' ? 1600 : 1200)
  const expectedTimeSeconds = q.expectedTimeSeconds ?? (q.difficulty === 'easy' ? 30 : q.difficulty === 'hard' ? 60 : 45)

  // Drop blank rubric rows (the editor keeps them while typing — the schema
  // rejects empty concepts); an all-blank rubric saves as null.
  const rubric = (q.rubric ?? []).filter((n) => n.concept.trim())

  return {
    // Carry the client UUID as the row id so created rows can be correlated
    // back by id (skip-/order-proof). clientId is a crypto.randomUUID() for new
    // questions; guard in case a non-UUID ever slips in so the schema doesn't reject.
    id: UUID_RE.test(q.clientId) ? q.clientId : undefined,
    questionText: q.questionText,
    content,
    difficulty: q.difficulty,
    bloomsLevel: q.bloomsLevel,
    tags,
    points: q.points,
    explanation: q.explanation,
    isBonus: q.isBonus,
    isExtraCredit: q.isExtraCredit,
    imageUrl: q.imageUrl ?? null,
    imagePath: q.imagePath ?? null,
    codeSnippet: q.codeSnippet ?? null,
    eloRating,
    expectedTimeSeconds,
    irtA: q.irtA ?? null,
    irtB: q.irtB ?? null,
    irtC: q.irtC ?? null,
    rubric: rubric.length > 0 ? rubric : null,
    sourceCitation: q.sourceCitation ?? null,
  }
}

/** Payload for bulkUpdateQuestionContent — one builder shared by the draft-save
 *  and publish paths so they can't drift (a field missing here silently loses
 *  that edit on every autosave; the rubric was lost exactly this way). */
export function wizardToContentUpdate(q: WizardQuestion) {
  const serverInput = wizardToServerInput(q)
  return {
    questionId: q.dbId!,
    questionText: serverInput.questionText,
    content: serverInput.content,
    difficulty: serverInput.difficulty,
    bloomsLevel: serverInput.bloomsLevel,
    tags: serverInput.tags,
    points: serverInput.points,
    explanation: serverInput.explanation,
    isBonus: serverInput.isBonus,
    isExtraCredit: serverInput.isExtraCredit,
    imageUrl: serverInput.imageUrl ?? null,
    imagePath: serverInput.imagePath ?? null,
    codeSnippet: serverInput.codeSnippet ?? null,
    eloRating: serverInput.eloRating ?? 1200,
    expectedTimeSeconds: serverInput.expectedTimeSeconds ?? null,
    // IRT b/a from the sidebar — without these, editing difficulty (b) or
    // discrimination (a) on a saved question was silently dropped on autosave.
    irtA: serverInput.irtA ?? null,
    irtB: serverInput.irtB ?? null,
    rubric: serverInput.rubric ?? null,
  }
}

// Map one AI-generated question into an editable wizard question. Module-scope
// so both the (batch-streamed) generation consumer and any direct caller share
// one mapping. Pure — a fresh clientId + per-type field extraction.
/** A generate-with-AI request as handed from the dialog to the studio. */
type AIGenRequest = {
  moduleItemIds: string[]
  additionalFilePaths: string[]
  questionCount: number
  customPrompt?: string
  includeMetadata?: boolean
  questionTypes?: string[]
  /** Opt-in: fill any source shortfall with on-topic questions from the AI's
   *  own knowledge (tagged ai_extended). Threaded to the generate-stream body. */
  beyondDocument?: boolean
}

function mapGeneratedToWizard(g: GeneratedQuestion): WizardQuestion {
  return {
    clientId: generateId(),
    questionText: g.questionText,
    questionType: g.content.questionType,
    difficulty: g.difficulty,
    bloomsLevel: g.bloomsLevel ?? null,
    tags: (g.tags || []).join(', '),
    points: g.points,
    explanation: g.explanation,
    isBonus: g.isBonus ?? false,
    isExtraCredit: g.isExtraCredit ?? false,
    choices:
      g.content.questionType === 'multiple_choice'
        ? g.content.choices
        : [
            { id: generateId(), text: '', isCorrect: true },
            { id: generateId(), text: '', isCorrect: false },
          ],
    allowMultiple:
      g.content.questionType === 'multiple_choice' ? g.content.allowMultiple : false,
    correctAnswer:
      g.content.questionType === 'true_false' ? g.content.correctAnswer : true,
    acceptedAnswers:
      g.content.questionType === 'short_answer'
        ? g.content.acceptedAnswers.map((v) => ({ value: v }))
        : [{ value: '' }],
    caseSensitive:
      g.content.questionType === 'short_answer' ? g.content.caseSensitive : false,
    blanks:
      g.content.questionType === 'fill_in_blank'
        ? g.content.blanks.map((b) => ({
            id: b.id,
            acceptedAnswers: b.acceptedAnswers.join(', '),
            caseSensitive: b.caseSensitive,
          }))
        : [{ id: generateId(), acceptedAnswers: '', caseSensitive: false }],
    // Walkthrough conversation config — dropping these lost the AI's scripted
    // opening between generation and save.
    opening: g.content.questionType === 'walkthrough' ? g.content.opening : '',
    maxTurns: g.content.questionType === 'walkthrough' ? g.content.maxTurns : 4,
    validationWarning: g.validationWarning,
    codeSnippet: g.codeSnippet || null,
    // Visual questions arrive with a source-region crop already attached
    // (signed imageUrl + imagePath) — carry it, don't reset it.
    imageUrl: g.imageUrl ?? null,
    imagePath: g.imagePath ?? null,
    // Carry the AI-seeded adaptive params + rubric through to save.
    eloRating: g.eloRating,
    expectedTimeSeconds: g.expectedTimeSeconds,
    irtA: g.irtA,
    irtB: g.irtB,
    irtC: g.irtC,
    rubric: g.rubric,
    // Source citation (file + page) resolved server-side, for the peek chip.
    sourceCitation: g.sourceCitation ?? null,
  }
}

// Append `incoming` to `prev`, skipping any question whose identity (dbId, or
// clientId when it has no dbId yet) is already present. Pure, and meant to run
// INSIDE the setQuestions updater so it dedupes against the latest list: a live
// generation stream and a reattach poll can both merge the same server-persisted
// question, and since streamed questions use their dbId as the clientId, an
// un-deduped append collides on that shared key (React "duplicate key" +
// selecting one question highlights two). Race-proof because `prev` is current.
export function mergeQuestions(
  prev: WizardQuestion[],
  incoming: WizardQuestion[],
): WizardQuestion[] {
  const seen = new Set<string>()
  for (const q of prev) {
    seen.add(q.clientId)
    if (q.dbId) seen.add(q.dbId)
  }
  const fresh = incoming.filter((q) => {
    const identity = q.dbId ?? q.clientId
    if (seen.has(identity) || seen.has(q.clientId)) return false
    // Guard against duplicates WITHIN the incoming batch too.
    seen.add(q.clientId)
    if (q.dbId) seen.add(q.dbId)
    return true
  })
  return fresh.length ? [...prev, ...fresh] : prev
}

/** "42s" / "2m 10s" — for the generation banner's live clock and the
 *  shortfall notice's "(in 2m 10s)". */
function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

/** "850 tokens" / "42k tokens" — the banner's live usage meter. */
function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k tokens` : `${n} tokens`
}

// Persistent banner shown while AI questions stream in — visible whether or not
// the generate modal is still open, so the professor always knows work is in
// flight (and can keep editing the batches already delivered).
function GenerationBanner({
  received,
  total,
  status,
  startedAt,
  tokens,
}: {
  received: number
  total: number
  status?: string | null
  /** Epoch ms the run started (server's stamp on reattach) — drives the live
   *  elapsed clock; omit to hide it. */
  startedAt?: number | null
  /** Running token total across the run's model calls (0 = hide). */
  tokens?: number
}) {
  // 1s tick for the elapsed clock — only while the banner is mounted.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!startedAt) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [startedAt])
  // Usage meter rides the LEFT side with the title/status; the right side is
  // reserved for the one number that matters most — the ready counter.
  const meter = [
    tokens ? `${formatTokens(tokens)} used` : null,
    startedAt ? formatElapsed(now - startedAt) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 rounded-2xl border border-primary/30 bg-primary/5 px-3 py-2 text-sm"
    >
      <Bot className="h-4 w-4 shrink-0 animate-pulse text-primary motion-reduce:animate-none" aria-hidden="true" />
      {/* Single row, always: the title, plus an optional transient status note
          (the pipeline stage currently running) and the usage meter inline so
          a pause never reads as a hang. The banner never changes height, so
          the questions below never shift. */}
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
        Generating questions with AI…
        {/* No leading "·" separator: these trailing notes are already a distinct
            style (smaller, muted, lighter) from the title, so the ml-2 gap alone
            reads as a break. A middot only goes BETWEEN the same-styled status
            and meter, where there's no other visual divider. */}
        {status && <span className="ml-2 text-xs font-normal text-muted-foreground">{status}</span>}
        {/* aria-hidden: the clock ticks every second — inside this aria-live
            region it would re-announce the banner ~120×/run and bury the
            meaningful updates (counter, stage notes). Visual-only glance. */}
        {meter && <span aria-hidden="true" className="ml-2 text-xs font-normal tabular-nums text-muted-foreground">{status ? `· ${meter}` : meter}</span>}
      </span>
      {total > 0 && (
        <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
          {received} of {total} ready
        </span>
      )}
      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden="true" />
    </div>
  )
}

/** What a finished run leaves behind for the completion banner: the counts,
 *  wall-clock, and token spend of the run that just ended. */
interface GenerationSummary {
  delivered: number
  requested: number
  durationMs: number | null
  tokens: number
}

// The generating banner's resting state: stays after the run completes (same
// blue bar, spinner gone) summarizing what happened, until the professor
// dismisses it. Shortfall runs don't use this — the "supported N of M" notice
// banner is their summary.
function GenerationDoneBanner({ summary, onDismiss }: { summary: GenerationSummary; onDismiss: () => void }) {
  const detail = [
    summary.durationMs ? `in ${formatElapsed(summary.durationMs)}` : null,
    summary.tokens ? `${formatTokens(summary.tokens)} used` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-2xl border border-primary/30 bg-primary/5 px-3 py-2 text-sm"
    >
      <Bot className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
        {summary.delivered}/{summary.requested} questions generated
        {/* Real leading space inside the span — margin alone renders fine but
            copies as "generatedin 2m 8s". */}
        {detail && <span className="text-xs font-normal tabular-nums text-muted-foreground">{` ${detail}`}</span>}
      </span>
      {/* Full 32px hit target, but pulled into the row with a negative margin
          so the bar keeps the exact height of the live generating banner. */}
      <Button
        size="icon"
        variant="ghost"
        className="-my-1.5 h-8 w-8 shrink-0"
        onClick={onDismiss}
        aria-label="Dismiss generation summary"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  )
}

// Shimmering placeholder card for the canvas before the first batch lands.
function QuestionShimmer() {
  return (
    <div className="space-y-3" aria-hidden="true">
      <div className="h-6 w-2/3 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
      <div className="h-24 w-full animate-pulse rounded-2xl bg-muted motion-reduce:animate-none" />
      <div className="h-10 w-full animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
      <div className="h-10 w-full animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
    </div>
  )
}

// ── Component ────────────────────────────────────────────────────

export function QuizStudio({
  sectionId,
  mode,
  quizId,
  initialQuiz,
  initialQuestions = [],
  allBankQuestions,
  focusQuestion,
  initialPreview,
  initiallyGenerating,
  initialIntent,
  attemptCount = null,
}: QuizStudioProps) {
  const router = useRouter()
  const [questions, setQuestions] = useState<WizardQuestion[]>(
    () => initialQuestions.map(questionToWizard),
  )
  const [isPending, startTransition] = useTransition()
  const isPublished = initialQuiz?.status === 'published'
  // "Live" = students can see it now or will on a schedule (a scheduled quiz is
  // a draft with scheduledPublishAt set). Placeholder/incomplete questions are
  // only persisted on non-live drafts; a live quiz keeps the strict autosave so
  // an incomplete edit never reaches students.
  const isLive = isPublished || !!initialQuiz?.scheduledPublishAt

  // ── Studio state ────────────────────────────────────────────
  // selectedId null means "auto": the deep-linked question if any, else the first.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Add hub fills the canvas when there are no questions, or when re-opened from the rail
  const [hubOpen, setHubOpen] = useState(false)
  // One-click add type — sticks to the last type used (per quiz, client-side)
  const [stickyType, setStickyType] = useState<QuizItemType>('multiple_choice')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [deleteQuizOpen, setDeleteQuizOpen] = useState(false)
  // Preview needs questions to show; an empty quiz opens on the editor/hub as usual.
  const [previewOpen, setPreviewOpen] = useState(
    () => Boolean(initialPreview) && initialQuestions.length > 0,
  )
  const [bankOpen, setBankOpen] = useState(false)
  const [jsonOpen, setJsonOpen] = useState(false)
  // The last run's requested-vs-delivered (from the quiz row, so it survives reload).
  // There is no banner for it any more — Athena reads it off the screen snapshot and
  // offers the follow-up in conversation, where the professor already is.
  const [notice, setNotice] = useState<GenerationNotice | null>(initialQuiz?.generationNotice ?? null)
  // Source-page peek for an AI question's citation (right-hand panel)
  const [peekCitation, setPeekCitation] = useState<SourceCitation | null>(null)
  // Publish dialog — opened from the header "Publish" button
  const [publishDialogOpen, setPublishDialogOpen] = useState(false)
  // Roadmap placement — loaded when the publish dialog opens (the commit point:
  // autosaved drafts are throwaway, a published quiz must land under a module).
  const [placementModules, setPlacementModules] = useState<{ id: string; title: string; weekNumber: number | null }[] | null>(null)
  const [placementModuleId, setPlacementModuleId] = useState('')

  const selectedQuestion =
    questions.find((q) => q.clientId === selectedId) ??
    (focusQuestion ? questions.find((q) => q.dbId === focusQuestion) : undefined) ??
    questions[0] ??
    null
  // AI generation is owned by the studio (not the modal): the dialog hands over
  // the request and closes, then questions STREAM in batch-by-batch via
  // startAIGeneration below — so the professor can edit the first batch while
  // the rest arrive, and closing the modal mid-generation just leaves this
  // running with a visible loading state (a completion notification lands in the
  // bell either way).
  const [genActive, setGenActive] = useState(false)
  const [genRequested, setGenRequested] = useState(0)
  const [genReceived, setGenReceived] = useState(0)
  // Short human-readable note for non-happy-path moments (retry, salvage,
  // exhaustion) streamed by the server — shown under the banner counter so a
  // pause never reads as a hang. Cleared when the next batch lands.
  const [genStatus, setGenStatus] = useState<string | null>(null)
  // Running token total streamed by the route (`usage` messages) — the
  // banner's live usage meter. 0 = nothing to show yet.
  const [genTokens, setGenTokens] = useState(0)
  // Set when a full run completes (no shortfall notice): keeps the blue bar
  // up as a dismissible "10/10 generated in 2m 7s · 56k tokens used" summary.
  const [genSummary, setGenSummary] = useState<GenerationSummary | null>(null)
  // Epoch ms the current run started — drives the banner's elapsed clock. Set
  // when this tab starts a stream; a reattach adopts the server's stamp so the
  // clock measures the real run, not the reconnect.
  const [genStartedAt, setGenStartedAt] = useState<number | null>(null)
  // True while the reattach poll is pulling a detached run's questions in —
  // keeps the "Generating questions with AI…" banner up so arrivals never look
  // like the list changing on its own.
  const [genReattaching, setGenReattaching] = useState(false)
  const genPending = Math.max(0, genRequested - genReceived)
  // Abort handle for the generation stream — aborted on unmount so a stream
  // can never keep feeding a studio that no longer exists (the source of the
  // "new quiz shows the old quiz's questions" bug). The SERVER keeps
  // generating and persisting to the draft regardless.
  const genAbortRef = useRef<AbortController | null>(null)
  // While generation runs (or the studio is detached from a still-running
  // generation), the autosave's destructive assignment rewrite is suspended —
  // the route owns assignment appends during that window. Content edits still
  // save normally; one full ordered sync runs when generation settles.
  //
  // Seed it from the server's "is a run in flight?" truth (initiallyGenerating),
  // NOT just false: this ref resets on every remount, so navigating away and
  // back DURING a run would otherwise start unlocked — and an early autosave
  // could destructively rewrite assignments (delete-all + reinsert from local
  // state that predates the route's in-flight appends), wiping generated
  // questions off the quiz. The reattach that the mount effect kicks off unlocks
  // it (its finally) once the run settles.
  const assignmentsLockedRef = useRef(Boolean(initiallyGenerating))

  // "Generation in progress" — either a live stream this tab owns (genActive) or
  // a run we've reattached to after a reload/navigation (genReattaching). Both
  // drive the same generating UI: banner, shimmer, no empty-state hub.
  const generating = genActive || genReattaching

  // Mirrored for Athena: her getScreen/onFill are stable callbacks, so they must read the
  // live values rather than a closed-over render's. Assigned during render (like
  // questionsRef) so they are correct the moment the next fill or snapshot runs.
  const generatingRef = useRef(generating)
  generatingRef.current = generating
  // startAIGeneration does async work (draft creation, a create-in-flight poll) BEFORE
  // genActive flips, so `generating` stays false for a beat after Athena hands a run off.
  // A second fill arriving in that window would slip past the lock. This closes it from
  // the moment the hand-off happens; the effect below clears it once the real flag owns it.
  const athenaGenPendingRef = useRef(false)
  const noticeRef = useRef(notice)
  noticeRef.current = notice
  const genReceivedRef = useRef(genReceived)
  genReceivedRef.current = genReceived
  const genRequestedRef = useRef(genRequested)
  genRequestedRef.current = genRequested

  useEffect(() => {
    if (generating) athenaGenPendingRef.current = false
  }, [generating])

  // While generation is streaming (or reattached), show the studio (with its
  // loading banner + placeholders), never the empty-state hub — even at zero
  // questions so far.
  const showHub = !generating && (questions.length === 0 || hubOpen)

  const form = useForm<WizardFormValues>({
    resolver: zodResolver(wizardFormSchema) as never,
    defaultValues: quizToFormValues(initialQuiz),
  })

  // ── Auto-save to draft ─────────────────────────────────────
  // Tracks the DB quiz ID (set on first save). In edit mode, starts with the existing ID.
  const [draftQuizId, setDraftQuizId] = useState<string | null>(quizId ?? null)

  // Load the module list (and the quiz's current placement, when editing) as the
  // publish dialog opens, so the required picker is ready at the commit point.
  useEffect(() => {
    if (!publishDialogOpen && !settingsOpen) return
    let alive = true
    Promise.all([
      getPlacementModules(sectionId),
      draftQuizId ? getResourcePlacement(sectionId, 'quiz', draftQuizId) : Promise.resolve({ data: null as string | null }),
    ]).then(([mods, current]) => {
      if (!alive) return
      setPlacementModules(mods.data ?? [])
      if (current.data) setPlacementModuleId(current.data)
    })
    return () => { alive = false }
  }, [publishDialogOpen, settingsOpen, sectionId, draftQuizId])

  // ── New-quiz setup spotlight ───────────────────────────────
  // The first-time setup spotlight: dims the studio, highlights the title field,
  // and asks which module the quiz belongs to on the roadmap (or "decide later";
  // the publish dialog re-confirms at the commit point). Opened by the intent
  // effect below — NOT a prop — so the create URL never carries a ?new=1 flag.
  const [setupOpen, setSetupOpen] = useState(false)
  // Module chosen in the spotlight, waiting for the draft row to exist — the
  // roadmap edge needs a quiz id, which the first autosave creates.
  const [pendingPlacement, setPendingPlacement] = useState<string | null>(null)
  useEffect(() => {
    if (setupOpen) document.getElementById('studio-title')?.focus()
  }, [setupOpen])
  // One-shot post-create intent handoff. Normally via sessionStorage (NOT the
  // URL — that's what kept the ?new=1 flash-then-strip alive), set by the quiz
  // list before it navigates here. `initialIntent` is the one exception: drafts
  // created server-side (dashboard quick action → redirect) never run that
  // client code, so the URL is the only channel — stripped here once read, same
  // as the sessionStorage key, so a reload never re-fires it. 'ai' opens the AI
  // dialog; 'setup' opens the first-time spotlight (skipped if the draft somehow
  // already has questions or a preview is showing). Read in an effect (not a
  // useState initializer) to stay SSR/hydration-safe.
  useEffect(() => {
    if (typeof window === 'undefined' || mode !== 'edit' || !quizId) return
    let intent: string | null = null
    try {
      intent = sessionStorage.getItem(`quiz-intent:${quizId}`)
      if (intent) sessionStorage.removeItem(`quiz-intent:${quizId}`)
    } catch {
      // sessionStorage unavailable — fall through to the URL-carried intent below.
    }
    if (!intent && initialIntent) {
      intent = initialIntent
      router.replace(`/professor/courses/${sectionId}/quizzes/${quizId}`, { scroll: false })
    }
    if (intent === 'setup' && initialQuestions.length === 0 && !initialPreview) {
      setSetupOpen(true)
    }
    // Effectively mount-only: these deps are stable for a given editor page, and
    // the key/param is consumed on first read so any re-run is a no-op.
  }, [mode, quizId, sectionId, initialPreview, initialQuestions.length, initialIntent, router])
  useEffect(() => {
    if (!draftQuizId || !pendingPlacement) return
    setPendingPlacement(null)
    setResourcePlacement(sectionId, 'quiz', draftQuizId, pendingPlacement).then((res) => {
      if (res.error) toast.error(res.error)
    })
  }, [draftQuizId, pendingPlacement, sectionId])

  // Placement changed from the settings drawer — write it now if the draft row
  // exists, otherwise queue it (pendingPlacement) until the first autosave does.
  const handlePlacementChange = useCallback(
    (moduleId: string) => {
      setPlacementModuleId(moduleId)
      if (!moduleId) return
      const id = draftQuizIdRef.current
      if (id) {
        setResourcePlacement(sectionId, 'quiz', id, moduleId).then((res) => {
          if (res.error) toast.error(res.error)
        })
      } else {
        setPendingPlacement(moduleId)
      }
    },
    [sectionId],
  )
  const [draftSaving, setDraftSaving] = useState(false)
  const [lastDraftSavedAt, setLastDraftSavedAt] = useState(0)
  // Autosave surfaces failures instead of swallowing them (a too-long
  // description or a server error used to fail silently while the pill said
  // "Saved"). True when the last autosave couldn't fully persist.
  const [draftError, setDraftError] = useState(false)
  // Mobile (< lg): the rail and per-question settings collapse into slide-over
  // sheets so the canvas gets the full width instead of three panes overflowing.
  const [mobileRailOpen, setMobileRailOpen] = useState(false)
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false)
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // clientIds of questions that failed the last save attempt — only these show the
  // inline validation hint, so a question being typed for the first time isn't nagged.
  const [flaggedQuestionIds, setFlaggedQuestionIds] = useState<Set<string>>(new Set())
  const adaptiveMode = form.watch('adaptiveMode')
  // What actually renders as ⚠/inline hint: flagged AND still invalid — a flag
  // clears itself the moment the question is fixed, not on the next save attempt.
  const activeFlaggedIds = useMemo(() => {
    if (flaggedQuestionIds.size === 0) return flaggedQuestionIds
    const invalid = new Set(
      validateWizardQuestions(questions, { adaptive: adaptiveMode }).map((e) => e.clientId),
    )
    return new Set([...flaggedQuestionIds].filter((id) => invalid.has(id)))
  }, [flaggedQuestionIds, questions, adaptiveMode])
  // clientId → why autosave is holding that question back (invalid →
  // editor-only until fixed). The rail marks these "Not saved" with the
  // specific reason, so they don't masquerade as persisted.
  const unsavedReasons = useMemo(() => {
    const reasons = new Map<string, string>()
    for (const q of questions) {
      const reason = wizardQuestionUnsavableReason(q)
      if (reason) reasons.set(q.clientId, reason)
    }
    return reasons
  }, [questions])
  // Bring the offending question into the canvas on a failed save — selecting it
  // in the rail replaces the old wizard's scroll-into-view.
  const selectQuestion = useCallback((clientId: string) => {
    setSelectedId(clientId)
    setHubOpen(false)
    setPreviewOpen(false)
  }, [])
  const draftQuizIdRef = useRef(draftQuizId)
  draftQuizIdRef.current = draftQuizId
  // True while the first createQuizFull is in flight — blocks a second concurrent
  // autosave (debounce / question-change / step-nav) from creating a duplicate quiz row.
  const creatingRef = useRef(false)
  // Coordinate the autosave with publish/save so they never insert the same
  // client-UUID question row twice (duplicate PK → "Failed to create
  // questions", #323). `publishingRef` makes the background autosave stand
  // down while a publish/save runs; `inFlightSaveRef` lets that publish await
  // an autosave that was already running when it started.
  const publishingRef = useRef(false)
  const inFlightSaveRef = useRef<Promise<void> | null>(null)
  const questionsRef = useRef(questions)
  questionsRef.current = questions

  // Collect form+question state into a serializable snapshot for change detection.
  // Includes question content and all quiz settings so edits trigger auto-save.
  const getSnapshot = useCallback(() => {
    const v = form.getValues()
    // Snapshot exactly what would be persisted — every field wizardToServerInput
    // carries must count as a change. Enumerating a subset here silently drops
    // edits: a rubric-only (or opening-/accepted-answer-only) edit deduped to
    // "no change" and never saved.
    const qSnapshot = questionsRef.current.map(wizardToServerInput)
    return JSON.stringify({
      title: v.title,
      description: v.description,
      questions: qSnapshot,
      // Quiz settings — ensure config changes trigger autosave
      timeLimitMinutes: v.timeLimitMinutes,
      maxAttempts: v.maxAttempts,
      passThreshold: v.passThreshold,
      dueDate: v.dueDate,
      scheduledPublishAt: v.scheduledPublishAt,
      shuffleQuestions: v.shuffleQuestions,
      shuffleAnswers: v.shuffleAnswers,
      showExplanations: v.showExplanations,
      showLeaderboard: v.showLeaderboard,
      allowFormulaSheet: v.allowFormulaSheet,
      formulaSheetUrl: v.formulaSheetUrl,
      formulaSheetPath: v.formulaSheetPath,
      negativeMarking: v.negativeMarking,
      negativeMarkingPenalty: v.negativeMarkingPenalty,
      proctoringEnabled: v.proctoringEnabled,
      videoProctoringEnabled: v.videoProctoringEnabled,
      adaptiveMode: v.adaptiveMode,
      adaptiveQuestionCount: v.adaptiveQuestionCount,
      selectLambda: v.selectLambda,
      stopMode: v.stopMode,
      targetSe: v.targetSe,
      showRatingToStudents: v.showRatingToStudents,
    })
  }, [form])

  const lastSnapshotRef = useRef(getSnapshot())
  // What the studio looked like on mount — used to skip creating a draft row
  // when nothing was ever touched.
  const initialSnapshotRef = useRef(lastSnapshotRef.current)

  /** The quiz-row payload for create/update, from current form values. Shared
   *  by the autosave and by ensureDraftForGeneration so the two can never
   *  drift. An unnamed quiz drafts as "Untitled quiz". */
  const buildQuizPayload = useCallback(() => {
    const values = form.getValues()
    return {
      title: values.title?.trim() || 'Untitled quiz',
      description: values.description,
      timeLimitMinutes: values.timeLimitMinutes,
      shuffleQuestions: values.shuffleQuestions,
      shuffleAnswers: values.shuffleAnswers,
      maxAttempts: values.maxAttempts,
      passThreshold: values.passThreshold,
      dueDate: values.dueDate,
      scheduledPublishAt: values.publishMode === 'scheduled' ? values.scheduledPublishAt : null,
      showExplanations: values.showExplanations,
      showLeaderboard: values.showLeaderboard,
      allowFormulaSheet: values.allowFormulaSheet,
      formulaSheetUrl: values.formulaSheetUrl,
      formulaSheetPath: values.formulaSheetPath,
      negativeMarking: values.negativeMarking,
      negativeMarkingPenalty: values.negativeMarkingPenalty,
      proctoringEnabled: values.proctoringEnabled,
      videoProctoringEnabled: values.videoProctoringEnabled,
      adaptiveMode: values.adaptiveMode,
      adaptiveQuestionCount: values.adaptiveQuestionCount,
      selectLambda: values.selectLambda,
      stopMode: values.stopMode,
      targetSe: values.targetSe,
      showRatingToStudents: values.showRatingToStudents,
    }
  }, [form])

  // ── Generation marker ────────────────────────────────────────
  // A per-tab record that a server-side generation is (probably) still
  // filling a draft. Set when a generation starts, cleared when its stream
  // finishes or a resumed poll settles. Survives reloads — it's how a studio
  // that lost its stream (reload, navigation) finds the run again instead of
  // stranding the professor.
  const genMarkerKey = `scholera-gen-${sectionId}`
  const readGenMarker = useCallback((): { quizId: string; at: number } | null => {
    try {
      const raw = sessionStorage.getItem(genMarkerKey)
      if (!raw) return null
      const m = JSON.parse(raw) as { quizId?: string; at?: number }
      if (!m.quizId || !m.at) return null
      if (Date.now() - m.at > 15 * 60_000) return null // stale — run long over
      return { quizId: m.quizId, at: m.at }
    } catch {
      return null
    }
  }, [genMarkerKey])
  const writeGenMarker = useCallback(
    (id: string) => {
      try {
        sessionStorage.setItem(genMarkerKey, JSON.stringify({ quizId: id, at: Date.now() }))
      } catch {
        // storage unavailable — recovery just won't be offered
      }
    },
    [genMarkerKey],
  )
  const clearGenMarker = useCallback(
    (id?: string) => {
      try {
        if (!id || readGenMarker()?.quizId === id) sessionStorage.removeItem(genMarkerKey)
      } catch {
        // ignore
      }
    },
    [genMarkerKey, readGenMarker],
  )

  /** Persist current state as a draft (create or update). Called by debounce timer. */
  const saveDraft = useCallback(async () => {
    // A publish/save is running — it owns persistence and will insert these
    // questions itself. Bailing here stops the background autosave from racing
    // it with a second insert of the same client-UUID rows (#323).
    if (publishingRef.current) return
    const values = form.getValues()
    // Autosave never waits for a title — an unnamed quiz drafts as "Untitled
    // quiz" via buildQuizPayload (the real name is confirmed in the publish
    // dialog before students see it).

    // No draft row yet and a create is already in flight — skip. The in-flight
    // create establishes the id; the next autosave persists any delta. This is
    // what prevents two concurrent autosaves from each creating a quiz row.
    if (!draftQuizIdRef.current && creatingRef.current) return

    const snapshot = getSnapshot()
    if (snapshot === lastSnapshotRef.current && draftQuizIdRef.current) return // no changes
    // Don't create a row for an untouched studio — a mere visit to /quizzes/new
    // shouldn't leave an "Untitled quiz" draft behind. (Kept separate from the
    // guard above so a failed first create still retries once state changed.)
    if (!draftQuizIdRef.current && snapshot === initialSnapshotRef.current) return
    // …and don't create one for a quiz with nothing a professor would miss:
    // no questions, no title, no description (Gmail-style — empty drafts are
    // never saved). Settings tinkering stays in memory and is persisted with
    // the first real content.
    if (
      !draftQuizIdRef.current &&
      questionsRef.current.length === 0 &&
      !values.title?.trim() &&
      !values.description?.trim()
    ) {
      return
    }
    lastSnapshotRef.current = snapshot

    setDraftSaving(true)
    setDraftError(false)
    // Any action returning { error } (e.g. a too-long description) flips this so
    // we surface a failure instead of silently showing "Saved".
    let sawError = false
    // Publish awaits this so its inserts can't race ours (#323). Set before the
    // first await; resolved in the finally below.
    let resolveInFlight: (() => void) | undefined
    inFlightSaveRef.current = new Promise<void>((res) => {
      resolveInFlight = res
    })
    try {
      const quizPayload = buildQuizPayload()

      let targetId = draftQuizIdRef.current

      if (!targetId) {
        // First save — create the draft
        creatingRef.current = true
        const result = await createQuizFull(sectionId, quizPayload)
        if (result.error || !result.data) {
          setDraftError(true)
          return
        }
        targetId = result.data.id
        // Sync the ref immediately (not just state) so a concurrent or next-up
        // saveDraft reuses this id instead of creating a second row.
        draftQuizIdRef.current = targetId
        setDraftQuizId(targetId)
      } else {
        // Subsequent saves — update existing draft
        const r = await updateQuiz(sectionId, targetId, quizPayload)
        if (r?.error) sawError = true
      }

      // Save questions if any exist
      const currentQuestions = questionsRef.current
      if (currentQuestions.length > 0 && targetId) {
        const newQuestions = currentQuestions.filter((q) => !q.dbId)
        // Correlate created rows back to client questions by id: we pass each
        // question's clientId as the row id, so created.id === q.clientId.
        // Skip-/order-proof (no positional drift, no questionText collisions).
        const createdIds = new Set<string>()
        if (newQuestions.length > 0) {
          const inputs = newQuestions.map(wizardToServerInput)
          // On a DRAFT, persist even blank/incomplete questions (tagged
          // is_complete=false) so placeholders survive navigation. On a LIVE
          // quiz (published/scheduled) keep the strict path — an incomplete
          // question must never reach students.
          const bulkResult = await bulkCreateQuestions(sectionId, inputs, !isLive)
          // Background draft save — stay quiet about questions still mid-edit
          // (on a live quiz a skipped one isn't persisted yet; it stays in the
          // editor and saves once valid). Publish surfaces a blocking error.
          if (!bulkResult.error) {
            for (const created of bulkResult.data) createdIds.add(created.id)
            // Update local questions with DB IDs so they aren't re-created
            const updated = currentQuestions.map((q) =>
              !q.dbId && createdIds.has(q.clientId) ? { ...q, dbId: q.clientId } : q,
            )
            // Sync the ref imperatively (not just next render) so a publish
            // awaiting this save reads the new dbIds immediately and treats
            // these as existing rows to update — never re-inserts them (#323).
            questionsRef.current = updated
            // Update via the parent setter (questionsRef stays in sync next render)
            setQuestions(updated)
          }
        }
        // Sync full content on existing questions (image, code, text, etc.).
        // On a DRAFT we persist incomplete edits too (is_complete is recomputed
        // server-side), so a placeholder keeps whatever the professor typed. On
        // a LIVE quiz we NEVER autosave an edit that makes a saved question
        // ungradeable or blank (e.g. unchecking the only correct MCQ choice, or
        // clearing the stem) — those stay in the editor until fixed; handleSave
        // still hard-blocks. The rail marks held-back ones "Not saved".
        const existingQuestions = currentQuestions.filter((q) => q.dbId)
        const persistable = isLive
          ? existingQuestions.filter((q) => !wizardQuestionUnsavable(q))
          : existingQuestions
        if (persistable.length > 0) {
          const r = await bulkUpdateQuestionContent(sectionId, persistable.map(wizardToContentUpdate))
          if (r?.error) sawError = true
        }

        // Assignment sync is a DESTRUCTIVE rewrite (delete-all + reinsert from
        // local state) — suspended while the generation route is appending
        // assignments server-side, or a rewrite from a state snapshot that
        // predates a batch would wipe that batch off the quiz. The route owns
        // assignments during that window; a full ordered sync runs when
        // generation settles (see startAIGeneration's finally).
        if (!assignmentsLockedRef.current) {
          const orderedIds: string[] = []
          for (const q of currentQuestions) {
            if (q.dbId) {
              orderedIds.push(q.dbId)
            } else if (createdIds.has(q.clientId)) {
              orderedIds.push(q.clientId)
            }
          }
          if (orderedIds.length > 0) {
            const r = await updateQuizQuestions(sectionId, targetId, orderedIds)
            if (r?.error) sawError = true
          }
        }
      }

      if (sawError) {
        setDraftError(true)
      } else {
        setLastDraftSavedAt(Date.now())
      }
    } catch {
      setDraftError(true)
      // Show a subtle warning so professor knows draft may not be saved
      toast.warning('Auto-save failed — your changes may not be saved yet.')
    } finally {
      creatingRef.current = false
      setDraftSaving(false)
      inFlightSaveRef.current = null
      resolveInFlight?.()
    }
  }, [form, getSnapshot, sectionId, setQuestions, isLive, buildQuizPayload])

  /** Schedule a draft save shortly after the last edit — frequent enough that
   *  the "Draft saved" badge feels live (Notion-style), long enough to batch
   *  a burst of typing into one round of server calls. */
  // Keep a live handle to the latest saveDraft so the unmount flush below —
  // which must have empty deps to fire only on unmount — never calls a stale one.
  const saveDraftRef = useRef(saveDraft)
  saveDraftRef.current = saveDraft

  const scheduleDraftSave = useCallback(() => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    // Null the ref when the timer fires so `draftTimerRef.current` reliably means
    // "a save is still pending" — which the unmount flush relies on.
    draftTimerRef.current = setTimeout(() => {
      draftTimerRef.current = null
      saveDraft()
    }, 3_000)
  }, [saveDraft])

  // Watch for form changes to trigger auto-draft
  useEffect(() => {
    const subscription = form.watch(() => scheduleDraftSave())
    return () => subscription.unsubscribe()
  }, [form, scheduleDraftSave])

  // Watch for question changes (content or count) to trigger auto-draft.
  // The wizard flushed on step navigation; with no steps, edits themselves
  // schedule the save (getSnapshot dedupes no-op saves).
  useEffect(() => {
    scheduleDraftSave()
  }, [questions, scheduleDraftSave])

  // On unmount, flush a pending save so navigating away within the debounce
  // window doesn't silently drop unsaved edits. The dispatched server-action
  // fetch completes past unmount; saveDraft's own guards (snapshot dedup,
  // empty-draft skip) keep an untouched-then-left studio from creating a row.
  useEffect(() => {
    return () => {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current)
        void saveDraftRef.current()
      }
    }
  }, [])

  // On unmount, detach the generation VIEW — the stream must never keep
  // feeding a studio that no longer exists (the "new quiz showed the old
  // quiz's questions" bug). The server run continues and persists to its
  // draft; the bell notification reports completion.
  useEffect(() => {
    return () => {
      genAbortRef.current?.abort()
    }
  }, [])

  const backUrl = `/professor/courses/${sectionId}/quizzes`

  const handleAIMetadata = useCallback(
    (metadata: { title: string; description: string }) => {
      // Only fill if fields are still empty (don't overwrite manual input) —
      // the title/description are visible in the studio header for review.
      const currentTitle = form.getValues('title')
      const currentDesc = form.getValues('description')
      if (!currentTitle && metadata.title) {
        form.setValue('title', metadata.title)
      }
      if (!currentDesc && metadata.description) {
        form.setValue('description', metadata.description)
      }
    },
    [form],
  )

  // ── Question handlers (add / ingest / edit / remove) ───────
  const handleAddType = useCallback(
    (type: QuizItemType) => {
      const newQ = createBlankQuestion(type)
      setQuestions((prev) => [...prev, newQ])
      setStickyType(type)
      selectQuestion(newQ.clientId)
      // Drop the caret straight into the new question's text — the one-click
      // authoring promise, and it keeps focus from falling to <body> when the
      // add hub unmounts. Delay lets the card mount first.
      setTimeout(() => {
        document
          .querySelector<HTMLTextAreaElement>('#studio-canvas textarea')
          ?.focus()
      }, 100)
      return newQ.clientId
    },
    [selectQuestion],
  )

  const existingDbIds = new Set(questions.filter((q) => q.dbId).map((q) => q.dbId!))

  const handlePickFromBank = useCallback(
    (selected: Question[]) => {
      const ids = new Set(questions.filter((q) => q.dbId).map((q) => q.dbId!))
      const newQuestions = selected.filter((q) => !ids.has(q.id)).map(questionToWizard)
      if (newQuestions.length > 0) {
        setQuestions((prev) => [...prev, ...newQuestions])
        selectQuestion(newQuestions[0].clientId)
      }
    },
    [questions, selectQuestion],
  )

  /** The stream died but the server generation continues persisting to the
   *  draft — poll the quiz's assignments and merge new arrivals into the rail
   *  until they stop, so "interrupted" becomes "reattached" instead of lost
   *  work. Owns unlocking the assignment sync when it settles. */
  // Athena refuses edits while a run streams and promises to do them "as soon as it
  // finishes" — but nothing pulls a fresh screen until the professor speaks again, so she
  // would keep saying that forever. Telling her the run settled is what makes the promise
  // true, and it is also the only place the professor learns the run came up short now
  // that the shortfall banner is gone.
  const notifyAthena = useAthenaNotify()
  const { setOpen: setAthenaOpen } = useAthenaDock()
  const reportGenerationSettled = useCallback(
    (delivered: number, requested: number) => {
      const short = requested > 0 && delivered < requested
      notifyAthena(
        short
          ? `Generation finished: ${delivered} of the ${requested} questions asked for — the material ran dry. I can pull from more lectures, or write the rest from general knowledge on the same topics. Anything you asked me to hold, say the word and I'll do it now.`
          : `Generation finished: ${delivered} ${delivered === 1 ? 'question' : 'questions'} are on the quiz. Anything you asked me to hold, say the word and I'll do it now.`,
      )
    },
    [notifyAthena],
  )

  const reattachDetachedGeneration = useCallback(
    async (quizIdToPoll: string) => {
      setGenReattaching(true)
      try {
        // Poll until the SERVER confirms the run is over (generation_started_at
        // cleared) — NOT a guess based on how long questions have paused. This
        // keeps the generating banner up the whole time (across reloads and
        // navigation) and merges each new batch as it lands, only stopping when
        // the generation actually finishes, errors out, or the quiz is gone.
        // 90 × 8s = 12-min hard backstop (a run can't outlast the 5-min route
        // ceiling, but the stamp's own 15-min cutoff is the real floor).
        // Captured across polls for the settle summary below: the server
        // clears generation_total/started_at when the run ends, so the LAST
        // in-flight values are the only record this watching tab has.
        let lastTarget = 0
        let runStartedMs: number | null = null
        for (let i = 0; i < 90; i++) {
          // Poll FIRST, wait AFTER — so the "N of M" counter appears on the
          // first round-trip, not 8s later.
          const st = await getQuizGenerationState(sectionId, quizIdToPoll)
          const ids = st.data?.questionIds ?? []
          // Same "N of M ready" counter + fading rail chips as the live stream:
          // the server stamped the target total at start (existing + requested).
          if (st.data?.total) {
            setGenRequested(st.data.total)
            lastTarget = st.data.total
          }
          // Adopt the server's start stamp (once) so the elapsed clock shows
          // the run's real age, not time-since-reattach.
          const serverStart = st.data?.startedAt ? new Date(st.data.startedAt).getTime() : null
          if (serverStart) {
            setGenStartedAt((cur) => cur ?? serverStart)
            if (!runStartedMs) runStartedMs = serverStart
          }
          const known = new Set(questionsRef.current.map((q) => q.dbId).filter(Boolean))
          const freshIds = ids.filter((id) => !known.has(id))
          // Post-merge page count, captured inside the (race-proof) updater. Start
          // from the current length in case there's nothing fresh this round.
          let shown = questionsRef.current.length
          if (freshIds.length > 0) {
            const bank = await getQuestions(sectionId)
            const byId = new Map((bank.data ?? []).map((q) => [q.id, q]))
            const mapped = freshIds
              .map((id) => byId.get(id))
              .filter((q): q is NonNullable<typeof q> => !!q)
              .map(questionToWizard)
            if (mapped.length > 0) {
              // mergeQuestions dedupes against whatever's already there — vital
              // because a live stream in THIS tab may be appending the same
              // server-persisted questions concurrently (the `known` pre-filter
              // above is only a fetch optimization; it can be stale).
              setQuestions((prev) => {
                const next = mergeQuestions(prev, mapped)
                shown = next.length
                return next
              })
            }
          }
          // Count what's actually on the page after this merge, NOT the server's
          // raw id count: an id can be persisted (in questionIds) before its row
          // is mappable from the bank, so ids.length can run ahead of the cards
          // shown. Tying the counter to the rendered total keeps "N of M ready"
          // in lock-step with the questions the professor sees.
          setGenReceived(shown)
          // Definitive stop: the server says the generation is no longer running
          // (finished/errored) or the quiz no longer exists. The last poll above
          // already merged the final batch before we saw the flag clear. Surface
          // the shortfall notice from the server the moment the run settles —
          // this tab only watched the run, so without this the "supported N of M"
          // bar wouldn't appear until a manual reload.
          if (!st.data || !st.data.generating) {
            setNotice(st.data?.notice ?? null)
            // A settled run with no shortfall notice leaves the same
            // dismissible done-summary the live stream would have — without
            // this, a detached run (reload, HMR recompile, dropped connection)
            // just vanishes at the end with no completion cue. Counts mirror
            // this banner's own whole-quiz counter ("N of M ready"); tokens
            // are unknown to a watching tab, so the meter is simply omitted.
            if (st.data && !st.data.notice && lastTarget > 0 && shown > 0) {
              setGenSummary({
                delivered: shown,
                requested: lastTarget,
                durationMs: runStartedMs ? Date.now() - runStartedMs : null,
                tokens: 0,
              })
            }
            if (shown > 0) reportGenerationSettled(shown, lastTarget)
            break
          }
          await new Promise((r) => setTimeout(r, 8000))
        }
      } finally {
        setGenReattaching(false)
        setGenRequested(0)
        setGenReceived(0)
        setGenStartedAt(null)
        clearGenMarker(quizIdToPoll)
        assignmentsLockedRef.current = false
        // Resume normal autosave with one full ordered sync.
        lastSnapshotRef.current = ''
        scheduleDraftSave()
      }
      // No completion toast here: the server fires the bell notification
      // ("N AI questions ready") when a run finishes, from anywhere in the app —
      // a green toast on top of it is a duplicate (and a reattach that fires on
      // several returns would stack several).
    },
    [sectionId, setQuestions, scheduleDraftSave, clearGenMarker, reportGenerationSettled],
  )

  const startAIGeneration = useCallback(
    async (req: AIGenRequest) => {
      // One generation at a time per studio. A second concurrent run would feed
      // two streams into the same quiz and both would race the settle-time
      // assignment rewrite (updateQuizQuestions is destructive) — orphaning the
      // just-generated questions. Athena refuses to call generate_questions while a run
      // is live; this is the backstop for any other entry.
      if (generating) {
        toast.info('AI is already generating for this quiz — it’ll finish shortly.')
        return
      }
      setHubOpen(false)
      // The draft must exist BEFORE generation starts so the server can
      // persist every batch to it: reload/navigation/crash mid-run then loses
      // nothing. Starting a generation is itself the fingerprint that earns a
      // draft row (and its URL).
      let targetQuizId = draftQuizIdRef.current
      if (!targetQuizId && creatingRef.current) {
        // An autosave create is in flight — give it a moment to land.
        for (let i = 0; i < 20 && !draftQuizIdRef.current; i++) {
          await new Promise((r) => setTimeout(r, 250))
        }
        targetQuizId = draftQuizIdRef.current
      }
      if (!targetQuizId) {
        creatingRef.current = true
        try {
          const result = await createQuizFull(sectionId, buildQuizPayload())
          if (result.error || !result.data) {
            toast.error('Could not prepare a draft for generation. Please try again.')
            return
          }
          targetQuizId = result.data.id
          draftQuizIdRef.current = targetQuizId
          setDraftQuizId(targetQuizId)
        } finally {
          creatingRef.current = false
        }
      }

      // Count against the quiz's FULL target, not just this batch: an append or
      // beyond-document fill onto a quiz that already has questions shows
      // "21 of 30 ready" (existing + requested), not "0 of 9". Matches the
      // server's generation_total stamp and the reattach counter. A fresh run on
      // an empty quiz naturally reads "0 of N".
      const genBase = questionsRef.current.length
      setGenActive(true)
      setGenRequested(genBase + req.questionCount)
      setGenReceived(genBase)
      setGenStatus(null)
      setGenTokens(0)
      setGenSummary(null)
      setGenStartedAt(Date.now())
      // Record the run so a studio that loses this stream (reload, navigation)
      // can find it again.
      writeGenMarker(targetQuizId)
      // The route appends assignments as it persists batches — suspend the
      // autosave's destructive assignment rewrite until generation settles.
      assignmentsLockedRef.current = true
      const abort = new AbortController()
      genAbortRef.current = abort
      let firstBatch = true
      let sawError = false
      let detached = false
      let unmounted = false
      // Token total captured locally (not from genTokens state) so the done
      // handler reads the final value without a state-read race.
      let runTokens = 0
      try {
        const res = await fetch('/api/quizzes/generate-stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...req, sectionId, quizId: targetQuizId }),
          signal: abort.signal,
        })
        if (!res.ok || !res.body) {
          // The route refuses with a plain-text reason (403: the AI kill switch
          // names who disabled it) — surface it; "try again" can't fix policy.
          const reason = res.ok ? '' : (await res.text().catch(() => '')).trim()
          toast.error(
            reason && reason.length <= 200 ? reason : 'Could not start generation. Please try again.',
          )
          return
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        // NDJSON: one JSON message per line; the last split fragment may be
        // partial, so it's kept in `buf` until the next chunk completes it.
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            let msg: {
              type: string
              questions?: (GeneratedQuestion & { dbId?: string | null })[]
              metadata?: { title: string; description: string } | null
              message?: string
              tokens?: number
              total?: number
              requested?: number
              durationMs?: number
              exhausted?: boolean
              rateLimited?: boolean
              extendedCount?: number
              notice?: GenerationNotice | null
              error?: string
            }
            try {
              msg = JSON.parse(line)
            } catch {
              continue
            }
            if (msg.type === 'batch' && msg.questions?.length) {
              // Questions arrive ALREADY PERSISTED to the draft (dbId set) —
              // fully editable, and the autosave knows not to re-create them.
              const mapped = msg.questions.map((q) => {
                const w = mapGeneratedToWizard(q)
                return q.dbId ? { ...w, clientId: q.dbId, dbId: q.dbId } : w
              })
              // Dedupe inside the updater: if a reattach poll already merged this
              // server-persisted batch, appending it again would collide on the
              // shared dbId-as-clientId key.
              setQuestions((prev) => mergeQuestions(prev, mapped))
              setGenReceived((n) => n + mapped.length)
              setGenStatus(null)
              // Select the very first question so the editor opens on it; later
              // batches append without stealing the professor's current selection.
              if (firstBatch) {
                selectQuestion(mapped[0].clientId)
                firstBatch = false
              }
            } else if (msg.type === 'status' && msg.message) {
              setGenStatus(msg.message)
            } else if (msg.type === 'usage' && typeof msg.tokens === 'number') {
              runTokens = msg.tokens
              setGenTokens(msg.tokens)
            } else if (msg.type === 'done') {
              if (msg.metadata) handleAIMetadata(msg.metadata)
              // Full delivery keeps the blue bar up as a dismissible summary.
              // A shortfall doesn't — its summary is the notice banner below.
              if (!msg.notice && typeof msg.total === 'number' && msg.total > 0) {
                setGenSummary({
                  delivered: msg.total,
                  requested: msg.requested ?? msg.total,
                  durationMs: msg.durationMs ?? null,
                  tokens: runTokens,
                })
              }
              // Tell Athena either way — a SHORT run is exactly when she must speak up.
              reportGenerationSettled(
                msg.notice?.delivered ?? msg.total ?? 0,
                msg.notice?.requested ?? msg.requested ?? msg.total ?? 0,
              )
              // The persistent shortfall notice (offering the topic-based fill)
              // is authoritative: the route sets it when the source ran dry and
              // the professor hasn't opted in, and clears it otherwise. Mirror it
              // now so the banner reflects this run without waiting for a reload.
              setNotice(msg.notice ?? null)
              // An honest shortfall gets an explanation, not a mystery. A rate
              // limit is a distinct cause from exhausted material — retrying
              // gets the rest, so don't tell the professor to add more sources.
              if (msg.rateLimited && typeof msg.total === 'number' && typeof msg.requested === 'number') {
                toast.warning(
                  `The AI hit its limit, so only ${msg.total} of the ${msg.requested} requested were generated. Wait a minute and generate again for the rest.`,
                  { duration: 10000 },
                )
              } else if (msg.extendedCount && msg.extendedCount > 0) {
                toast.success(
                  `Added ${msg.extendedCount} topic-based question${msg.extendedCount === 1 ? '' : 's'} beyond your material — they're tagged "AI-extended" for review.`,
                  { duration: 8000 },
                )
              }
              // No exhausted-shortfall toast: the persistent notice banner
              // (setNotice above) already explains it in place with the
              // beyond-document action, and the server's bell notification
              // carries the same sentence — a third copy was pure noise. The
              // rate-limit and AI-extended toasts stay: each carries advice
              // that exists on no other surface.
            } else if (msg.type === 'error') {
              sawError = true
              toast.error(msg.error || 'Generation failed.')
            }
          }
        }
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') {
          // This studio instance is going away (unmount) — the server keeps
          // generating and persisting to the draft; the bell notification
          // reports completion. Assignments stay LOCKED so the unmount flush
          // can't rewrite them from a snapshot missing the later batches.
          unmounted = true
        } else if (!sawError) {
          // Connection lost mid-stream, but the server keeps generating into
          // the draft — reattach by polling instead of declaring losses.
          detached = true
          toast.info('Connection to the generation was lost — it continues in the background and this quiz will keep filling in.', { duration: 8000 })
        }
      } finally {
        if (genAbortRef.current === abort) genAbortRef.current = null
        if (!unmounted) {
          setGenActive(false)
          setGenRequested(0)
          setGenReceived(0)
          setGenStatus(null)
          setGenTokens(0)
          setGenStartedAt(null)
          if (detached) {
            // Run continues server-side — the reattach poll owns the marker.
            void reattachDetachedGeneration(targetQuizId)
          } else {
            // Stream concluded (done or error) — the run is over.
            clearGenMarker(targetQuizId)
            assignmentsLockedRef.current = false
            // One full ordered sync now that the route stopped appending —
            // persists any reorders/edits made during generation and
            // normalizes assignment positions.
            lastSnapshotRef.current = ''
            scheduleDraftSave()
          }
        }
      }
    },
    [sectionId, selectQuestion, handleAIMetadata, buildQuizPayload, scheduleDraftSave, reattachDetachedGeneration, writeGenMarker, clearGenMarker, generating, reportGenerationSettled],
  )

  // On mount, look for a generation this tab started that's (probably) still
  // running server-side, and resume the "still generating" view for it.
  useEffect(() => {
    const marker = readGenMarker()
    const markerHere = !!marker && mode === 'edit' && quizId === marker.quizId

    // Resume the "still generating" view if THIS quiz has a run in flight —
    // known from this tab's marker OR, robustly, from the server's generation
    // flag at page load (covers a fresh tab / another device / an expired
    // marker). Keeps the banner + shimmer up and polls new questions in until
    // the server says the run is done.
    if ((markerHere || initiallyGenerating) && mode === 'edit' && quizId) {
      assignmentsLockedRef.current = true
      // No toast here: on return the generating banner + counter + fading chips
      // already show the run is live, so a popup saying the same is just noise.
      // The bell notification (server-side) covers being told it's done from
      // anywhere else in the app.
      void reattachDetachedGeneration(quizId)
      return
    }

    // A marker for a DIFFERENT draft (the studio's on another quiz): point the
    // professor at the still-filling draft instead of hijacking this one.
    if (marker && !markerHere) {
      toast.info('An AI generation is still running on another draft quiz.', {
        duration: 12_000,
        action: {
          label: 'Open it',
          onClick: () => router.push(`/professor/courses/${sectionId}/quizzes/${marker.quizId}`),
        },
      })
    }
    // Once on mount, deliberately — marker state is a mount-time concern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleJSONImported = useCallback(
    (imported: WizardQuestion[]) => {
      setQuestions((prev) => [...prev, ...imported])
      if (imported.length > 0) selectQuestion(imported[0].clientId)
    },
    [selectQuestion],
  )

  const handleQuestionChange = useCallback((clientId: string, updated: WizardQuestion) => {
    setQuestions((prev) => prev.map((q) => (q.clientId === clientId ? updated : q)))
  }, [])

  // ── Athena seam ─────────────────────────────────────────────────
  // Athena writes through the SAME two channels the professor's own hands use
  // (setQuestions + form.setValue), so the existing debounced autosave persists her edits
  // with no new write path. Three rules make that safe:
  //  1. Question ops apply inside a FUNCTIONAL update. A generation batch merges with
  //     setQuestions((prev) => …) too, so applying to a closed-over array could erase a
  //     batch that landed in the same frame.
  //  2. Nothing is applied while a generation run is in flight — the run appends
  //     server-side with the assignment sync suspended, so a concurrent edit can leave
  //     questions created-but-unlinked. Enforced HERE, not just in the prompt.
  //  3. generate_questions is a hand-off to the existing streaming run, not a write.
  const athenaSettings = useCallback((): QuizAthenaSettings => {
    const v = form.getValues()
    return {
      title: v.title,
      description: v.description,
      timeLimitMinutes: v.timeLimitMinutes,
      maxAttempts: v.maxAttempts,
      passThreshold: v.passThreshold,
      dueDate: v.dueDate,
      shuffleQuestions: v.shuffleQuestions,
      shuffleAnswers: v.shuffleAnswers,
      showExplanations: v.showExplanations,
      negativeMarking: v.negativeMarking,
      negativeMarkingPenalty: v.negativeMarkingPenalty,
      adaptiveMode: v.adaptiveMode,
      isPublished,
    }
  }, [form, isPublished])

  const getAthenaScreen = useCallback(
    (): AssignmentScreen => ({
      authoring: serializeQuizForAthena(questionsRef.current, athenaSettings(), {
        isGenerating: generatingRef.current,
        generatedSoFar: genReceivedRef.current,
        requested: genRequestedRef.current,
        lastRun: noticeRef.current
          ? { requested: noticeRef.current.requested, delivered: noticeRef.current.delivered }
          : undefined,
      }),
    }),
    [athenaSettings],
  )

  const onAthenaFill = useCallback(
    (tool: AssignmentFillTool, payload: unknown): FillResult => {
      if (generatingRef.current || athenaGenPendingRef.current) {
        return {
          summary: 'The quiz is locked while questions are generating — I’ll make that change as soon as it finishes.',
          applied: false,
        }
      }

      if (tool === 'apply_edits') {
        const { ops } = (payload ?? {}) as { ops?: QuizOp[] }
        if (!ops?.length) return { summary: 'No changes.', applied: false }
        // Dry run against the latest render for the chip + undo snapshot; the authoritative
        // write goes through a functional update so a batch that merged in the same frame
        // can never be clobbered by a stale closure.
        const before = questionsRef.current
        const opts = { adaptiveMode: form.getValues('adaptiveMode') }
        const preview = applyQuizOps(before, ops, opts)
        if (preview.changed === 0) return { summary: preview.summary, applied: false }
        // applyQuizOps is pure but NOT deterministic — createBlankQuestion mints a fresh
        // crypto.randomUUID per question. Re-running it would produce different clientIds
        // than the ones in `preview`, so `touchedId` would select a question that doesn't
        // exist. Reuse the dry-run result whenever React's state is still the array we ran
        // against (the overwhelmingly common case); only recompute if it moved underneath.
        setQuestions((prev) => (prev === before ? preview.questions : applyQuizOps(prev, ops, opts).questions))
        if (preview.touchedId) selectQuestion(preview.touchedId)

        // Undo restores a whole snapshot, which is only safe while nothing else has touched
        // the array. A generation run appends persisted questions, so a later Undo would
        // wipe them from the quiz — and the next autosave's destructive assignment rewrite
        // would then unlink them for real. Refuse instead of silently deleting.
        const expectedLength = preview.questions.length
        return {
          summary: preview.summary,
          undo: () => {
            if (questionsRef.current.length !== expectedLength) {
              toast.info('Too much has changed since then to undo it safely — tell Athena what to put back.')
              return
            }
            setQuestions(before)
          },
        }
      }

      if (tool === 'set_quiz_settings') {
        const before = athenaSettings()
        const { values, summary, changed } = applyQuizSettings(before, (payload ?? {}) as QuizSettingsPayload)
        if (changed === 0) return { summary, applied: false }
        for (const [key, value] of Object.entries(values)) {
          form.setValue(key as keyof WizardFormValues, value as never, { shouldDirty: true })
        }
        return {
          summary,
          undo: () => {
            for (const [key, value] of Object.entries(before)) {
              form.setValue(key as keyof WizardFormValues, value as never, { shouldDirty: true })
            }
          },
        }
      }

      if (tool === 'generate_questions') {
        const req = (payload ?? {}) as GenerateQuestionsPayload
        if (!req.moduleItemIds?.length) {
          return { summary: 'I need at least one lecture file to generate from.', applied: false }
        }
        athenaGenPendingRef.current = true
        void startAIGeneration({
          moduleItemIds: req.moduleItemIds,
          additionalFilePaths: [],
          questionCount: Math.min(req.count ?? 10, ATHENA_MAX_GENERATED),
          customPrompt: req.customPrompt,
          questionTypes: req.questionTypes,
          beyondDocument: req.beyondDocument,
          includeMetadata: questionsRef.current.length === 0,
        }).finally(() => {
          // If it bailed before genActive ever flipped (already generating, no draft row),
          // release the lock — otherwise the canvas would stay frozen with no run to wait for.
          if (!generatingRef.current) athenaGenPendingRef.current = false
        })
        const n = Math.min(req.count ?? 10, ATHENA_MAX_GENERATED)
        // No undo: the run is already in flight server-side, and its questions are
        // persisted batch by batch. Removing them is a normal edit afterwards.
        return { summary: `Generating ${n} ${n === 1 ? 'question' : 'questions'}…` }
      }

      return { summary: 'Nothing to apply.', applied: false }
    },
    [athenaSettings, form, selectQuestion, startAIGeneration],
  )

  /** A PDF dropped into Athena becomes a real course-material item (the same path the
   *  generate dialog used), so the generation pipeline can read it and cite its pages. */
  const onAthenaAttach = useCallback(
    async (file: File): Promise<AttachResult> => {
      const upload = await uploadFile(file, `${sectionId}/quiz-ai-uploads`)
      if (upload.error || !upload.data) {
        return { error: 'That file could not be uploaded. Try again in a moment.' }
      }
      const res = await registerQuizUpload(sectionId, upload.data.path, file.name)
      if (res.error || !res.data) {
        void deleteFile(upload.data.path)
        return { error: res.error ?? 'That file could not be added to the course material.' }
      }
      return {
        name: file.name,
        // No raw id in the copy: the upload becomes a REAL module item, so Athena picks
        // its id up from list_modules like any other lecture file. Cleaner for the
        // professor, and one channel for source ids instead of two.
        //
        // The panel has ALREADY staged the same file as a chat attachment, so Athena can
        // read it on the next send. This note covers the extra thing this surface does
        // with it: bulk generation needs a module id, which only this path produces.
        note: `📎 I've got **${file.name}** and can read it now. I also added it to your course material — once it finishes processing I can generate questions from it in bulk, with page citations.`,
      }
    },
    [sectionId],
  )

  useAthenaSurface({
    active: true,
    surface: 'authoring',
    kind: 'quiz',
    assignmentId: quizId,
    getScreen: getAthenaScreen,
    onFill: onAthenaFill,
    onAttach: onAthenaAttach,
  })

  /** Set every question's points (the pts popover's "apply to all"). A bulk
   *  overwrite of mostly off-screen values — confirm with a toast and make it
   *  recoverable with Undo (snapshot outside the updater; keyed by clientId so
   *  add/remove between apply and undo can't misalign it). */
  const applyPointsToAll = useCallback((points: number) => {
    const before = new Map(questionsRef.current.map((q) => [q.clientId, q.points]))
    setQuestions((prev) => prev.map((q) => ({ ...q, points })))
    toast.success(
      `All ${before.size} questions set to ${points} ${points === 1 ? 'pt' : 'pts'}`,
      {
        action: {
          label: 'Undo',
          onClick: () =>
            setQuestions((prev) =>
              prev.map((q) => ({ ...q, points: before.get(q.clientId) ?? q.points })),
            ),
        },
      },
    )
  }, [])

  const handleRemove = useCallback(
    (clientId: string) => {
      // Compute outside the state updater so the Undo toast fires exactly once
      // (updaters can re-run under StrictMode).
      const prev = questionsRef.current
      const idx = prev.findIndex((q) => q.clientId === clientId)
      if (idx === -1) return
      const removed = prev[idx]
      const next = prev.filter((q) => q.clientId !== clientId)
      // Keep the canvas occupied: select the neighbor that takes this slot
      const neighbor = next[Math.min(idx, next.length - 1)]
      setQuestions(next)
      setSelectedId(neighbor?.clientId ?? null)
      // Deleting is instant — undo beats a confirm dialog for a frequent editing
      // action. (Removal only unlinks from this quiz; the bank row survives, so
      // re-inserting with its dbId intact re-links cleanly on the next save.)
      toast('Question deleted', {
        action: {
          label: 'Undo',
          onClick: () => {
            setQuestions((cur) => {
              const at = Math.min(idx, cur.length)
              return [...cur.slice(0, at), removed, ...cur.slice(at)]
            })
            setSelectedId(removed.clientId)
          },
        },
      })
    },
    [],
  )

  // ── Save / Schedule / Publish ──────────────────────────────
  // Behaviour driven by the publishMode field set in QuizInfoStep.
  const handleSave = useCallback(
    async () => {
      // A generation run owns the quiz's assignments while it's in flight (the
      // route appends batches server-side and the autosave stands down via
      // assignmentsLockedRef). Saving/publishing now would call
      // updateQuizQuestions with THIS tab's view of the questions — which may
      // lag a batch the route already persisted — and the atomic rewrite would
      // orphan those just-generated questions off the quiz (same race class as
      // #323). Block until the run settles; the buttons are also disabled while
      // `generating`, this is the belt-and-suspenders correctness guard.
      if (generating) {
        toast.info('Hold on — AI generation is still finishing. You can save or publish once it’s done.')
        return
      }
      const formValid = await form.trigger()
      if (!formValid) {
        const errors = form.formState.errors
        const errorFields = Object.keys(errors)
        const firstError = errorFields.length > 0
          ? (errors[errorFields[0] as keyof typeof errors] as { message?: string })?.message || errorFields[0]
          : 'Unknown field'
        toast.error(`Please fix: ${firstError}`)
        // Title errors are fixed in the header; everything else lives in Settings
        if (errorFields[0] === 'title' || errorFields[0] === 'description') {
          document.getElementById('studio-title')?.focus()
        } else {
          setSettingsOpen(true)
        }
        return
      }

      const values = form.getValues()
      const effectiveMode = values.publishMode

      if ((effectiveMode === 'published' || effectiveMode === 'scheduled') && questions.length === 0) {
        toast.error('Add at least one question before publishing')
        setPublishDialogOpen(false)
        setPreviewOpen(false)
        setHubOpen(true)
        return
      }

      // Block saving on any invalid question — for every mode, not just publish
      // — so nothing is silently skipped server-side ("No valid questions to
      // create") and the professor gets the specific per-question problem while
      // the offending card shows the same message inline (F-MAJ-1).
      if (questions.length > 0) {
        const questionErrors = validateWizardQuestions(questions, {
          adaptive: values.adaptiveMode,
        })
        if (questionErrors.length > 0) {
          setFlaggedQuestionIds(new Set(questionErrors.map((e) => e.clientId)))
          setPublishDialogOpen(false)
          toast.error(questionErrors[0].message)
          selectQuestion(questionErrors[0].clientId)
          return
        }
        setFlaggedQuestionIds(new Set())
      }

      if (effectiveMode === 'scheduled') {
        if (!values.scheduledPublishAt) {
          toast.error('Select a scheduled publish time')
          setPublishDialogOpen(true)
          return
        }
        if (new Date(values.scheduledPublishAt) <= new Date()) {
          toast.error('Scheduled publish time must be in the future')
          setPublishDialogOpen(true)
          return
        }
      }

      startTransition(async () => {
        // Take ownership of persistence so the autosave stands down (its guard
        // reads this ref); reset in the finally so autosave resumes afterwards.
        publishingRef.current = true
        try {
          // #323: an autosave may have started before we set publishingRef.
          // Await it so its inserts — and the dbIds it assigns — land before we
          // read state and insert, otherwise both paths insert the same
          // client-UUID rows and the second hits a duplicate-PK error.
          if (inFlightSaveRef.current) await inFlightSaveRef.current
          // Cancel any pending debounce now that we own persistence — one armed
          // before publish, or one the awaited save just re-armed via
          // setQuestions — so it can't fire a redundant autosave mid-publish.
          // (We only clear here, past validation, so a Publish that fails
          // validation leaves the debounce intact and the edit still autosaves.)
          if (draftTimerRef.current) {
            clearTimeout(draftTimerRef.current)
            draftTimerRef.current = null
          }

          // Re-read the latest questions: the awaited autosave may have just
          // assigned dbIds, which decide new-vs-existing below.
          const currentQuestions = questionsRef.current

          // Use auto-saved draft ID if available, otherwise fall back to prop
          let targetQuizId = draftQuizIdRef.current || quizId

          const quizPayload = {
            title: values.title,
            description: values.description,
            timeLimitMinutes: values.timeLimitMinutes,
            shuffleQuestions: values.shuffleQuestions,
            shuffleAnswers: values.shuffleAnswers,
            maxAttempts: values.maxAttempts,
            passThreshold: values.passThreshold,
            dueDate: values.dueDate,
            scheduledPublishAt: effectiveMode === 'scheduled' ? values.scheduledPublishAt : null,
            showExplanations: values.showExplanations,
            showLeaderboard: values.showLeaderboard,
            allowFormulaSheet: values.allowFormulaSheet,
            formulaSheetUrl: values.formulaSheetUrl,
            formulaSheetPath: values.formulaSheetPath,
            negativeMarking: values.negativeMarking,
            negativeMarkingPenalty: values.negativeMarkingPenalty,
            proctoringEnabled: values.proctoringEnabled,
            videoProctoringEnabled: values.videoProctoringEnabled,
            adaptiveMode: values.adaptiveMode,
            adaptiveQuestionCount: values.adaptiveQuestionCount,
            selectLambda: values.selectLambda,
            stopMode: values.stopMode,
            targetSe: values.targetSe,
            showRatingToStudents: values.showRatingToStudents,
          }

          if (targetQuizId) {
            // Draft already exists (from auto-save or edit mode) — just update
            const result = await updateQuiz(sectionId, targetQuizId, quizPayload)
            if (result.error) {
              toast.error(result.error)
              return
            }
          } else {
            // No draft yet — create fresh
            const result = await createQuizFull(sectionId, quizPayload)
            if (result.error || !result.data) {
              toast.error(result.error || 'Failed to create quiz')
              return
            }
            targetQuizId = result.data.id
            setDraftQuizId(targetQuizId)
          }

          if (!targetQuizId) {
            toast.error('Something went wrong')
            return
          }

          // Handle questions: separate new vs existing (from the re-read state,
          // so rows the awaited autosave just created count as existing).
          const newQuestions = currentQuestions.filter((q) => !q.dbId)
          const existingQuestions = currentQuestions.filter((q) => q.dbId)

          // Sync existing questions' full content (image, code, text, etc.)
          if (existingQuestions.length > 0) {
            await bulkUpdateQuestionContent(sectionId, existingQuestions.map(wizardToContentUpdate))
          }

          // Correlate created rows by id (we pass each question's clientId as the
          // row id). Hard fail-safe: if any new question wasn't created, ABORT
          // rather than silently dropping it from the quiz (F-MAJ-1). Publish
          // already passed validateWizardQuestions, so a skip here is unexpected.
          const createdIds = new Set<string>()
          if (newQuestions.length > 0) {
            const inputs = newQuestions.map(wizardToServerInput)
            const bulkResult = await bulkCreateQuestions(sectionId, inputs)
            if (bulkResult.error) {
              toast.error(bulkResult.error)
              return
            }
            for (const created of bulkResult.data) createdIds.add(created.id)
            // Sync DB IDs into local state immediately (clientId === row id), so if
            // a later step fails (assign/publish), a retry treats these as existing
            // and updates them instead of re-inserting → no PK-collision lock-up.
            setQuestions((prev) =>
              prev.map((q) => (!q.dbId && createdIds.has(q.clientId) ? { ...q, dbId: q.clientId } : q)),
            )
            const missing = newQuestions.filter((q) => !createdIds.has(q.clientId))
            if (missing.length > 0) {
              toast.error(
                `Couldn't save ${missing.length} question(s). Please review your questions and try again.`,
              )
              selectQuestion(missing[0].clientId)
              return
            }
          }

          // Build ordered list of question IDs for the quiz (clientId === dbId for new)
          const orderedIds: string[] = []
          for (const q of currentQuestions) {
            if (q.dbId) {
              orderedIds.push(q.dbId)
            } else if (createdIds.has(q.clientId)) {
              orderedIds.push(q.clientId)
            }
          }

          const assignResult = await updateQuizQuestions(sectionId, targetQuizId, orderedIds)
          if (assignResult.error) {
            toast.error(assignResult.error)
            return
          }

          // Publish immediately if the professor selected "Published"
          if (effectiveMode === 'published') {
            const pubResult = await publishQuiz(sectionId, targetQuizId)
            if (pubResult.error) {
              toast.error(pubResult.error)
              return
            }
            toast.success('Quiz published!')
          } else if (effectiveMode === 'scheduled') {
            toast.success('Quiz scheduled!')
          } else {
            toast.success(mode === 'create' ? 'Quiz created as draft!' : 'Quiz saved!')
          }

          // Place the quiz under its module on the roadmap (picked in the
          // publish dialog; idempotent — re-publishing just moves it).
          if (placementModuleId) {
            const attach = await setResourcePlacement(sectionId, 'quiz', targetQuizId, placementModuleId)
            if (attach.error) toast.error(attach.error)
          }

          router.push(backUrl)
        } catch {
          toast.error('An unexpected error occurred')
        } finally {
          // Hand persistence back to the autosave (whether we published,
          // navigated away, or bailed on an error).
          publishingRef.current = false
        }
      })
    },
    [form, questions, mode, quizId, sectionId, router, backUrl, selectQuestion, placementModuleId, generating],
  )

  // ── Back — flush a pending autosave, then leave ─────────────
  // The unmount backstop can't await, so a fast click during the debounce
  // window only persists partial state (the quiz row, not the questions mid-
  // create). Here we await the full save (create → questions → order) before
  // navigating so nothing typed is lost.
  const handleBack = useCallback(() => {
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current)
      draftTimerRef.current = null
    }
    startTransition(async () => {
      await saveDraftRef.current()
      router.push(backUrl)
    })
  }, [router, backUrl])

  // ── Delete the whole quiz (from the settings drawer) ────────
  const handleDeleteQuiz = useCallback(() => {
    const id = draftQuizIdRef.current
    if (!id) return
    // Cancel any pending autosave so it can't recreate/touch the row post-delete.
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current)
      draftTimerRef.current = null
    }
    setDeleteQuizOpen(false)
    // Abort any in-flight generation view and drop its marker so a deleted
    // quiz can't leave a stale "still generating" marker behind.
    genAbortRef.current?.abort()
    clearGenMarker(id)
    startTransition(async () => {
      const res = await deleteQuiz(sectionId, id)
      if (res?.error) {
        toast.error(res.error)
        return
      }
      toast.success('Quiz deleted')
      router.push(backUrl)
    })
  }, [sectionId, router, backUrl, clearGenMarker])

  // ── Revert to Draft ─────────────────────────────────────────
  /* The quiz list's card menu has always confirmed this; the Studio's button reverted
     instantly. Same action, same consequence — students lose access — so it gets the same
     guard, with the same copy and the same reassurance that attempts are kept (#615). */
  const [confirmUnpublish, setConfirmUnpublish] = useState(false)

  const handleUnpublish = useCallback(() => {
    if (!quizId) return
    /* Do NOT close the dialog here. Closing before startTransition unmounts the footer before
       isPending flips, so "Unpublishing…" can never render — which defeated the whole point of
       the preventDefault() on the action button. Close on success instead; on failure the dialog
       stays up with the error, which is also where the professor wants to be. */
    startTransition(async () => {
      const result = await unpublishQuiz(sectionId, quizId)
      if (result.error) {
        toast.error(result.error)
        return
      }
      setConfirmUnpublish(false)
      toast.success('Quiz reverted to draft')
      router.refresh()
    })
  }, [quizId, sectionId, router])

  const publishMode = form.watch('publishMode')
  const titleValue = form.watch('title')
  const scheduledAtValue = form.watch('scheduledPublishAt')
  const selectedIndex = selectedQuestion
    ? questions.findIndex((q) => q.clientId === selectedQuestion.clientId)
    : -1

  return (
    // pb-24 below md keeps the question editor clear of the floating AthenaAskLine.
    <div className="flex flex-col h-[calc(100dvh-8rem)] pb-24 md:pb-0">
      {/* ── Header — back, inline title, actions ── */}
      <div className="shrink-0 border-b pb-3 space-y-3 bg-background">
        {/* flex-wrap: at 390px the title + actions came to ~422px and Publish fell off
            the right edge, reachable only by horizontally scrolling the pane. */}
        <div className="flex flex-wrap items-start justify-between gap-4 pt-1">
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={handleBack}
              disabled={isPending}
              aria-label="Back to quizzes"
              className="shrink-0"
            >
              {/* Spinner at the point of click while the exit-flush saves —
                  matches the Publish button; the "Saving…" pill is far right. */}
              {isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              )}
            </Button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {/* Title hugs its text (field-sizing, no min width) so the ✎
                    sits right beside it — ghost "Untitled quiz" when empty,
                    per the Option D mock; description lives in Settings.
                    On a new quiz, SetupSpotlight lifts this block above a scrim
                    and asks for the name + roadmap module before anything else. */}
                <SetupSpotlight
                  open={setupOpen}
                  onOpenChange={setSetupOpen}
                  sectionId={sectionId}
                  ariaLabel="Set up your new quiz"
                  description="Give your quiz a name to get started, or you can give it a name later."
                  onConfirm={(m) => {
                    if (!m) return
                    // Prefill the publish dialog's picker; the roadmap edge
                    // itself is written once the draft row exists.
                    setPlacementModuleId(m)
                    setPendingPlacement(m)
                  }}
                  className="flex min-w-0 items-center gap-1"
                  haloClassName="-inset-x-3 -inset-y-1.5"
                >
                  <Input
                    id="studio-title"
                    placeholder="Untitled quiz"
                    aria-label="Quiz title"
                    className="h-9 w-auto max-w-md field-sizing-content border-none bg-transparent px-0 text-2xl font-semibold tracking-tight shadow-none focus-visible:ring-0 md:text-2xl"
                    {...form.register('title')}
                  />
                  <button
                    type="button"
                    aria-label="Edit quiz title"
                    // Pointer-only affordance — keyboard users already have the
                    // labeled input, so don't add a redundant tab stop.
                    tabIndex={-1}
                    onClick={() => document.getElementById('studio-title')?.focus()}
                    className="shrink-0 rounded-full p-0.5 text-muted-foreground/50 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </SetupSpotlight>
                {/* Persistent mode indicator — the enable-in-place toast is transient */}
                {adaptiveMode && (
                  <button
                    type="button"
                    onClick={() => setSettingsOpen(true)}
                    title="This quiz runs in Adaptive Mode — configure or turn it off in Settings"
                    className="shrink-0 rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-xs font-medium text-primary transition-colors hover:border-primary/60"
                  >
                    Adaptive
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Wraps, and below md it must also be ALLOWED to shrink: `shrink-0` pinned this
              row at its 313px max-content width inside a 286px column, so flex-wrap never
              engaged and Publish hung off the right edge. Desktop keeps shrink-0 so the
              buttons never get squeezed. */}
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 md:shrink-0">
            {/* Autosave status by the actions — the Option D mock's green
                "✓ Draft saved" pill, with a quiet spinner while a save runs. */}
            {(draftSaving || draftError || lastDraftSavedAt > 0) && (
              // Fixed width: this pill cycles Saving… → Draft saved → Couldn't save, and
              // it now shares a wrapping row with the buttons. A width change would move
              // the wrap point and slide Publish sideways just as a professor reaches for
              // it. Reserving the widest state keeps the composition stable.
              <span role="status" className="mr-1 flex min-w-28 shrink-0 justify-end">
                {draftSaving ? (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                    Saving…
                  </span>
                ) : draftError ? (
                  <span
                    title="Your last change couldn't be saved. It'll retry automatically when you edit again, or press Publish/Save."
                    className="flex items-center gap-1 rounded-full bg-destructive-muted px-2 py-0.5 text-xs font-medium text-destructive-muted-foreground"
                  >
                    <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                    Couldn&apos;t save
                  </span>
                ) : (
                  <span className="flex items-center gap-1 rounded-full bg-success-muted px-2 py-0.5 text-xs font-medium text-success-muted-foreground">
                    <CircleCheck className="h-3 w-3" aria-hidden="true" />
                    {isPublished ? 'Saved' : 'Draft saved'}
                  </span>
                )}
              </span>
            )}
            <AthenaAskLine />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 className="h-4 w-4 mr-1" aria-hidden="true" />
              Settings
            </Button>
            <span title={questions.length === 0 ? 'Add a question to preview' : undefined}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPreviewOpen((v) => !v)}
                disabled={questions.length === 0}
                aria-pressed={previewOpen}
              >
                <Eye className="h-4 w-4 mr-1" aria-hidden="true" />
                {previewOpen ? 'Exit preview' : 'Preview'}
              </Button>
            </span>
            {isPublished ? (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  form.setValue('publishMode', 'published')
                  handleSave()
                }}
                disabled={isPending || generating}
              >
                {isPending ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Save className="h-4 w-4 mr-1" />
                )}
                Save Changes
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  // Drafts auto-save; this dialog is for publishing, so default
                  // a still-draft quiz to "Publish" when it opens.
                  if (form.getValues('publishMode') === 'draft') {
                    form.setValue('publishMode', 'published')
                  }
                  setPublishDialogOpen(true)
                }}
                disabled={isPending || generating}
              >
                <Send className="h-4 w-4 mr-1" />
                Publish
              </Button>
            )}
          </div>
        </div>

        {/* Published Banner */}
        {isPublished && (
          <Alert className="border-warning/30 bg-warning-muted/40 items-center">
            <AlertTriangle className="h-4 w-4 text-warning-muted-foreground" />
            <AlertDescription className="flex items-center justify-between">
              <span className="text-sm text-warning-muted-foreground">
                This quiz is published and visible to students. Changes are saved immediately.
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmUnpublish(true)}
                disabled={isPending}
              >
                Unpublish
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {/* Global generation banner — lives in the studio header (not the
            canvas) so it reads as "the whole quiz is generating", not as
            something attached to the currently-open question. */}
        {(genActive || genReattaching) && (
          <GenerationBanner received={genReceived} total={genRequested} status={genStatus} startedAt={genStartedAt} tokens={genTokens} />
        )}

        {/* Resting state of the bar above: a completed full run stays visible
            as a one-line summary until dismissed. */}
        {!genActive && !genReattaching && genSummary && (
          <GenerationDoneBanner summary={genSummary} onDismiss={() => setGenSummary(null)} />
        )}
      </div>

      {/* ── Body — student preview, or rail + canvas ── */}
      {previewOpen ? (
        <div className="flex-1 min-h-0 overflow-y-auto pt-4">
          <div className="mx-auto mb-4 flex max-w-5xl items-center justify-between rounded-xl border border-primary/30 bg-primary/5 px-4 py-2">
            <span className="flex items-center gap-2 text-sm text-primary">
              <Eye className="h-4 w-4" aria-hidden="true" />
              Previewing as a student
            </span>
            <Button variant="outline" size="sm" onClick={() => setPreviewOpen(false)}>
              Exit preview
            </Button>
          </div>
          <QuizReviewStep
            formValues={form.getValues()}
            questions={questions}
            anchorClientId={selectedQuestion?.clientId}
            onEditQuestion={(idx) => {
              const q = questions[idx]
              if (q) selectQuestion(q.clientId)
            }}
          />
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 flex-col lg:flex-row">
          {/* Mobile (< lg): reach the rail + per-question settings via sheets so
              the canvas isn't crushed by three side-by-side panes. */}
          <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 lg:hidden">
            <Button variant="outline" onClick={() => setMobileRailOpen(true)}>
              <PanelLeft className="h-4 w-4 mr-1" aria-hidden="true" />
              Questions ({questions.length})
            </Button>
            {!showHub && selectedQuestion && (
              <Button variant="outline" onClick={() => setMobileSettingsOpen(true)}>
                <SlidersHorizontal className="h-4 w-4 mr-1" aria-hidden="true" />
                Settings
              </Button>
            )}
          </div>
          {/* Inline rail — desktop only; lg:contents lets its own root be the
              flex child. Mobile uses the sheet below. Skipped entirely on an
              empty quiz: with no thumbnails and the hub owning the add actions,
              the rail would just be a dead column beside the landing hub — but
              shown during generation so the shimmer placeholders have a home. */}
          {(questions.length > 0 || generating) && (
            <div className="hidden lg:contents">
              <QuizStudioRail
                questions={questions}
                selectedId={selectedQuestion?.clientId ?? null}
                onSelect={selectQuestion}
                onReorder={setQuestions}
                stickyType={stickyType}
                onAddType={handleAddType}
                adaptive={adaptiveMode}
                onOpenHub={() => setHubOpen(true)}
                onRemove={handleRemove}
                hideAddControls={showHub}
                generating={generating}
                pendingCount={genPending}
                flaggedIds={activeFlaggedIds}
                unsavedReasons={unsavedReasons}
              />
            </div>
          )}
          <div className="flex min-w-0 flex-1">
            <div id="studio-canvas" className="min-h-0 flex-1 overflow-y-auto p-4">
              {showHub ? (
                <AddQuestionHub
                  firstVisit={questions.length === 0}
                  stickyType={stickyType}
                  onAddType={handleAddType}
                  adaptive={adaptiveMode}
                  onOpenAthena={() => setAthenaOpen(true)}
                  onOpenBank={() => setBankOpen(true)}
                  onOpenJSON={() => setJsonOpen(true)}
                />
              ) : selectedQuestion ? (
                <QuestionEditorCard
                  key={selectedQuestion.clientId}
                  question={selectedQuestion}
                  onChange={(updated) => handleQuestionChange(selectedQuestion.clientId, updated)}
                  sectionId={sectionId}
                  adaptive={adaptiveMode}
                  onPeekSource={setPeekCitation}
                  showError={activeFlaggedIds.has(selectedQuestion.clientId)}
                  onApplyPointsToAll={applyPointsToAll}
                />
              ) : generating ? (
                // First batch not back yet (fresh run OR reattached after a
                // reload) — a shimmering placeholder card so the canvas reads as
                // "working", not broken/empty.
                <QuestionShimmer />
              ) : null}
            </div>
            {/* Right sidebar — the selected question's own settings */}
            {!showHub && selectedQuestion && (
              <aside
                aria-label="Question settings"
                className="hidden w-60 shrink-0 border-l bg-muted/20 lg:flex"
              >
                {/* Primary inner edge — visibly binds the panel to the selected
                    rail thumbnail (Option D mock) */}
                <div aria-hidden="true" className="w-1 shrink-0 bg-primary" />
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <QuizStudioQuestionSidebar
                    question={selectedQuestion}
                    index={selectedIndex}
                    onChange={(u) => handleQuestionChange(selectedQuestion.clientId, u)}
                    onRemove={() => handleRemove(selectedQuestion.clientId)}
                    adaptive={adaptiveMode}
                  />
                </div>
              </aside>
            )}
            {/* Source-page peek for an AI question's citation (ai_extended
                questions have no source page and never open this panel) */}
            {peekCitation && peekCitation.kind !== 'ai_extended' && (
              <div className="my-4 mr-4 w-[40%] min-w-80 shrink-0 overflow-hidden rounded-xl border">
                <DocumentPagePreview
                  itemId={peekCitation.kind === 'module_item' ? peekCitation.moduleItemId : undefined}
                  filePath={peekCitation.kind === 'upload' ? peekCitation.filePath : undefined}
                  page={peekCitation.page}
                  title={peekCitation.title}
                  onClose={() => setPeekCitation(null)}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Mobile slide-overs (< lg): the rail + per-question settings ── */}
      <Sheet open={mobileRailOpen} onOpenChange={setMobileRailOpen}>
        {/* w-52 hugs the rail's own w-48 (+ close-X); distinct dndId so this
            instance doesn't collide with the inline desktop rail's DndContext. */}
        <SheetContent side="left" className="w-52 p-0" aria-describedby={undefined}>
          <SheetHeader className="sr-only">
            <SheetTitle>Questions</SheetTitle>
          </SheetHeader>
          <QuizStudioRail
            dndId="quiz-studio-rail-dnd-mobile"
            questions={questions}
            selectedId={selectedQuestion?.clientId ?? null}
            onSelect={(id) => {
              selectQuestion(id)
              setMobileRailOpen(false)
            }}
            onReorder={setQuestions}
            stickyType={stickyType}
            onAddType={(t) => {
              handleAddType(t)
              setMobileRailOpen(false)
            }}
            adaptive={adaptiveMode}
            onOpenHub={() => {
              setHubOpen(true)
              setMobileRailOpen(false)
            }}
            onRemove={handleRemove}
            hideAddControls={showHub}
            generating={generating}
            pendingCount={genPending}
            flaggedIds={activeFlaggedIds}
            unsavedReasons={unsavedReasons}
          />
        </SheetContent>
      </Sheet>
      <Sheet open={mobileSettingsOpen} onOpenChange={setMobileSettingsOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto p-4 sm:max-w-sm" aria-describedby={undefined}>
          <SheetHeader className="sr-only">
            <SheetTitle>Question settings</SheetTitle>
          </SheetHeader>
          {selectedQuestion && (
            <QuizStudioQuestionSidebar
              question={selectedQuestion}
              index={selectedIndex}
              onChange={(u) => handleQuestionChange(selectedQuestion.clientId, u)}
              onRemove={() => {
                handleRemove(selectedQuestion.clientId)
                setMobileSettingsOpen(false)
              }}
              adaptive={adaptiveMode}
            />
          )}
        </SheetContent>
      </Sheet>

      {/* ── Drawers & dialogs ── */}
      <QuizSettingsDrawer
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        form={form}
        sectionId={sectionId}
        quizId={quizId}
        placementModules={placementModules}
        placementModuleId={placementModuleId}
        onPlacementChange={handlePlacementChange}
        // Only once the draft actually exists is there something to delete.
        onDeleteQuiz={draftQuizId ? () => setDeleteQuizOpen(true) : undefined}
      />
      <DeleteQuizDialog
        open={deleteQuizOpen}
        onOpenChange={setDeleteQuizOpen}
        quizTitle={form.getValues('title')?.trim() || 'Untitled quiz'}
        onConfirm={handleDeleteQuiz}
      />
      <PickFromBankDialog
        open={bankOpen}
        onOpenChange={setBankOpen}
        allQuestions={allBankQuestions}
        existingIds={existingDbIds}
        onAdd={handlePickFromBank}
        adaptive={adaptiveMode}
      />
      <UploadJSONDialog
        open={jsonOpen}
        onOpenChange={setJsonOpen}
        onImported={handleJSONImported}
      />


      {/* ── Publish Dialog — no draft option (drafts are automatic via autosave);
             the quiz name is confirmed here, at the commit point ── */}
      <Dialog open={publishDialogOpen} onOpenChange={setPublishDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Publish quiz</DialogTitle>
            <DialogDescription>
              Name it and choose when it goes live.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Quiz name */}
            <div className="space-y-2">
              <Label htmlFor="publish-quiz-name" className="text-xs text-muted-foreground">
                Quiz name
              </Label>
              <Input
                id="publish-quiz-name"
                placeholder="e.g. Midterm Quiz — Chapter 1–5"
                autoFocus={!titleValue?.trim()}
                value={titleValue ?? ''}
                onChange={(e) => form.setValue('title', e.target.value, { shouldDirty: true })}
              />
              {!titleValue?.trim() && (
                <p className="text-xs text-muted-foreground">
                  Give your quiz a name — it&apos;s what students will see.
                </p>
              )}
            </div>

            {/* Roadmap placement — required whenever the section has modules, so
                the roadmap can show the quiz under the module it assesses. */}
            <div className="space-y-2">
              <Label htmlFor="publish-quiz-module" className="text-xs text-muted-foreground">
                Module it belongs to <span className="text-destructive">*</span>
              </Label>
              {placementModules === null ? (
                <p className="text-xs text-muted-foreground">Loading modules…</p>
              ) : placementModules.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No modules in this section yet — add one to place this quiz on the roadmap. Until then it stays in the Archive.
                </p>
              ) : (
                <Select value={placementModuleId} onValueChange={setPlacementModuleId}>
                  <SelectTrigger id="publish-quiz-module" className="w-full">
                    <SelectValue placeholder="Pick a module…" />
                  </SelectTrigger>
                  <SelectContent>
                    {placementModules.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.weekNumber ? `Week ${m.weekNumber} · ` : ''}{m.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* When */}
            <div className="flex items-center gap-2" role="group" aria-label="When to publish">
              {(
                [
                  { value: 'published', label: 'Publish now' },
                  { value: 'scheduled', label: 'Schedule' },
                ] as { value: WizardFormValues['publishMode']; label: string }[]
              ).map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={publishMode === value}
                  onClick={() => {
                    form.setValue('publishMode', value)
                    if (value !== 'scheduled') {
                      form.setValue('scheduledPublishAt', null)
                    }
                  }}
                  className={[
                    'flex-1 px-3 py-2 rounded-xl text-sm font-medium border transition-colors text-center',
                    publishMode === value
                      ? value === 'published'
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-warning text-warning-foreground border-warning'
                      : 'border-input text-muted-foreground hover:text-foreground hover:border-foreground/30',
                  ].join(' ')}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Scheduled datetime picker */}
            {publishMode === 'scheduled' && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Publish at (local time)</Label>
                <Input
                  type="datetime-local"
                  value={toLocalDateTimeInput(form.watch('scheduledPublishAt'))}
                  /* Both halves through the same module: an unparseable or empty
                     value yields null instead of a RangeError, and the inbound
                     conversion above stays its exact inverse. */
                  onChange={(e) =>
                    form.setValue('scheduledPublishAt', fromLocalDateTimeInput(e.target.value))
                  }
                />
                {form.watch('scheduledPublishAt') &&
                  new Date(form.watch('scheduledPublishAt')!) <= new Date() && (
                    <p className="text-xs text-destructive">Scheduled time must be in the future</p>
                  )}
              </div>
            )}

            {/* Hint text */}
            <p className="text-xs text-muted-foreground">
              {publishMode === 'scheduled'
                ? 'Auto-publishes at the scheduled time. Until then it stays a draft.'
                : 'Students will see the quiz immediately.'}
            </p>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPublishDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setPublishDialogOpen(false)
                handleSave()
              }}
              disabled={
                isPending ||
                generating ||
                !titleValue?.trim() ||
                // Prevention over recovery: all required fields gate the button
                // the same way (no click-then-toast for a missing module/time).
                placementModules === null ||
                (placementModules.length > 0 && !placementModuleId) ||
                (publishMode === 'scheduled' &&
                  (!scheduledAtValue || new Date(scheduledAtValue) <= new Date()))
              }
            >
              {isPending ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Send className="h-4 w-4 mr-1" />
              )}
              {publishMode === 'scheduled' ? 'Schedule' : 'Publish'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmUnpublish} onOpenChange={setConfirmUnpublish}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unpublish &ldquo;{titleValue || 'this quiz'}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-1">
                <span className="block">
                  Students will immediately lose access until you publish it again.
                </span>
                {attemptCount === null ? (
                  <span className="block font-medium text-warning-muted-foreground">
                    Couldn&apos;t check whether anyone has attempted this yet. If they have,
                    their attempts are kept — but this confirmation can&apos;t tell you how many.
                  </span>
                ) : attemptCount > 0 ? (
                  <span className="block">
                    {attemptCount} student{attemptCount === 1 ? ' has' : 's have'} already
                    submitted — their attempts are kept.
                  </span>
                ) : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            {/* preventDefault: Radix closes on click otherwise, so the pending label never shows. */}
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleUnpublish() }}
              disabled={isPending}
            >
              {isPending ? 'Unpublishing…' : 'Unpublish'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
