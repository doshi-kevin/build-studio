// Right sidebar of the quiz studio: the selected question's own settings —
// difficulty, points, Bloom's, tags, explanation, bonus/extra-credit, delete.
// Moved out of QuestionEditorCard so the canvas stays focused on content
// (docs/designs/quizzes/quiz-editor-studio.md). Fully controlled via onChange.

'use client'

import { Info, Trash2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'
import {
  DIFFICULTY_LEVELS,
  DIFFICULTY_LABELS,
  BLOOMS_LEVELS,
  BLOOMS_LABELS,
  type DifficultyLevel,
  type BloomsLevel,
} from '@/lib/validations/quiz'
import { DEFAULT_IRT_A } from '@/lib/quiz/irt/estimator'
import { cn } from '@/lib/utils'
import type { WizardQuestion } from './QuestionEditorCard'

/** Small (i) hover/focus hint next to a setting label. */
function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Info
            tabIndex={0}
            role="button"
            aria-label={label}
            className="h-3.5 w-3.5 cursor-help text-muted-foreground"
          />
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-xs">
          <p className="text-xs">{children}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// Difficulty ↔ IRT `b` are kept in sync: the categorical label is the friendly
// view, `b` is the continuous value the CCAT engine actually uses. Canonical
// anchors match the AI fallback map (llm-client: easy −1 / medium 0 / hard +1).
// Standard (non-adaptive) quizzes only read the category, so this never breaks them.
// Clicking a difficulty segment snaps b to that end of the −3…3 scale.
const B_FOR_DIFFICULTY: Record<DifficultyLevel, number> = { easy: -3, medium: 0, hard: 3 }
// Label from a typed number — thirds of the −3…3 scale: b < −1 easy, −1…1 medium, b > 1 hard.
function difficultyForB(b: number): DifficultyLevel {
  if (b < -1) return 'easy'
  if (b > 1) return 'hard'
  return 'medium'
}
// Difficulty colours — matches the app convention (PickFromBank, Challenges).
const DIFFICULTY_COLORS: Record<DifficultyLevel, string> = {
  easy: 'bg-success-muted text-success-muted-foreground',
  medium: 'bg-warning-muted text-warning-muted-foreground',
  hard: 'bg-destructive-muted text-destructive-muted-foreground',
}
// Short pill labels so number + pills fit one row in the ~200px sidebar frame
// (full names stay on the buttons' aria-labels).
const DIFFICULTY_PILL_LABELS: Record<DifficultyLevel, string> = {
  easy: 'Easy',
  medium: 'Med',
  hard: 'Hard',
}

/**
 * Does this text contain markdown/LaTeX that renders to something different from the raw
 * source? Deliberately narrow — math delimiters, escaped LaTeX commands, code ticks, and
 * paired bold/italic markers. A lone underscore or asterisk in prose ("state_of_the_art",
 * "3 * 4") must NOT trigger a preview, or every field grows a duplicate of itself.
 */
function hasRichSyntax(text: string): boolean {
  if (!text) return false
  return (
    /\$[^$]+\$/.test(text) || // $…$ inline math
    /\\\(|\\\[/.test(text) || // \( … \)  /  \[ … \]
    /\\[a-zA-Z]{2,}/.test(text) || // \times, \frac, \alpha …
    /`[^`]+`/.test(text) || // `code`
    /\*\*[^*]+\*\*/.test(text) // **bold**
  )
}

interface QuizStudioQuestionSidebarProps {
  question: WizardQuestion
  index: number
  onChange: (updated: WizardQuestion) => void
  onRemove: () => void
  /** Whether the quiz is adaptive — gates the numeric IRT difficulty/discrimination controls */
  adaptive?: boolean
}

export function QuizStudioQuestionSidebar({
  question,
  index,
  onChange,
  onRemove,
  adaptive,
}: QuizStudioQuestionSidebarProps) {
  const update = (partial: Partial<WizardQuestion>) => {
    onChange({ ...question, ...partial })
  }

  return (
    <div className="space-y-4">
      {/* Header — heading + aside landmark (in QuizStudio) give AT users an anchor.
          aria-label keeps the SR reading clean ("Question 1 settings") while the
          visible parts are split for styling. */}
      <h3 aria-label={`Question ${index + 1} settings`} className="flex items-baseline gap-2">
        {/* "Q1" reads as one identifier — the number carries the emphasis in the
            primary blue (echoing the selected rail thumb), no competing chip shape.
            tracking-tight keeps the letter + digit hugging as a single token. */}
        <span aria-hidden="true" className="text-sm font-bold tracking-tight text-muted-foreground">
          Q<span className="text-primary">{index + 1}</span>
        </span>
        <span
          aria-hidden="true"
          className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Settings
        </span>
      </h3>

      {/* Difficulty — label · (i), then ONE bordered control: the b number
          (adaptive only) with the easy/medium/hard pills inside the same frame.
          The numeric b (−3…3) is the source of truth when adaptive and the
          category label updates from it; standard quizzes get the same pills
          without the number (clicking still anchors b). flex-wrap: the pills
          drop to a second row inside the frame instead of overflowing. */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <Label className="text-xs text-muted-foreground">Difficulty</Label>
          {adaptive && (
            <InfoTip label="About adaptive difficulty">
              Adaptive difficulty (b) runs −3 (easiest) to +3 (hardest). Easy is below −1,
              Medium −1 to +1, Hard above +1 — clicking a label snaps b to −3 / 0 / +3.
            </InfoTip>
          )}
        </div>
        <div className="flex min-h-9 flex-wrap items-center gap-x-1 gap-y-1 rounded-xl border border-input px-2 py-1">
          {adaptive && (
            <Input
              type="number"
              step={0.1}
              min={-3}
              max={3}
              aria-label="Difficulty (b), −3 easier to +3 harder"
              placeholder="0"
              className="h-7 w-12 border-0 p-0 tabular-nums shadow-none focus-visible:ring-0"
              value={question.irtB ?? ''}
              onChange={(e) => {
                if (e.target.value === '') {
                  update({ irtB: null })
                  return
                }
                const b = parseFloat(e.target.value)
                if (Number.isNaN(b)) {
                  update({ irtB: null })
                  return
                }
                // Number drives the category.
                update({ irtB: b, difficulty: difficultyForB(b) })
              }}
            />
          )}
          <div
            className={cn('flex items-center gap-0.5', adaptive && 'ml-auto')}
            role="group"
            aria-label="Difficulty"
          >
            {DIFFICULTY_LEVELS.map((d) => {
              // Adaptive with a stored b: the number is the source of truth, so
              // the highlight derives from it (AI items can carry a drifted
              // category). Otherwise the stored category is all there is.
              const active =
                adaptive && question.irtB != null
                  ? difficultyForB(question.irtB) === d
                  : question.difficulty === d
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={active}
                  aria-label={DIFFICULTY_LABELS[d]}
                  onClick={() => update({ difficulty: d, irtB: B_FOR_DIFFICULTY[d] })}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active ? DIFFICULTY_COLORS[d] : 'text-muted-foreground/50 hover:text-foreground',
                  )}
                >
                  {DIFFICULTY_PILL_LABELS[d]}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Points lives on the editor card's header pill row (with apply-to-all) */}

      {/* Discrimination (a) — adaptive-only; how sharply the item separates
          strong from weak students. AI-seeded, professor-tunable; questions
          with no stored value show (and run with) the engine default. */}
      {adaptive && (
        <div className="flex items-center gap-1.5">
          <Label className="text-xs text-muted-foreground">Discrimination</Label>
          <InfoTip label="About discrimination">
            How sharply the question separates stronger from weaker students — 0.5 gentle
            to 2.5 sharp. New questions start at the engine default of {DEFAULT_IRT_A};
            AI-generated ones arrive pre-tuned.
          </InfoTip>
          <Input
            type="number"
            step={0.1}
            min={0.5}
            max={2.5}
            aria-label="Discrimination (a), 0.5 gentle to 2.5 sharp"
            // Muted while riding the engine default — a tuned value reads solid
            className={cn(
              'ml-auto h-7 w-14 px-2 tabular-nums',
              question.irtA == null && 'text-muted-foreground',
            )}
            value={question.irtA ?? DEFAULT_IRT_A}
            onChange={(e) => {
              if (e.target.value === '') {
                update({ irtA: null })
                return
              }
              const a = parseFloat(e.target.value)
              update({ irtA: Number.isNaN(a) ? null : a })
            }}
          />
        </div>
      )}

      {/* Bloom's Level — compact label · (i) · value dropdown on one row */}
      <div className="flex items-center gap-1.5">
        <Label className="text-xs text-muted-foreground">Bloom&apos;s</Label>
        <InfoTip label="About Bloom's level">
          Bloom&apos;s taxonomy — the kind of thinking the question demands, from recalling
          facts (Remember) up to producing original work (Create). Optional; it feeds the
          quiz insights, students never see it.
        </InfoTip>
        <Select
          value={question.bloomsLevel ?? 'none'}
          onValueChange={(v) => update({ bloomsLevel: v === 'none' ? null : (v as BloomsLevel) })}
        >
          <SelectTrigger
            aria-label="Bloom's level"
            className="ml-auto h-auto w-auto gap-1 border-0 p-0 text-xs font-semibold shadow-none"
          >
            <SelectValue placeholder="None" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            {BLOOMS_LEVELS.map((b) => (
              <SelectItem key={b} value={b}>
                {BLOOMS_LABELS[b]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Tags */}
      <div className="space-y-1.5">
        <Label htmlFor={`q-tags-${question.clientId}`} className="text-xs text-muted-foreground">
          Tags
        </Label>
        <Input
          id={`q-tags-${question.clientId}`}
          placeholder="comma-separated"
          className="h-9"
          value={question.tags}
          onChange={(e) => update({ tags: e.target.value })}
        />
      </div>

      {/* Explanation — the textarea has to show raw source to be editable, but generated
          explanations are full of markdown and LaTeX ($…$, \times, **bold**), which reads
          as gibberish. So when the text actually contains that syntax, show it rendered
          underneath, using the same MarkdownLatex the player and review cards use. Labelled
          "Rendered preview" rather than "as students will see it" because showExplanations
          can be 'never' — the claim would be false on those quizzes. Plain prose gets no
          preview (nothing to reveal). */}
      <div className="space-y-1.5">
        <Label htmlFor={`q-explanation-${question.clientId}`} className="text-xs text-muted-foreground">
          Explanation
        </Label>
        <Textarea
          id={`q-explanation-${question.clientId}`}
          placeholder="Shown to students after answering (optional)"
          rows={2}
          className="resize-none"
          value={question.explanation}
          onChange={(e) => update({ explanation: e.target.value })}
        />
        {hasRichSyntax(question.explanation) && (
          <div className="rounded-xl border border-border bg-muted/40 px-2.5 py-2">
            <p className="mb-1 text-xs text-muted-foreground">Rendered preview</p>
            <MarkdownLatex
              content={question.explanation}
              variant="compact"
              className="text-xs text-foreground"
            />
          </div>
        )}
      </div>

      {/* Bonus / Extra Credit */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Switch
            id={`q-bonus-${question.clientId}`}
            checked={question.isBonus}
            onCheckedChange={(checked) => update({ isBonus: checked })}
          />
          <Label htmlFor={`q-bonus-${question.clientId}`} className="text-xs">
            Bonus
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id={`q-extra-credit-${question.clientId}`}
            checked={question.isExtraCredit}
            onCheckedChange={(checked) => update({ isExtraCredit: checked })}
          />
          <Label htmlFor={`q-extra-credit-${question.clientId}`} className="text-xs">
            Extra Credit
          </Label>
        </div>
      </div>

      {/* Delete */}
      <div className="border-t pt-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-1.5 text-destructive hover:text-destructive"
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          Delete question
        </Button>
      </div>
    </div>
  )
}
