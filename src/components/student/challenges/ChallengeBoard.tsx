/**
 * ChallengeBoard — Student main challenge board view.
 *
 * Tabs: Challenges | My Claims | Leaderboard
 * Challenge tab: left card list + right detail/claim/submit panel.
 *
 * Type: Client Component
 */
'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import { safeExternalUrl } from '@/components/shared/modules/module-item-display'
import {
  Trophy,
  Medal,
  Lightbulb,
  CalendarDays,
  Hand,
  Send,
  Undo2,
  CheckCircle2,
  XCircle,
  Clock,
  Award,
  ExternalLink,
  GraduationCap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/professor/PageHeader'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  CHALLENGE_TYPE_LABELS,
  CHALLENGE_DIFFICULTY_LABELS,
  CLAIM_STATUS_LABELS,
  CHALLENGE_TYPES,
  CHALLENGE_DIFFICULTIES,
  proposeChallengeSchema,
  type ChallengeType,
  type ChallengeDifficulty,
  type ClaimStatus,
  type ProposeChallengeInput,
} from '@/lib/validations/challenge'
import {
  claimChallenge,
  withdrawClaim,
  proposeChallenge,
} from '@/app/(dashboard)/student/courses/[sectionId]/challenges/actions'
import { ChallengeCard } from './ChallengeCard'
import { SubmitSolutionDialog } from './SubmitSolutionDialog'
import {
  CertificateCelebration,
  StudentCertificatesList,
  type StudentCertificate,
} from './StudentCertificates'

// ── Colors ──────────────────────────────────────────────────────

const difficultyColors: Record<string, string> = {
  easy: 'bg-success-muted text-success-muted-foreground border-success/30',
  medium: 'bg-warning-muted text-warning-muted-foreground border-warning/30',
  hard: 'bg-warning-muted text-warning-muted-foreground border-warning/30',
  expert: 'bg-destructive-muted text-destructive border-destructive/30',
}

const claimStatusColors: Record<string, string> = {
  claimed: 'bg-muted text-foreground border-transparent',
  submitted: 'bg-warning-muted text-warning-muted-foreground border-warning/30',
  approved: 'bg-success-muted text-success-muted-foreground border-success/30',
  rejected: 'bg-destructive-muted text-destructive border-destructive/30',
  withdrawn: 'bg-muted text-muted-foreground border-transparent',
}

// ── Interfaces ──────────────────────────────────────────────────

interface ChallengeBadge {
  id: string
  name: string
  icon: string
}

interface Challenge {
  id: string
  title: string
  description?: string
  type: string
  difficulty: string
  points: number
  bonus_points: number
  due_at?: string | null
  badge?: ChallengeBadge | null
  challenge_claims?: ChallengeClaim[]
  status?: string
}

interface ChallengeSubmission {
  id: string
  submission_type: string
  content?: string
  url?: string
  file_name?: string
}

interface ChallengeClaim {
  id: string
  challenge_id?: string
  challenge?: Challenge
  status: string
  claimed_at?: string
  reviewer_note?: string
  challenge_submissions?: ChallengeSubmission[]
}

interface LeaderboardEntry {
  userId: string
  name: string
  count: number
  totalPoints: number
}

interface UserBadge {
  id: string
  badge?: ChallengeBadge
}

// ── Props ───────────────────────────────────────────────────────

interface ChallengeBoardProps {
  sectionId: string
  challenges: Challenge[]
  myClaims: ChallengeClaim[]
  leaderboard: LeaderboardEntry[]
  myBadges: UserBadge[]
  userId: string
  /** challengeId → the skills it builds, for the card chips (Slice A). */
  challengeSkills: Record<string, { id: string; name: string }[]>
  /** The student's earned certificates (Slice B/D). */
  certificates: StudentCertificate[]
}

// ── Component ───────────────────────────────────────────────────

export function ChallengeBoard({
  sectionId,
  challenges,
  myClaims,
  leaderboard,
  myBadges,
  userId,
  challengeSkills,
  certificates,
}: ChallengeBoardProps) {
  const router = useRouter()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [difficultyFilter, setDifficultyFilter] = useState<string>('all')
  const [submitDialogOpen, setSubmitDialogOpen] = useState(false)
  const [proposeDialogOpen, setProposeDialogOpen] = useState(false)

  // Build claim lookup: challengeId → claim
  const claimMap: Record<string, ChallengeClaim> = {}
  for (const claim of myClaims) {
    const cid = claim.challenge?.id || claim.challenge_id
    if (cid) claimMap[cid] = claim
  }

  const filtered = difficultyFilter === 'all'
    ? challenges
    : challenges.filter((c) => c.difficulty === difficultyFilter)

  const selectedChallenge = challenges.find((c) => c.id === selectedId)
  const selectedClaim = selectedId ? claimMap[selectedId] : null

  /* `?challenge=<id>` — Athena proposing one (§14, C14). Opening its detail
     panel IS the pre-fill: the student lands on the real Claim button with the
     points, deadline and description in front of them, and claims it there
     through the same vetted action as any other click. She never claims it.

     Reacts to the param rather than reading it once at mount, because she
     arrives by client push into a page that may already be rendered — the same
     reason the roadmap's `?node=` deep link works after mount. An id that isn't
     on this board (stale link, withdrawn challenge, another section) is
     ignored: it must not clear a selection the student made themselves.

     The param is deliberately left in the URL — it makes the proposal
     shareable and refresh-proof, which a sessionStorage handoff would not be. */
  const searchParams = useSearchParams()
  const proposedId = searchParams.get('challenge')
  // Applied during render (React's "adjust state when a prop changes" pattern,
  // as the Athena shell does for its citation preview) rather than in an
  // effect: selecting a card is React state, not an external system, and doing
  // it in an effect costs a cascading render. Once-per-proposal, so
  // the student can click a different card afterwards and it stays clicked.
  const [appliedProposal, setAppliedProposal] = useState<string | null>(null)
  if (proposedId && proposedId !== appliedProposal && challenges.some((c) => c.id === proposedId)) {
    setAppliedProposal(proposedId)
    setSelectedId(proposedId)
    // Otherwise a same-page drive can point at a card the active filter is
    // hiding: the detail panel opens, the grid shows no selection, and the
    // scroll silently no-ops.
    setDifficultyFilter('all')
  }
  // Scrolling IS an external system, so it stays an effect — and runs after the
  // card it targets has committed.
  useEffect(() => {
    if (!appliedProposal) return
    document.querySelector(`[data-challenge-id="${CSS.escape(appliedProposal)}"]`)?.scrollIntoView({
      block: 'nearest',
      // globals.css already promises "motion is the enhancement, never the
      // signal" for every other Athena movement.
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    })
  }, [appliedProposal])

  function formatDate(date: string | null | undefined): string {
    if (!date) return '--'
    return new Date(date).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    })
  }

  function getInitials(name: string | null | undefined): string {
    if (!name) return '?'
    return name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2)
  }

  async function handleClaim(challengeId: string) {
    const result = await claimChallenge(challengeId, sectionId)
    if ('error' in result && result.error) { toast.error(result.error); return }
    toast.success('Challenge claimed!')
    router.refresh()
  }

  async function handleWithdraw(claimId: string) {
    const result = await withdrawClaim(claimId, sectionId)
    if ('error' in result && result.error) { toast.error(result.error); return }
    toast.success('Claim withdrawn')
    router.refresh()
  }

  return (
    <div className="space-y-6">
      <CertificateCelebration sectionId={sectionId} certificates={certificates} />
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Trophy className="h-6 w-6" />
            Challenge Board
          </span>
        }
        description="Take on challenges, earn points, and climb the leaderboard."
      />

      <Tabs defaultValue="challenges" className="space-y-4">
        <TabsList>
          <TabsTrigger value="challenges">
            Challenges ({challenges.length})
          </TabsTrigger>
          <TabsTrigger value="myclaims">
            My Claims ({myClaims.length})
          </TabsTrigger>
          <TabsTrigger value="leaderboard">
            Leaderboard
          </TabsTrigger>
        </TabsList>

        {/* ── Challenges Tab ────────────────────────────────────── */}
        <TabsContent value="challenges">
          <div className="flex gap-6">
            {/* Left: Challenge list */}
            <div className="w-full max-w-sm shrink-0 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <Select value={difficultyFilter} onValueChange={setDifficultyFilter}>
                  <SelectTrigger className="h-8 text-xs w-32">
                    <SelectValue placeholder="Difficulty" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Levels</SelectItem>
                    <SelectItem value="easy">Easy</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="hard">Hard</SelectItem>
                    <SelectItem value="expert">Expert</SelectItem>
                  </SelectContent>
                </Select>
                <Button size="sm" variant="outline" onClick={() => setProposeDialogOpen(true)}>
                  <Lightbulb className="h-3.5 w-3.5 mr-1" />
                  Propose
                </Button>
              </div>

              {filtered.length === 0 ? (
                <EmptyState
                  icon={Trophy}
                  title="No challenges"
                  description="Check back later for new challenges."
                />
              ) : (
                <div className="space-y-2">
                  {filtered.map((challenge) => (
                    <ChallengeCard
                      key={challenge.id}
                      challenge={challenge}
                      myClaim={claimMap[challenge.id]}
                      skills={challengeSkills[challenge.id]}
                      isSelected={selectedId === challenge.id}
                      onClick={() => setSelectedId(challenge.id)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Right: Detail panel */}
            <div className="flex-1 min-w-0">
              {selectedChallenge ? (
                <div className="bg-card border border-border rounded-xl p-5 space-y-4">
                  <div>
                    <h3 className="text-lg font-semibold">{selectedChallenge.title}</h3>
                    <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {CHALLENGE_TYPE_LABELS[selectedChallenge.type as ChallengeType] || selectedChallenge.type}
                      </Badge>
                      <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0', difficultyColors[selectedChallenge.difficulty])}>
                        {CHALLENGE_DIFFICULTY_LABELS[selectedChallenge.difficulty as ChallengeDifficulty] || selectedChallenge.difficulty}
                      </Badge>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        <Trophy className="h-2.5 w-2.5 mr-0.5" />
                        {selectedChallenge.points} pts
                        {selectedChallenge.bonus_points > 0 && ` + ${selectedChallenge.bonus_points} bonus`}
                      </Badge>
                      {selectedChallenge.badge && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                          {selectedChallenge.badge.icon} {selectedChallenge.badge.name}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {selectedChallenge.description && (
                    <p className="text-sm whitespace-pre-wrap">{selectedChallenge.description}</p>
                  )}

                  {selectedChallenge.due_at && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <CalendarDays className="h-3 w-3" />
                      Due {formatDate(selectedChallenge.due_at)}
                    </p>
                  )}

                  {/* CTA buttons */}
                  <div className="pt-2 border-t">
                    {!selectedClaim && (
                      <Button onClick={() => handleClaim(selectedChallenge.id)}>
                        <Hand className="h-4 w-4 mr-1" />
                        Claim Challenge
                      </Button>
                    )}
                    {selectedClaim?.status === 'claimed' && (
                      <div className="flex gap-2">
                        <Button onClick={() => setSubmitDialogOpen(true)}>
                          <Send className="h-4 w-4 mr-1" />
                          Submit Solution
                        </Button>
                        <Button variant="outline" onClick={() => handleWithdraw(selectedClaim.id)}>
                          <Undo2 className="h-4 w-4 mr-1" />
                          Withdraw
                        </Button>
                      </div>
                    )}
                    {selectedClaim?.status === 'submitted' && (
                      <div className="flex items-center gap-2 text-sm text-warning-muted-foreground">
                        <Clock className="h-4 w-4" />
                        Awaiting review
                      </div>
                    )}
                    {selectedClaim?.status === 'approved' && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-sm text-success-muted-foreground">
                          <CheckCircle2 className="h-4 w-4" />
                          Approved!
                        </div>
                        {selectedClaim.reviewer_note && (
                          <p className="text-sm text-muted-foreground bg-muted/30 rounded-xl p-2">
                            {selectedClaim.reviewer_note}
                          </p>
                        )}
                      </div>
                    )}
                    {selectedClaim?.status === 'rejected' && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-sm text-destructive">
                          <XCircle className="h-4 w-4" />
                          Rejected
                        </div>
                        {selectedClaim.reviewer_note && (
                          <p className="text-sm text-muted-foreground bg-muted/30 rounded-xl p-2">
                            {selectedClaim.reviewer_note}
                          </p>
                        )}
                      </div>
                    )}
                    {selectedClaim?.status === 'withdrawn' && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        Withdrawn — you can reclaim this challenge.
                        <Button size="sm" onClick={() => handleClaim(selectedChallenge.id)}>
                          Re-claim
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="border border-dashed border-border rounded-xl p-8 flex items-center justify-center text-muted-foreground text-sm">
                  Select a challenge to view details.
                </div>
              )}
            </div>
          </div>

          {/* Submit dialog */}
          {selectedClaim && (
            <SubmitSolutionDialog
              open={submitDialogOpen}
              onOpenChange={setSubmitDialogOpen}
              claimId={selectedClaim.id}
              sectionId={sectionId}
            />
          )}
        </TabsContent>

        {/* ── My Claims Tab ─────────────────────────────────────── */}
        <TabsContent value="myclaims">
          <div className="max-w-2xl mx-auto space-y-4">
            {/* My certificates (Slice B/D) */}
            <div className="bg-card border border-border rounded-xl p-4">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-1">
                <GraduationCap className="h-4 w-4" />
                My Certificates
              </h3>
              <StudentCertificatesList certificates={certificates} />
            </div>

            {/* My badges */}
            {myBadges.length > 0 && (
              <div className="bg-card border border-border rounded-xl p-4">
                <h3 className="text-sm font-semibold mb-2 flex items-center gap-1">
                  <Award className="h-4 w-4" />
                  My Badges
                </h3>
                <div className="flex gap-2 flex-wrap">
                  {myBadges.map((ub) => (
                    <Badge key={ub.id} variant="secondary" className="text-xs px-2 py-1">
                      {ub.badge?.icon || '🏆'} {ub.badge?.name || 'Badge'}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Claims history */}
            {myClaims.length === 0 ? (
              <EmptyState
                icon={Hand}
                title="No claims yet"
                description="Claim a challenge to get started."
              />
            ) : (
              <div className="space-y-2">
                {myClaims.map((claim) => {
                  const challenge = claim.challenge || {} as Partial<Challenge>
                  const submissions = claim.challenge_submissions || []

                  return (
                    <div key={claim.id} className="bg-card border border-border rounded-xl p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <h4 className="text-sm font-semibold truncate">{challenge.title || 'Unknown'}</h4>
                          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                            <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0', claimStatusColors[claim.status])}>
                              {CLAIM_STATUS_LABELS[claim.status as ClaimStatus] || claim.status}
                            </Badge>
                            <span className="text-[11px] text-muted-foreground">
                              Claimed {formatDate(claim.claimed_at)}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 text-sm font-medium text-muted-foreground shrink-0 tabular-nums">
                          <Trophy className="h-3.5 w-3.5" />
                          {challenge.points || 0}
                        </div>
                      </div>

                      {/* Submission summary */}
                      {submissions.length > 0 && (
                        <div className="mt-2 bg-muted/30 rounded-xl p-2">
                          {submissions.map((sub) => (
                            <div key={sub.id} className="text-xs text-muted-foreground">
                              {sub.submission_type === 'text' && (
                                <p className="line-clamp-2">{sub.content}</p>
                              )}
                              {(sub.submission_type === 'link' || sub.submission_type === 'github') && sub.url && (
                                safeExternalUrl(sub.url) ? (
                                  <a href={safeExternalUrl(sub.url)} target="_blank" rel="noopener noreferrer" className="text-primary flex items-center gap-1 hover:underline">
                                    <ExternalLink className="h-3 w-3" />
                                    {sub.url}
                                  </a>
                                ) : (
                                  <span className="flex items-center gap-1 break-all">{sub.url}</span>
                                )
                              )}
                              {sub.file_name && <p>File: {sub.file_name}</p>}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Reviewer note */}
                      {claim.reviewer_note && (
                        <p className="text-xs text-muted-foreground mt-2 italic">
                          Feedback: {claim.reviewer_note}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </TabsContent>

        {/* ── Leaderboard Tab ───────────────────────────────────── */}
        <TabsContent value="leaderboard">
          <div className="max-w-xl">
            <h3 className="text-lg font-semibold flex items-center gap-2 mb-4">
              <Medal className="h-5 w-5" />
              Top Challengers
            </h3>
            {leaderboard.length === 0 ? (
              <EmptyState
                icon={Medal}
                title="No data yet"
                description="Complete challenges to appear on the leaderboard."
              />
            ) : (
              <div className="space-y-2">
                {leaderboard.map((entry, index) => {
                  const isCurrentUser = entry.userId === userId
                  const rank = index + 1
                  const rankDisplay = rank <= 3
                    ? ['🥇', '🥈', '🥉'][rank - 1]
                    : `#${rank}`

                  return (
                    <div
                      key={entry.userId}
                      className={cn(
                        'flex items-center gap-3 bg-card border border-border rounded-xl p-3',
                        isCurrentUser && 'border-primary/40 ring-1 ring-primary/20',
                      )}
                    >
                      <span className="text-lg w-8 text-center shrink-0">
                        {rankDisplay}
                      </span>
                      <Avatar className="h-8 w-8">
                        <AvatarFallback className="text-xs">
                          {getInitials(entry.name)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <span className="text-sm font-medium truncate block">
                          {entry.name}
                          {isCurrentUser && (
                            <Badge variant="outline" className="text-[10px] px-1 py-0 ml-1">You</Badge>
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {entry.count} challenge{entry.count !== 1 ? 's' : ''} completed
                        </span>
                      </div>
                      <div className="flex items-center gap-1 text-sm font-semibold shrink-0 tabular-nums">
                        <Trophy className="h-4 w-4 text-warning" />
                        {entry.totalPoints}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* Propose Challenge Dialog */}
      <ProposeChallengeDialog
        open={proposeDialogOpen}
        onOpenChange={setProposeDialogOpen}
        sectionId={sectionId}
      />
    </div>
  )
}

// ── Propose Challenge Dialog ────────────────────────────────────

function ProposeChallengeDialog({
  open,
  onOpenChange,
  sectionId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
}) {
  const router = useRouter()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const form = useForm<ProposeChallengeInput>({
    resolver: zodResolver(proposeChallengeSchema) as Resolver<ProposeChallengeInput>,
    defaultValues: {
      title: '',
      description: '',
      type: 'general',
      difficulty: 'medium',
      points: 10,
    },
  })

  const onSubmit = async (data: ProposeChallengeInput) => {
    setIsSubmitting(true)
    try {
      const result = await proposeChallenge(sectionId, data)
      if ('error' in result && result.error) { toast.error(result.error); return }
      toast.success('Challenge proposed! Awaiting instructor approval.')
      onOpenChange(false)
      form.reset()
      router.refresh()
    } catch { toast.error('Failed to propose challenge') }
    finally { setIsSubmitting(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle>Propose a Challenge</DialogTitle>
          <DialogDescription>
            Suggest a challenge for the class. Your instructor will review and publish it.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title *</FormLabel>
                  <FormControl>
                    <Input placeholder="Challenge title" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Describe the challenge..."
                      className="resize-none"
                      rows={3}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {CHALLENGE_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {CHALLENGE_TYPE_LABELS[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="difficulty"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Difficulty</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {CHALLENGE_DIFFICULTIES.map((d) => (
                          <SelectItem key={d} value={d}>
                            {CHALLENGE_DIFFICULTY_LABELS[d]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Proposing...' : 'Propose Challenge'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
