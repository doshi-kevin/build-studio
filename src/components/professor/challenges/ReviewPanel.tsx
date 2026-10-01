/**
 * ReviewPanel — Professor review panel for a selected challenge.
 *
 * Shows challenge details + list of claims with approve/reject controls.
 * Fetches claims client-side when challenge is selected.
 *
 * Type: Client Component
 */
'use client'

import { useState, useCallback } from 'react'
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
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { safeExternalUrl } from '@/components/shared/modules/module-item-display'
import {
  Trophy,
  Send,
  Eye,
  CalendarDays,
  CheckCircle2,
  XCircle,
  Users,
  ExternalLink,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { EmptyState } from '@/components/ui/empty-state'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import {
  CHALLENGE_TYPE_LABELS,
  CHALLENGE_DIFFICULTY_LABELS,
  CLAIM_STATUS_LABELS,
  SUBMISSION_TYPE_LABELS,
  type ChallengeType,
  type ChallengeDifficulty,
  type ClaimStatus,
  type SubmissionType,
} from '@/lib/validations/challenge'
import {
  publishChallenge,
  getChallengeCascadeCounts,
  archiveChallenge,
  deleteChallenge,
  reviewClaim,
} from '@/app/(dashboard)/professor/courses/[sectionId]/challenges/actions'

const difficultyColors: Record<string, string> = {
  easy: 'bg-success-muted text-success-muted-foreground border-success/30',
  medium: 'bg-warning-muted text-warning-muted-foreground border-warning/30',
  hard: 'bg-warning-muted text-warning-muted-foreground border-warning/30',
  expert: 'bg-destructive-muted text-destructive-muted-foreground border-destructive/30',
}

const claimStatusColors: Record<string, string> = {
  claimed: 'bg-muted text-muted-foreground border-transparent',
  submitted: 'bg-warning-muted text-warning-muted-foreground border-warning/30',
  approved: 'bg-success-muted text-success-muted-foreground border-success/30',
  rejected: 'bg-destructive-muted text-destructive-muted-foreground border-destructive/30',
  withdrawn: 'bg-muted text-muted-foreground border-transparent',
}

interface ChallengeSubmission {
  id: string
  submission_type: string
  content?: string
  url?: string
  file_name?: string
}

interface UserProfile {
  name?: string
  email?: string
}

interface ChallengeClaim {
  id: string
  status: string
  claimed_at?: string | null
  reviewer_note?: string | null
  user_profile?: UserProfile
  challenge_submissions?: ChallengeSubmission[]
}

interface ChallengeDetail {
  id: string
  title: string
  type: string
  difficulty: string
  visibility: string
  points: number
  bonus_points: number
  due_at?: string | null
  description?: string
  badge?: { icon: string; name: string } | null
}

interface ReviewPanelProps {
  sectionId: string
  challenge: ChallengeDetail
  claims: ChallengeClaim[]
}

export function ReviewPanel({ sectionId, challenge, claims }: ReviewPanelProps) {
  const router = useRouter()
  const [reviewingClaimId, setReviewingClaimId] = useState<string | null>(null)
  const [reviewNote, setReviewNote] = useState('')
  const [isReviewing, setIsReviewing] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  /* null while checking, 'failed' when the lookup itself broke. Never zeros for a failure:
     the dialog reads zeros as "nothing to lose" (#702/#715). */
  const [counts, setCounts] = useState<{ claims: number; approved: number; points: number } | 'failed' | null>(null)

  function getInitials(name: string | null | undefined): string {
    if (!name) return '?'
    return name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2)
  }

  function formatDate(date: string | null | undefined): string {
    if (!date) return '--'
    return new Date(date).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    })
  }

  async function handlePublish() {
    setIsPublishing(true)
    try {
      const result = await publishChallenge(challenge.id, sectionId)
      if ('error' in result && result.error) { toast.error(result.error); return }
      toast.success('Challenge published')
      router.refresh()
    } catch { toast.error('Failed to publish') }
    finally { setIsPublishing(false) }
  }

  const loadCounts = useCallback(() => {
    setCounts(null)
    getChallengeCascadeCounts(challenge.id, sectionId)
      .then((c) => setCounts(c ?? 'failed'))
      .catch(() => setCounts('failed'))
  }, [challenge.id, sectionId])

  async function handleArchive() {
    const result = await archiveChallenge(challenge.id, sectionId)
    if ('error' in result && result.error) { toast.error(result.error); return }
    toast.success('Challenge archived')
    router.refresh()
  }

  async function handleDelete() {
    setIsDeleting(true)
    const result = await deleteChallenge(challenge.id, sectionId)
    setIsDeleting(false)
    if ('error' in result && result.error) { toast.error(result.error); return }
    toast.success('Challenge deleted')
    setConfirmDelete(false)
    router.refresh()
  }

  /* Archive was already the safe alternative to delete — it leaves point totals intact —
     but there was no way back from it anywhere in the UI, so the safe option was itself
     irreversible (#702). publishChallenge has no status guard, so the server already
     permitted this; only the control was missing. */
  async function handleUnarchive() {
    setIsPublishing(true)
    const result = await publishChallenge(challenge.id, sectionId)
    setIsPublishing(false)
    if ('error' in result && result.error) { toast.error(result.error); return }
    toast.success('Challenge republished')
    router.refresh()
  }

  async function handleReview(claimId: string, status: 'approved' | 'rejected') {
    setIsReviewing(true)
    try {
      const result = await reviewClaim(claimId, sectionId, { status, reviewer_note: reviewNote })
      if ('error' in result && result.error) { toast.error(result.error); return }
      toast.success(`Claim ${status}`)
      setReviewingClaimId(null)
      setReviewNote('')
      router.refresh()
    } catch { toast.error('Failed to review') }
    finally { setIsReviewing(false) }
  }

  return (
    <div className="space-y-5">
      {/* Challenge header */}
      <div>
        <h3 className="text-lg font-semibold">{challenge.title}</h3>
        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            {CHALLENGE_TYPE_LABELS[challenge.type as ChallengeType] || challenge.type}
          </Badge>
          <Badge className={cn('text-[10px] px-1.5 py-0', difficultyColors[challenge.difficulty])}>
            {CHALLENGE_DIFFICULTY_LABELS[challenge.difficulty as ChallengeDifficulty] || challenge.difficulty}
          </Badge>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 tabular-nums">
            <Trophy className="h-2.5 w-2.5 mr-0.5" />
            {challenge.points} pts
          </Badge>
          {challenge.bonus_points > 0 && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 tabular-nums">
              +{challenge.bonus_points} bonus
            </Badge>
          )}
          {challenge.badge && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              {challenge.badge.icon} {challenge.badge.name}
            </Badge>
          )}
        </div>
        {challenge.description && (
          <p className="text-sm text-muted-foreground mt-2 whitespace-pre-wrap">{challenge.description}</p>
        )}
        {challenge.due_at && (
          <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
            <CalendarDays className="h-3 w-3" />
            Due {formatDate(challenge.due_at)}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 flex-wrap">
        {challenge.visibility === 'draft' && (
          <>
            <Button size="sm" onClick={handlePublish} disabled={isPublishing}>
              <Send className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
              {isPublishing ? 'Publishing…' : 'Publish'}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => { setConfirmDelete(true); loadCounts() }}>
              Delete
            </Button>
          </>
        )}
        {challenge.visibility === 'published' && (
          <Button size="sm" variant="outline" onClick={handleArchive}>
            Archive
          </Button>
        )}
        {challenge.visibility === 'archived' && (
          <Button size="sm" variant="outline" onClick={handleUnarchive} disabled={isPublishing}>
            <Send className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
            {isPublishing ? 'Republishing…' : 'Unarchive'}
          </Button>
        )}
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{challenge.title}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>This cannot be undone.</p>
                {counts === null ? (
                  <p className="text-sm text-muted-foreground">Checking what this would destroy…</p>
                ) : counts === 'failed' ? (
                  <p className="text-sm font-medium text-destructive">
                    Couldn&apos;t check what students have earned here. Deleting may remove their
                    points.{' '}
                    <button type="button" onClick={loadCounts} className="underline underline-offset-4 hover:no-underline">
                      Try again
                    </button>
                  </p>
                ) : counts.approved > 0 ? (
                  <p className="text-sm font-medium text-destructive">
                    {counts.approved} student{counts.approved === 1 ? '' : 's'} already scored this
                    challenge. Deleting it removes {counts.points} earned point
                    {counts.points === 1 ? '' : 's'}, and points cannot be re-granted.
                    Archive it instead to keep the totals.
                  </p>
                ) : counts.claims > 0 ? (
                  <p className="text-sm text-destructive">
                    {counts.claims} student{counts.claims === 1 ? '' : 's'} claimed this challenge.
                    Nothing has been scored yet, so no points are lost.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">No student has claimed this yet.</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={isDeleting || counts === null} variant="destructive">
              {isDeleting ? 'Deleting…' : 'Delete challenge'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Claims list */}
      <div>
        <h4 className="text-sm font-semibold mb-2 flex items-center gap-1">
          <Users className="h-4 w-4" />
          Claims ({claims.length})
        </h4>
        {claims.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No claims yet"
            description="No students have claimed this challenge."
          />
        ) : (
          <AnimatedList className="space-y-2">
            {claims.map((claim) => {
              const profile = claim.user_profile || {}
              const submissions = claim.challenge_submissions || []
              const isReviewable = claim.status === 'submitted'

              return (
                <AnimatedItem key={claim.id} className="bg-card border border-border rounded-xl p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Avatar className="h-7 w-7">
                        <AvatarFallback className="text-[10px]">
                          {getInitials(profile.name)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <span className="text-sm font-medium truncate block">
                          {profile.name || profile.email || 'Unknown'}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          Claimed {formatDate(claim.claimed_at)}
                        </span>
                      </div>
                    </div>
                    <Badge className={cn('text-[10px] px-1.5 py-0 shrink-0', claimStatusColors[claim.status])}>
                      {CLAIM_STATUS_LABELS[claim.status as ClaimStatus] || claim.status}
                    </Badge>
                  </div>

                  {/* Submission preview */}
                  {submissions.length > 0 && (
                    <div className="bg-muted/40 rounded-xl p-2.5">
                      {submissions.map((sub) => (
                        <div key={sub.id} className="text-sm">
                          <Badge variant="outline" className="text-[10px] px-1 py-0 mb-1">
                            {SUBMISSION_TYPE_LABELS[sub.submission_type as SubmissionType] || sub.submission_type}
                          </Badge>
                          {sub.content && (
                            <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap line-clamp-4">
                              {sub.content}
                            </p>
                          )}
                          {/* The professor opens submissions in order to grade them, so this is
                              the direction that matters: a student could put a hostile URL in
                              front of their professor. safeExternalUrl makes a non-http(s)
                              value inert here regardless of when it was stored (#700). */}
                          {sub.url && (
                            safeExternalUrl(sub.url) ? (
                              <a
                                href={safeExternalUrl(sub.url)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-primary flex items-center gap-1 mt-1 hover:underline"
                              >
                                <ExternalLink className="h-3 w-3" />
                                {sub.url}
                              </a>
                            ) : (
                              <p className="text-xs text-muted-foreground mt-1 break-all">{sub.url}</p>
                            )
                          )}
                          {sub.file_name && (
                            <p className="text-xs text-muted-foreground mt-1">
                              File: {sub.file_name}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Review note (if already reviewed) */}
                  {claim.reviewer_note && (
                    <p className="text-xs text-muted-foreground italic">
                      Note: {claim.reviewer_note}
                    </p>
                  )}

                  {/* Review controls */}
                  {isReviewable && (
                    <div>
                      {reviewingClaimId === claim.id ? (
                        <div className="space-y-2 pt-1">
                          {/* The note now REACHES the student on a decline (#703 part 5), so the
                              copy says so. Previously it was stored and shown only back to staff,
                              which is why "Optional review note" was accurate and is no longer the
                              most useful thing to say: a decline with no reason gives the student
                              nothing to act on. Still optional, because forcing a note on an
                              approval would be friction for no gain. */}
                          <Textarea
                            value={reviewNote}
                            onChange={(e) => setReviewNote(e.target.value)}
                            placeholder="Add a note. If you decline, this is sent to the student as the reason."
                            rows={2}
                            className="resize-none text-sm"
                            maxLength={2000}
                            aria-label="Review note, sent to the student when you decline"
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              onClick={() => handleReview(claim.id, 'approved')}
                              disabled={isReviewing}
                              className="bg-success text-success-foreground hover:bg-success/90"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => handleReview(claim.id, 'rejected')}
                              disabled={isReviewing}
                            >
                              <XCircle className="h-3.5 w-3.5 mr-1" />
                              Reject
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => { setReviewingClaimId(null); setReviewNote('') }}
                              disabled={isReviewing}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setReviewingClaimId(claim.id)}
                        >
                          <Eye className="h-3.5 w-3.5 mr-1" />
                          Review
                        </Button>
                      )}
                    </div>
                  )}
                </AnimatedItem>
              )
            })}
          </AnimatedList>
        )}
      </div>
    </div>
  )
}
