'use client'

import { format } from 'date-fns'
import { Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { UpvoteButton } from './UpvoteButton'
import { TIP_CATEGORY_LABELS } from '@/lib/validations/intel'

interface Tip {
  id: string
  category: string
  content: string
  is_anonymous: boolean
  author_id?: string | null
  author_name?: string
  vote_count?: number
  created_at: string
}

interface TipCardProps {
  tip: Tip
  hasVoted: boolean
  onVote: () => void
  isOwn?: boolean
  onDelete?: () => void
}

export function TipCard({ tip, hasVoted, onVote, isOwn, onDelete }: TipCardProps) {
  const authorName = tip.is_anonymous
    ? 'Anonymous'
    : tip.author_name || 'Unknown'
  const categoryLabel =
    TIP_CATEGORY_LABELS[tip.category as keyof typeof TIP_CATEGORY_LABELS] ||
    tip.category

  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-3">
      {/* Category Badge + Upvote */}
      <div className="flex items-start justify-between gap-3">
        <Badge variant="secondary">{categoryLabel}</Badge>
        {/* gap-3, not gap-1: at 390px the destructive control sat 4px from Upvote. */}
        <div className="flex items-center gap-3 shrink-0">
          <UpvoteButton
            count={tip.vote_count ?? 0}
            hasVoted={hasVoted}
            onVote={onVote}
          />
          {isOwn && onDelete && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              aria-label="Delete your tip"
              title="Delete your tip"
              className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 p-0 text-destructive hover:bg-destructive-muted hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      <p className="text-sm leading-relaxed whitespace-pre-wrap break-words text-foreground">
        {tip.content}
      </p>

      {/* Footer: Author + Date */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{authorName}</span>
        <span>{format(new Date(tip.created_at), 'MMM d, yyyy')}</span>
      </div>
    </div>
  )
}
