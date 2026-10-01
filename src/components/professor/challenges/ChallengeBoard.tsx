/**
 * ChallengeBoard — Professor main challenge board view.
 *
 * Tabs: Active Challenges | Proposals | Badges
 * Active tab: left challenge list + right review panel.
 *
 * Type: Client Component
 */
'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
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
  Trophy,
  Award,
  Lightbulb,
  CheckCircle2,
  XCircle,
  Trash2,
  Plus,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { EmptyState } from '@/components/ui/empty-state'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { PageHeader } from '@/components/professor/PageHeader'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import {
  CHALLENGE_TYPE_LABELS,
  CHALLENGE_DIFFICULTY_LABELS,
  createBadgeSchema,
  type CreateBadgeInput,
  type ChallengeType,
  type ChallengeDifficulty,
} from '@/lib/validations/challenge'
import {
  approveProposal,
  rejectProposal,
  createBadge,
  deleteBadge,
  getBadgeCascadeCounts,
} from '@/app/(dashboard)/professor/courses/[sectionId]/challenges/actions'
import { ChallengeCard } from './ChallengeCard'
import { CreateChallengeDialog } from './CreateChallengeDialog'
import { ReviewPanel } from './ReviewPanel'
import { CertificatesPanel } from './CertificatesPanel'

// ── Types ───────────────────────────────────────────────────────

const difficultyColors: Record<string, string> = {
  easy: 'bg-success-muted text-success-muted-foreground border-success/30',
  medium: 'bg-warning-muted text-warning-muted-foreground border-warning/30',
  hard: 'bg-warning-muted text-warning-muted-foreground border-warning/30',
  expert: 'bg-destructive-muted text-destructive-muted-foreground border-destructive/30',
}

interface ChallengeBadge {
  id: string
  name: string
  description?: string
  icon: string
}

interface ChallengeProposal {
  id: string
  title: string
  description?: string
  type: string
  difficulty: string
  creator?: { name?: string }
}

interface ChallengeClaim {
  id: string
  status: string
  claimed_at?: string | null
  reviewer_note?: string | null
  user_profile?: { name?: string; email?: string }
  challenge_submissions?: { id: string; submission_type: string; content?: string; url?: string; file_name?: string }[]
}

interface ChallengeItem {
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
  challenge_claims?: ChallengeClaim[]
}

interface ChallengeBoardProps {
  sectionId: string
  challenges: ChallengeItem[]
  proposals: ChallengeProposal[]
  badges: ChallengeBadge[]
  /** Section skills for the create dialog's linker (Slice A). */
  skills: { id: string; name: string }[]
  /** challengeId → the skills it builds, for the card chips (Slice A). */
  challengeSkills: Record<string, { id: string; name: string }[]>
  /** Certificate templates for this section (Slice B). */
  certificates: {
    id: string
    title: string
    description: string
    is_active: boolean
    challenge_ids: string[]
    earned_count: number
  }[]
}

// ── Component ───────────────────────────────────────────────────

export function ChallengeBoard({ sectionId, challenges, proposals, badges, skills, challengeSkills, certificates }: ChallengeBoardProps) {
  const router = useRouter()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'draft' | 'published' | 'archived'>('all')

  const filtered = filter === 'all' ? challenges : challenges.filter((c) => c.visibility === filter)
  const selectedChallenge = challenges.find((c) => c.id === selectedId)
  const selectedClaims = selectedChallenge?.challenge_claims || []

  async function handleApproveProposal(id: string) {
    const result = await approveProposal(id, sectionId)
    if ('error' in result && result.error) { toast.error(result.error); return }
    toast.success('Proposal approved and published')
    router.refresh()
  }

  async function handleRejectProposal(id: string) {
    const result = await rejectProposal(id, sectionId)
    if ('error' in result && result.error) { toast.error(result.error); return }
    toast.success('Proposal rejected')
    router.refresh()
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Challenges"
        description="Create challenges and review student submissions."
        actions={<CreateChallengeDialog sectionId={sectionId} badges={badges} skills={skills} />}
      />

      <Tabs defaultValue="active" className="space-y-4">
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="active">
            Challenges ({challenges.length})
          </TabsTrigger>
          <TabsTrigger value="proposals">
            Proposals ({proposals.length})
          </TabsTrigger>
          <TabsTrigger value="certificates">
            Certificates ({certificates.length})
          </TabsTrigger>
          <TabsTrigger value="badges">
            Badges ({badges.length})
          </TabsTrigger>
        </TabsList>

        {/* ── Active Challenges Tab ─────────────────────────────── */}
        <TabsContent value="active">
          {challenges.length === 0 ? (
            <EmptyState
              variant="teaching"
              icon={Trophy}
              title="Create your first challenge"
              description="Challenges let students earn points and badges for going beyond the syllabus. Draft one now, then publish it when you're ready."
            >
              <CreateChallengeDialog sectionId={sectionId} badges={badges} skills={skills} />
            </EmptyState>
          ) : (
            <div className="flex flex-col gap-6 lg:flex-row">
              {/* Left: Challenge list */}
              <div className="w-full lg:max-w-sm lg:shrink-0 space-y-3">
                <ToggleGroup
                  type="single"
                  value={filter}
                  onValueChange={(v) => v && setFilter(v as typeof filter)}
                  variant="outline"
                  size="sm"
                  className="w-full"
                >
                  <ToggleGroupItem value="all" aria-label="All challenges">All</ToggleGroupItem>
                  <ToggleGroupItem value="draft" aria-label="Draft challenges">Draft</ToggleGroupItem>
                  <ToggleGroupItem value="published" aria-label="Published challenges">Published</ToggleGroupItem>
                  <ToggleGroupItem value="archived" aria-label="Archived challenges">Archived</ToggleGroupItem>
                </ToggleGroup>

                {filtered.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
                    No {filter} challenges.
                  </p>
                ) : (
                  <AnimatedList className="space-y-2">
                    {filtered.map((challenge) => (
                      <AnimatedItem key={challenge.id}>
                        <ChallengeCard
                          challenge={challenge}
                          skills={challengeSkills[challenge.id]}
                          isSelected={selectedId === challenge.id}
                          onClick={() => setSelectedId(challenge.id)}
                        />
                      </AnimatedItem>
                    ))}
                  </AnimatedList>
                )}
              </div>

              {/* Right: Review panel */}
              <div className="flex-1 min-w-0">
                {selectedChallenge ? (
                  <div className="bg-card border border-border rounded-xl p-5">
                    <ReviewPanel
                      sectionId={sectionId}
                      challenge={selectedChallenge}
                      claims={selectedClaims}
                    />
                  </div>
                ) : (
                  <div className="flex h-full min-h-[16rem] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 p-8 text-center">
                    <Trophy className="h-8 w-8 text-muted-foreground/40" />
                    <p className="mt-3 text-sm font-medium text-foreground">No challenge selected</p>
                    <p className="mt-1 max-w-xs text-sm text-muted-foreground">
                      Select a challenge to view details and review student submissions.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </TabsContent>

        {/* ── Proposals Tab ─────────────────────────────────────── */}
        <TabsContent value="proposals">
          {proposals.length === 0 ? (
            <EmptyState
              variant="teaching"
              icon={Lightbulb}
              title="No proposals to review"
              description="When students propose their own challenges, they'll land here for you to approve or reject."
            />
          ) : (
            <AnimatedList className="space-y-3 max-w-2xl mx-auto">
              {proposals.map((proposal) => {
                const creator = proposal.creator || {}
                return (
                  <AnimatedItem
                    key={proposal.id}
                    className="bg-card border border-border rounded-xl p-4 hover:border-ring/40 hover:shadow-sm transition duration-200 ease-out"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-semibold">{proposal.title}</h3>
                        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                            {CHALLENGE_TYPE_LABELS[proposal.type as ChallengeType] || proposal.type}
                          </Badge>
                          <Badge className={cn('text-[10px] px-1.5 py-0', difficultyColors[proposal.difficulty])}>
                            {CHALLENGE_DIFFICULTY_LABELS[proposal.difficulty as ChallengeDifficulty] || proposal.difficulty}
                          </Badge>
                          <span className="text-[11px] text-muted-foreground">
                            by {creator.name || 'Unknown'}
                          </span>
                        </div>
                        {proposal.description && (
                          <p className="text-sm text-muted-foreground mt-2 whitespace-pre-wrap line-clamp-3">
                            {proposal.description}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <Button
                          size="sm"
                          onClick={() => handleApproveProposal(proposal.id)}
                          className="bg-success text-success-foreground hover:bg-success/90"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => handleRejectProposal(proposal.id)}
                        >
                          <XCircle className="h-3.5 w-3.5 mr-1" />
                          Reject
                        </Button>
                      </div>
                    </div>
                  </AnimatedItem>
                )
              })}
            </AnimatedList>
          )}
        </TabsContent>

        {/* ── Certificates Tab ──────────────────────────────────── */}
        <TabsContent value="certificates">
          <CertificatesPanel
            sectionId={sectionId}
            certificates={certificates}
            challenges={challenges.map((c) => ({ id: c.id, title: c.title, visibility: c.visibility }))}
          />
        </TabsContent>

        {/* ── Badges Tab ────────────────────────────────────────── */}
        <TabsContent value="badges">
          <div className="max-w-2xl mx-auto space-y-4">
            <CreateBadgeForm sectionId={sectionId} />
            {badges.length === 0 ? (
              <EmptyState
                icon={Award}
                title="No badges yet"
                description="Create badges above to award students who complete challenges."
              />
            ) : (
              <AnimatedList className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {badges.map((badge) => (
                  <AnimatedItem key={badge.id}>
                    <BadgeCard badge={badge} sectionId={sectionId} />
                  </AnimatedItem>
                ))}
              </AnimatedList>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ── Create Badge Form ───────────────────────────────────────────

function CreateBadgeForm({ sectionId }: { sectionId: string }) {
  const router = useRouter()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const form = useForm<CreateBadgeInput>({
    resolver: zodResolver(createBadgeSchema) as Resolver<CreateBadgeInput>,
    defaultValues: { name: '', description: '', icon: '🏆' },
  })

  const onSubmit = async (data: CreateBadgeInput) => {
    setIsSubmitting(true)
    try {
      const result = await createBadge(sectionId, data)
      if ('error' in result && result.error) { toast.error(result.error); return }
      toast.success('Badge created')
      form.reset()
      router.refresh()
    } catch { toast.error('Failed to create badge') }
    finally { setIsSubmitting(false) }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="bg-card border border-border rounded-xl p-4">
        <h3 className="text-sm font-semibold mb-3">Create Badge</h3>
        <div className="flex gap-3 items-end">
          <FormField
            control={form.control}
            name="icon"
            render={({ field }) => (
              <FormItem className="w-16">
                <FormLabel className="text-xs">Icon</FormLabel>
                <FormControl>
                  <Input className="text-center text-lg" maxLength={10} {...field} />
                </FormControl>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel className="text-xs">Name *</FormLabel>
                <FormControl>
                  <Input placeholder="Badge name" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel className="text-xs">Description</FormLabel>
                <FormControl>
                  <Input placeholder="Optional description" {...field} />
                </FormControl>
              </FormItem>
            )}
          />
          <Button type="submit" size="sm" disabled={isSubmitting}>
            <Plus className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
            {isSubmitting ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </form>
    </Form>
  )
}

// ── Badge Card ──────────────────────────────────────────────────

function BadgeCard({ badge, sectionId }: { badge: ChallengeBadge; sectionId: string }) {
  const router = useRouter()
  const [confirmOpen, setConfirmOpen] = useState(false)
  /* Three states, not two: not-checked-yet, could-not-check, checked. Collapsing the
     middle one into zero is what tells a professor a held badge is unheld (#702/#715). */
  const [holders, setHolders] = useState<number | 'failed' | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const loadHolders = useCallback(() => {
    setHolders(null)
    getBadgeCascadeCounts(badge.id, sectionId)
      .then((c) => setHolders(c ? c.holders : 'failed'))
      .catch(() => setHolders('failed'))
  }, [badge.id, sectionId])

  async function handleDelete() {
    setIsDeleting(true)
    const result = await deleteBadge(badge.id, sectionId)
    setIsDeleting(false)
    if ('error' in result && result.error) { toast.error(result.error); return }
    toast.success('Badge deleted')
    setConfirmOpen(false)
    router.refresh()
  }

  return (
    <div className="group bg-card border border-border rounded-xl p-3 flex items-center gap-3 hover:border-ring/40 hover:shadow-sm transition duration-200 ease-out">
      <span className="text-2xl">{badge.icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{badge.name}</p>
        {badge.description && (
          <p className="text-xs text-muted-foreground truncate">{badge.description}</p>
        )}
      </div>
      {/* Deleting a badge cascades to every user_badges row, so it strips a credential from
          every student who earned it. It used to do that on ONE click with no confirmation
          (#702). The accessible name said "Delete challenge", on a badge. */}
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 text-destructive hover:text-destructive hover:bg-destructive-muted h-7 w-7 p-0"
        onClick={() => { setConfirmOpen(true); loadHolders() }}
        aria-label={`Delete badge ${badge.name}`}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{badge.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>This cannot be undone.</p>
                {holders === null ? (
                  <p className="text-sm text-muted-foreground">Checking who holds this badge…</p>
                ) : holders === 'failed' ? (
                  <p className="text-sm font-medium text-destructive">
                    Couldn&apos;t check who holds this badge. Deleting it may remove it from
                    students who earned it.{' '}
                    <button type="button" onClick={loadHolders} className="underline underline-offset-4 hover:no-underline">
                      Try again
                    </button>
                  </p>
                ) : holders > 0 ? (
                  <p className="text-sm font-medium text-destructive">
                    {holders} student{holders === 1 ? '' : 's'} already earned this badge. Deleting
                    it takes the badge away from {holders === 1 ? 'them' : 'all of them'}.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">No student holds this badge yet.</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            {/* Inert until the count settles, so a fast click cannot confirm before the
                warning renders. */}
            <AlertDialogAction onClick={handleDelete} disabled={isDeleting || holders === null} variant="destructive">
              {isDeleting ? 'Deleting…' : 'Delete badge'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
