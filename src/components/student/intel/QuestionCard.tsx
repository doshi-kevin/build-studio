'use client'

import { useState } from 'react'
import { format } from 'date-fns'
import { MessageSquare, ChevronDown, ChevronUp, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

interface Question {
  id: string
  title: string
  body?: string
  is_anonymous: boolean
  author_id?: string | null
  author_name?: string
  answer_count?: number
  created_at: string
}

interface QuestionCardProps {
  question: Question
  sectionId: string
  userId: string
  isAlumni: boolean
  onDelete?: () => void
  children?: React.ReactNode
}

export function QuestionCard(props: QuestionCardProps) {
  const { question, userId, onDelete, children } = props
  /* Anonymous rows keep author_id for the viewer's OWN content (see
     redactAnonymousAuthors), which is what makes this affordance work without
     leaking who wrote someone else's anonymous question. */
  const isOwn = !!question.author_id && question.author_id === userId
  const [expanded, setExpanded] = useState(false)

  const authorName = question.is_anonymous
    ? 'Anonymous'
    : question.author_name || 'Unknown'
  const answerCount = question.answer_count ?? 0

  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {/* break-words: a pasted URL, stack trace or long package name in a title
              otherwise overflows the card and drags the whole PAGE into horizontal
              scroll (#739). min-w-0 lets the column shrink; only this lets the text
              break mid-token. Matches live-classroom/QuestionList. */}
          <h3 className="font-semibold text-sm leading-snug text-foreground break-words">
            {question.title}
          </h3>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-muted-foreground">
              {authorName}
            </span>
            <span className="text-xs text-muted-foreground">
              {format(new Date(question.created_at), 'MMM d, yyyy')}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Badge variant="secondary" className="gap-1 tabular-nums">
            <MessageSquare className="h-3 w-3" />
            {answerCount}
          </Badge>
        </div>
      </div>

      {/* Question Body */}
      {question.body && (
        <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap break-words">
          {question.body}
        </p>
      )}

      {/* Action row. The delete lives HERE, not up beside the title: in the header it
          reserved ~44px of a 275px card at 390px and squeezed the title column to under
          half the card, so a long question rendered as an eight-line wedge. Down here it
          also stops sharing an edge with the answer-count badge. */}
      <div className="flex items-center justify-between gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(!expanded)}
          className="gap-1.5 text-xs h-8 px-2"
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3.5 w-3.5" />
              Hide Answers
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5" />
              {answerCount > 0
                ? `Show ${answerCount} Answer${answerCount !== 1 ? 's' : ''}`
                : 'Answer this question'}
            </>
          )}
        </Button>
        {isOwn && onDelete && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            aria-label="Delete your question"
              title="Delete your question"
            className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 shrink-0 p-0 text-destructive hover:bg-destructive-muted hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Answers + Answer Form */}
      {expanded && (
        <div className="space-y-3 pl-4 border-l border-border">
          {children}
        </div>
      )}
    </div>
  )
}
