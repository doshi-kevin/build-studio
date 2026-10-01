// Shared "create a poll or quiz" composer for Live Classroom.
//
// One surface, two homes:
//   • in-class — inside InteractionComposer, above the live open/closed lists
//   • pre-class — inside PreClassInteractionPrep, so a prof can queue polls and
//     quizzes as drafts while the deck renders.
//
// Both create an lc_interactions row in 'draft' status via createInteraction;
// the prof later launches it (draft → open). This component owns only the
// create flow: launcher tiles → quiz options (time limit / reveal) → compose
// form. The live surface passes `quizExtras` to slot in its transcription-based
// "Generate with AI" button; pre-class omits it (no transcript yet).
//
// Third path: "Reuse a past question" prefills the compose form from something
// this section already launched (#133), so re-asking a poll after a discussion —
// or re-running last week's check-in — costs one click instead of retyping it.
// It still creates a NEW draft, so the re-launch collects fresh responses.

'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  BarChart3,
  FileQuestion,
  Loader2,
  Plus,
  Trash2,
  Check,
  Pencil,
  X,
  ChevronDown,
  History,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { toast } from 'sonner'
import {
  createInteraction,
  listReusableInteractions,
  type ReusableInteraction,
} from '@/lib/live-classroom/interactions/actions'
import { getRoomTopicOptions } from '@/app/(dashboard)/professor/courses/[sectionId]/live-classroom/actions'
import { QuizHistoryList, type QuizHistoryListItem } from '@/components/live-classroom/shared/QuizHistoryList'
import { SPRING, SPRING_SNAPPY } from '@/lib/motion'

interface NewInteractionComposerProps {
  roomId: string
  /** Fired after a poll/quiz draft is created — the parent refetches its list. */
  onCreated?: () => void
  /** Success toast copy after creating. Defaults to the in-class wording. */
  successMessage?: string
  /** Extra control rendered in the quiz-options block (the live "Generate with
   *  AI" button). Receives the current quiz settings. Omitted pre-class. */
  quizExtras?: (opts: { timeLimitSeconds: number; revealAnswers: boolean }) => React.ReactNode
}

export function NewInteractionComposer({
  roomId,
  onCreated,
  successMessage,
  quizExtras,
}: NewInteractionComposerProps) {
  const [composerKind, setComposerKind] = useState<'poll' | 'quiz' | null>(null)
  const [showQuizOptions, setShowQuizOptions] = useState(false)
  // Single source of truth for the quiz time limit — shared by the manual
  // composer and the AI "Generate with AI" path (default 1m).
  const [quizTimeLimit, setQuizTimeLimit] = useState(60)
  // Reveal correct answers to students immediately on submit. Default off so
  // it doesn't undercut anti-cheat on graded checks.
  const [revealAnswers, setRevealAnswers] = useState(false)
  // Past polls/quizzes this section already launched. null = still loading;
  // the reuse entry point only appears once there's something to reuse.
  const [reusable, setReusable] = useState<ReusableInteraction[] | null>(null)
  const [showReuse, setShowReuse] = useState(false)
  // The past item the compose form is prefilled from (null = blank form).
  const [prefill, setPrefill] = useState<ReusableInteraction | null>(null)

  useEffect(() => {
    let cancelled = false
    listReusableInteractions({ roomId }).then((r) => {
      if (!cancelled) setReusable(r.interactions ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [roomId])

  const startReuse = (id: string) => {
    const item = reusable?.find((i) => i.id === id)
    if (!item) return
    // Carry the stored quiz settings over — they live in the parent so the
    // AI path can share them, so they have to be set here, not in the form.
    if (item.kind === 'quiz') {
      setQuizTimeLimit(item.timeLimitSeconds ?? 60)
      setRevealAnswers(item.revealAnswers ?? false)
    }
    setPrefill(item)
    setShowReuse(false)
    setComposerKind(item.kind)
  }

  const closeComposer = () => {
    setComposerKind(null)
    setPrefill(null)
  }

  const reuseItems: QuizHistoryListItem[] = (reusable ?? []).map((i) => ({
    id: i.id,
    title: i.question,
    closedAt: i.createdAt,
    rightLabel: i.kind === 'quiz' ? 'Quiz' : 'Poll',
    rightTone: 'neutral',
    kind: i.kind,
  }))

  return (
    <TooltipProvider delayDuration={250}>
      <div className="space-y-4">
        {/* Quick-launch row (hidden while composing) */}
        {!composerKind && !showQuizOptions && !showReuse && (
          <div className="space-y-2.5">
            <div className="grid grid-cols-2 gap-2.5">
              <LaunchTile
                icon={BarChart3}
                title="New poll"
                hint="Gauge the room"
                onClick={() => setComposerKind('poll')}
              />
              <LaunchTile
                icon={FileQuestion}
                title="New quiz"
                hint="Check understanding"
                onClick={() => setShowQuizOptions(true)}
              />
            </div>
            {/* Secondary by design — a slim row, not a third tile, so the two
                primary actions stay dominant. Absent until there's history. */}
            {reusable && reusable.length > 0 && (
              <button
                type="button"
                onClick={() => setShowReuse(true)}
                className="w-full flex items-center gap-2 rounded-2xl border border-border bg-background hover:bg-muted/30 hover:border-foreground/30 transition-colors px-3.5 py-2.5 text-left"
              >
                <History className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden />
                <span className="text-xs font-medium">Reuse a past question</span>
                <span className="text-xs text-muted-foreground ml-auto tabular-nums">
                  {reusable.length}
                </span>
              </button>
            )}
          </div>
        )}

        {/* Reuse picker */}
        {!composerKind && showReuse && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={SPRING_SNAPPY}
            className="space-y-2"
          >
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
                Reuse a past question
              </p>
              <button
                type="button"
                onClick={() => setShowReuse(false)}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Back
              </button>
            </div>
            <QuizHistoryList
              items={reuseItems}
              onSelect={startReuse}
              emptyTitle="Nothing to reuse yet"
              emptyHint="Polls and quizzes you launch in this course show up here, ready to re-ask."
            />
          </motion.div>
        )}

        {/* Quiz creation options */}
        {!composerKind && showQuizOptions && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={SPRING}
            className="space-y-2"
          >
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
                Create a quiz
              </p>
              <button
                type="button"
                onClick={() => setShowQuizOptions(false)}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Back
              </button>
            </div>
            <TimeLimitPicker value={quizTimeLimit} onChange={setQuizTimeLimit} />
            <RevealAnswersToggle checked={revealAnswers} onCheckedChange={setRevealAnswers} />
            <div className="grid grid-cols-1 gap-2">
              <LaunchTile
                icon={FileQuestion}
                title="Write your own"
                hint="Create a custom question with choices"
                onClick={() => { setShowQuizOptions(false); setComposerKind('quiz') }}
              />
              {quizExtras?.({ timeLimitSeconds: quizTimeLimit, revealAnswers })}
            </div>
          </motion.div>
        )}

        {/* Composer */}
        <AnimatePresence initial={false} mode="wait">
          {composerKind && (
            <motion.div
              // The prefill id is part of the key so picking a second past
              // question remounts the form with the new values instead of
              // keeping the first one's state.
              key={`${composerKind}:${prefill?.id ?? 'blank'}`}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={SPRING}
            >
              <ComposeForm
                kind={composerKind}
                roomId={roomId}
                initial={prefill}
                timeLimitSeconds={quizTimeLimit}
                onTimeLimitChange={setQuizTimeLimit}
                revealAnswers={revealAnswers}
                onRevealAnswersChange={setRevealAnswers}
                successMessage={successMessage}
                onCreated={onCreated}
                onDone={closeComposer}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </TooltipProvider>
  )
}

function LaunchTile({
  icon: Icon,
  title,
  hint,
  onClick,
}: {
  icon: typeof BarChart3
  title: string
  hint: string
  onClick: () => void
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.98 }}
      transition={SPRING_SNAPPY}
      className="group flex flex-col items-start gap-2 rounded-2xl border border-border bg-background hover:bg-muted/30 hover:border-foreground/30 transition-colors p-3.5 text-left h-full"
    >
      <div className="flex items-center justify-between w-full">
        <div className="rounded-xl bg-muted/40 border border-border p-2 group-hover:bg-primary group-hover:text-primary-foreground group-hover:border-primary transition-colors">
          <Icon className="h-4 w-4" />
        </div>
        <Plus className="h-3.5 w-3.5 text-muted-foreground/60 group-hover:text-foreground transition-colors" />
      </div>
      <div>
        <p className="text-sm font-medium leading-tight">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>
      </div>
    </motion.button>
  )
}

// Preset time-limit chips + a custom seconds field, shared by the manual
// composer and the AI generate path. The field is the source of truth (10–600s);
// the presets are shortcuts that set it. Editing the field via a local draft
// (rather than clamping every keystroke) lets the prof type e.g. "180" without
// the value fighting them at each digit — it only commits an in-range number.
const QUIZ_TIME_PRESETS: Array<{ seconds: number; label: string }> = [
  { seconds: 30, label: '30s' },
  { seconds: 60, label: '1m' },
  { seconds: 120, label: '2m' },
  { seconds: 300, label: '5m' },
]

function TimeLimitPicker({ value, onChange }: { value: number; onChange: (seconds: number) => void }) {
  // When the value isn't one of the presets, the custom field is the one in
  // effect — give it a darker border to signal that (without the filled-chip
  // look, which reads as non-editable).
  const isCustom = !QUIZ_TIME_PRESETS.some((p) => p.seconds === value)
  const [draft, setDraft] = useState(String(value))
  // Keep the field in sync when a preset chip changes the value externally.
  useEffect(() => {
    setDraft(String(value))
  }, [value])

  return (
    <div className="space-y-2">
      <Label className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
        Time limit
      </Label>
      <div className="flex items-center gap-1.5 flex-wrap">
        {QUIZ_TIME_PRESETS.map((preset) => {
          const active = value === preset.seconds
          return (
            <button
              key={preset.seconds}
              type="button"
              onClick={() => onChange(preset.seconds)}
              aria-pressed={active}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold border transition-colors ${
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-muted-foreground hover:border-foreground/40 hover:text-foreground'
              }`}
            >
              {preset.label}
            </button>
          )
        })}
        {/* Custom field — looks like an input (pencil + focus ring) so it's
            obviously editable, not a static chip. */}
        <label
          className={`inline-flex items-center gap-1.5 rounded-full border bg-background pl-2.5 pr-2.5 py-1 cursor-text transition-colors hover:border-foreground/40 focus-within:border-foreground focus-within:ring-2 focus-within:ring-foreground/10 ${
            isCustom ? 'border-foreground' : 'border-border'
          }`}
        >
          <Pencil className={`h-3 w-3 shrink-0 ${isCustom ? 'text-foreground' : 'text-muted-foreground'}`} aria-hidden />
          <input
            type="text"
            inputMode="numeric"
            value={draft}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, '').slice(0, 3)
              setDraft(digits)
              const n = parseInt(digits, 10)
              if (!Number.isNaN(n) && n >= 10 && n <= 600) onChange(n)
            }}
            onBlur={() => {
              const n = parseInt(draft, 10)
              const clamped = Number.isNaN(n) ? value : Math.max(10, Math.min(600, n))
              onChange(clamped)
              setDraft(String(clamped))
            }}
            aria-label="Custom time limit in seconds"
            className="w-8 bg-transparent text-xs font-semibold tabular-nums text-foreground text-center outline-none"
          />
          <span className="text-xs font-semibold text-muted-foreground">sec</span>
        </label>
      </div>
    </div>
  )
}

// Toggle for immediate per-submit answer reveal — shared by the manual composer
// and the AI generate path. Off by default; flipping it on tells students they
// get their results the moment they submit (which also reveals the answer to
// fast finishers while the quiz is still open).
function RevealAnswersToggle({
  checked,
  onCheckedChange,
}: {
  checked: boolean
  onCheckedChange: (reveal: boolean) => void
}) {
  return (
    <label className="flex items-start justify-between gap-3 rounded-2xl border border-border bg-background px-3.5 py-3 cursor-pointer">
      <div className="min-w-0">
        <p className="text-sm font-medium leading-tight">Reveal answers on submit</p>
        <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
          Students see what they got right and why as soon as they answer, instead of waiting for you to close the quiz.
        </p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} className="mt-0.5 shrink-0" />
    </label>
  )
}

// Composer — collects question + N choices for a poll, title + 1 question for a quiz.
// Choices are rendered as individual editable rows (more delightful than a textarea
// blob and lets students see exactly what they'll vote on).
function ComposeForm({
  kind,
  roomId,
  initial,
  timeLimitSeconds,
  onTimeLimitChange,
  revealAnswers,
  onRevealAnswersChange,
  successMessage,
  onCreated,
  onDone,
}: {
  kind: 'poll' | 'quiz'
  roomId: string
  /** A past poll/quiz to prefill from (the reuse path). null = blank form. */
  initial?: ReusableInteraction | null
  timeLimitSeconds: number
  onTimeLimitChange: (seconds: number) => void
  revealAnswers: boolean
  onRevealAnswersChange: (reveal: boolean) => void
  successMessage?: string
  onCreated?: () => void
  onDone: () => void
}) {
  const [pending, setPending] = useState(false)
  const [question, setQuestion] = useState(initial?.question ?? '')
  const [choices, setChoices] = useState<string[]>(
    initial && initial.choices.length >= 2 ? initial.choices : ['', ''],
  )
  // Index (within `choices`) of the choice marked correct for quizzes.
  // Defaults to 0 so the prof has a sensible starting point — but they
  // can flip it by clicking any other choice's letter pill.
  const [correctIdx, setCorrectIdx] = useState(initial?.correctIndex ?? 0)
  // Quiz-only: optional reasoning shown to students after the quiz closes.
  const [explanation, setExplanation] = useState(initial?.explanation ?? '')
  // Quiz-only: the section's tracked subtopics this question assesses. Tagging
  // links the quiz to topic mastery (same as the normal quiz's tags); AI quizzes
  // get this automatically. Empty is fine — mastery just falls back to the title.
  const [topicOptions, setTopicOptions] = useState<Array<{ id: string; name: string }>>([])
  const [selectedTopicIds, setSelectedTopicIds] = useState<string[]>(initial?.skillIds ?? [])

  const isQuiz = kind === 'quiz'

  // Load taggable subtopics once, only for quizzes (polls don't score mastery).
  useEffect(() => {
    if (!isQuiz) return
    let cancelled = false
    getRoomTopicOptions(roomId).then((r) => {
      if (cancelled || !r.topics) return
      const topics = r.topics
      setTopicOptions(topics)
      // A reused quiz can carry tags for topics the course no longer tracks —
      // drop those so the chips match what's actually submitted.
      setSelectedTopicIds((prev) => prev.filter((id) => topics.some((t) => t.id === id)))
    })
    return () => {
      cancelled = true
    }
  }, [isQuiz, roomId])

  const toggleTopic = (id: string) => {
    setSelectedTopicIds((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]))
  }

  const updateChoice = (idx: number, value: string) => {
    setChoices((prev) => prev.map((c, i) => (i === idx ? value : c)))
  }

  const removeChoice = (idx: number) => {
    setChoices((prev) => {
      if (prev.length <= 2) return prev
      const next = prev.filter((_, i) => i !== idx)
      // Keep `correctIdx` pointing at the same choice. If we removed the
      // correct one, fall back to 0; if we removed an earlier one, shift down.
      setCorrectIdx((prevCorrect) => {
        if (idx === prevCorrect) return 0
        if (idx < prevCorrect) return prevCorrect - 1
        return prevCorrect
      })
      return next
    })
  }

  const addChoice = () => {
    setChoices((prev) => (prev.length >= 6 ? prev : [...prev, '']))
  }

  const handleSubmit = async () => {
    setPending(true)
    try {
      // Track which RAW choice index ends up at which position after
      // filtering empties — so the correct-answer mark survives the trim.
      const filteredWithIdx = choices
        .map((text, originalIdx) => ({ text: text.trim(), originalIdx }))
        .filter((x) => x.text.length > 0)
      if (filteredWithIdx.length < 2) {
        toast.error('Add at least 2 choices')
        return
      }
      const choiceObjects = filteredWithIdx.map((x, idx) => ({ id: `c${idx + 1}`, text: x.text }))

      // Map the prof's selected correct index to its post-filter id.
      let correctChoiceId = choiceObjects[0].id
      if (isQuiz) {
        const matched = filteredWithIdx.findIndex((x) => x.originalIdx === correctIdx)
        correctChoiceId = matched >= 0 ? choiceObjects[matched].id : choiceObjects[0].id
        if (matched < 0) {
          toast.error('Mark the correct answer before pushing the quiz')
          return
        }
      }

      const result =
        kind === 'poll'
          ? await createInteraction({
              roomId,
              kind: 'poll',
              payload: { question, pollType: 'single_choice', choices: choiceObjects },
            })
          : await createInteraction({
              roomId,
              kind: 'quiz',
              payload: {
                title: question,
                timeLimitSeconds,
                revealAnswers,
                questions: [
                  {
                    id: 'q1',
                    prompt: question,
                    choices: choiceObjects,
                    correctChoiceId,
                    explanation: explanation.trim() || undefined,
                    skillIds: selectedTopicIds.length ? selectedTopicIds : undefined,
                    // Label the report by the tagged skill(s) instead of the
                    // "General" fallback. Display only — mastery uses skillIds.
                    concept:
                      topicOptions
                        .filter((t) => selectedTopicIds.includes(t.id))
                        .map((t) => t.name)
                        .join(', ') || undefined,
                  },
                ],
              },
            })
      if (result.error) toast.error(result.error)
      else {
        toast.success(successMessage ?? 'Created — click Push to share with students')
        onDone()
        onCreated?.()
      }
    } finally {
      setPending(false)
    }
  }

  const filledCount = choices.filter((c) => c.trim()).length
  const canSubmit = question.trim() && filledCount >= 2 && !pending

  return (
    <div className="rounded-2xl border border-foreground/20 bg-muted/15 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isQuiz ? (
            <FileQuestion className="h-4 w-4 text-muted-foreground" />
          ) : (
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
            New {kind}
          </span>
        </div>
        <button
          type="button"
          onClick={onDone}
          aria-label="Cancel"
          className="h-7 w-7 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {initial && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground leading-snug">
          <History className="h-3 w-3 mt-0.5 shrink-0" aria-hidden />
          Prefilled from a past {initial.kind}. Edit anything — creating makes a new
          one, so it collects fresh responses.
        </p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="question" className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
          {isQuiz ? 'Question' : 'Prompt'}
        </Label>
        <Input
          id="question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={isQuiz ? 'Which of these is true about…?' : 'How are you feeling about today’s topic?'}
          autoFocus
          className="h-11 rounded-xl text-sm"
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
            Choices
          </Label>
          {isQuiz && (
            <span className="text-xs text-muted-foreground italic">
              Tap a letter to mark the correct answer
            </span>
          )}
        </div>

        <div className="space-y-1.5">
          <AnimatePresence initial={false}>
            {choices.map((value, idx) => {
              const letter = String.fromCharCode(65 + idx) // A, B, C...
              const isCorrect = isQuiz && idx === correctIdx
              const letterPill = (
                <span
                  className={`shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-xl text-xs font-semibold uppercase tracking-widest border transition-colors ${
                    isCorrect
                      ? 'border-success bg-success text-success-foreground'
                      : isQuiz
                        ? 'border-border bg-background text-muted-foreground hover:border-foreground/40 hover:text-foreground'
                        : 'border-border bg-background text-muted-foreground'
                  }`}
                  aria-label={isCorrect ? 'Correct answer' : `Choice ${letter}`}
                >
                  {isCorrect ? <Check className="h-4 w-4" strokeWidth={3} /> : letter}
                </span>
              )
              return (
                <motion.div
                  key={idx}
                  layout
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={SPRING_SNAPPY}
                  className="flex items-center gap-2"
                >
                  {isQuiz ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => setCorrectIdx(idx)}
                          aria-pressed={isCorrect}
                          className="shrink-0 rounded-xl"
                        >
                          {letterPill}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        {isCorrect ? 'Correct answer' : 'Mark as correct answer'}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    letterPill
                  )}
                  <Input
                    value={value}
                    onChange={(e) => updateChoice(idx, e.target.value)}
                    placeholder={`Choice ${letter}`}
                    className="h-9 rounded-xl text-sm flex-1"
                  />
                  {choices.length > 2 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => removeChoice(idx)}
                          className="shrink-0 h-9 w-9 rounded-xl flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                          aria-label={`Remove choice ${letter}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">Remove choice</TooltipContent>
                    </Tooltip>
                  )}
                </motion.div>
              )
            })}
          </AnimatePresence>
        </div>

        {choices.length < 6 && (
          <button
            type="button"
            onClick={addChoice}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
          >
            <Plus className="h-3 w-3" />
            Add choice ({choices.length}/6)
          </button>
        )}
      </div>

      {isQuiz && <TimeLimitPicker value={timeLimitSeconds} onChange={onTimeLimitChange} />}

      {isQuiz && <RevealAnswersToggle checked={revealAnswers} onCheckedChange={onRevealAnswersChange} />}

      {isQuiz && (
        <div className="space-y-1.5">
          <Label htmlFor="explanation" className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
            Explanation <span className="normal-case tracking-normal text-muted-foreground/70">(optional)</span>
          </Label>
          <Textarea
            id="explanation"
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
            placeholder="Why is this the correct answer? Shown to students after the quiz closes."
            maxLength={2000}
            rows={2}
            className="rounded-xl text-sm resize-none"
          />
        </div>
      )}

      {isQuiz && topicOptions.length > 0 && (
        <div className="space-y-1.5">
          <Label className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
            Topics <span className="normal-case tracking-normal text-muted-foreground/70">(optional — links this quiz to mastery)</span>
          </Label>
          {/* A course can track a lot of topics — the picker lives in a bounded,
              scrollable popover (same bounded-scroll technique as
              SkillMasterySettings.tsx) so a long list scrolls in a fixed-height
              panel instead of growing the whole composer taller. The current
              selection stays visible as removable chips below the trigger —
              collapsing it to a bare count would mean re-opening the popover
              just to recall what's tagged, on a field that drives topic-mastery
              scoring. */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                className="h-9 rounded-full px-4 text-xs font-medium border"
              >
                {selectedTopicIds.length > 0
                  ? `${selectedTopicIds.length} topic${selectedTopicIds.length === 1 ? '' : 's'} selected`
                  : 'Select topics'}
                <ChevronDown className="h-3 w-3 opacity-60" aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="max-h-[min(60vh,var(--radix-popover-content-available-height))] w-80 overflow-y-auto">
              <div className="flex flex-wrap gap-1.5">
                {topicOptions.map((t) => {
                  const selected = selectedTopicIds.includes(t.id)
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => toggleTopic(t.id)}
                      aria-pressed={selected}
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs font-medium transition-colors ${
                        selected
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground'
                      }`}
                    >
                      {selected && <Check className="h-3 w-3" strokeWidth={3} />}
                      {t.name}
                    </button>
                  )
                })}
              </div>
            </PopoverContent>
          </Popover>
          {selectedTopicIds.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {topicOptions
                .filter((t) => selectedTopicIds.includes(t.id))
                .map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggleTopic(t.id)}
                    aria-label={`Remove ${t.name}`}
                    className="inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                  >
                    {t.name}
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                ))}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button
          variant="outline"
          onClick={onDone}
          className="rounded-full h-10 flex-1 border"
        >
          Cancel
        </Button>
        <Button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="rounded-full h-10 flex-1 font-semibold"
        >
          {pending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" aria-hidden="true" />
              Creating…
            </>
          ) : (
            <>Create</>
          )}
        </Button>
      </div>
    </div>
  )
}
