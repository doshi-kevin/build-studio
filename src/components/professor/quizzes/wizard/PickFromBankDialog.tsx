// Dialog for picking existing questions from the question bank.
// Shows searchable/filterable list with checkboxes.

'use client'

import { useState, useMemo } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import {
  QUESTION_TYPE_LABELS,
  QUESTION_TYPES,
  QUIZ_ITEM_TYPES,
  DIFFICULTY_LEVELS,
  DIFFICULTY_LABELS,
  type Question,
  type QuizItemType,
  type DifficultyLevel,
} from '@/lib/validations/quiz'
import { cn } from '@/lib/utils'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'
import { blankPlaceholderText } from '@/lib/quiz/fill-in-blank'

const DIFFICULTY_COLORS: Record<DifficultyLevel, string> = {
  easy: 'bg-success-muted text-success-muted-foreground',
  medium: 'bg-warning-muted text-warning-muted-foreground',
  hard: 'bg-destructive-muted text-destructive-muted-foreground',
}

interface PickFromBankDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  allQuestions: Question[]
  /** IDs of questions already in the quiz */
  existingIds: Set<string>
  onAdd: (questions: Question[]) => void
  /** Whether the quiz is adaptive. AI-graded bank questions (explanation/walkthrough)
   *  can't be graded by the standard linear flow, so they're hidden when off. */
  adaptive?: boolean
}

export function PickFromBankDialog({
  open,
  onOpenChange,
  allQuestions,
  existingIds,
  onAdd,
  adaptive,
}: PickFromBankDialogProps) {
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<QuizItemType | 'all'>('all')
  const [difficultyFilter, setDifficultyFilter] = useState<DifficultyLevel | 'all'>('all')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const filtered = useMemo(() => {
    return allQuestions.filter((q) => {
      // Incomplete placeholder questions belong to their draft quiz only — never
      // offer them for reuse here until they're filled in.
      if (q.isComplete === false) return false
      const t = q.content.questionType
      if (!adaptive && (t === 'explanation' || t === 'walkthrough')) return false
      if (search) {
        const s = search.toLowerCase()
        if (
          !q.questionText.toLowerCase().includes(s) &&
          !q.tags.some((t) => t.toLowerCase().includes(s))
        ) {
          return false
        }
      }
      if (typeFilter !== 'all' && q.content.questionType !== typeFilter) return false
      if (difficultyFilter !== 'all' && q.difficulty !== difficultyFilter) return false
      return true
    })
  }, [allQuestions, search, typeFilter, difficultyFilter, adaptive])

  const toggleId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleAdd = () => {
    const toAdd = allQuestions.filter((q) => selectedIds.has(q.id))
    onAdd(toAdd)
    setSelectedIds(new Set())
    onOpenChange(false)
  }

  const handleClose = () => {
    setSelectedIds(new Set())
    setSearch('')
    setTypeFilter('all')
    setDifficultyFilter('all')
    onOpenChange(false)
  }

  return (
    <Sheet open={open} onOpenChange={handleClose}>
      <SheetContent side="right" className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Pick from Question Bank</SheetTitle>
          <SheetDescription>
            Select questions to add to this quiz. {allQuestions.length} questions in bank.
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search questions or tags..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Filters */}
          <div className="flex gap-2">
            <Select
              value={typeFilter}
              onValueChange={(v) => setTypeFilter(v as QuizItemType | 'all')}
            >
              <SelectTrigger className="flex-1" aria-label="Filter by type">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {/* Adaptive quizzes can hold the AI-graded types too */}
                {(adaptive ? QUIZ_ITEM_TYPES : QUESTION_TYPES).map((t) => (
                  <SelectItem key={t} value={t}>
                    {QUESTION_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={difficultyFilter}
              onValueChange={(v) => setDifficultyFilter(v as DifficultyLevel | 'all')}
            >
              <SelectTrigger className="flex-1" aria-label="Filter by difficulty">
                <SelectValue placeholder="Difficulty" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Difficulties</SelectItem>
                {DIFFICULTY_LEVELS.map((d) => (
                  <SelectItem key={d} value={d}>
                    {DIFFICULTY_LABELS[d]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Question List */}
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-1 pr-3">
              {filtered.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">
                  {allQuestions.length === 0
                    ? 'No questions in the bank yet.'
                    : 'No questions match your filters.'}
                </p>
              )}
              {filtered.map((q) => {
                const isInQuiz = existingIds.has(q.id)
                const isSelected = selectedIds.has(q.id)

                return (
                  <label
                    key={q.id}
                    className={cn(
                      'flex items-start gap-3 p-2.5 rounded-xl cursor-pointer transition-colors',
                      isInQuiz
                        ? 'opacity-50 cursor-not-allowed'
                        : 'hover:bg-muted/50',
                      isSelected && 'bg-primary/5',
                    )}
                  >
                    <Checkbox
                      checked={isSelected || isInQuiz}
                      onCheckedChange={() => {
                        if (!isInQuiz) toggleId(q.id)
                      }}
                      disabled={isInQuiz}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="line-clamp-2">
                        <MarkdownLatex content={blankPlaceholderText(q.questionText)} variant="compact" className="text-sm" />
                      </div>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span className="text-xs text-muted-foreground">
                          {QUESTION_TYPE_LABELS[q.content.questionType]}
                        </span>
                        <Badge
                          variant="secondary"
                          className={cn('text-xs', DIFFICULTY_COLORS[q.difficulty])}
                        >
                          {DIFFICULTY_LABELS[q.difficulty]}
                        </Badge>
                        <span className="text-xs text-muted-foreground">{q.points} pt</span>
                        {isInQuiz && (
                          <Badge variant="outline" className="text-[10px]">
                            Already in quiz
                          </Badge>
                        )}
                      </div>
                    </div>
                  </label>
                )
              })}
            </div>
          </ScrollArea>

        </div>

        {/* Footer — pinned below the scrolling list */}
        <div className="flex items-center justify-between gap-2 border-t p-4">
          <span className="text-sm text-muted-foreground">
            {selectedIds.size} selected
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button onClick={handleAdd} disabled={selectedIds.size === 0}>
              {selectedIds.size > 1 ? `Add ${selectedIds.size} questions` : 'Add'}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
