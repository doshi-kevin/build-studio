// Editor for the selected question's content, rendered borderless in the
// studio canvas (the rail owns reordering; metadata lives in the sidebar).
// GitHub-style input: code in ``` fences, images via a permanent attach strip
// (drag & drop, paste, browse, or the module library).

'use client'

import { useState, useRef } from 'react'
import { ChevronDown, Library, Loader2, Paperclip, Plus, X, Bot } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { NumericInput } from '@/components/ui/numeric-input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  QUESTION_TYPES,
  QUIZ_ITEM_TYPES,
  QUESTION_TYPE_LABELS,
  type Question,
  type QuizItemType,
  type DifficultyLevel,
  type BloomsLevel,
  type SourceCitation,
} from '@/lib/validations/quiz'
import { generateId } from '@/lib/quiz/utils'
import { parseBlanks } from '@/lib/quiz/fill-in-blank'
import { wizardQuestionInlineError } from '@/lib/quiz/wizard-validation'
import { InlineBlankEditor } from '@/components/professor/quizzes/InlineBlankEditor'
import { cn } from '@/lib/utils'
import { QuizCodeBlock } from '@/components/shared/QuizCodeBlock'
import { uploadFile, deleteFile } from '@/lib/supabase/storage'
import { InsertFromLibraryDialog } from '@/components/professor/quizzes/InsertFromLibraryDialog'
import { QuestionSourceChip } from './QuestionSourceChip'
import type { LibraryImage, LibraryFormula } from '@/lib/extraction/library-queries'
import { buildFormulaToken, insertAtCaret, advanceCaret } from '@/lib/quiz/formula-insert'
import { toast } from 'sonner'

// ── Types ────────────────────────────────────────────────────────

export interface WizardQuestion {
  /** Temp client-side ID for new questions, DB ID for existing */
  clientId: string
  /** DB ID if already persisted */
  dbId?: string
  questionText: string
  questionType: QuizItemType
  difficulty: DifficultyLevel
  bloomsLevel: BloomsLevel | null
  tags: string
  points: number
  explanation: string
  isBonus: boolean
  isExtraCredit: boolean
  // MC fields
  choices: { id: string; text: string; isCorrect: boolean }[]
  allowMultiple: boolean
  // TF
  correctAnswer: boolean
  // SA
  acceptedAnswers: { value: string }[]
  caseSensitive: boolean
  // FIB
  blanks: { id: string; acceptedAnswers: string; caseSensitive: boolean }[]
  // Walkthrough (multi-turn AI tutor) — the tutor's first message + turn budget
  opening: string
  maxTurns: number
  /** Image URL for display */
  imageUrl?: string | null
  /** Storage path for deletion */
  imagePath?: string | null
  /** Code snippet configuration */
  codeSnippet?: { language: string; code: string } | null
  /** Elo rating (preserved from DB for existing questions) */
  eloRating?: number
  /** Expected time in seconds (preserved from DB for existing questions) */
  expectedTimeSeconds?: number | null
  /** CCAT/IRT params (preserved from DB; AI-seeded for new constructed-response items) */
  irtA?: number | null
  irtB?: number | null
  irtC?: number | null
  /** Grading rubric for explanation/walkthrough items */
  rubric?: { concept: string; match?: string[] }[] | null
  /** AI-generated only: the source file + page this question was drawn from (peekable) */
  sourceCitation?: SourceCitation | null
  /** Warning from AI generation if any */
  validationWarning?: string
}

/** Convert a DB Question to a WizardQuestion */
export function questionToWizard(q: Question): WizardQuestion {
  const base: WizardQuestion = {
    clientId: q.id,
    dbId: q.id,
    questionText: q.questionText,
    questionType: q.content.questionType,
    difficulty: q.difficulty,
    bloomsLevel: q.bloomsLevel,
    tags: q.tags.join(', '),
    points: q.points,
    explanation: q.explanation,
    isBonus: q.isBonus ?? false,
    isExtraCredit: q.isExtraCredit ?? false,
    choices: q.content.questionType === 'multiple_choice'
      ? q.content.choices
      : [{ id: generateId(), text: '', isCorrect: true }, { id: generateId(), text: '', isCorrect: false }],
    allowMultiple: q.content.questionType === 'multiple_choice' ? q.content.allowMultiple : false,
    correctAnswer: q.content.questionType === 'true_false' ? q.content.correctAnswer : true,
    acceptedAnswers: q.content.questionType === 'short_answer'
      ? q.content.acceptedAnswers.map((v) => ({ value: v }))
      : [{ value: '' }],
    caseSensitive: q.content.questionType === 'short_answer' ? q.content.caseSensitive : false,
    blanks: q.content.questionType === 'fill_in_blank'
      ? q.content.blanks.map((b) => ({
          id: b.id,
          acceptedAnswers: b.acceptedAnswers.join(', '),
          caseSensitive: b.caseSensitive,
        }))
      : [{ id: generateId(), acceptedAnswers: '', caseSensitive: false }],
    opening: q.content.questionType === 'walkthrough' ? q.content.opening : '',
    maxTurns: q.content.questionType === 'walkthrough' ? q.content.maxTurns : 4,
    imageUrl: q.imageUrl,
    imagePath: q.imagePath,
    codeSnippet: q.codeSnippet,
    eloRating: q.eloRating,
    expectedTimeSeconds: q.expectedTimeSeconds,
    irtA: q.irtA,
    irtB: q.irtB,
    irtC: q.irtC,
    rubric: q.rubric,
    sourceCitation: q.sourceCitation,
  }
  return base
}

/** Create a blank WizardQuestion for a given type */
export function createBlankQuestion(type: QuizItemType): WizardQuestion {
  return {
    clientId: generateId(),
    questionText: '',
    questionType: type,
    difficulty: 'medium',
    bloomsLevel: null,
    tags: '',
    points: 1,
    explanation: '',
    isBonus: false,
    isExtraCredit: false,
    choices: [
      { id: generateId(), text: '', isCorrect: true },
      { id: generateId(), text: '', isCorrect: false },
    ],
    allowMultiple: false,
    correctAnswer: true,
    acceptedAnswers: [{ value: '' }],
    caseSensitive: false,
    blanks: [{ id: generateId(), acceptedAnswers: '', caseSensitive: false }],
    opening: '',
    maxTurns: 4,
    imageUrl: null,
    imagePath: null,
    codeSnippet: null,
    // AI-graded types start with one empty rubric row so the editor invites input
    rubric: type === 'explanation' || type === 'walkthrough' ? [{ concept: '' }] : null,
  }
}

// ── Props ────────────────────────────────────────────────────────

interface QuestionEditorCardProps {
  question: WizardQuestion
  onChange: (updated: WizardQuestion) => void
  /** Section ID for image uploads */
  sectionId?: string
  /** Whether the quiz is adaptive — gates the adaptive-only types in the type pill */
  adaptive?: boolean
  /** Opens the source-page preview panel for an AI-generated question's citation */
  onPeekSource?: (citation: SourceCitation) => void
  /** Show the inline validation hint — only true after a failed Save/Next, so a
   *  question being typed for the first time isn't nagged. */
  showError?: boolean
  /** Sets every question's points to the given value (the pts popover's
   *  "apply to all" action). */
  onApplyPointsToAll?: (points: number) => void
}

// ── Component ────────────────────────────────────────────────────

export function QuestionEditorCard({
  question,
  onChange,
  sectionId,
  adaptive,
  onPeekSource,
  showError,
  onApplyPointsToAll,
}: QuestionEditorCardProps) {
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [imageEnlarged, setImageEnlarged] = useState(false)
  const questionTextRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const update = (partial: Partial<WizardQuestion>) => {
    onChange({ ...question, ...partial })
  }

  const onPickLibraryImage = (img: LibraryImage) => {
    update({ imageUrl: img.storageUrl, imagePath: img.storagePath })
    // Stable id so rapid multi-pick sessions replace the prior toast of the
    // same kind in place instead of stacking up.
    toast.success('Image attached', {
      id: 'library-pick-image',
      description: `${img.lectureTitle} · p.${img.pageNumber}`,
    })
  }

  const onPickLibraryFormula = (f: LibraryFormula) => {
    const textarea = questionTextRef.current
    const token = buildFormulaToken(f.latex, f.kind)
    const { next, caret } = insertAtCaret(question.questionText ?? '', token, textarea)
    update({ questionText: next })
    // Update the textarea's selection range without stealing focus back
    // from the open library dialog — Radix's focus trap would fight us.
    advanceCaret(textarea, caret)
    toast.success('Formula inserted', {
      id: 'library-pick-formula',
      description: `${f.lectureTitle} · p.${f.pageNumber}`,
    })
  }

  // ── Image attach: browse / drag & drop / paste all land here ──
  const attachImage = async (file: File | undefined | null) => {
    if (!file || uploading) return
    if (!file.type.startsWith('image/')) {
      toast.error('Only image files can be attached')
      return
    }
    setUploading(true)
    const previousPath = question.imagePath
    // sectionId first so the course-materials read policy
    // (is_section_member(foldername[1])) permits createSignedUrl.
    const { data, error } = await uploadFile(
      file,
      `${sectionId || 'unknown'}/quiz-images/${question.dbId || question.clientId}`,
    )
    setUploading(false)
    if (error || !data) {
      toast.error("Couldn't attach the image", {
        description: 'Check your connection and try again.',
      })
      return
    }
    // Replace semantics: drop the old file so it doesn't orphan in storage.
    if (previousPath) void deleteFile(previousPath)
    update({ imageUrl: data.url, imagePath: data.path })
  }

  const removeImage = async () => {
    if (question.imagePath) {
      await deleteFile(question.imagePath)
    }
    update({ imageUrl: null, imagePath: null })
  }

  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault()
      setDragActive(true)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node)) return
      setDragActive(false)
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setDragActive(false)
      void attachImage(Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/')))
    },
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/'))
    if (file) {
      e.preventDefault()
      void attachImage(file)
    }
  }

  const isFib = question.questionType === 'fill_in_blank'
  const isAiGraded =
    question.questionType === 'explanation' || question.questionType === 'walkthrough'
  // AI-graded types' only inline error is "rubric missing" — shown inside the
  // rubric panel (red border + message) instead of the generic spot below the text.
  const rubricError = isAiGraded && showError ? wizardQuestionInlineError(question) : null
  // The AI-generation warning for a rubric-less item ("… needs a rubric of at
  // least 1 conceptual node") also belongs on the panel, not the card top.
  // Gated on the text actually being about the rubric — generation can attach
  // unrelated warnings (e.g. a schema-parse issue) that must stay at the top.
  // Position prefix stripped — the generation index may not match this card's.
  const rubricWarning =
    isAiGraded &&
    question.validationWarning &&
    /rubric|conceptual node|insight/i.test(question.validationWarning) &&
    !(question.rubric ?? []).some((n) => n.concept.trim())
      ? question.validationWarning.replace(/^Question \d+:\s*/, '')
      : null
  const rubricPanelError = rubricError ?? rubricWarning
  const imageFileName = question.imagePath?.split('/').pop() || 'attached image'

  return (
    <div id={`question-${question.clientId}`} className="space-y-3">
      {question.validationWarning && !rubricWarning && (
        <p className="text-xs text-warning-muted-foreground">{question.validationWarning}</p>
      )}

      {/* Header pills, right-aligned: type · AI source · points. Difficulty
          stays in the sidebar (it's a grading-shape setting, not card chrome). */}
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        <Select
          value={question.questionType}
          onValueChange={(v) => update({ questionType: v as QuizItemType })}
          disabled={!!question.dbId}
        >
          <SelectTrigger
            aria-label="Question type"
            // h-7! overrides the shadcn trigger's data-[size=default]:h-9 (36px)
            // so the pill matches the AI-source and pts pills (28px) beside it.
            // Locked (persisted) questions keep the crisp badge look instead of
            // the dimmed disabled control — the chevron hides since it's inert.
            className="h-7! w-auto gap-1 rounded-full border-none bg-info-muted px-3 py-0! text-xs font-medium text-info-muted-foreground shadow-none disabled:cursor-default disabled:opacity-100 [&:disabled_svg]:hidden"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* Adaptive-only types are offered when Adaptive Mode is on — and
                also when this question already IS one (so it can be switched
                away after Adaptive was turned off). */}
            {(adaptive ||
            question.questionType === 'explanation' ||
            question.questionType === 'walkthrough'
              ? QUIZ_ITEM_TYPES
              : QUESTION_TYPES
            ).map((t) => (
              <SelectItem key={t} value={t}>
                {QUESTION_TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {question.sourceCitation && onPeekSource && (
          <QuestionSourceChip citation={question.sourceCitation} onOpen={onPeekSource} />
        )}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`pts ${question.points} — edit points`}
              className="flex h-7 items-center gap-1 rounded-full bg-muted px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              pts <span className="font-semibold text-foreground">{question.points}</span>
              <ChevronDown className="h-3 w-3" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-60 space-y-2 p-3">
            <Label
              htmlFor={`q-points-${question.clientId}`}
              className="text-xs text-muted-foreground"
            >
              Points
            </Label>
            <NumericInput
              id={`q-points-${question.clientId}`}
              min={1}
              max={100}
              className="h-8"
              value={question.points}
              onChange={(v) => update({ points: parseInt(v) || 1 })}
            />
            {onApplyPointsToAll && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => onApplyPointsToAll(question.points)}
              >
                Apply to all questions
              </Button>
            )}
          </PopoverContent>
        </Popover>
      </div>

      {/* Question text — GitHub-style frame with the attach strip at the bottom */}
      <div className="space-y-1.5">
        <div
          {...dropProps}
          className={cn(
            'overflow-hidden rounded-xl border border-input transition-colors focus-within:border-primary',
            dragActive && 'border-primary ring-2 ring-primary/20',
          )}
        >
          {isFib ? (
            // Inline blanks: the sentence carries {{blank:id:answers}} chips; the
            // blanks array is derived from it so the save path is unchanged.
            // frameless — this shared frame (with the attach strip) is its border.
            <InlineBlankEditor
              frameless
              value={question.questionText}
              onChange={(text) =>
                update({
                  questionText: text,
                  blanks: parseBlanks(text).map((b) => ({
                    id: b.id,
                    acceptedAnswers: b.acceptedAnswers.join(', '),
                    caseSensitive: false,
                  })),
                })
              }
            />
          ) : (
            <Textarea
              ref={questionTextRef}
              placeholder="Type your question…"
              rows={3}
              className="resize-none rounded-none border-0 font-mono text-sm shadow-none focus-visible:ring-0"
              value={question.questionText}
              onChange={(e) => update({ questionText: e.target.value })}
              onPaste={handlePaste}
            />
          )}
          {question.imageUrl && (
            <ImageThumb
              url={question.imageUrl}
              fileName={imageFileName}
              onEnlarge={() => setImageEnlarged(true)}
              onRemove={removeImage}
              className="mx-3 mb-2"
            />
          )}
          {/* The strip stays available even after an image is attached so the
              professor can always swap it — picking a new file or a library
              image replaces the current one (drop/paste onto the thumbnail
              works too). */}
          <AttachStrip
            uploading={uploading}
            hasImage={!!question.imageUrl}
            onBrowse={() => fileInputRef.current?.click()}
            onLibrary={sectionId ? () => setLibraryOpen(true) : undefined}
          />
        </div>
        {!isFib && (
          <p className="text-[11px] text-muted-foreground">Markdown + LaTeX supported</p>
        )}
        {(() => {
          // Only after a failed Save/Next (showError) — never while first typing.
          // AI-graded types surface their only possible error (missing rubric)
          // inside the rubric panel itself — see RubricEditor's error prop.
          if (!showError || isAiGraded) return null
          const inlineErr = wizardQuestionInlineError(question)
          return inlineErr ? (
            <p role="status" className="mt-1 text-xs font-medium text-destructive">
              {inlineErr}
            </p>
          ) : null
        })()}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          void attachImage(e.target.files?.[0])
          e.target.value = ''
        }}
      />

      {/* Existing questions may carry a stored code snippet; new code goes
          in the question text inside ``` fences, so there's no add button. */}
      {question.codeSnippet && (
            <div className="space-y-2 rounded-xl border bg-muted/20 p-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Code Snippet</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-destructive hover:text-destructive"
                  onClick={() => update({ codeSnippet: null })}
                >
                  Remove Code
                </Button>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <Select
                    value={question.codeSnippet.language}
                    onValueChange={(v) =>
                      update({
                        codeSnippet: { ...question.codeSnippet!, language: v },
                      })
                    }
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[
                        'javascript',
                        'python',
                        'java',
                        'cpp',
                        'sql',
                        'html',
                        'css',
                        'typescript',
                        'go',
                        'rust',
                        'plaintext',
                      ].map((l) => (
                        <SelectItem key={l} value={l} className="text-xs uppercase">
                          {l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Textarea
                placeholder="Paste your code here..."
                className="font-mono text-xs min-h-25 bg-background"
                value={question.codeSnippet.code}
                onChange={(e) =>
                  update({
                    codeSnippet: { ...question.codeSnippet!, code: e.target.value },
                  })
                }
              />
              {question.codeSnippet.code && (
                <div className="mt-2">
                  <p className="text-[10px] text-muted-foreground mb-1 uppercase font-semibold">Preview</p>
                  <QuizCodeBlock
                    language={question.codeSnippet.language}
                    code={question.codeSnippet.code}
                  />
                </div>
              )}
            </div>
          )}

          {/* Type-specific answer editor */}
          <div>
            {question.questionType === 'multiple_choice' && (
              <MultipleChoiceEditor question={question} update={update} />
            )}
            {question.questionType === 'true_false' && (
              <TrueFalseEditor question={question} update={update} />
            )}
            {question.questionType === 'short_answer' && (
              <ShortAnswerEditor question={question} update={update} />
            )}
            {/* Fill-in-blank answers are authored inline in the Question Text
                (InlineBlankEditor chips) — no separate blanks list here. */}
            {/* AI-graded types have no answer key: the student's free text /
                chat transcript is graded against the editable rubric. */}
            {question.questionType === 'explanation' && (
              <RubricEditor
                question={question}
                update={update}
                error={rubricPanelError}
                copy="Students write a short free-text explanation. The AI grades it against this rubric — no answer key needed."
              />
            )}
            {question.questionType === 'walkthrough' && (
              <div className="space-y-3">
                <WalkthroughEditor question={question} update={update} />
                <RubricEditor
                  question={question}
                  update={update}
                  error={rubricPanelError}
                  copy="Hidden from the student — the AI tutor steers the conversation toward these insights, then grades the transcript against them."
                />
              </div>
            )}
          </div>

      {question.imageUrl && (
        <Dialog open={imageEnlarged} onOpenChange={setImageEnlarged}>
          <DialogContent className="max-w-3xl">
            <DialogTitle className="sr-only">Question image</DialogTitle>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={question.imageUrl}
              alt="Question attachment (full size)"
              className="max-h-[70vh] w-full rounded-xl object-contain"
            />
          </DialogContent>
        </Dialog>
      )}
      {sectionId && (
        <InsertFromLibraryDialog
          open={libraryOpen}
          onOpenChange={setLibraryOpen}
          sectionId={sectionId}
          initialTab="images"
          onPickImage={onPickLibraryImage}
          onPickFormula={onPickLibraryFormula}
        />
      )}
    </div>
  )
}

// ── Attach strip & image thumbnail ───────────────────────────────

/** Attach strip — the bottom edge of the question frame. Two compact actions,
 *  no standing copy (drag & drop highlights the frame live; paste still works). */
function AttachStrip({
  uploading,
  hasImage,
  onBrowse,
  onLibrary,
}: {
  uploading: boolean
  hasImage: boolean
  onBrowse: () => void
  onLibrary?: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-dashed bg-muted/30 px-3 py-1.5 text-xs">
      {uploading ? (
        <span className="flex items-center gap-1.5 py-0.5 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Uploading image…
        </span>
      ) : (
        <>
          <button
            type="button"
            onClick={onBrowse}
            className="flex items-center gap-1 rounded-full px-2 py-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
            {hasImage ? 'Replace image' : 'Add image'}
          </button>
          {onLibrary && (
            // Chip treatment — a different kind of source than a local file
            <button
              type="button"
              onClick={onLibrary}
              className="flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Library className="h-3 w-3" aria-hidden="true" />
              Module library
            </button>
          )}
        </>
      )}
    </div>
  )
}

/** Slack-style compact thumbnail for the attached image — click to enlarge. */
function ImageThumb({
  url,
  fileName,
  onEnlarge,
  onRemove,
  className,
}: {
  url: string
  fileName: string
  onEnlarge: () => void
  onRemove: () => void
  className?: string
}) {
  return (
    <div
      className={cn(
        'inline-flex max-w-full items-center gap-2 rounded-xl border bg-background p-1.5 pr-2',
        className,
      )}
    >
      <button
        type="button"
        onClick={onEnlarge}
        className="shrink-0 overflow-hidden rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Enlarge image"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="Question attachment" className="h-10 w-10 object-cover" />
      </button>
      <div className="min-w-0 text-left">
        <p className="truncate text-xs font-medium">{fileName}</p>
        <p className="text-[10px] text-muted-foreground">click to enlarge</p>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove image"
        className="ml-1 rounded-full p-1 text-muted-foreground hover:text-destructive"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}

// ── AI-graded types (explanation / walkthrough) ──────────────────

/** Editable grading rubric for the AI-graded types. Explanation grades the
 *  student's free text against these concepts; walkthrough keeps them hidden —
 *  the tutor steers toward them and the transcript is graded against them.
 *  Editing a concept drops its AI-seeded `match` keywords: the keyword-grader
 *  fallback re-derives them from the new wording (see grader.ts). */
function RubricEditor({
  question,
  update,
  copy,
  error,
}: {
  question: WizardQuestion
  update: (p: Partial<WizardQuestion>) => void
  copy: string
  /** Post-save-attempt validation error — red border + message on the panel */
  error?: string | null
}) {
  const isWalkthrough = question.questionType === 'walkthrough'
  const noun = isWalkthrough ? 'insight' : 'concept'
  const nodes = question.rubric ?? []
  return (
    <div
      className={cn(
        'space-y-2.5 rounded-xl border bg-muted/20 p-3',
        error && 'border-destructive',
      )}
    >
      <div>
        <span className="text-sm font-medium">
          {isWalkthrough ? 'Target Insights' : 'Grading Rubric'}
        </span>
        <p className="mt-0.5 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {copy}
        </p>
      </div>
      {nodes.map((node, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <span className="w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
            {idx + 1}.
          </span>
          <Input
            aria-label={`${isWalkthrough ? 'Target insight' : 'Grading concept'} ${idx + 1}`}
            placeholder={
              `${isWalkthrough ? 'Insight' : 'Concept'} ${idx + 1}` +
              // Example on the first row only — repeating it on every row is noise
              (idx === 0
                ? ` (e.g. ${isWalkthrough ? '“the inner derivative is the missing factor”' : '“instantaneous rate of change”'})`
                : '')
            }
            maxLength={500}
            value={node.concept}
            onChange={(e) =>
              update({ rubric: nodes.map((n, i) => (i === idx ? { concept: e.target.value } : n)) })
            }
            className="h-8 flex-1 bg-background"
          />
          <button
            type="button"
            onClick={() => update({ rubric: nodes.filter((_, i) => i !== idx) })}
            aria-label={`Remove ${noun} ${idx + 1}`}
            className="rounded-full p-1 text-muted-foreground hover:text-destructive"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => update({ rubric: [...nodes, { concept: '' }] })}
        className="flex w-full items-center justify-center gap-1 rounded-xl border border-dashed px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Add {noun}
      </button>
      {error && (
        <p role="status" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/** Walkthrough: the tutor's opening message + how many student turns to allow. */
function WalkthroughEditor({
  question,
  update,
}: {
  question: WizardQuestion
  update: (p: Partial<WizardQuestion>) => void
}) {
  return (
    <div className="space-y-3">
      <span className="text-sm font-medium">Guided Conversation</span>
      <div className="space-y-1.5">
        <Label htmlFor={`q-opening-${question.clientId}`} className="text-xs text-muted-foreground">
          Opening message
        </Label>
        <Textarea
          id={`q-opening-${question.clientId}`}
          placeholder="How the AI tutor starts the conversation (optional — it opens from the question itself if empty)"
          rows={2}
          maxLength={1000}
          className="resize-none"
          value={question.opening}
          onChange={(e) => update({ opening: e.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`q-max-turns-${question.clientId}`} className="text-xs text-muted-foreground">
          Student turns
        </Label>
        <NumericInput
          id={`q-max-turns-${question.clientId}`}
          min={2}
          max={8}
          className="h-9 w-24"
          value={question.maxTurns}
          onChange={(v) => update({ maxTurns: parseInt(v) || 4 })}
        />
        <p className="text-xs text-muted-foreground">
          2–8 back-and-forth turns before the tutor wraps up.
        </p>
      </div>
    </div>
  )
}

// ── Type-Specific Editors ────────────────────────────────────────

function MultipleChoiceEditor({
  question,
  update,
}: {
  question: WizardQuestion
  update: (p: Partial<WizardQuestion>) => void
}) {
  const addChoice = () => {
    if (question.choices.length >= 8) return
    update({
      choices: [...question.choices, { id: generateId(), text: '', isCorrect: false }],
    })
  }

  const removeChoice = (idx: number) => {
    if (question.choices.length <= 2) return
    update({ choices: question.choices.filter((_, i) => i !== idx) })
  }

  const updateChoice = (idx: number, partial: Partial<{ text: string; isCorrect: boolean }>) => {
    // With "allow multiple" OFF these are radio buttons, not checkboxes: marking one
    // correct has to clear the rest. Two correct ids on a single-answer question makes it
    // UNGRADEABLE — scoring.ts requires exactly one, so every student is marked wrong
    // whatever they pick (and docked, under negative marking) while the editor looks fine.
    // Unchecking is left alone: it can reach zero correct, which validation already
    // blocks at save with a clear message.
    const exclusive = partial.isCorrect === true && !question.allowMultiple
    const updated = question.choices.map((c, i) =>
      i === idx ? { ...c, ...partial } : exclusive ? { ...c, isCorrect: false } : c,
    )
    update({ choices: updated })
  }

  const setAllowMultiple = (checked: boolean) => {
    if (checked) {
      update({ allowMultiple: true })
      return
    }
    // Turning it off has to reconcile what is ALREADY marked, or the question stays in
    // the very state the switch claims is impossible. Keep the first correct choice.
    const firstCorrect = question.choices.findIndex((c) => c.isCorrect)
    update({
      allowMultiple: false,
      choices: question.choices.map((c, i) => ({ ...c, isCorrect: i === firstCorrect })),
    })
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">Answer Choices</span>
        <div className="flex items-center gap-2">
          <Switch
            id={`q-allow-multiple-${question.clientId}`}
            checked={question.allowMultiple}
            onCheckedChange={setAllowMultiple}
          />
          <Label htmlFor={`q-allow-multiple-${question.clientId}`} className="text-xs text-muted-foreground">
            Allow multiple correct answers
          </Label>
        </div>
      </div>
      {question.choices.map((choice, idx) => (
        <div
          key={choice.id}
          className={cn(
            'flex items-center gap-2.5 rounded-xl border bg-card px-3 py-1.5 transition-colors',
            choice.isCorrect && 'border-success-muted-foreground/40 bg-success-muted/30',
          )}
        >
          <Checkbox
            checked={choice.isCorrect}
            onCheckedChange={(checked) => updateChoice(idx, { isCorrect: !!checked })}
            aria-label={`Choice ${idx + 1} is correct`}
          />
          <Input
            placeholder={`Choice ${idx + 1}`}
            value={choice.text}
            onChange={(e) => updateChoice(idx, { text: e.target.value })}
            className="h-8 flex-1 border-0 px-0 shadow-none focus-visible:ring-0"
          />
          {question.choices.length > 2 && (
            <button
              type="button"
              onClick={() => removeChoice(idx)}
              aria-label={`Remove choice ${idx + 1}`}
              className="p-1 rounded-full text-muted-foreground hover:text-destructive"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={addChoice}
        disabled={question.choices.length >= 8}
        className="flex w-full items-center justify-center gap-1 rounded-xl border border-dashed px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-50 disabled:hover:border-border disabled:hover:text-muted-foreground"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Add choice
      </button>
    </div>
  )
}

function TrueFalseEditor({
  question,
  update,
}: {
  question: WizardQuestion
  update: (p: Partial<WizardQuestion>) => void
}) {
  return (
    <div className="space-y-2">
      <Label>Correct Answer</Label>
      <Select
        value={question.correctAnswer ? 'true' : 'false'}
        onValueChange={(v) => update({ correctAnswer: v === 'true' })}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">True</SelectItem>
          <SelectItem value="false">False</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

function ShortAnswerEditor({
  question,
  update,
}: {
  question: WizardQuestion
  update: (p: Partial<WizardQuestion>) => void
}) {
  const addAnswer = () => {
    update({ acceptedAnswers: [...question.acceptedAnswers, { value: '' }] })
  }

  const removeAnswer = (idx: number) => {
    if (question.acceptedAnswers.length <= 1) return
    update({ acceptedAnswers: question.acceptedAnswers.filter((_, i) => i !== idx) })
  }

  const updateAnswer = (idx: number, value: string) => {
    const updated = question.acceptedAnswers.map((a, i) =>
      i === idx ? { value } : a,
    )
    update({ acceptedAnswers: updated })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Accepted Answers</span>
        <Button type="button" variant="ghost" size="sm" onClick={addAnswer}>
          <Plus className="h-3 w-3 mr-1" />
          Add Answer
        </Button>
      </div>
      {question.acceptedAnswers.map((a, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <Input
            placeholder={`Answer ${idx + 1}`}
            value={a.value}
            onChange={(e) => updateAnswer(idx, e.target.value)}
            className="flex-1"
          />
          {question.acceptedAnswers.length > 1 && (
            <button
              type="button"
              onClick={() => removeAnswer(idx)}
              aria-label={`Remove answer ${idx + 1}`}
              className="p-1 rounded-full text-muted-foreground hover:text-destructive"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Switch
          id={`q-case-sensitive-${question.clientId}`}
          checked={question.caseSensitive}
          onCheckedChange={(checked) => update({ caseSensitive: checked })}
        />
        <Label htmlFor={`q-case-sensitive-${question.clientId}`} className="text-sm">
          Case sensitive
        </Label>
      </div>
    </div>
  )
}
