/**
 * WriteReviewDialog -- Review submission/edit dialog for Course Alumni Intelligence Panel.
 *
 * Form with 5 rating dimensions, review text, grade, hours/week, would-take-again,
 * and anonymous toggle. Supports both create and edit modes.
 *
 * Type: Client Component
 */
'use client'

import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from '@/components/ui/form'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { RatingStars } from './RatingStars'
import { AnonymousToggle } from './AnonymousToggle'
import {
  createReviewSchema,
  GRADE_OPTIONS,
  RATING_DIMENSION_LABELS,
  type CreateReviewInput,
} from '@/lib/validations/intel'
import {
  submitReview,
  updateReview,
} from '@/app/(dashboard)/student/courses/[sectionId]/intel/actions'

interface ExistingReview {
  id: string
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
}

interface WriteReviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
  existingReview?: ExistingReview | null
}

/**
 * The form's values for a given review, or the blank create state when there isn't
 * one. Lifted out of useForm so the reset-on-open below and the initial
 * defaultValues can't drift apart — the drift is what #736/#738 were.
 */
function defaultsFrom(existingReview?: ExistingReview | null): CreateReviewInput {
  return {
    rating_overall: existingReview?.rating_overall ?? 0,
    rating_difficulty: existingReview?.rating_difficulty ?? 0,
    rating_workload: existingReview?.rating_workload ?? 0,
    rating_teaching: existingReview?.rating_teaching ?? 0,
    rating_grading_fairness: existingReview?.rating_grading_fairness ?? 0,
    review_text: existingReview?.review_text ?? '',
    would_take_again: existingReview?.would_take_again ?? true,
    grade_received: (existingReview?.grade_received as CreateReviewInput['grade_received']) ?? null,
    hours_per_week: existingReview?.hours_per_week ?? null,
    is_anonymous: existingReview?.is_anonymous ?? false,
  }
}

const RATING_FIELDS = [
  { key: 'rating_overall', dimension: 'overall' },
  { key: 'rating_difficulty', dimension: 'difficulty' },
  { key: 'rating_workload', dimension: 'workload' },
  { key: 'rating_teaching', dimension: 'teaching' },
  { key: 'rating_grading_fairness', dimension: 'grading_fairness' },
] as const

export function WriteReviewDialog({
  open,
  onOpenChange,
  sectionId,
  existingReview,
}: WriteReviewDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  /* Values held back while the de-anonymisation confirm is on screen (#738). */
  const [pendingDeanon, setPendingDeanon] = useState<CreateReviewInput | null>(null)
  const isEditMode = !!existingReview

  const form = useForm<CreateReviewInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(createReviewSchema) as any,
    defaultValues: defaultsFrom(existingReview),
  })

  /* Re-seed the form every time the dialog opens (#736).
     `defaultValues` is read once, at first render — and IntelReviews mounts this
     dialog unconditionally while `editingReview` is still null, so the defaults
     locked in blank for the life of the mount. Clicking Edit updated the prop but
     never the form: the user was shown their saved review as an empty form and had
     to retype every field from memory.

     The field that made it more than an annoyance is `is_anonymous` (#738). It was
     pinned to false, so re-entering the fields — which the blank form forces, since
     rating_overall is required — silently republished an anonymous review under the
     author's real name. Course reviews routinely criticise a named professor.

     Keyed on `open` as well as the review so a cancelled create leaves nothing
     behind for the next edit. form.reset in a useEffect on open is the house
     pattern (QuestionFormDialog, CreateModuleDialog, CalendarEventForm); RHF's
     `values` option is used nowhere in this codebase and re-syncs on every render,
     which can wipe in-progress typing. */
  useEffect(() => {
    if (open) {
      form.reset(defaultsFrom(existingReview))
      setPendingDeanon(null)
    }
  }, [open, existingReview, form])

  const save = async (data: CreateReviewInput) => {
    setIsSubmitting(true)
    try {
      const result = isEditMode
        ? await updateReview(existingReview.id, sectionId, data)
        : await submitReview(sectionId, data)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success(isEditMode ? 'Review updated' : 'Review submitted')
      onOpenChange(false)
    } catch {
      toast.error('Something went wrong')
    } finally {
      setIsSubmitting(false)
    }
  }

  const onSubmit = async (data: CreateReviewInput) => {
    /* Anonymous → named is irreversible in practice: other students may already
       have read it. Ask before doing it, never as a side effect of saving. */
    if (isEditMode && existingReview.is_anonymous && !data.is_anonymous) {
      setPendingDeanon(data)
      return
    }
    await save(data)
  }

  return (
    /* Fragment, and the confirm is a SIBLING of the Dialog, not a child.
       Nested, Radix's inner dismiss propagated to the outer Dialog's onOpenChange,
       so "Keep me anonymous" closed the edit form too and discarded everything the
       user had retyped — the safe choice was the one that lost their work, while its
       own copy told them to go back and flip the toggle. */
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg max-h-[85vh] overflow-y-auto"
        /* While the de-anonymisation confirm is up, nothing outside this form may
           dismiss it (#738).
           Making the AlertDialog a SIBLING of the Dialog was necessary but not
           sufficient: browser QA found that Escape preserved the form while clicking
           "Keep me anonymous" still closed it. The discriminator localises the cause
           precisely — the alert renders in its OWN portal, so a click on its buttons is
           outside this Dialog's DOM subtree and trips Radix's outside-pointer
           dismissal, which the keyboard path never touches. The user picked the safe
           option and lost everything they had retyped.
           Test BOTH paths on any change here; passing on Escape alone is what made the
           first fix look complete. */
        onPointerDownOutside={(e) => { if (pendingDeanon) e.preventDefault() }}
        onInteractOutside={(e) => { if (pendingDeanon) e.preventDefault() }}
      >
        <DialogHeader>
          <DialogTitle>{isEditMode ? 'Edit Review' : 'Write a Review'}</DialogTitle>
          <DialogDescription>
            {isEditMode
              ? 'Update your course review.'
              : 'Share your experience to help future students.'}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            {/* Rating dimensions */}
            <div className="space-y-3">
              {RATING_FIELDS.map(({ key, dimension }) => (
                <FormField
                  key={key}
                  control={form.control}
                  name={key}
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel className="text-sm">
                          {RATING_DIMENSION_LABELS[dimension]} *
                        </FormLabel>
                        <FormControl>
                          <RatingStars
                            value={field.value}
                            onChange={field.onChange}
                            size="lg"
                          />
                        </FormControl>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ))}
            </div>

            {/* Review text */}
            <FormField
              control={form.control}
              name="review_text"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Review</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="What did you think of this course? Share tips, pros, cons..."
                      className="resize-none"
                      rows={4}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Would take again */}
            <FormField
              control={form.control}
              name="would_take_again"
              render={({ field }) => (
                <FormItem className="flex items-center gap-3">
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                  <Label className="!mt-0 cursor-pointer text-sm">
                    Would take this course again
                  </Label>
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              {/* Grade received */}
              <FormField
                control={form.control}
                name="grade_received"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Grade Received</FormLabel>
                    <Select
                      value={field.value ?? ''}
                      onValueChange={(val) =>
                        field.onChange(val === '_none' ? null : val)
                      }
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Prefer not to say" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="_none">Prefer not to say</SelectItem>
                        {GRADE_OPTIONS.map((grade) => (
                          <SelectItem key={grade} value={grade}>
                            {grade}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Hours per week */}
              <FormField
                control={form.control}
                name="hours_per_week"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Hours / Week</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        max={80}
                        placeholder="e.g. 10"
                        value={field.value ?? ''}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value ? Number(e.target.value) : null
                          )
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Anonymous toggle */}
            <FormField
              control={form.control}
              name="is_anonymous"
              render={({ field }) => (
                <FormItem>
                  <AnonymousToggle
                    value={field.value}
                    onChange={field.onChange}
                  />
                </FormItem>
              )}
            />

            {/* Actions */}
            <div className="flex justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? isEditMode
                    ? 'Updating...'
                    : 'Submitting...'
                  : isEditMode
                    ? 'Update Review'
                    : 'Submit Review'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>

    {/* De-anonymisation confirm (#738) */}
    <AlertDialog
      open={pendingDeanon !== null}
      onOpenChange={(o) => {
        if (!o) {
          setPendingDeanon(null)
          /* Dismissing this confirm means "don't do that", which has to include the
             toggle — so Escape and the backdrop agree with the Cancel button. */
          form.setValue('is_anonymous', true, { shouldDirty: true })
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Publish this review under your name?</AlertDialogTitle>
          <AlertDialogDescription>
            You posted this review anonymously. Saving with &ldquo;Post
            anonymously&rdquo; off shows your name and avatar to everyone on the course,
            and it can&apos;t be taken back.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* Cancel now DOES what it says — it used to only abort the save, leaving the
              toggle off, so the button labelled "Keep me anonymous" didn't keep you
              anonymous and the description had to tell you to go flip it back yourself.

              The restore lives ONLY in onOpenChange above, not here as well. Radix
              routes a Cancel click, Escape and a programmatic close all through
              onOpenChange, so an onClick handler here was a second call to the same
              setValue — and browser QA caught it landing mid-render:
              "flushSync was called from inside a lifecycle method", on the button path
              only, which is exactly the path that had both. Behaviour was correct
              either way; in dev it popped the Next error overlay over the UI.

              (isSubmitting dropped from both buttons too: setPendingDeanon runs before
              save(), so this dialog is never mounted while it's true.) */}
          <AlertDialogCancel>Keep me anonymous</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(e) => {
              /* Radix closes the dialog on click; the save is async, so keep the
                 values in hand rather than reading state after the unmount. */
              e.preventDefault()
              const values = pendingDeanon
              setPendingDeanon(null)
              if (values) void save({ ...values, is_anonymous: false })
            }}
          >
            Publish under my name
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
}
