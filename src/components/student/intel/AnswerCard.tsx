'use client'

import { format } from 'date-fns'
import { ShieldCheck, Trash2 } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { UpvoteButton } from './UpvoteButton'

interface Answer {
  id: string
  body: string
  is_anonymous: boolean
  author_id?: string | null
  author_name?: string
  vote_count?: number
  created_at: string
}

interface AnswerCardProps {
  answer: Answer
  hasVoted: boolean
  onVote: () => void
  isOwn?: boolean
  onDelete?: () => void
}

export function AnswerCard({ answer, hasVoted, onVote, isOwn, onDelete }: AnswerCardProps) {
  const authorName = answer.is_anonymous
    ? 'Anonymous Alumni'
    : answer.author_name || 'Unknown'
  const initials = answer.is_anonymous
    ? 'AA'
    : (answer.author_name || 'U')
        .split(' ')
        .map((n: string) => n[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()

  return (
    <div className="py-3 space-y-2">
      {/* Author Row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Avatar className="h-7 w-7">
            <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
          </Avatar>
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-foreground">{authorName}</span>
            <Badge variant="outline" className="gap-0.5 text-[10px] py-0 bg-success-muted text-success-muted-foreground border-success/30">
              <ShieldCheck className="h-2.5 w-2.5" />
              Alumni
            </Badge>
          </div>
        </div>

        {/* gap-3, not gap-1: at 390px the destructive control sat 4px from Upvote. */}
        <div className="flex items-center gap-3">
          <UpvoteButton
            count={answer.vote_count ?? 0}
            hasVoted={hasVoted}
            onVote={onVote}
          />
          {isOwn && onDelete && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              aria-label="Delete your answer"
              title="Delete your answer"
              className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 p-0 text-destructive hover:bg-destructive-muted hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Answer Body */}
      <p className="text-sm leading-relaxed whitespace-pre-wrap break-words pl-9 text-foreground">
        {answer.body}
      </p>

      {/* Date */}
      <p className="text-xs text-muted-foreground pl-9">
        {format(new Date(answer.created_at), 'MMM d, yyyy')}
      </p>
    </div>
  )
}
