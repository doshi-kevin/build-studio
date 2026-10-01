'use client'

import { CircleCheck, CircleDot, TextCursorInput, PenLine, Pencil, Trash2, MessagesSquare, MoreVertical } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Question, QuizItemType } from '@/lib/validations/quiz'
import { QUESTION_TYPE_LABELS, DIFFICULTY_LABELS } from '@/lib/validations/quiz'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'
import { blankPlaceholderText } from '@/lib/quiz/fill-in-blank'

const TYPE_ICONS: Record<QuizItemType, typeof CircleCheck> = {
  multiple_choice: CircleDot,
  true_false: CircleCheck,
  short_answer: PenLine,
  fill_in_blank: TextCursorInput,
  explanation: PenLine,
  walkthrough: MessagesSquare,
}

const DIFFICULTY_COLORS: Record<string, string> = {
  easy: 'bg-success-muted text-success-muted-foreground',
  medium: 'bg-warning-muted text-warning-muted-foreground',
  hard: 'bg-destructive-muted text-destructive-muted-foreground',
}

interface QuestionCardProps {
  question: Question
  onEdit: () => void
  onDelete: () => void
}

export function QuestionCard({ question, onEdit, onDelete }: QuestionCardProps) {
  // Legacy rows may have a null/missing questionType; fall back to a neutral icon + label.
  const qType = question.content?.questionType
  const TypeIcon = (qType && TYPE_ICONS[qType]) || CircleDot
  const typeLabel = (qType && QUESTION_TYPE_LABELS[qType]) || 'Unknown'
  const diffLabel = DIFFICULTY_LABELS[question.difficulty] ?? question.difficulty ?? 'Unknown'
  const diffColor = DIFFICULTY_COLORS[question.difficulty] ?? ''

  return (
    <div className="bg-card border border-border rounded-xl p-4 hover:border-ring/40 hover:shadow-sm transition duration-200 ease-out">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <TypeIcon className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground">{typeLabel}</span>
            <Badge variant="secondary" className={`text-xs ${diffColor}`}>
              {diffLabel}
            </Badge>
            <span className="text-xs text-muted-foreground">{question.points} pt{question.points !== 1 ? 's' : ''}</span>
          </div>
          <div className="line-clamp-2">
            <MarkdownLatex content={blankPlaceholderText(question.questionText)} variant="compact" className="text-sm font-medium" />
          </div>
          {question.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {question.tags.map((tag) => (
                <Badge key={tag} variant="outline" className="text-xs">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0">
              <span className="sr-only">Actions</span>
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil className="h-4 w-4 mr-2" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDelete} className="text-destructive">
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
