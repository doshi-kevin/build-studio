// Clickable list of past (closed) quizzes — shared by the student and
// professor history surfaces. Purely presentational; the parent decides what
// opens on select (a student review vs the professor's results report).

'use client'

import { BarChart3, FileQuestion } from 'lucide-react'
import { LocalDateTime } from '@/components/shared/LocalDateTime'

export interface QuizHistoryListItem {
  id: string
  title: string
  closedAt: string | null
  /** Right-aligned summary chip, e.g. "80%" (student) or "12 answers" (prof). */
  rightLabel?: string
  rightTone?: 'good' | 'bad' | 'neutral'
  /** Picks the leading icon. Omit on quiz-only lists (keeps the poll-style icon). */
  kind?: 'poll' | 'quiz'
}

interface Props {
  items: QuizHistoryListItem[]
  onSelect: (id: string) => void
  emptyTitle?: string
  emptyHint?: string
}

export function QuizHistoryList({ items, onSelect, emptyTitle = 'No past quizzes yet', emptyHint }: Props) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center text-center py-8 px-4 rounded-2xl border border-dashed border-border bg-muted/10">
        <div className="rounded-full bg-background border border-border p-3 mb-3">
          <FileQuestion className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium mb-1">{emptyTitle}</p>
        {emptyHint && <p className="text-xs text-muted-foreground max-w-[260px] leading-relaxed">{emptyHint}</p>}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {items.map((item) => {
        const Icon = item.kind === 'quiz' ? FileQuestion : BarChart3
        return (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect(item.id)}
          className="w-full flex items-center gap-3 rounded-2xl border border-border bg-background hover:bg-muted/30 hover:border-foreground/30 transition-colors p-3 text-left"
        >
          <div className="rounded-xl bg-muted/40 border border-border p-2 shrink-0">
            <Icon className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{item.title}</p>
            {item.closedAt && (
              <p className="text-xs text-muted-foreground">
                <LocalDateTime iso={item.closedAt} mode="datetime" />
              </p>
            )}
          </div>
          {item.rightLabel && (
            <span
              className={`shrink-0 inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums ${
                item.rightTone === 'good'
                  ? 'bg-success-muted text-success-muted-foreground'
                  : item.rightTone === 'bad'
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-muted text-muted-foreground'
              }`}
            >
              {item.rightLabel}
            </span>
          )}
        </button>
        )
      })}
    </div>
  )
}
