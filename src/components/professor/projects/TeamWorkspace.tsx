/**
 * TeamWorkspace — full-page professor view of one project team.
 *
 * Replaces the old TeamDetailView dialog. Header answers "are they
 * working?" at a glance (posts this week, last activity, members posting,
 * phases done), then tabs: Discussions (read-only chat), Phases (the
 * team's own phases with professor comments), Members, Contributions.
 *
 * Type: Client Component
 */
'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  ArrowLeft,
  Users,
  Crown,
  Shield,
  Eye,
  CheckCircle2,
  Clock,
  AlertCircle,
  Circle,
  Calendar,
  FileText,
  MessageSquare,
  Send,
  Loader2,
  Trash2,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  MEMBER_ROLE_LABELS,
  PHASE_STATUS_LABELS,
  TEAM_STATUS_LABELS,
} from '@/lib/validations/project'
import {
  getPhaseComments,
  addPhaseComment,
  deletePhaseComment,
  type PhaseComment,
} from '@/app/(dashboard)/professor/courses/[sectionId]/projects/actions'
import {
  TeamDiscussions,
  type DiscussionChannel,
  type DiscussionMember,
} from './TeamDiscussions'

const roleColors: Record<string, string> = {
  owner: 'bg-warning-muted text-warning-muted-foreground',
  member: 'bg-muted text-foreground',
  viewer: 'bg-muted text-foreground',
}

const phaseColors: Record<string, string> = {
  not_started: 'bg-muted text-foreground',
  in_progress: 'bg-muted text-foreground',
  completed: 'bg-success-muted text-success-muted-foreground',
  blocked: 'bg-destructive/10 text-destructive',
}

const phaseIcons: Record<string, typeof Circle> = {
  not_started: Circle,
  in_progress: Clock,
  completed: CheckCircle2,
  blocked: AlertCircle,
}

// ── Types ────────────────────────────────────────────────────────

interface MemberProfile {
  name?: string
  email?: string
}

interface TeamMember {
  id: string
  user_id: string
  role: string
  contribution_summary?: string
  profile?: MemberProfile
}

interface TeamPhase {
  id: string
  title: string
  description?: string
  status: string
  start_date?: string | null
  due_date?: string | null
}

export interface TeamPulse {
  postsThisWeek: number
  lastActivity: string | null
  membersPosting: number
  membersTotal: number
  phasesDone: number
  phasesTotal: number
}

interface TeamWorkspaceProps {
  sectionId: string
  projectId: string
  projectTitle: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  team: any
  members: TeamMember[]
  phases: TeamPhase[]
  pulse: TeamPulse
  channels: DiscussionChannel[]
  initialChannelId: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initialMessages: any[]
  discussionMembers: DiscussionMember[]
  phaseTitles: Record<string, string>
  docTitles: Record<string, string>
}

// ── Helpers ──────────────────────────────────────────────────────

function getInitials(name: string | null | undefined): string {
  if (!name) return '?'
  return name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
}

function formatDate(date: string | null | undefined): string {
  if (!date) return '--'
  // timeZone pinned so SSR (UTC) and client (local) render the same text — avoids React #418.
  return new Date(date).toLocaleDateString('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
  })
}

function relTime(iso: string | null): { value: string; hint: string } {
  if (!iso) return { value: '–', hint: 'no activity yet' }
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 60) return { value: `${Math.max(mins, 1)}m`, hint: 'ago' }
  const hours = Math.floor(mins / 60)
  if (hours < 24) return { value: `${hours}h`, hint: 'ago' }
  return { value: `${Math.floor(hours / 24)}d`, hint: 'ago' }
}

function PulseStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-3.5 py-2.5">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="mt-0.5 text-xl font-bold tabular-nums">
        {value}
        {hint && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{hint}</span>}
      </p>
    </div>
  )
}

// ── Component ────────────────────────────────────────────────────

export function TeamWorkspace({
  sectionId,
  projectId,
  projectTitle,
  team,
  members,
  phases,
  pulse,
  channels,
  initialChannelId,
  initialMessages,
  discussionMembers,
  phaseTitles,
  docTitles,
}: TeamWorkspaceProps) {
  const statusColor =
    team.status === 'completed'
      ? 'bg-success-muted text-success-muted-foreground'
      : team.status === 'archived'
        ? 'bg-warning-muted text-warning-muted-foreground'
        : 'bg-muted text-foreground'
  const last = relTime(pulse.lastActivity)

  return (
    <div className="space-y-6">
      <Link
        href={`/professor/courses/${sectionId}/projects/${projectId}`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to {projectTitle}
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2.5 text-2xl font-bold">
            {team.name}
            <Badge className={cn('px-1.5 py-0 text-xs', statusColor)}>
              {TEAM_STATUS_LABELS[team.status as keyof typeof TEAM_STATUS_LABELS] || team.status}
            </Badge>
          </h1>
          {team.description && (
            <p className="mt-1 text-sm text-muted-foreground">{team.description}</p>
          )}
        </div>
        <div className="flex">
          {members.slice(0, 6).map((m, i) => (
            <Avatar
              key={m.id}
              className={cn('h-8 w-8 border-2 border-card', i > 0 && '-ml-2')}
            >
              <AvatarFallback className="text-xs">
                {getInitials(m.profile?.name)}
              </AvatarFallback>
            </Avatar>
          ))}
        </div>
      </div>

      {/* Pulse strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <PulseStat label="Posts this week" value={String(pulse.postsThisWeek)} />
        <PulseStat label="Last activity" value={last.value} hint={last.hint} />
        <PulseStat
          label="Members posting"
          value={`${pulse.membersPosting}/${pulse.membersTotal}`}
          hint={
            pulse.membersTotal > pulse.membersPosting
              ? `${pulse.membersTotal - pulse.membersPosting} silent`
              : 'everyone active'
          }
        />
        <PulseStat label="Phases done" value={`${pulse.phasesDone}/${pulse.phasesTotal}`} />
      </div>

      {/* Tabs */}
      <Tabs defaultValue="discussions">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="discussions">Discussions</TabsTrigger>
            <TabsTrigger value="phases">Phases ({phases.length})</TabsTrigger>
            <TabsTrigger value="members">Members ({members.length})</TabsTrigger>
            <TabsTrigger value="contributions">Contributions</TabsTrigger>
          </TabsList>
          <Button asChild variant="outline" size="sm" className="h-8 gap-1 text-xs">
            <Link href={`/professor/courses/${sectionId}/projects/${projectId}/teams/${team.id}/grade`}>
              <ClipboardCheck className="h-3.5 w-3.5" />
              Grade
            </Link>
          </Button>
        </div>

        <TabsContent value="discussions" className="mt-6">
          <TeamDiscussions
            sectionId={sectionId}
            projectId={projectId}
            teamId={team.id}
            channels={channels}
            initialChannelId={initialChannelId}
            initialMessages={initialMessages}
            members={discussionMembers}
            phaseTitles={phaseTitles}
            docTitles={docTitles}
          />
        </TabsContent>

        <TabsContent value="phases" className="mt-6">
          {phases.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title="No phases"
              description="This team has not created any project phases yet."
            />
          ) : (
            <div className="max-w-3xl space-y-3">
              {phases.map((phase) => (
                <CommentablePhase key={phase.id} phase={phase} sectionId={sectionId} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="members" className="mt-6">
          {members.length === 0 ? (
            <EmptyState icon={Users} title="No members" description="" />
          ) : (
            <div className="max-w-3xl space-y-2">
              {members.map((m) => {
                const name = m.profile?.name || 'Unknown'
                const email = m.profile?.email || ''
                const roleColor = roleColors[m.role] || roleColors.viewer
                const RoleIcon = m.role === 'owner' ? Crown : m.role === 'viewer' ? Eye : Shield
                return (
                  <div key={m.id} className="flex items-center gap-3 rounded-xl border p-3">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="text-xs">{getInitials(name)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{name}</span>
                        <Badge className={cn('px-1.5 py-0 text-xs', roleColor)}>
                          <RoleIcon className="mr-0.5 h-2.5 w-2.5" />
                          {MEMBER_ROLE_LABELS[m.role as keyof typeof MEMBER_ROLE_LABELS] || m.role}
                        </Badge>
                      </div>
                      {email && <p className="truncate text-xs text-muted-foreground">{email}</p>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="contributions" className="mt-6">
          {members.length === 0 ? (
            <EmptyState icon={FileText} title="No contributions" description="" />
          ) : (
            <div className="max-w-3xl space-y-3">
              {members.map((m) => {
                const name = m.profile?.name || 'Unknown'
                const roleColor = roleColors[m.role] || roleColors.viewer
                const RoleIcon = m.role === 'owner' ? Crown : m.role === 'viewer' ? Eye : Shield
                return (
                  <div key={m.id} className="rounded-xl border p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <Avatar className="h-6 w-6">
                        <AvatarFallback className="text-xs">{getInitials(name)}</AvatarFallback>
                      </Avatar>
                      <span className="text-sm font-medium">{name}</span>
                      <Badge className={cn('px-1.5 py-0 text-xs', roleColor)}>
                        <RoleIcon className="mr-0.5 h-2.5 w-2.5" />
                        {MEMBER_ROLE_LABELS[m.role as keyof typeof MEMBER_ROLE_LABELS] || m.role}
                      </Badge>
                    </div>
                    <div className="text-sm whitespace-pre-wrap">
                      {m.contribution_summary || (
                        <span className="text-muted-foreground/60 italic">
                          No contribution added yet.
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ── Phase card with the professor comment thread ────────────────
// (Ported from the retired TeamDetailView dialog.)

function CommentablePhase({ phase, sectionId }: { phase: TeamPhase; sectionId: string }) {
  const StatusIcon = phaseIcons[phase.status] || Circle
  const color = phaseColors[phase.status] || phaseColors.not_started
  const [expanded, setExpanded] = useState(false)
  const [comments, setComments] = useState<PhaseComment[]>([])
  const [loadingComments, setLoadingComments] = useState(false)
  const [newComment, setNewComment] = useState('')
  const [sending, setSending] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [commentCount, setCommentCount] = useState<number | null>(null)
  const pendingDeleteRef = useRef<string | null>(null)

  const fetchComments = useCallback(async () => {
    setLoadingComments(true)
    try {
      const result = await getPhaseComments(phase.id, sectionId)
      if (result.data) {
        setComments(result.data)
        setCommentCount(result.data.length)
      }
    } finally {
      setLoadingComments(false)
    }
  }, [phase.id, sectionId])

  useEffect(() => {
    if (expanded && comments.length === 0 && commentCount !== 0) {
      void fetchComments()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded])

  async function handleSend() {
    if (!newComment.trim()) return
    setSending(true)
    try {
      const result = await addPhaseComment(phase.id, sectionId, newComment)
      if (result.error) {
        toast.error(result.error)
      } else {
        setNewComment('')
        await fetchComments()
      }
    } finally {
      setSending(false)
    }
  }

  function requestDelete(commentId: string) {
    pendingDeleteRef.current = commentId
    setDeleteConfirmId(commentId)
  }

  async function confirmDelete() {
    const commentId = pendingDeleteRef.current
    if (!commentId) return
    setDeleteConfirmId(null)
    setDeletingId(commentId)
    const result = await deletePhaseComment(commentId, sectionId)
    if (result.error) {
      toast.error(result.error)
    } else {
      setComments((prev) => prev.filter((c) => c.id !== commentId))
      setCommentCount((prev) => (prev ?? 1) - 1)
    }
    setDeletingId(null)
    pendingDeleteRef.current = null
  }

  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="p-3">
        <div className="flex items-start gap-2">
          <StatusIcon
            className={cn('mt-0.5 h-4 w-4 shrink-0', {
              'text-muted-foreground': phase.status === 'not_started',
              'text-foreground': phase.status === 'in_progress',
              'text-success': phase.status === 'completed',
              'text-destructive': phase.status === 'blocked',
            })}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{phase.title}</span>
              <Badge className={cn('px-1.5 py-0 text-xs', color)}>
                {PHASE_STATUS_LABELS[phase.status as keyof typeof PHASE_STATUS_LABELS] || phase.status}
              </Badge>
            </div>
            {phase.description && (
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                {phase.description}
              </p>
            )}
            {(phase.start_date || phase.due_date) && (
              <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <Calendar className="h-3 w-3" />
                {phase.start_date && formatDate(phase.start_date)}
                {phase.due_date && ` - ${formatDate(phase.due_date)}`}
              </div>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <MessageSquare className="h-3 w-3" />
          {commentCount != null && commentCount > 0 ? (
            <span>
              {commentCount} comment{commentCount !== 1 ? 's' : ''}
            </span>
          ) : (
            <span>Add comment</span>
          )}
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
      </div>

      {expanded && (
        <div className="space-y-3 border-t bg-muted/20 px-3 py-3">
          {loadingComments ? (
            <div className="flex items-center justify-center py-3">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : comments.length > 0 ? (
            <div className="space-y-2.5">
              {comments.map((comment) => (
                <div key={comment.id} className="group flex gap-2.5">
                  <Avatar className="mt-0.5 h-6 w-6 shrink-0">
                    <AvatarFallback className="text-xs">
                      {getInitials(comment.author?.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium">
                        {comment.author?.name || 'Professor'}
                      </span>
                      <span className="text-xs text-muted-foreground/60">
                        {/* timeZone pinned so SSR (UTC) and client (local) agree — avoids React #418. */}
                        {new Date(comment.created_at).toLocaleDateString('en-US', {
                          timeZone: 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                        })}
                      </span>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => requestDelete(comment.id)}
                              disabled={deletingId === comment.id}
                              className="-m-1 ml-auto rounded-full p-1.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                            >
                              {deletingId === comment.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                              )}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>Delete comment</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed whitespace-pre-wrap text-foreground/80">
                      {comment.content}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex gap-2">
            <Textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder="Write a comment for this phase..."
              className="min-h-[60px] resize-none bg-background text-xs"
              rows={2}
              maxLength={5000}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  handleSend()
                }
              }}
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-[60px] w-9 shrink-0"
              disabled={sending || !newComment.trim()}
              onClick={handleSend}
              aria-label={sending ? 'Sending comment…' : 'Send comment'}
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Send className="h-4 w-4" aria-hidden="true" />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground/50">
            Press Cmd+Enter to send. Students will see your comments on this phase.
          </p>
        </div>
      )}

      <AlertDialog open={!!deleteConfirmId} onOpenChange={(open) => { if (!open) setDeleteConfirmId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete comment?</AlertDialogTitle>
            <AlertDialogDescription>
              This feedback will be permanently removed. Students will no longer see it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {/* variant, not raw destructive classes. This dialog was ported from
                TeamDetailView, which main fixed the same way in 3fe34e80 before
                this branch retired it — porting the file carried the old form
                back in with it. */}
            <AlertDialogAction
              variant="destructive"
              onClick={confirmDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
