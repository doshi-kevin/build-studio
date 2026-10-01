'use client'

import { useState, useMemo } from 'react'
import { Plus, SortAsc, Star, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
import { EmptyState } from '@/components/ui/empty-state'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { ReviewCard } from './ReviewCard'
import { WriteReviewDialog } from './WriteReviewDialog'
import { deleteReview } from '@/app/(dashboard)/student/courses/[sectionId]/intel/actions'
import { toast } from 'sonner'

interface Review {
  id: string
  author_id: string
  rating_overall: number
  rating_difficulty: number
  rating_workload: number
  rating_teaching: number
  rating_grading_fairness: number
  review_text?: string
  would_take_again: boolean
  grade_received?: string | null
  hours_per_week?: number | null
  is_anonymous: boolean
  helpful_count?: number
  created_at: string
  author?: { name?: string }
  author_name?: string
}

interface IntelReviewsProps {
  reviews: Review[]
  sectionId: string
  userId: string
  isAlumni: boolean
  userReview: Review | null
}

type SortOption = 'newest' | 'highest' | 'most_helpful'

export function IntelReviews({
  reviews,
  sectionId,
  userId,
  isAlumni,
  userReview,
}: IntelReviewsProps) {
  const [sortBy, setSortBy] = useState<SortOption>('newest')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingReview, setEditingReview] = useState<Review | null>(null)
  /* Predates this change, but it is the same control in the same card family as the
     Q&A and tip deletes added for #735 — leaving one of the four unguarded would be
     the inconsistency, and #733 shows deleting a review has the least obvious
     consequences of the lot. */
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const sortedReviews = useMemo(() => {
    const sorted = [...reviews]
    switch (sortBy) {
      case 'newest':
        sorted.sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        )
        break
      case 'highest':
        sorted.sort((a, b) => b.rating_overall - a.rating_overall)
        break
      case 'most_helpful':
        sorted.sort(
          (a, b) => (b.helpful_count ?? 0) - (a.helpful_count ?? 0)
        )
        break
    }
    return sorted
  }, [reviews, sortBy])

  const confirmDelete = async () => {
    if (!pendingDeleteId) return
    const reviewId = pendingDeleteId
    setDeleting(true)
    const result = await deleteReview(reviewId, sectionId)
    setDeleting(false)
    setPendingDeleteId(null)
    if ('error' in result && result.error) {
      toast.error(result.error)
    } else {
      toast.success('Review deleted')
    }
  }

  const handleEdit = (review: Review) => {
    setEditingReview(review)
    setDialogOpen(true)
  }

  const handleOpenNew = () => {
    setEditingReview(null)
    setDialogOpen(true)
  }

  const canWriteReview = isAlumni && !userReview
  const hasExistingReview = !!userReview

  const getButtonTooltip = () => {
    if (!isAlumni) return 'Complete this course to write a review'
    if (hasExistingReview) return 'You have already reviewed this course'
    return ''
  }

  return (
    <div className="space-y-4">
      {/* Header: Sort + Action */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <SortAsc className="h-4 w-4 text-muted-foreground" />
          <Select
            value={sortBy}
            onValueChange={(val) => setSortBy(val as SortOption)}
          >
            <SelectTrigger className="w-[160px] h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest First</SelectItem>
              <SelectItem value="highest">Highest Rated</SelectItem>
              <SelectItem value="most_helpful">Most Helpful</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          {hasExistingReview ? (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => handleEdit(userReview)}
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit Review
            </Button>
          ) : (
            <Button
              size="sm"
              className="gap-1.5"
              onClick={handleOpenNew}
              disabled={!canWriteReview}
              title={getButtonTooltip()}
            >
              <Plus className="h-3.5 w-3.5" />
              Write a Review
            </Button>
          )}
        </div>
      </div>

      {/* Reviews List */}
      {sortedReviews.length > 0 ? (
        <AnimatedList className="space-y-4">
          {sortedReviews.map((review) => (
            <AnimatedItem key={review.id}>
              <ReviewCard
                review={{
                  ...review,
                  author_name: review.author?.name || review.author_name,
                }}
                isOwn={review.author_id === userId}
                onEdit={() => handleEdit(review)}
                onDelete={() => setPendingDeleteId(review.id)}
              />
            </AnimatedItem>
          ))}
        </AnimatedList>
      ) : (
        <EmptyState
          variant="teaching"
          icon={Star}
          title="No reviews yet"
          description="Be the first to share your experience with this course and help future students."
        />
      )}

      {/* Write/Edit Review Dialog */}
      <WriteReviewDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        sectionId={sectionId}
        existingReview={editingReview}
      />

      <AlertDialog
        open={pendingDeleteId !== null}
        onOpenChange={(o) => { if (!o && !deleting) setPendingDeleteId(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your review?</AlertDialogTitle>
            <AlertDialogDescription>
              {/* The "you can write a new one" clause earns its place HERE and nowhere
                  else in this family: #733 was precisely the fear that deleting consumed
                  your one slot for the course. On a tip or an answer it would be filler. */}
              It will be removed from this course for everyone. You can write a new one
              afterwards, but this text and these ratings won&apos;t come back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={(e) => { e.preventDefault(); void confirmDelete() }}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
