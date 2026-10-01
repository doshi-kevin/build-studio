'use client'

// QuizCard — displays a quiz in the professor's quiz list.
// Shows status badges, key metadata, and a dropdown with actions
// including a one-click Publish shortcut for draft quizzes.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Clock, FileQuestion, MoreVertical, Pencil, Eye, EyeOff, BarChart3, Trash2, Send, CalendarClock, Target, Users, Copy, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { publishQuiz, unpublishQuiz, duplicateQuiz } from '@/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions'
import { getPlacementModules, getResourcePlacement, setResourcePlacement } from '@/lib/roadmap/placement-actions'
import type { Quiz } from '@/lib/validations/quiz'
import { formatDate, isPastDue as isDatePast } from '@/lib/quiz/utils'

interface QuizCardProps {
  quiz: Quiz
  sectionId: string
  /** Number of submitted attempts for this quiz */
  submissionCount?: number
  onDelete: () => void
  /** Called after a mutation (publish/unpublish/duplicate) so the parent list re-fetches. */
  onChanged?: () => void
  /**
   * Whether the viewer is the professor. Publish, Unpublish, Duplicate and Delete
   * are all professor-only server-side, but the menu showed them to every TA and
   * grader — so the only signal that an action was never theirs was the refusal
   * toast (#749). Defaults to true so an un-migrated call site keeps today's menu
   * rather than silently losing the professor's own controls.
   */
  canWriteProfessor?: boolean
}

export function QuizCard({ quiz, sectionId, submissionCount = 0, onDelete, onChanged, canWriteProfessor = true }: QuizCardProps) {
  const router = useRouter()
  const basePath = `/professor/courses/${sectionId}/quizzes/${quiz.id}`
  const [publishDialogOpen, setPublishDialogOpen] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [unpublishDialogOpen, setUnpublishDialogOpen] = useState(false)
  const [isUnpublishing, setIsUnpublishing] = useState(false)
  // Roadmap placement: modules load when the publish dialog opens; picking one
  // is required (when any exist) so the roadmap knows where the quiz belongs.
  const [modules, setModules] = useState<{ id: string; title: string; weekNumber: number | null }[] | null>(null)
  const [moduleId, setModuleId] = useState<string>('')

  const isScheduled = quiz.status === 'draft' && !!quiz.scheduledPublishAt
  const isDraft = quiz.status === 'draft' && !quiz.scheduledPublishAt
  // Shared helper, so the professor's card and the student's own page can't
  // disagree about whether the same quiz is past due (#311).
  const isPastDue = isDatePast(quiz.dueDate)
  // A scheduled quiz whose time has passed but is still a draft was held back by
  // the publish gate — it has no questions, or an incomplete one. Without this the
  // card kept promising a publish that already silently declined to happen.
  const schedulePassed = isScheduled && isDatePast(quiz.scheduledPublishAt)

  async function openPublishDialog() {
    setPublishDialogOpen(true)
    if (modules === null) {
      const [res, current] = await Promise.all([
        getPlacementModules(sectionId),
        getResourcePlacement(sectionId, 'quiz', quiz.id),
      ])
      setModules(res.data ?? [])
      if (current.data) setModuleId(current.data)
    }
  }

  async function handlePublish() {
    setIsPublishing(true)
    const result = await publishQuiz(sectionId, quiz.id)
    if (result.error) {
      setIsPublishing(false)
      setPublishDialogOpen(false)
      toast.error(result.error)
      return
    }
    // Place the quiz on the roadmap under the chosen module (required above
    // whenever the section has modules).
    if (moduleId) {
      const attach = await setResourcePlacement(sectionId, 'quiz', quiz.id, moduleId)
      if (attach.error) toast.error(attach.error)
    }
    setIsPublishing(false)
    setPublishDialogOpen(false)
    toast.success('Quiz published!')
    onChanged?.()
  }

  async function handleUnpublish() {
    setIsUnpublishing(true)
    const result = await unpublishQuiz(sectionId, quiz.id)
    setIsUnpublishing(false)
    setUnpublishDialogOpen(false)
    if (result.error) {
      toast.error(result.error)
      return
    }
    toast.success('Quiz unpublished — students can no longer see it.')
    onChanged?.()
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => router.push(basePath)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            router.push(basePath)
          }
        }}
        className="group bg-card border border-border rounded-xl p-4 cursor-pointer hover:border-ring/40 hover:shadow-sm transition duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="text-sm font-semibold truncate text-left group-hover:text-primary transition-colors">
                {quiz.title}
              </span>
              {isScheduled ? (
                <Badge variant="outline" className="bg-warning-muted text-warning-muted-foreground border-warning/30">
                  Scheduled
                </Badge>
              ) : quiz.status === 'published' ? (
                <Badge className="bg-success text-success-foreground border-transparent hover:bg-success">
                  published
                </Badge>
              ) : (
                <Badge variant="secondary">{quiz.status}</Badge>
              )}
            </div>
            {quiz.description && (
              <p className="text-xs text-muted-foreground line-clamp-1 mb-2">
                {quiz.description}
              </p>
            )}
            <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
              <span className="flex items-center gap-1">
                <FileQuestion className="h-3.5 w-3.5" />
                {quiz.questionIds.length} question{quiz.questionIds.length !== 1 ? 's' : ''}
              </span>
              {quiz.timeLimitMinutes && (
                <span className="flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5" />
                  {quiz.timeLimitMinutes} min
                </span>
              )}
              <span className="flex items-center gap-1">
                <Target className="h-3.5 w-3.5" />
                Pass: {quiz.passThreshold}%
              </span>
              {submissionCount > 0 && (
                <span className="flex items-center gap-1">
                  <Users className="h-3.5 w-3.5" />
                  {submissionCount} submitted
                </span>
              )}
              {quiz.dueDate && (
                <span className={`flex items-center gap-1 ${isPastDue ? 'text-destructive' : ''}`}>
                  <CalendarClock className="h-3.5 w-3.5" />
                  Due {formatDate(quiz.dueDate)}
                </span>
              )}
              {isScheduled && quiz.scheduledPublishAt && (
                schedulePassed ? (
                  <span className="flex items-center gap-1 text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Didn&apos;t publish — needs at least one complete question
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-warning-muted-foreground">
                    <Clock className="h-3.5 w-3.5" />
                    Publishes {formatDate(quiz.scheduledPublishAt)}
                  </span>
                )
              )}
              <span>Created {formatDate(quiz.createdAt)}</span>
            </div>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0" aria-label="Quiz options" onClick={(e) => e.stopPropagation()}>
                <MoreVertical className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            {/* React routes synthetic events through the component tree, so item clicks
                bubble to the card's onClick (navigate) even though the menu is portaled.
                Stop them here so Delete/Publish/etc. don't also open the quiz. */}
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onClick={() => router.push(basePath)}>
                <Pencil className="h-4 w-4 mr-2" />
                Edit
              </DropdownMenuItem>
              {/* Opens the studio with the student preview already showing */}
              <DropdownMenuItem onClick={() => router.push(`${basePath}?preview=1`)}>
                <Eye className="h-4 w-4 mr-2" />
                Preview
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => router.push(`${basePath}/insights`)}>
                <BarChart3 className="h-4 w-4 mr-2" />
                Insights
              </DropdownMenuItem>
              {canWriteProfessor && (
                <DropdownMenuItem onClick={async () => {
                  const result = await duplicateQuiz(sectionId, quiz.id)
                  if (result.error) { toast.error(result.error); return }
                  toast.success(`Duplicated as "${result.data?.title}"`)
                  onChanged?.()
                }}>
                  <Copy className="h-4 w-4 mr-2" />
                  Duplicate
                </DropdownMenuItem>
              )}
              {canWriteProfessor && isDraft && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={openPublishDialog}>
                    <Send className="h-4 w-4 mr-2" />
                    Publish Now
                  </DropdownMenuItem>
                </>
              )}
              {canWriteProfessor && quiz.status === 'published' && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setUnpublishDialogOpen(true)}>
                    <EyeOff className="h-4 w-4 mr-2" />
                    Unpublish
                  </DropdownMenuItem>
                </>
              )}
              {canWriteProfessor && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onDelete} className="text-destructive">
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Publish confirmation dialog */}
      <AlertDialog open={publishDialogOpen} onOpenChange={setPublishDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish &ldquo;{quiz.title}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              Students will be able to see and attempt this quiz immediately.
              {quiz.questionIds.length === 0 && (
                <span className="block mt-1 text-destructive font-medium">
                  Warning: This quiz has no questions.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* Roadmap placement — required whenever the section has modules, so
              the roadmap can show the quiz under the module it assesses. */}
          <div className="space-y-1.5">
            <label htmlFor={`quiz-module-${quiz.id}`} className="text-xs font-medium text-muted-foreground">
              Module this quiz belongs to <span className="text-destructive">*</span>
            </label>
            {modules === null ? (
              <p className="text-xs text-muted-foreground">Loading modules…</p>
            ) : modules.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No modules in this section yet — add one to place this quiz on the roadmap. Until then it stays in the Archive.
              </p>
            ) : (
              <Select value={moduleId} onValueChange={setModuleId}>
                <SelectTrigger id={`quiz-module-${quiz.id}`} className="w-full">
                  <SelectValue placeholder="Pick a module…" />
                </SelectTrigger>
                <SelectContent>
                  {modules.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.weekNumber ? `Week ${m.weekNumber} · ` : ''}{m.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <AlertDialogFooter>
            {/* disabled while in flight: dismissing mid-request leaves the professor with no
                idea whether the unpublish landed. */}
            <AlertDialogCancel disabled={isUnpublishing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handlePublish}
              disabled={isPublishing || modules === null || (modules.length > 0 && !moduleId)}
            >
              {isPublishing ? 'Publishing…' : 'Publish'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Unpublish confirmation — unpublishing pulls a live quiz from students,
          so it is guarded like Publish/Delete (no undo beyond re-publishing). */}
      <AlertDialog open={unpublishDialogOpen} onOpenChange={setUnpublishDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unpublish &ldquo;{quiz.title}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              Students will immediately lose access until you publish it again.
              {submissionCount > 0 && (
                <span className="block mt-1">
                  {submissionCount} student{submissionCount !== 1 ? 's have' : ' has'} already submitted —
                  their attempts are kept.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {/* preventDefault: Radix closes the dialog on click otherwise, so
                "Unpublishing…" and the disabled guard below never render. */}
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void handleUnpublish() }}
              disabled={isUnpublishing}
            >
              {isUnpublishing ? 'Unpublishing…' : 'Unpublish'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
