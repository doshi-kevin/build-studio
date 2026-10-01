'use client'

import { format } from 'date-fns'
import { ShieldCheck, Pencil, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { RatingStars } from './RatingStars'
import { RATING_DIMENSION_LABELS } from '@/lib/validations/intel'

interface ReviewData {
  id: string
  is_anonymous: boolean
  author_name?: string
  rating_overall: number
  rating_difficulty: number
  rating_workload: number
  rating_teaching: number
  rating_grading_fairness: number
  review_text?: string
  grade_received?: string | null
  hours_per_week?: number | null
  would_take_again: boolean
  helpful_count?: number
  created_at: string
  [key: string]: unknown
}

interface ReviewCardProps {
  review: ReviewData
  isOwn: boolean
  onEdit?: () => void
  onDelete?: () => void
}

export function ReviewCard({ review, isOwn, onEdit, onDelete }: ReviewCardProps) {
  const authorName = review.is_anonymous
    ? 'Anonymous Student'
    : review.author_name || 'Unknown'
  const initials = review.is_anonymous
    ? 'AS'
    : (review.author_name || 'U')
        .split(' ')
        .map((n: string) => n[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()

  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-4">
      {/* Header: Author + Actions */}
      <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <Avatar className="h-9 w-9">
              <AvatarFallback className="text-xs">{initials}</AvatarFallback>
            </Avatar>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm text-foreground">{authorName}</span>
                {/* "Alumni" implied graduated; verifyAlumniStatus (queries.ts)
                    only checks that someone was ever enrolled. */}
                <Badge variant="outline" className="gap-1 text-[10px] bg-success-muted text-success-muted-foreground border-success/30">
                  <ShieldCheck className="h-3 w-3" />
                  Verified Enrollment
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {format(new Date(review.created_at), 'MMM d, yyyy')}
              </p>
            </div>
          </div>

          {/* These two predate #735 but sit in the same card family as the new
              Question/Answer/Tip deletes, so leaving them at 32px with no accessible
              name would make the family internally inconsistent — and an unlabelled
              destructive icon button is a real screen-reader failure, not a polish
              item: it announced only "button". */}
          {isOwn && (
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={onEdit}
                aria-label="Edit your review"
                title="Edit your review"
                className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 p-0"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onDelete}
                aria-label="Delete your review"
                title="Delete your review"
                className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 p-0 text-destructive hover:bg-destructive-muted hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
      </div>

      {/* Rating Dimensions Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2">
        {Object.entries(RATING_DIMENSION_LABELS).map(([key, label]) => (
          <div key={key} className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{label}</span>
            <RatingStars
              value={(review[`rating_${key}`] as number) || 0}
              readonly
              size="sm"
            />
          </div>
        ))}
      </div>

      {/* Review Text */}
      {review.review_text && (
        <p className="text-sm leading-relaxed whitespace-pre-wrap break-words text-foreground">
          {review.review_text}
        </p>
      )}

      {/* Meta Badges */}
      <div className="flex flex-wrap items-center gap-2">
        {review.grade_received && (
          <Badge variant="outline">Grade: {review.grade_received}</Badge>
        )}
        {review.hours_per_week != null && (
          <Badge variant="outline">{review.hours_per_week} hrs/week</Badge>
        )}
        <Badge variant={review.would_take_again ? 'secondary' : 'outline'}>
          {review.would_take_again ? 'Would take again' : 'Would not take again'}
        </Badge>
      </div>
    </div>
  )
}
