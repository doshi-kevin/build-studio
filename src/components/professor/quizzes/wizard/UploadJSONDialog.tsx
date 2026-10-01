// Dialog for importing quiz questions by pasting JSON. Accepts the legacy
// SkillSignal format with question, options, answer (letter), difficulty, and
// optional slide reference. Converts to WizardQuestion format for the quiz editor.

'use client'

import { useState, useCallback } from 'react'
import { Import, AlertCircle, CheckCircle2, Info, Copy, Check, Bot } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { generateId } from '@/lib/quiz/utils'
import type { WizardQuestion } from './QuestionEditorCard'

// ── Expected JSON Schema ─────────────────────────────────────

interface LegacyQuestion {
  question: string
  options: string[]
  answer: string // Letter: "A", "B", "C", "D"
  difficulty?: 'easy' | 'medium' | 'hard'
  slide?: string
}

const EXAMPLE_JSON = `[
  {
    "question": "What is NLP primarily concerned with?",
    "options": [
      "Creating artificial languages",
      "Interactions between computers and human languages",
      "Teaching foreign languages",
      "Designing programming languages"
    ],
    "answer": "B",
    "difficulty": "medium",
    "slide": "18"
  }
]`

const AI_PROMPT = `Based on our conversation so far, generate quiz questions as a JSON array. Use the topics, concepts, and details we've discussed as the primary source material. Output the JSON inside a \`\`\`json code block with no other text or explanation.

\`\`\`json
[
  {
    "question": "The question text",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "answer": "B",
    "difficulty": "medium"
  }
]
\`\`\`

Rules:
- Draw questions directly from the concepts, examples, and explanations covered in this conversation. If I shared notes, slides, or topics, prioritize those.
- Each question must have exactly 4 options.
- "answer" is the letter (A, B, C, or D) corresponding to the correct option.
- "difficulty" must be one of: "easy", "medium", or "hard". If I've mentioned a preferred difficulty level or distribution earlier in our conversation, follow that. Otherwise, include a balanced mix of all three.
- Generate 20 questions unless I specify otherwise.`

const LETTER_TO_INDEX: Record<string, number> = {
  A: 0, B: 1, C: 2, D: 3, E: 4, F: 5,
  a: 0, b: 1, c: 2, d: 3, e: 4, f: 5,
}

// ── Props ────────────────────────────────────────────────────

interface UploadJSONDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: (questions: WizardQuestion[]) => void
}

export function UploadJSONDialog({ open, onOpenChange, onImported }: UploadJSONDialogProps) {
  const [jsonText, setJsonText] = useState('')
  const [preview, setPreview] = useState<{ total: number; easy: number; medium: number; hard: number } | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [parsed, setParsed] = useState<LegacyQuestion[]>([])
  const [copied, setCopied] = useState(false)

  const reset = useCallback(() => {
    setJsonText('')
    setPreview(null)
    setErrors([])
    setParsed([])
  }, [])

  const validate = useCallback((text: string) => {
    setJsonText(text)
    setErrors([])
    setPreview(null)
    setParsed([])

    if (!text.trim()) return

    // Strip code fences (```json ... ```) so professors can paste AI output directly
    let cleaned = text.trim()
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```\s*$/i, '')

    try {
      const raw = JSON.parse(cleaned)

      if (!Array.isArray(raw)) {
        setErrors(['JSON must be an array of question objects'])
        return
      }

      if (raw.length === 0) {
        setErrors(['Array is empty — add at least one question'])
        return
      }

      const validationErrors: string[] = []
      const valid: LegacyQuestion[] = []

      raw.forEach((item: Record<string, unknown>, idx: number) => {
        const qNum = idx + 1

        if (!item.question || typeof item.question !== 'string') {
          validationErrors.push(`Q${qNum}: Missing or invalid "question" field`)
          return
        }

        if (!Array.isArray(item.options) || item.options.length < 2) {
          validationErrors.push(`Q${qNum}: "options" must be an array with at least 2 items`)
          return
        }

        if (!item.answer || typeof item.answer !== 'string' || !(item.answer.toUpperCase() in LETTER_TO_INDEX)) {
          validationErrors.push(`Q${qNum}: "answer" must be a letter (A, B, C, D...)`)
          return
        }

        const answerIdx = LETTER_TO_INDEX[item.answer.toUpperCase()]
        if (answerIdx >= (item.options as string[]).length) {
          validationErrors.push(`Q${qNum}: Answer "${item.answer}" exceeds number of options (${(item.options as string[]).length})`)
          return
        }

        const diff = item.difficulty as string | undefined
        if (diff && !['easy', 'medium', 'hard'].includes(diff)) {
          validationErrors.push(`Q${qNum}: "difficulty" must be "easy", "medium", or "hard" (got "${diff}")`)
          return
        }

        valid.push({
          question: item.question as string,
          options: item.options as string[],
          answer: (item.answer as string).toUpperCase(),
          difficulty: (diff as 'easy' | 'medium' | 'hard') || 'medium',
          slide: item.slide as string | undefined,
        })
      })

      if (validationErrors.length > 0) {
        const shown = validationErrors.slice(0, 10)
        if (validationErrors.length > 10) {
          shown.push(`... and ${validationErrors.length - 10} more errors`)
        }
        setErrors(shown)
      }

      if (valid.length > 0) {
        setParsed(valid)
        setPreview({
          total: valid.length,
          easy: valid.filter((q) => q.difficulty === 'easy').length,
          medium: valid.filter((q) => q.difficulty === 'medium').length,
          hard: valid.filter((q) => q.difficulty === 'hard').length,
        })
      }
    } catch {
      setErrors(['Invalid JSON — check your syntax'])
    }
  }, [])

  const handleImport = useCallback(() => {
    if (parsed.length === 0) return

    const wizardQuestions: WizardQuestion[] = parsed.map((q) => {
      const answerIdx = LETTER_TO_INDEX[q.answer]
      const choices = q.options.map((text, idx) => ({
        id: generateId(),
        text,
        isCorrect: idx === answerIdx,
      }))

      return {
        clientId: generateId(),
        questionText: q.question,
        questionType: 'multiple_choice' as const,
        difficulty: q.difficulty || 'medium',
        bloomsLevel: null,
        tags: q.slide ? `slide:${q.slide}` : '',
        points: q.difficulty === 'easy' ? 1 : q.difficulty === 'hard' ? 3 : 2,
        explanation: '',
        isBonus: false,
        isExtraCredit: false,
        choices,
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
      }
    })

    onImported(wizardQuestions)
    toast.success(`Imported ${wizardQuestions.length} questions`)
    reset()
    onOpenChange(false)
  }, [parsed, onImported, onOpenChange, reset])

  const handleCopyPrompt = useCallback(() => {
    navigator.clipboard.writeText(AI_PROMPT)
    setCopied(true)
    toast.success('Copied! Paste this into ChatGPT, Claude, or any AI chat to generate questions')
    setTimeout(() => setCopied(false), 2000)
  }, [])

  const handlePasteExample = useCallback(() => {
    setJsonText(EXAMPLE_JSON)
    validate(EXAMPLE_JSON)
  }, [validate])

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset()
        onOpenChange(v)
      }}
    >
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Import className="h-5 w-5" />
            Import questions
          </DialogTitle>
          <DialogDescription>
            Paste your questions as a JSON array. Each question needs a question text,
            options, answer letter, and difficulty level.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 flex-1 overflow-y-auto min-h-0 pr-1">
          {/* AI generation helper — collapses to single row once JSON is pasted */}
          {parsed.length > 0 ? (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-xs text-muted-foreground"
                onClick={handleCopyPrompt}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-success-muted-foreground" />
                ) : (
                  <Bot className="h-3.5 w-3.5" />
                )}
                {copied ? 'Copied!' : 'Copy Instructions for AI'}
              </Button>
              <div className="relative group inline-block ml-auto">
                <button type="button" className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                  <Info className="h-3.5 w-3.5" />
                  <span className="text-[11px] uppercase tracking-[0.12em] font-semibold">
                    Format
                  </span>
                </button>
                <div className="absolute right-0 top-full mt-1.5 z-50 hidden group-hover:block">
                  <div className="rounded-xl border bg-popover text-popover-foreground shadow-md max-w-sm p-3 space-y-2">
                    <pre className="text-[11px] leading-relaxed font-mono whitespace-pre">
{`[
  {
    "question": "Your question text",
    "options": ["Option A", "Option B", ...],
    "answer": "B",
    "difficulty": "easy" | "medium" | "hard",
    "slide": "18"
  }
]`}
                    </pre>
                    <p className="text-[10px] leading-relaxed">
                      <strong>answer</strong>: Letter (A, B, C, D...) &bull;{' '}
                      <strong>difficulty</strong>: Defaults to &quot;medium&quot; &bull;{' '}
                      <strong>slide</strong>: Optional, saved as tag &bull;{' '}
                      <strong>Points</strong>: easy=1, medium=2, hard=3
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-xl border border-border bg-background flex items-center justify-center shrink-0">
                    <Bot className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">Use AI to generate questions</p>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                      Copy the instructions below and paste them into ChatGPT, Claude, or any AI assistant.
                      It will generate questions in the right format — then paste the result here.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={handleCopyPrompt}
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-success-muted-foreground" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copied ? 'Copied!' : 'Copy Instructions for AI'}
                  </Button>
                  <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={handlePasteExample}>
                    Try Example
                  </Button>
                </div>
              </div>

              {/* Schema hint — only shown before paste */}
              <div className="relative group inline-block">
                <button type="button" className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                  <Info className="h-3.5 w-3.5" />
                  <span className="text-[11px] uppercase tracking-[0.12em] font-semibold">
                    Expected Format
                  </span>
                </button>
                <div className="absolute left-0 top-full mt-1.5 z-50 hidden group-hover:block">
                  <div className="rounded-xl border bg-popover text-popover-foreground shadow-md max-w-sm p-3 space-y-2">
                    <pre className="text-[11px] leading-relaxed font-mono whitespace-pre">
{`[
  {
    "question": "Your question text",
    "options": ["Option A", "Option B", ...],
    "answer": "B",
    "difficulty": "easy" | "medium" | "hard",
    "slide": "18"
  }
]`}
                    </pre>
                    <p className="text-[10px] leading-relaxed">
                      <strong>answer</strong>: Letter (A, B, C, D...) &bull;{' '}
                      <strong>difficulty</strong>: Defaults to &quot;medium&quot; &bull;{' '}
                      <strong>slide</strong>: Optional, saved as tag &bull;{' '}
                      <strong>Points</strong>: easy=1, medium=2, hard=3
                    </p>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Paste area */}
          <Textarea
            placeholder="Paste your JSON array here..."
            value={jsonText}
            onChange={(e) => validate(e.target.value)}
            className="font-mono text-xs min-h-[320px] max-h-[450px] resize-y"
          />

          {/* Validation Errors */}
          {errors.length > 0 && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 space-y-1">
              <div className="flex items-center gap-1.5 text-destructive text-xs font-medium">
                <AlertCircle className="h-3.5 w-3.5" />
                Validation Issues
              </div>
              <ul className="text-[11px] text-destructive/80 space-y-0.5 pl-5 list-disc">
                {errors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Preview */}
          {preview && (
            <div className="rounded-xl border bg-success-muted/40 border-success/30 p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-success-muted-foreground text-xs font-medium">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Ready to import {preview.total} questions
              </div>
              <div className="flex items-center gap-4 text-[11px]">
                <span className="text-muted-foreground">
                  Easy: <strong className="text-foreground">{preview.easy}</strong>
                </span>
                <span className="text-muted-foreground">
                  Medium: <strong className="text-foreground">{preview.medium}</strong>
                </span>
                <span className="text-muted-foreground">
                  Hard: <strong className="text-foreground">{preview.hard}</strong>
                </span>
              </div>
            </div>
          )}

        </div>

        {/* Sticky footer */}
        <div className="flex justify-end gap-2 pt-4 border-t shrink-0">
          <Button variant="outline" size="sm" onClick={() => { reset(); onOpenChange(false) }}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={parsed.length === 0}
            onClick={handleImport}
          >
            <Import className="h-4 w-4 mr-1" />
            Import {parsed.length > 0 ? `${parsed.length} Questions` : ''}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
