/**
 * StudentProjectDetail — project assignment view with team support.
 *
 * Two modes:
 * (A) No team: shows assignment info (title, description, guidelines, due date),
 *     list of existing teams, and "Create Team" button.
 * (B) Has team: renders StudentTeamDetail with full tabbed workspace.
 *
 * Type: Client Component
 */
'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Users,
  CalendarDays,
  UsersRound,
  Plus,
  UserPlus,
  Clock,
  XCircle,
  Loader2,
  Send,
  Search,
  Mail,
  Check,
  X,
  MessageSquare,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MasterPhaseView } from '@/components/student/projects/StudentPhasesTab'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  PROJECT_STATUS_LABELS,
  PROJECT_VISIBILITY_LABELS,
} from '@/lib/validations/project'
import {
  requestToJoinTeam,
  withdrawJoinRequest,
  getMyInvitations,
  respondToInvitation,
  type MyJoinRequest,
  type TeamInvitationWithProfile,
} from '@/app/(dashboard)/student/courses/[sectionId]/projects/actions'
import dynamic from 'next/dynamic'
import { CreateTeamDialog } from '@/components/student/projects/CreateTeamDialog'

const StudentTeamDetail = dynamic(
  () => import('@/components/student/projects/StudentTeamDetail').then((m) => m.StudentTeamDetail),
  { ssr: false },
)

// ── Badge colors ────────────────────────────────────────────────

const statusColors: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  active: 'bg-muted text-foreground',
  completed: 'bg-success-muted text-success-muted-foreground',
  archived: 'bg-warning-muted text-warning-muted-foreground',
}

// ── Props ───────────────────────────────────────────────────────

interface ProjectInfo {
  id: string
  title: string
  description?: string
  guidelines?: string
  status: string
  visibility?: string
  max_team_size?: number
  due_date?: string | null

}

interface TeamInfo {
  id: string
  name: string
  description?: string
  planning_doc?: string
  status: string
  member_count?: number
  phase_count?: number
  completed_phases?: number
  project_members?: unknown[]
  created_at?: string
}

interface TeamMemberInfo {
  id: string
  user_id: string
  role: string
  contribution_summary?: string | null
  profile?: { name?: string | null; email?: string | null; avatar_url?: string | null }
}

interface ProjectPhaseInfo {
  id: string
  title: string
  description?: string
  status: string
  start_date?: string | null
  due_date?: string | null
}

interface StudentProjectDetailProps {
  sectionId: string
  project: ProjectInfo
  /** All teams for this project (with member counts) */
  teams: TeamInfo[]
  /** Current user's team data (null if no team) */
  team: TeamInfo | null
  /** Team members (only if team exists) */
  members: TeamMemberInfo[]
  /** Team phases (only if team exists) */
  phases: ProjectPhaseInfo[]
  /** User's role within the team */
  userRole: 'owner' | 'member' | 'viewer' | null
  userId: string
  /** Current user's join requests for this project */
  myJoinRequests?: MyJoinRequest[]
  /** Professor-defined project roadmap (read-only). */
  masterPhases?: MasterPhaseView[]
}

// ── Component ───────────────────────────────────────────────────

export function StudentProjectDetail({
  sectionId,
  project,
  teams,
  team,
  members,
  phases,
  userRole,
  userId,
  myJoinRequests = [],
  masterPhases = [],
}: StudentProjectDetailProps) {
  const router = useRouter()
  const statusColor = statusColors[project.status] || statusColors.draft

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Button
        variant="ghost"
        size="sm"
        className="gap-2 -ml-2 text-muted-foreground hover:text-foreground group"
        onClick={() => router.push(`/student/courses/${sectionId}/projects`)}
      >
        <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-1" />
        Back to Projects
      </Button>

      {/* Mode A: No team — show assignment info + create team (with full project header) */}
      {/* Mode B: Has team — project title lives inside StudentTeamDetail, no duplicate header */}
      {team ? (
        <StudentTeamDetail
          sectionId={sectionId}
          project={project}
          team={team}
          members={members}
          phases={phases}
          userRole={userRole}
          userId={userId}
          allTeams={teams}
          masterPhases={masterPhases}
        />
      ) : (
        <>
          {/* Project header — only rendered in no-team mode */}
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-3 flex-wrap mb-1">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">{project.title}</h1>
                <Badge className={cn('text-[11px] px-2.5 py-0.5 rounded-full', statusColor)}>
                  {PROJECT_STATUS_LABELS[project.status as keyof typeof PROJECT_STATUS_LABELS] || project.status}
                </Badge>
              </div>
              <div className="flex items-center gap-3 mt-2 text-[13px] text-muted-foreground flex-wrap font-medium">
                {project.visibility && (
                  <>
                    <span className="flex items-center gap-1.5">
                      <Globe className="h-3.5 w-3.5 opacity-70" />
                      {PROJECT_VISIBILITY_LABELS[project.visibility as keyof typeof PROJECT_VISIBILITY_LABELS] || project.visibility}
                    </span>
                    <span className="text-muted-foreground/40 hidden sm:inline">·</span>
                  </>
                )}
                <span className="flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5 opacity-70" />
                  Max {project.max_team_size || 5} per team
                </span>
                <span className="text-muted-foreground/40 hidden sm:inline">·</span>
                <span className="flex items-center gap-1.5">
                  <UsersRound className="h-3.5 w-3.5 opacity-70" />
                  {teams.length} team{teams.length !== 1 ? 's' : ''}
                </span>
                {project.due_date && (
                  <>
                    <span className="text-muted-foreground/40 hidden sm:inline">·</span>
                    <span className="flex items-center gap-1.5">
                      <CalendarDays className="h-3.5 w-3.5 opacity-70" />
                      Due {new Date(project.due_date).toLocaleDateString('en-US', {
                        timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
                      })}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
          <AssignmentView
            sectionId={sectionId}
            project={project}
            teams={teams}
            userId={userId}
            myJoinRequests={myJoinRequests}
          />
        </>
      )}
    </div>
  )
}

// ── Assignment View (no team yet) ───────────────────────────────

interface AssignmentViewProps {
  sectionId: string
  project: ProjectInfo
  teams: TeamInfo[]
  userId: string
  myJoinRequests: MyJoinRequest[]
}

function AssignmentView(props: AssignmentViewProps) {
  const { sectionId, project, teams, myJoinRequests } = props
  const [createOpen, setCreateOpen] = useState(false)
  const [browseTeamsOpen, setBrowseTeamsOpen] = useState(false)
  const [joinDialogTeam, setJoinDialogTeam] = useState<TeamInfo | null>(null)
  const [joinMessage, setJoinMessage] = useState('')
  const [isRequesting, setIsRequesting] = useState(false)
  const [isWithdrawing, setIsWithdrawing] = useState<string | null>(null)
  const [teamSearch, setTeamSearch] = useState('')
  const [isStuck, setIsStuck] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const router = useRouter()

  // Detect when the sticky bar becomes stuck at the top
  // rootMargin shrinks the top by 150px so the title reveals only after
  // the user has scrolled past the header, not the instant it touches the top
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      ([entry]) => setIsStuck(!entry.isIntersecting),
      { threshold: 0, rootMargin: '-150px 0px 0px 0px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [])

  const canCreateTeam = project.status === 'active'
  const maxSize = project.max_team_size || 5

  // Build a map of teamId → request status for quick lookup
  const requestsByTeam = new Map(myJoinRequests.map((r) => [r.team_id, r]))

  // Filter teams by search
  const filteredTeams = teams.filter((t) =>
    !teamSearch || t.name.toLowerCase().includes(teamSearch.toLowerCase()) ||
    t.description?.toLowerCase().includes(teamSearch.toLowerCase())
  )

  // Check if deadline is within 7 days. due_date is a DATE — anchor "today" to UTC
  // midnight so the calendar-day math isn't shifted by the local timezone.
  const isDeadlineSoon = project.due_date
    ? (new Date(project.due_date).getTime() - new Date(new Date().toISOString().slice(0, 10)).getTime()) / (1000 * 60 * 60 * 24) <= 7
    : false

  // Count pending requests for badge
  const pendingCount = myJoinRequests.filter((r) => r.status === 'pending').length

  const handleRequestJoin = async () => {
    if (!joinDialogTeam) return
    setIsRequesting(true)
    try {
      const result = await requestToJoinTeam(joinDialogTeam.id, project.id, sectionId, joinMessage)
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success('Join request sent! The team owner will review it.')
        setJoinDialogTeam(null)
        setJoinMessage('')
        router.refresh()
      }
    } catch {
      toast.error('Something went wrong')
    } finally {
      setIsRequesting(false)
    }
  }

  const handleWithdraw = async (requestId: string) => {
    setIsWithdrawing(requestId)
    try {
      const result = await withdrawJoinRequest(requestId, sectionId)
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success('Request withdrawn')
        router.refresh()
      }
    } catch {
      toast.error('Something went wrong')
    } finally {
      setIsWithdrawing(null)
    }
  }

  return (
    <div className="space-y-14">

      {/* Sentinel: when this scrolls behind the navbar, sticky bar title appears */}
      <div ref={sentinelRef} className="h-0 -mb-14" aria-hidden />

      {/* ── Action Bar: Create / Join buttons ───────────────────────── */}
      {canCreateTeam && (
        <div className="sticky top-0 z-30 flex items-center gap-3 py-3 bg-background/80 backdrop-blur-md border-b border-border/40 -mx-6 px-6 animate-in fade-in slide-in-from-bottom-2 duration-500 fill-mode-both">
          <h2
            className={cn(
              'text-base font-semibold tracking-tight text-foreground truncate mr-auto min-w-0',
              isStuck ? 'opacity-100 translate-y-0 transition duration-200 ease-out' : 'opacity-0 -translate-y-2 pointer-events-none transition duration-150 ease-out'
            )}
          >
            {project.title}
          </h2>
          <Button
            className="gap-2 group"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="w-4 h-4 transition-transform group-hover:rotate-90 duration-200 ease-out" />
            Create Team
          </Button>
          <Button
            variant="outline"
            className="gap-2 group"
            onClick={() => setBrowseTeamsOpen(true)}
          >
            <UsersRound className="w-4 h-4" />
            Browse Teams
            {teams.length > 0 && (
              <span className="ml-1 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-muted text-[11px] font-medium text-muted-foreground tabular-nums">
                {teams.length}
              </span>
            )}
            {pendingCount > 0 && (
              <span className="ml-0.5 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-warning-muted text-[11px] font-medium text-warning-muted-foreground tabular-nums">
                {pendingCount} pending
              </span>
            )}
            <ArrowRight className="w-4 h-4 text-muted-foreground/50 group-hover:text-foreground group-hover:translate-x-0.5 transition duration-200 ease-out" />
          </Button>
        </div>
      )}

      {/* ── Invitation Inbox ─────────────────────────────────────────── */}
      <InvitationInbox
        sectionId={sectionId}
        projectId={project.id}
      />

      {/* ── Content Body (Editorial) ────────────────────────────────── */}
      <div className="max-w-3xl mx-auto space-y-12 animate-in fade-in slide-in-from-bottom-2 duration-500 delay-100 fill-mode-both">
        {project.description && (
          <div>
            <p className="text-[11px] tracking-[0.2em] uppercase font-semibold text-muted-foreground mb-4">
              Description
            </p>
            <p className="text-[15px] whitespace-pre-wrap leading-[1.8] text-foreground/85">
              {project.description}
            </p>
          </div>
        )}

        {project.guidelines && (
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-500 delay-200 fill-mode-both">
            <p className="text-[11px] tracking-[0.2em] uppercase font-semibold text-muted-foreground mb-5">
              Guidelines
            </p>
            <p className="text-[15px] whitespace-pre-wrap leading-[1.8] text-foreground/85">
              {project.guidelines}
            </p>
          </div>
        )}

        {!project.description && !project.guidelines && (
          <div className="text-sm text-muted-foreground py-16 text-center border border-dashed border-border rounded-2xl bg-muted/5">
            No description or guidelines provided for this project.
          </div>
        )}
      </div>

      {/* ── Deadline reminder (sticky bottom bar) ───────────────────── */}
      {isDeadlineSoon && project.due_date && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-5 py-3 rounded-full bg-foreground text-background shadow-2xl text-sm font-medium animate-in fade-in slide-in-from-bottom-4 duration-500">
          <span className="w-1.5 h-1.5 rounded-full bg-background animate-pulse" />
          <CalendarDays className="w-4 h-4" />
          Due {new Date(project.due_date).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })}
          <span className="text-background/60 ml-1">— find a team soon</span>
        </div>
      )}

      {/* ── Create Team Dialog ──────────────────────────────────────── */}
      <CreateTeamDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        sectionId={sectionId}
        projectId={project.id}
      />

      {/* ── Browse Teams Dialog ─────────────────────────────────────── */}
      <Dialog open={browseTeamsOpen} onOpenChange={setBrowseTeamsOpen}>
        <DialogContent className="sm:max-w-5xl max-h-[92vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-xl font-semibold tracking-tight">Browse Teams</DialogTitle>
            <DialogDescription className="text-[13px]">
              {teams.length} team{teams.length !== 1 ? 's' : ''} available — request to join one that fits.
            </DialogDescription>
          </DialogHeader>

          {/* Search */}
          {teams.length > 3 && (
            <div className="relative mt-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search teams..."
                value={teamSearch}
                onChange={(e) => setTeamSearch(e.target.value)}
                className="h-10 pl-10 rounded-xl border-border bg-transparent text-sm placeholder:text-muted-foreground/60"
              />
            </div>
          )}

          {/* Teams gallery */}
          <div className="flex-1 overflow-y-auto -mx-6 px-6 mt-3">
            {filteredTeams.length === 0 && teams.length === 0 ? (
              <div className="py-16 flex flex-col items-center justify-center text-center">
                <div className="w-12 h-12 rounded-2xl bg-muted flex items-center justify-center mb-4">
                  <Users className="w-6 h-6 text-muted-foreground" />
                </div>
                <h3 className="text-base font-semibold text-foreground">
                  No teams yet
                </h3>
                <p className="text-sm text-muted-foreground mt-2 max-w-[280px]">
                  Be the first — close this and create a team to get started.
                </p>
              </div>
            ) : filteredTeams.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No teams match your search.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pb-4">
                {filteredTeams.map((t) => {
                  const memberCount = t.member_count ?? t.project_members?.length ?? 0
                  const isFull = memberCount >= maxSize
                  const existingRequest = requestsByTeam.get(t.id)
                  const isPending = existingRequest?.status === 'pending'
                  const isAccepted = existingRequest?.status === 'accepted'
                  // Declined requests reset to normal state — student can request again freely
                  const canRequest = canCreateTeam && !isFull && !isPending && !isAccepted
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const teamMembers = (t.project_members || []) as any[]

                  return (
                    <div
                      key={t.id}
                      className={cn(
                        'group rounded-xl border p-4 transition duration-200 ease-out flex flex-col',
                        isPending && 'border-warning/30 bg-warning-muted/40',
                        isFull && !isPending && 'opacity-60 border-border bg-muted/40',
                        !isPending && !isFull && 'border-border bg-card hover:border-ring/40 hover:shadow-sm'
                      )}
                    >
                      {/* Header: avatar + name + status */}
                      <div className="flex items-start gap-3 mb-2">
                        <div className="w-10 h-10 rounded-xl bg-muted/40 border border-border flex items-center justify-center shrink-0">
                          <span className="text-base font-bold text-foreground">{t.name.charAt(0).toUpperCase()}</span>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[15px] font-semibold text-foreground truncate">{t.name}</span>
                            {isPending && (
                              <Badge variant="outline" className="text-[10px] px-2 py-0.5 rounded-full border-warning/30 bg-warning-muted text-warning-muted-foreground gap-1 font-medium">
                                <Clock className="h-2.5 w-2.5" />
                                Pending
                              </Badge>
                            )}
                            {isFull && !isPending && (
                              <Badge variant="secondary" className="text-[10px] px-2 py-0.5 rounded-full font-medium">Full</Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-[12px] text-muted-foreground mt-1">
                            <Users className="h-3 w-3" />
                            <span>{memberCount} of {maxSize} members</span>
                            {t.phase_count != null && t.phase_count > 0 && (
                              <>
                                <span className="text-muted-foreground/40">·</span>
                                <span>{t.completed_phases ?? 0}/{t.phase_count} phases</span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Description — what this team is building */}
                      {t.description ? (
                        <div className="mb-2 bg-muted/40 rounded-xl px-3 py-2">
                          <p className="text-[11px] uppercase tracking-wide text-muted-foreground/60 font-semibold mb-0.5">Building</p>
                          <p className="text-[13px] text-foreground/80 leading-relaxed line-clamp-2">{t.description}</p>
                        </div>
                      ) : (
                        <div className="mb-2 bg-muted/20 rounded-xl px-3 py-2 border border-dashed border-border/60">
                          <p className="text-[12px] text-muted-foreground/50 italic">No description yet</p>
                        </div>
                      )}

                      {/* Member avatars */}
                      {teamMembers.length > 0 && (
                        <div className="flex items-center gap-2 mb-3">
                          <div className="flex -space-x-2">
                            {teamMembers.slice(0, 5).map((m, i) => {
                              const profile = m.profile || {}
                              const name = profile.name || 'Member'
                              return (
                                <TooltipProvider key={m.id || i}>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <div className="w-7 h-7 rounded-full border-2 border-background bg-muted/60 flex items-center justify-center shrink-0">
                                        {profile.avatar_url ? (
                                          // eslint-disable-next-line @next/next/no-img-element
                                          <img src={profile.avatar_url} alt={name} className="w-full h-full rounded-full object-cover" />
                                        ) : (
                                          <span className="text-[10px] font-semibold text-foreground">{name.charAt(0).toUpperCase()}</span>
                                        )}
                                      </div>
                                    </TooltipTrigger>
                                    <TooltipContent className="text-xs">{name}</TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )
                            })}
                          </div>
                          {teamMembers.length > 5 && (
                            <span className="text-[11px] text-muted-foreground font-medium">+{teamMembers.length - 5} more</span>
                          )}
                        </div>
                      )}

                      {/* Spacer to push action to bottom */}
                      <div className="mt-auto" />

                      {/* Action */}
                      <div className="pt-1">
                        {canRequest && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full rounded-full gap-2"
                            onClick={() => {
                              setBrowseTeamsOpen(false)
                              setTimeout(() => {
                                setJoinDialogTeam(t)
                                setJoinMessage('')
                              }, 150)
                            }}
                          >
                            <UserPlus className="h-3.5 w-3.5" />
                            Request to join
                          </Button>
                        )}
                        {isPending && existingRequest && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="w-full h-9 rounded-full text-[12px] text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors font-medium gap-2"
                                  onClick={() => handleWithdraw(existingRequest.id)}
                                  disabled={isWithdrawing === existingRequest.id}
                                >
                                  {isWithdrawing === existingRequest.id ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <XCircle className="h-3.5 w-3.5" />
                                  )}
                                  Withdraw request
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent className="text-xs">Cancel your pending join request</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Request to Join Dialog ──────────────────────────────────── */}
      <Dialog open={!!joinDialogTeam} onOpenChange={(open) => { if (!open) setJoinDialogTeam(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader className="mb-2">
            <DialogTitle className="text-lg font-semibold tracking-tight">Request to Join</DialogTitle>
            <DialogDescription className="text-[14.5px] mt-1.5">
              Send a join request to <span className="font-medium text-foreground">{joinDialogTeam?.name}</span>. The team owner will review your request.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex items-center gap-3 text-[14px] text-muted-foreground/80 p-3.5 rounded-xl border border-border/50 bg-muted/20">
              <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>
                {joinDialogTeam?.member_count ?? joinDialogTeam?.project_members?.length ?? 0} / {maxSize} members
              </span>
            </div>

            <div className="space-y-2">
              <label className="text-[13px] font-semibold text-foreground/90">
                Message <span className="text-muted-foreground/60 font-normal ml-1">(optional)</span>
              </label>
              <Textarea
                placeholder="Briefly introduce yourself or explain why you'd like to join this team..."
                value={joinMessage}
                onChange={(e) => setJoinMessage(e.target.value)}
                maxLength={500}
                rows={4}
                className="resize-none rounded-xl text-[14px] bg-background border-border/60 focus-visible:ring-offset-0 focus-visible:ring-1"
              />
              <p className="text-[11px] font-medium text-muted-foreground/50 text-right">{joinMessage.length} / 500</p>
            </div>
          </div>

          <DialogFooter className="mt-4">
            <Button variant="outline" className="rounded-full h-10 px-5" onClick={() => setJoinDialogTeam(null)} disabled={isRequesting}>
              Cancel
            </Button>
            <Button className="rounded-full h-10 px-5" onClick={handleRequestJoin} disabled={isRequesting}>
              {isRequesting ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <Send className="h-3.5 w-3.5 mr-1.5" />
              )}
              Send Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Invitation Inbox (no-team view) ─────────────────────────────

interface InvitationInboxProps {
  sectionId: string
  projectId: string
}

function InvitationInbox({ sectionId, projectId }: InvitationInboxProps) {
  const router = useRouter()
  const [invitations, setInvitations] = useState<TeamInvitationWithProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [respondingId, setRespondingId] = useState<string | null>(null)

  const fetchInvitations = useCallback(async () => {
    const result = await getMyInvitations(projectId, sectionId)
    if (result.data) setInvitations(result.data)
    setLoading(false)
  }, [projectId, sectionId])

  useEffect(() => {
    fetchInvitations()
  }, [fetchInvitations])

  async function handleRespond(invitationId: string, accept: boolean) {
    setRespondingId(invitationId)
    try {
      const result = await respondToInvitation(invitationId, sectionId, accept)
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success(accept ? 'You joined the team!' : 'Invitation declined')
        router.refresh()
        if (accept) {
          // Page will re-render with team data
        } else {
          fetchInvitations()
        }
      }
    } catch {
      toast.error('Something went wrong')
    } finally {
      setRespondingId(null)
    }
  }

  if (loading || invitations.length === 0) return null

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="border border-info/20 bg-info-muted/40 rounded-2xl p-5 space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-info-muted border border-info/20 flex items-center justify-center">
            <Mail className="h-4.5 w-4.5 text-info-muted-foreground" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Team Invitations
            </h3>
            <p className="text-xs text-muted-foreground">
              {invitations.length} team{invitations.length !== 1 ? 's' : ''} invited you to join
            </p>
          </div>
        </div>

        <div className="space-y-2.5">
          {invitations.map((inv) => {
            const isResponding = respondingId === inv.id

            return (
              <div
                key={inv.id}
                className="bg-background border border-border rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-foreground">
                      {inv.team_name || 'Unknown Team'}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      invited by {inv.inviter_profile?.name || 'someone'}
                    </span>
                  </div>
                  {inv.message && (
                    <div className="flex gap-1.5 mt-1.5">
                      <MessageSquare className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                      <p className="text-xs text-muted-foreground italic line-clamp-2">
                        &ldquo;{inv.message}&rdquo;
                      </p>
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground/60 mt-1">
                    {new Date(inv.created_at).toLocaleDateString('en-US', {
                      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                    })}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-3 text-xs rounded-full"
                    onClick={() => handleRespond(inv.id, false)}
                    disabled={isResponding}
                  >
                    {isResponding ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3 mr-1" />}
                    Decline
                  </Button>
                  <Button
                    size="sm"
                    className="h-8 px-4 text-xs rounded-full gap-1.5"
                    onClick={() => handleRespond(inv.id, true)}
                    disabled={isResponding}
                  >
                    {isResponding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    Accept & Join
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
