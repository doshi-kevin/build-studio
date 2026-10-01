// Quiz question display for the student quiz player.
// Uses a side-by-side layout when attachments (image/code) are present:
// left column for attachments, right column for question text + answers.
// Falls back to full-width single column when no attachments exist.
'use client'

import { useState, useMemo } from 'react'
import { Expand } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { VisuallyHidden } from 'radix-ui'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'
import { hasInlineBlanks, segmentFillInBlankText } from '@/lib/quiz/fill-in-blank'
import { QuizCodeBlock } from '@/components/shared/QuizCodeBlock'
import type { Question, Answer } from '@/lib/validations/quiz'
import { QUESTION_TYPE_LABELS } from '@/lib/validations/quiz'
import { shuffleArray } from '@/lib/quiz/utils'

interface QuestionDisplayProps {
  question: Question
  answer: Answer | undefined
  questionNumber: number
  shuffleAnswers: boolean
  onAnswer: (answer: Partial<Answer>) => void
  /** Rendered at the end of the header row — the studio preview's edit affordance. */
  headerAction?: React.ReactNode
  /** Read-only mode (studio preview): renders the question but disables every input. */
  disabled?: boolean
}

// ── Image Lightbox ─────────────────────────────────────────
// Renders the question image inside a bordered container.
// Clicking opens a full-screen Dialog for zoom.

function ImageLightbox({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group relative block w-full overflow-hidden rounded-xl border border-border bg-muted/20 transition-colors duration-300 hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label="Click to enlarge image"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          className="mx-auto block max-h-[280px] w-auto object-contain p-3"
        />

        {/* Persistent expand icon */}
        <div className="absolute bottom-2.5 right-2.5 flex h-7 w-7 items-center justify-center rounded-xl border border-border bg-background/80 text-muted-foreground opacity-80 transition duration-200 ease-out group-hover:scale-110 group-hover:opacity-100">
          <Expand className="h-3.5 w-3.5" />
        </div>
      </button>

      {/* Lightbox dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[90vh] max-w-[90vw] overflow-auto border-border bg-background p-2 sm:max-w-4xl sm:p-4"
          showCloseButton
        >
          <VisuallyHidden.Root>
            <DialogTitle>Question image (enlarged)</DialogTitle>
          </VisuallyHidden.Root>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            className="mx-auto block max-h-[80vh] w-auto rounded-xl object-contain"
          />
        </DialogContent>
      </Dialog>
    </>
  )
}

// ── Main QuestionDisplay ───────────────────────────────────

export function QuestionDisplay({
  question,
  answer,
  questionNumber,
  shuffleAnswers,
  onAnswer,
  headerAction,
  disabled = false,
}: QuestionDisplayProps) {
  const { content } = question
  const hasAttachments = !!(question.imageUrl || question.codeSnippet)

  // Inline fill-in-blank: the stem itself carries {{blank:id}} placeholders, so
  // render the inputs *within* the sentence and skip the legacy "Blank N" list.
  // Legacy questions (no tokens) keep the plain stem + list below.
  const inlineFIB =
    content.questionType === 'fill_in_blank' && hasInlineBlanks(question.questionText)
  const stem = inlineFIB ? (
    <FillInBlankStem
      text={question.questionText}
      values={answer?.blankAnswers ?? {}}
      onChange={(v) => onAnswer({ blankAnswers: v })}
      disabled={disabled}
    />
  ) : (
    <MarkdownLatex content={question.questionText} className="text-base font-medium" />
  )

  return (
    <div className="space-y-4">
      {/* ── Question header ── */}
      <div className="flex items-center gap-2">
        <span className="text-lg font-semibold tracking-tight text-foreground">
          Question {questionNumber}
        </span>
        <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
          {QUESTION_TYPE_LABELS[content.questionType]}
        </Badge>
        <span className="ml-auto rounded-full bg-muted/50 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground">
          {question.points} pt{question.points !== 1 ? 's' : ''}
        </span>
        {headerAction}
      </div>

      {/* ── Content area — side-by-side when attachments exist ── */}
      {hasAttachments ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {/* LEFT: Attachments (image + code) */}
          <div className="flex flex-col gap-4">
            {question.imageUrl && (
              <ImageLightbox
                src={question.imageUrl}
                alt={`Image for question ${questionNumber}`}
              />
            )}

            {question.codeSnippet && (
              <div className="min-h-0 overflow-auto rounded-xl border border-border">
                <QuizCodeBlock
                  language={question.codeSnippet.language}
                  code={question.codeSnippet.code}
                />
              </div>
            )}
          </div>

          {/* RIGHT: Question text + answers */}
          <div className="flex flex-col gap-4">
            <div className="rounded-2xl border border-border bg-card/50 p-5">
              {stem}
            </div>

            <AnswerArea
              content={content}
              answer={answer}
              shuffleAnswers={shuffleAnswers}
              onAnswer={onAnswer}
              inlineFillInBlank={inlineFIB}
              disabled={disabled}
            />
          </div>
        </div>
      ) : (
        /* ── Single column — no attachments ── */
        <div className="space-y-4">
          <div className="rounded-2xl border border-border bg-card/50 p-5">
            {stem}
          </div>

          <AnswerArea
            content={content}
            answer={answer}
            shuffleAnswers={shuffleAnswers}
            onAnswer={onAnswer}
            inlineFillInBlank={inlineFIB}
            disabled={disabled}
          />
        </div>
      )}
    </div>
  )
}

// ── Answer Area (shared between layouts) ────────────────────

function AnswerArea({
  content,
  answer,
  shuffleAnswers,
  onAnswer,
  inlineFillInBlank = false,
  disabled = false,
}: {
  content: Question['content']
  answer: Answer | undefined
  shuffleAnswers: boolean
  onAnswer: (answer: Partial<Answer>) => void
  /** When true the stem already renders the blanks inline — don't repeat the list. */
  inlineFillInBlank?: boolean
  /** Read-only mode (studio preview): disable every input. */
  disabled?: boolean
}) {
  return (
    <>
      {content.questionType === 'multiple_choice' && (
        <MultipleChoiceInput
          choices={content.choices}
          allowMultiple={content.allowMultiple}
          selectedIds={answer?.selectedChoiceIds ?? []}
          shuffleAnswers={shuffleAnswers}
          onSelect={(ids) => onAnswer({ selectedChoiceIds: ids })}
          disabled={disabled}
        />
      )}

      {content.questionType === 'true_false' && (
        <TrueFalseInput
          value={answer?.booleanAnswer}
          onSelect={(v) => onAnswer({ booleanAnswer: v })}
          disabled={disabled}
        />
      )}

      {content.questionType === 'short_answer' && (
        <ShortAnswerInput
          value={answer?.textAnswer ?? ''}
          onChange={(v) => onAnswer({ textAnswer: v })}
          disabled={disabled}
        />
      )}

      {content.questionType === 'fill_in_blank' && !inlineFillInBlank && (
        <FillInBlankInput
          blanks={content.blanks}
          values={answer?.blankAnswers ?? {}}
          onChange={(v) => onAnswer({ blankAnswers: v })}
          disabled={disabled}
        />
      )}

      {content.questionType === 'explanation' && (
        <ExplanationInput
          value={answer?.textAnswer ?? ''}
          onChange={(v) => onAnswer({ textAnswer: v })}
          disabled={disabled}
        />
      )}
    </>
  )
}

// Matches the server cap (adaptiveAnswerServerSchema.textAnswer.max(8000)).
const EXPLANATION_MAX = 8000

function ExplanationInput({
  value,
  onChange,
  disabled = false,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-1.5">
      <Textarea
        value={value}
        maxLength={EXPLANATION_MAX}
        onChange={(e) => onChange(e.target.value.slice(0, EXPLANATION_MAX))}
        placeholder="Explain in your own words — be clear and complete; you're graded on the ideas you convey, not exact wording."
        className="min-h-32 rounded-xl"
        disabled={disabled}
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          Graded by AI against a rubric of key ideas. Partial answers earn partial credit.
        </p>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
          {value.length.toLocaleString()}/{EXPLANATION_MAX.toLocaleString()}
        </span>
      </div>
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────

function MultipleChoiceInput({
  choices,
  allowMultiple,
  selectedIds,
  shuffleAnswers,
  onSelect,
  disabled = false,
}: {
  choices: { id: string; text: string; isCorrect: boolean }[]
  allowMultiple: boolean
  selectedIds: string[]
  shuffleAnswers: boolean
  onSelect: (ids: string[]) => void
  disabled?: boolean
}) {
  const displayChoices = useMemo(
    () => (shuffleAnswers ? shuffleArray(choices) : choices),
    [shuffleAnswers, choices],
  )

  const handleToggle = (choiceId: string) => {
    if (disabled) return
    if (allowMultiple) {
      const next = selectedIds.includes(choiceId)
        ? selectedIds.filter((id) => id !== choiceId)
        : [...selectedIds, choiceId]
      onSelect(next)
    } else {
      onSelect([choiceId])
    }
  }

  return (
    <div className="space-y-2">
      {displayChoices.map((choice) => {
        const isSelected = selectedIds.includes(choice.id)
        return (
          <div
            key={choice.id}
            role="option"
            aria-selected={isSelected}
            aria-disabled={disabled || undefined}
            onClick={() => handleToggle(choice.id)}
            className={`flex items-center gap-3 rounded-xl border p-3.5 transition duration-200 ease-out ${
              disabled ? 'cursor-default opacity-60' : 'cursor-pointer'
            } ${
              isSelected
                ? 'border-foreground/30 bg-muted/40'
                : disabled
                  ? 'border-border'
                  : 'border-border hover:border-foreground/15 hover:bg-muted/20'
            }`}
          >
            {allowMultiple ? (
              <Checkbox checked={isSelected} className="pointer-events-none" />
            ) : (
              <div
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                  isSelected ? 'border-foreground' : 'border-muted-foreground/30'
                }`}
              >
                {isSelected && <div className="h-2 w-2 rounded-full bg-primary" />}
              </div>
            )}
            <MarkdownLatex content={choice.text} variant="compact" className="text-sm" />
          </div>
        )
      })}
    </div>
  )
}

function TrueFalseInput({
  value,
  onSelect,
  disabled = false,
}: {
  value: boolean | undefined
  onSelect: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-2">
      {[true, false].map((option) => {
        const isSelected = value === option
        return (
          <div
            key={String(option)}
            role="option"
            aria-selected={isSelected}
            aria-disabled={disabled || undefined}
            className={`flex items-center gap-3 rounded-xl border p-3.5 transition duration-200 ease-out ${
              disabled ? 'cursor-default opacity-60' : 'cursor-pointer'
            } ${
              isSelected
                ? 'border-foreground/30 bg-muted/40'
                : disabled
                  ? 'border-border'
                  : 'border-border hover:border-foreground/15 hover:bg-muted/20'
            }`}
            onClick={() => {
              if (!disabled) onSelect(option)
            }}
          >
            <div
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                isSelected ? 'border-foreground' : 'border-muted-foreground/30'
              }`}
            >
              {isSelected && <div className="h-2 w-2 rounded-full bg-primary" />}
            </div>
            <span className="text-sm font-medium">{option ? 'True' : 'False'}</span>
          </div>
        )
      })}
    </div>
  )
}

function ShortAnswerInput({
  value,
  onChange,
  disabled = false,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Type your answer..."
      className="max-w-md rounded-xl"
      disabled={disabled}
    />
  )
}

// Inline stem: renders the question sentence with an input at each {{blank:id}}
// placeholder. The text arrives already answer-stripped from the server, so no
// answers are present here. Legacy questions (no tokens) use FillInBlankInput.
function FillInBlankStem({
  text,
  values,
  onChange,
  disabled = false,
}: {
  text: string
  values: Record<string, string>
  onChange: (v: Record<string, string>) => void
  disabled?: boolean
}) {
  const segments = segmentFillInBlankText(text)
  return (
    <div className="text-base font-medium leading-loose">
      {segments.map((seg, i) =>
        seg.type === 'text' ? (
          <MarkdownLatex key={i} content={seg.value} variant="compact" className="inline" />
        ) : (
          <input
            key={i}
            type="text"
            aria-label={`Blank ${seg.index + 1}`}
            value={values[seg.id] ?? ''}
            onChange={(e) => onChange({ ...values, [seg.id]: e.target.value })}
            placeholder={`${seg.index + 1}`}
            disabled={disabled}
            className="mx-1 inline-block w-32 max-w-full rounded-xl border-[1.5px] border-dashed border-primary bg-primary/5 px-2 py-0.5 align-baseline text-sm font-normal text-foreground outline-none focus:border-solid focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
          />
        ),
      )}
    </div>
  )
}

function FillInBlankInput({
  blanks,
  values,
  onChange,
  disabled = false,
}: {
  blanks: { id: string; acceptedAnswers: string[]; caseSensitive: boolean }[]
  values: Record<string, string>
  onChange: (v: Record<string, string>) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-3">
      {blanks.map((blank, i) => (
        <div key={blank.id} className="flex items-center gap-3">
          <span className="w-16 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Blank {i + 1}
          </span>
          <Input
            value={values[blank.id] ?? ''}
            onChange={(e) =>
              onChange({ ...values, [blank.id]: e.target.value })
            }
            placeholder="Your answer"
            className="max-w-xs rounded-xl"
            disabled={disabled}
          />
        </div>
      ))}
    </div>
  )
}
