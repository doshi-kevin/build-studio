'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { useForm, useFieldArray, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Plus, X, Library, FunctionSquare } from 'lucide-react'
import { FileUpload } from '@/components/ui/file-upload'
import { QuizCodeBlock } from '@/components/shared/QuizCodeBlock'
import { deleteFile } from '@/lib/supabase/storage'
import { InsertFromLibraryDialog } from './InsertFromLibraryDialog'
import type { LibraryImage, LibraryFormula } from '@/lib/extraction/library-queries'
import { buildFormulaToken, insertAtCaret, advanceCaret } from '@/lib/quiz/formula-insert'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NumericInput } from '@/components/ui/numeric-input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
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
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Separator } from '@/components/ui/separator'
import {
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  DIFFICULTY_LEVELS,
  DIFFICULTY_LABELS,
  BLOOMS_LEVELS,
  BLOOMS_LABELS,
  type Question,
  type QuestionType,
  type DifficultyLevel,
  type BloomsLevel,
} from '@/lib/validations/quiz'
import { generateId } from '@/lib/quiz/utils'
import { parseBlanks } from '@/lib/quiz/fill-in-blank'
import { InlineBlankEditor } from './InlineBlankEditor'
import { cn } from '@/lib/utils'

// ── Form Schema ─────────────────────────────────────────────

const formSchema = z.object({
  questionText: z.string().min(1, 'Question text is required').max(2000),
  questionType: z.enum(QUESTION_TYPES),
  difficulty: z.enum(DIFFICULTY_LEVELS),
  bloomsLevel: z.enum(BLOOMS_LEVELS).nullable(),
  tags: z.string(), // comma-separated, parsed on submit
  points: z.coerce.number().int().min(1).max(100),
  explanation: z.string().max(2000),
  isBonus: z.boolean(),
  isExtraCredit: z.boolean(),
  // Adaptive quiz fields
  eloRating: z.coerce.number().int().min(400).max(2400),
  expectedTimeSeconds: z.coerce.number().int().min(5).max(600).nullable(),
  imageUrl: z.string().nullable().optional(),
  imagePath: z.string().nullable().optional(),
  codeSnippet: z
    .object({
      language: z.string(),
      code: z.string(),
    })
    .nullable()
    .optional(),
  // Multiple choice
  choices: z.array(z.object({
    id: z.string(),
    text: z.string(),
    isCorrect: z.boolean(),
  })),
  allowMultiple: z.boolean(),
  // True/False
  correctAnswer: z.boolean(),
  // Short answer
  acceptedAnswers: z.array(z.object({ value: z.string() })),
  caseSensitive: z.boolean(),
  // Fill in blank
  blanks: z.array(z.object({
    id: z.string(),
    acceptedAnswers: z.string(), // comma-separated
    caseSensitive: z.boolean(),
  })),
})

type FormValues = z.infer<typeof formSchema>

// ── Props ───────────────────────────────────────────────────

interface QuestionFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  question: Question | null // null = create mode
  sectionId: string
  onSave: (question: Question) => void
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getDefaultValues(question: Question | null, sectionId: string): FormValues {
  if (question) {
    const { content } = question
    // This manual editor handles the four classic types; AI-generated
    // explanation/walkthrough items fall back to a safe default here (they are
    // edited via generation, not this dialog).
    const editableType = (QUESTION_TYPES as readonly string[]).includes(content.questionType)
      ? (content.questionType as QuestionType)
      : 'multiple_choice'
    return {
      questionText: question.questionText,
      questionType: editableType,
      difficulty: question.difficulty,
      bloomsLevel: question.bloomsLevel ?? null,
      tags: question.tags.join(', '),
      points: question.points,
      explanation: question.explanation,
      isBonus: question.isBonus ?? false,
      isExtraCredit: question.isExtraCredit ?? false,
      eloRating: question.eloRating ?? 1200,
      expectedTimeSeconds: question.expectedTimeSeconds ?? null,
      imageUrl: question.imageUrl ?? null,
      imagePath: question.imagePath ?? null,
      codeSnippet: question.codeSnippet ?? null,
      choices: content.questionType === 'multiple_choice' ? content.choices : [
        { id: generateId(), text: '', isCorrect: true },
        { id: generateId(), text: '', isCorrect: false },
      ],
      allowMultiple: content.questionType === 'multiple_choice' ? content.allowMultiple : false,
      correctAnswer: content.questionType === 'true_false' ? content.correctAnswer : true,
      acceptedAnswers: content.questionType === 'short_answer'
        ? content.acceptedAnswers.map((v) => ({ value: v }))
        : [{ value: '' }],
      caseSensitive: content.questionType === 'short_answer' ? content.caseSensitive : false,
      blanks: content.questionType === 'fill_in_blank'
        ? content.blanks.map((b) => ({
            id: b.id,
            acceptedAnswers: b.acceptedAnswers.join(', '),
            caseSensitive: b.caseSensitive,
          }))
        : [{ id: generateId(), acceptedAnswers: '', caseSensitive: false }],
    }
  }

  return {
    questionText: '',
    questionType: 'multiple_choice',
    difficulty: 'medium',
    bloomsLevel: null,
    tags: '',
    points: 1,
    explanation: '',
    isBonus: false,
    isExtraCredit: false,
    eloRating: 1200,
    expectedTimeSeconds: null,
    imageUrl: null,
    imagePath: null,
    codeSnippet: null,
    choices: [
      { id: generateId(), text: '', isCorrect: true },
      { id: generateId(), text: '', isCorrect: false },
    ],
    allowMultiple: false,
    correctAnswer: true,
    acceptedAnswers: [{ value: '' }],
    caseSensitive: false,
    blanks: [{ id: generateId(), acceptedAnswers: '', caseSensitive: false }],
  }
}

// ── Component ───────────────────────────────────────────────

export function QuestionFormDialog({
  open,
  onOpenChange,
  question,
  sectionId,
  onSave,
}: QuestionFormDialogProps) {
  const isEditMode = !!question

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema) as Resolver<FormValues>,
    defaultValues: getDefaultValues(question, sectionId),
  })

  // The dialog is always mounted, so `defaultValues` only applies once — after a
  // save the form keeps its last values, and the `blanks` field array leaks into
  // the next Add Question (a fresh question inherits the previous one's blanks,
  // which also misfires the marker/blank warning). Reset to the current
  // question's defaults each time the dialog opens (#318).
  useEffect(() => {
    if (open) form.reset(getDefaultValues(question, sectionId))
  }, [open, question, sectionId, form])

  // eslint-disable-next-line react-hooks/incompatible-library
  const questionType = form.watch('questionType')

  // Confirm before switching question type (prevents accidental data loss)
  const [pendingTypeChange, setPendingTypeChange] = useState<QuestionType | null>(null)

  // Library picker — one dialog, reused for both images and formulas.
  // `libraryTab` is what the dialog opens to when the user clicks
  // one of the two trigger buttons.
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryTab, setLibraryTab] = useState<'images' | 'formulas'>('images')
  const questionTextRef = useRef<HTMLTextAreaElement | null>(null)

  const onPickLibraryImage = useCallback(
    (img: LibraryImage) => {
      // Matches the shape the existing FileUpload sets. `shouldDirty`
      // is essential — without it the Save button stays disabled.
      form.setValue('imageUrl', img.storageUrl, {
        shouldDirty: true,
        shouldValidate: true,
      })
      form.setValue('imagePath', img.storagePath, { shouldDirty: true })
      // Stable id so rapid multi-pick sessions replace the prior toast of
      // the same kind in place instead of stacking up.
      toast.success('Image attached', {
        id: 'library-pick-image',
        description: `${img.lectureTitle} · p.${img.pageNumber}`,
      })
    },
    [form],
  )

  const onPickLibraryFormula = useCallback(
    (f: LibraryFormula) => {
      const textarea = questionTextRef.current
      const token = buildFormulaToken(f.latex, f.kind)
      const { next, caret } = insertAtCaret(form.getValues('questionText') ?? '', token, textarea)
      form.setValue('questionText', next, {
        shouldDirty: true,
        shouldValidate: true,
      })
      // Park the caret after the inserted token without stealing focus —
      // the library dialog stays open for multi-pick; focus belongs to it.
      advanceCaret(textarea, caret)
      toast.success('Formula inserted', {
        id: 'library-pick-formula',
        description: `${f.lectureTitle} · p.${f.pageNumber}`,
      })
    },
    [form],
  )

  function handleTypeChange(newType: QuestionType) {
    const currentType = form.getValues('questionType')
    if (currentType === newType) return
    // Check if current content has data worth preserving
    const hasContent =
      (currentType === 'multiple_choice' && form.getValues('choices')?.some((c: { text: string }) => c.text.trim())) ||
      (currentType === 'short_answer' && form.getValues('acceptedAnswers')?.some((a: { value: string }) => a.value.trim())) ||
      (currentType === 'fill_in_blank' && form.getValues('blanks')?.some((b: { acceptedAnswers: string }) => b.acceptedAnswers.trim()))
    if (hasContent) {
      setPendingTypeChange(newType)
    } else {
      form.setValue('questionType', newType)
    }
  }

  function confirmTypeChange() {
    if (pendingTypeChange) {
      form.setValue('questionType', pendingTypeChange)
      setPendingTypeChange(null)
    }
  }

  const {
    fields: choiceFields,
    append: appendChoice,
    remove: removeChoice,
  } = useFieldArray({ control: form.control, name: 'choices' })

  const {
    fields: answerFields,
    append: appendAnswer,
    remove: removeAnswer,
  } = useFieldArray({ control: form.control, name: 'acceptedAnswers' })


  const onSubmit = useCallback(
    (data: FormValues) => {
      // Fill-in-the-blank guardrails — blanks now live inline in the question
      // text as chips, so mismatch is impossible; we only guard the empty cases.
      if (data.questionType === 'fill_in_blank') {
        const parsed = parseBlanks(data.questionText)
        if (parsed.length === 0) {
          toast.error('Add at least one blank — click “Insert blank” where a word is missing.')
          return
        }
        const emptyIndex = parsed.findIndex((b) => b.acceptedAnswers.length === 0)
        if (emptyIndex !== -1) {
          toast.error(`Blank ${emptyIndex + 1} needs at least one accepted answer.`)
          return
        }
      }

      const now = new Date().toISOString()
      const tags = data.tags
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)

      let content: Question['content']
      switch (data.questionType) {
        case 'multiple_choice':
          content = {
            questionType: 'multiple_choice',
            choices: data.choices.filter((c) => c.text.trim()),
            allowMultiple: data.allowMultiple,
          }
          break
        case 'true_false':
          content = {
            questionType: 'true_false',
            correctAnswer: data.correctAnswer,
          }
          break
        case 'short_answer':
          content = {
            questionType: 'short_answer',
            acceptedAnswers: data.acceptedAnswers.map((a) => a.value).filter(Boolean),
            caseSensitive: data.caseSensitive,
          }
          break
        case 'fill_in_blank':
          // Blanks are derived from the inline {{blank:id:answers}} tokens in the
          // question text — the single source of truth the professor edits.
          content = {
            questionType: 'fill_in_blank',
            blanks: parseBlanks(data.questionText).map((b) => ({
              id: b.id,
              acceptedAnswers: b.acceptedAnswers,
              caseSensitive: false,
            })),
          }
          break
      }

      const saved: Question = {
        id: question?.id ?? generateId(),
        sectionId,
        questionText: data.questionText,
        content,
        difficulty: data.difficulty,
        bloomsLevel: data.bloomsLevel,
        tags,
        points: data.points,
        explanation: data.explanation,
        isBonus: data.isBonus,
        isExtraCredit: data.isExtraCredit,
        eloRating: data.eloRating,
        expectedTimeSeconds: data.expectedTimeSeconds,
        // IRT params/rubric are AI-seeded and not edited in this manual dialog —
        // preserve whatever the question already had.
        irtA: question?.irtA ?? null,
        irtB: question?.irtB ?? null,
        irtC: question?.irtC ?? null,
        rubric: question?.rubric ?? null,
        imageUrl: data.imageUrl ?? null,
        imagePath: data.imagePath ?? null,
        codeSnippet: data.codeSnippet ?? null,
        createdAt: question?.createdAt ?? now,
        updatedAt: now,
      }

      onSave(saved)
      onOpenChange(false)
    },
    [question, sectionId, onSave, onOpenChange],
  )

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle>{isEditMode ? 'Edit Question' : 'New Question'}</DialogTitle>
          <DialogDescription>
            {isEditMode ? 'Update question details.' : 'Add a new question to the bank.'}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(85vh-8rem)] px-6 pb-6">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            {/* Question Type */}
            <FormField
              control={form.control}
              name="questionType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Question Type</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(v) => handleTypeChange(v as QuestionType)}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {QUESTION_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {QUESTION_TYPE_LABELS[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Question Text */}
            <FormField
              control={form.control}
              name="questionText"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center justify-between">
                    <FormLabel>Question Text *</FormLabel>
                    {questionType !== 'fill_in_blank' && (
                      <button
                        type="button"
                        onClick={() => {
                          setLibraryTab('formulas')
                          setLibraryOpen(true)
                        }}
                        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        title="Insert a LaTeX formula extracted from one of your lectures"
                      >
                        <FunctionSquare className="h-3.5 w-3.5" />
                        Insert formula
                      </button>
                    )}
                  </div>
                  <FormControl>
                    {questionType === 'fill_in_blank' ? (
                      <InlineBlankEditor value={field.value ?? ''} onChange={field.onChange} />
                    ) : (
                      <Textarea
                        placeholder="Enter your question..."
                        rows={3}
                        className="resize-none"
                        {...field}
                        ref={(el) => {
                          // forward the RHF ref and capture our own so we can
                          // read the cursor position when inserting a formula.
                          field.ref(el)
                          questionTextRef.current = el
                        }}
                      />
                    )}
                  </FormControl>
                  <FormMessage />
                  {questionType !== 'fill_in_blank' && (
                    <p className="text-[11px] text-muted-foreground">
                      Tip: LaTeX rendered via KaTeX. Use <code>$…$</code> inline or <code>$$…$$</code> display.
                    </p>
                  )}
                </FormItem>
              )}
            />

            <Separator />

            {/* Type-specific editors */}
            {questionType === 'multiple_choice' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Answer Choices</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      appendChoice({ id: generateId(), text: '', isCorrect: false })
                    }
                    disabled={choiceFields.length >= 8}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Add Choice
                  </Button>
                </div>
                <FormField
                  control={form.control}
                  name="allowMultiple"
                  render={({ field }) => (
                    <FormItem className="flex items-center gap-2">
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={(checked) => {
                            field.onChange(checked)
                            if (checked) return
                            // Same reconcile as the studio's editor: switching back to
                            // single-answer must collapse existing marks, or the question
                            // saves in the state the switch says is impossible — and a
                            // 2-correct single-answer question marks EVERY student wrong
                            // (see multipleChoiceContentSchema).
                            const choices = form.getValues('choices')
                            const firstCorrect = choices.findIndex((c) => c.isCorrect)
                            choices.forEach((_, i) =>
                              form.setValue(`choices.${i}.isCorrect`, i === firstCorrect, {
                                shouldDirty: true,
                              }),
                            )
                          }}
                        />
                      </FormControl>
                      <FormLabel className="mt-0!">Allow multiple correct answers</FormLabel>
                    </FormItem>
                  )}
                />
                {choiceFields.map((field, index) => (
                  <div key={field.id} className="flex items-center gap-2">
                    <FormField
                      control={form.control}
                      name={`choices.${index}.isCorrect`}
                      render={({ field: checkField }) => (
                        <Checkbox
                          aria-label={`Choice ${index + 1} is correct`}
                          checked={checkField.value}
                          onCheckedChange={(checked) => {
                            checkField.onChange(checked)
                            // Radio semantics while multiple answers are off.
                            if (!checked || form.getValues('allowMultiple')) return
                            form.getValues('choices').forEach((_, i) => {
                              if (i !== index) {
                                form.setValue(`choices.${i}.isCorrect`, false, { shouldDirty: true })
                              }
                            })
                          }}
                        />
                      )}
                    />
                    <Input
                      placeholder={`Choice ${index + 1}`}
                      {...form.register(`choices.${index}.text`)}
                      className="flex-1"
                    />
                    {choiceFields.length > 2 && (
                      <button
                        type="button"
                        onClick={() => removeChoice(index)}
                        className="p-1 rounded-full text-muted-foreground hover:text-destructive"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {questionType === 'true_false' && (
              <FormField
                control={form.control}
                name="correctAnswer"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Correct Answer</FormLabel>
                    <Select
                      value={field.value ? 'true' : 'false'}
                      onValueChange={(v) => field.onChange(v === 'true')}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="true">True</SelectItem>
                        <SelectItem value="false">False</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
            )}

            {questionType === 'short_answer' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Accepted Answers</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => appendAnswer({ value: '' })}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Add Answer
                  </Button>
                </div>
                {answerFields.map((field, index) => (
                  <div key={field.id} className="flex items-center gap-2">
                    <Input
                      placeholder={`Answer ${index + 1}`}
                      {...form.register(`acceptedAnswers.${index}.value`)}
                      className="flex-1"
                    />
                    {answerFields.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeAnswer(index)}
                        className="p-1 rounded-full text-muted-foreground hover:text-destructive"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
                <FormField
                  control={form.control}
                  name="caseSensitive"
                  render={({ field }) => (
                    <FormItem className="flex items-center gap-2">
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <FormLabel className="mt-0!">Case sensitive</FormLabel>
                    </FormItem>
                  )}
                />
              </div>
            )}

            {/* Fill-in-blank answers are authored inline in the Question Text via
                chips (InlineBlankEditor) — no separate blanks list. */}

            <Separator />

            {/* Metadata */}
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="difficulty"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Difficulty</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={(v) => field.onChange(v as DifficultyLevel)}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {DIFFICULTY_LEVELS.map((d) => (
                          <SelectItem key={d} value={d}>
                            {DIFFICULTY_LABELS[d]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="points"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Points</FormLabel>
                    <FormControl>
                      <NumericInput min={1} max={100} value={field.value} onChange={(v) => field.onChange(parseInt(v) || 1)} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Bonus / Extra Credit */}
            <div className="flex gap-6">
              <FormField
                control={form.control}
                name="isBonus"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-2">
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                    <FormLabel className="mt-0!">Bonus Question</FormLabel>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="isExtraCredit"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-2">
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
      <FormLabel className="mt-0!">Extra Credit</FormLabel>
    </FormItem>
  )}
/>
</div>

<Separator />

{/* Image Upload Section */}
<div className="space-y-3">
<div className="flex items-center justify-between">
  <FormLabel className="text-sm font-medium">Image (Optional)</FormLabel>
  <button
    type="button"
    onClick={() => {
      setLibraryTab('images')
      setLibraryOpen(true)
    }}
    className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
    title="Pick an image already extracted from one of your lectures"
  >
    <Library className="h-3.5 w-3.5" />
    Pick from library
  </button>
</div>
<FormField
  control={form.control}
  name="imageUrl"
  render={({ field }) => (
    <FormItem>
      {field.value ? (
        <div className="relative group w-fit">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={field.value}
            alt="Question"
            className="h-32 w-auto rounded-xl border object-contain bg-muted/30"
          />
          <Button
            type="button"
            variant="destructive"
            size="icon"
            className="absolute -top-2 -right-2 h-6 w-6 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={async () => {
              const path = form.getValues('imagePath')
              // Only delete the uploaded blob if it's in the quiz-images
              // folder — library-picked images live under extracted-images/
              // and are still referenced by the source lecture.
              if (path && path.startsWith('quiz-images/')) {
                await deleteFile(path)
              }
              form.setValue('imageUrl', null, { shouldDirty: true })
              form.setValue('imagePath', null, { shouldDirty: true })
            }}
            aria-label="Remove image"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <FormControl>
          <FileUpload
            folder={`${sectionId}/quiz-images/${isEditMode ? question.id : 'new'}`}
            accept="image/*"
            onUpload={(res) => {
              form.setValue('imageUrl', res.url, { shouldDirty: true, shouldValidate: true })
              form.setValue('imagePath', res.path, { shouldDirty: true })
            }}
          />
        </FormControl>
      )}
      <FormMessage />
    </FormItem>
  )}
/>
</div>

<Separator />

{/* Code Snippet Section */}
<div className="space-y-4">
<div className="flex items-center justify-between">
  <FormLabel className="text-sm font-medium">Code Snippet (Optional)</FormLabel>
  <FormField
    control={form.control}
    name="codeSnippet"
    render={({ field }) => (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(
          'h-7 text-xs',
          field.value ? 'text-destructive hover:text-destructive' : ''
        )}
        onClick={() => {
          if (field.value) {
            form.setValue('codeSnippet', null)
          } else {
            form.setValue('codeSnippet', { language: 'javascript', code: '' })
          }
        }}
      >
        {field.value ? 'Remove Code' : 'Add Code Snippet'}
      </Button>
    )}
  />
</div>

<FormField
  control={form.control}
  name="codeSnippet"
  render={({ field }) => (
    <>
      {field.value && (
        <div className="space-y-3 p-3 rounded-xl border bg-muted/20">
          <Select
            value={field.value.language}
            onValueChange={(v) => form.setValue('codeSnippet', { ...field.value!, language: v })}
          >
            <FormControl>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
            </FormControl>
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
          <FormControl>
            <Textarea
              placeholder="Paste your code here..."
              className="font-mono text-xs min-h-[100px] bg-background"
              value={field.value.code}
              onChange={(e) =>
                form.setValue('codeSnippet', { ...field.value!, code: e.target.value })
              }
            />
          </FormControl>
          {field.value.code && (
            <div className="mt-2">
              <p className="text-[10px] text-muted-foreground mb-1 uppercase font-semibold">
                Preview
              </p>
              <QuizCodeBlock language={field.value.language} code={field.value.code} />
            </div>
          )}
        </div>
      )}
    </>
  )}
/>
</div>

<Separator />

            <FormField
              control={form.control}
              name="bloomsLevel"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Bloom&apos;s Taxonomy Level</FormLabel>
                  <Select
                    value={field.value ?? 'none'}
                    onValueChange={(v) =>
                      field.onChange(v === 'none' ? null : (v as BloomsLevel))
                    }
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Optional" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {BLOOMS_LEVELS.map((b) => (
                        <SelectItem key={b} value={b}>
                          {BLOOMS_LABELS[b]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="tags"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tags</FormLabel>
                  <FormControl>
                    <Input placeholder="algebra, chapter-3, midterm (comma-separated)" {...field} />
                  </FormControl>
                  <p className="text-[10px] text-muted-foreground">Tags are normalized to lowercase automatically.</p>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="explanation"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Explanation</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Shown to students after answering (optional)"
                      rows={2}
                      className="resize-none"
                      {...field}
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit">
                {isEditMode ? 'Update Question' : 'Create Question'}
              </Button>
            </div>
          </form>
        </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>

    {/* Confirm type change dialog */}
    <AlertDialog open={!!pendingTypeChange} onOpenChange={(open) => { if (!open) setPendingTypeChange(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Change question type?</AlertDialogTitle>
          <AlertDialogDescription>
            Switching to {pendingTypeChange ? QUESTION_TYPE_LABELS[pendingTypeChange] : ''} will clear your current answer choices. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={confirmTypeChange}>Switch Type</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    {/* Library picker (PR 6) — reused for both image and formula insertion */}
    <InsertFromLibraryDialog
      open={libraryOpen}
      onOpenChange={setLibraryOpen}
      sectionId={sectionId}
      initialTab={libraryTab}
      onPickImage={onPickLibraryImage}
      onPickFormula={onPickLibraryFormula}
    />
    </>
  )
}
