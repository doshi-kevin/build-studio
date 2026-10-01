/**
 * StudentTeamTab — team member management for a student team.
 *
 * Displays the list of team members with avatar, name, and role badge.
 * Team owners can add/remove members. Any member can update their own
 * contribution summary via an inline textarea.
 *
 * Type: Client Component
 */
'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  Users,
  UserPlus,
  UserMinus,
  Save,
  Crown,
  Shield,
  Eye,
  Check,
  X,
  Loader2,
  MessageSquare,
  Send,
  Mail,
  Clock,
  LogOut,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { MEMBER_ROLE_LABELS } from '@/lib/validations/project'
import { Search } from 'lucide-react'
import {
  updateContribution,
  removeTeamMember,
  leaveTeam,
  getTeamJoinRequests,
  respondToJoinRequest,
  getAvailableStudents,
  sendTeamInvitation,
  getSentInvitations,
  withdrawInvitation,
  type JoinRequestWithProfile,
  type AvailableStudent,
  type TeamInvitationWithProfile,
} from '@/app/(dashboard)/student/courses/[sectionId]/projects/actions'

// ── Role icons & colors ─────────────────────────────────────────

const roleIcons: Record<string, typeof Crown> = {
  owner: Crown,
  member: Shield,
  viewer: Eye,
}

const roleColors: Record<string, string> = {
  owner: 'bg-warning-muted text-warning-muted-foreground',
  member: 'bg-muted text-foreground',
  viewer: 'bg-muted text-muted-foreground',
}

// ── Props ───────────────────────────────────────────────────────

interface MemberProfile {
  name?: string | null
  email?: string | null
  avatar_url?: string | null
}

interface TeamMember {
  id: string
  user_id: string
  role: string
  contribution_summary?: string | null
  profile?: MemberProfile
}

interface ProjectInfo {
  id: string
  title: string
  max_team_size?: number
}

interface StudentTeamTabProps {
  sectionId: string
  project: ProjectInfo
  teamId: string
  teamDescription?: string
  members: TeamMember[]
  userRole: 'owner' | 'member' | 'viewer' | null
  userId: string
}

// ── Component ───────────────────────────────────────────────────

export function StudentTeamTab({
  sectionId,
  project,
  teamId,
  teamDescription,
  members,
  userRole,
  userId,
}: StudentTeamTabProps) {
  const router = useRouter()
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [inviteRefreshKey, setInviteRefreshKey] = useState(0)
  const [removeTarget, setRemoveTarget] = useState<TeamMember | null>(null)
  const [leaveOpen, setLeaveOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [contributionEditing, setContributionEditing] = useState<string | null>(null)
  const [contributionText, setContributionText] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  const isOwner = userRole === 'owner'
  /* Am I actually in this team? A viewer is looking at someone else's team and has nothing to
     leave. `userRole` is null for a non-member. */
  const isMember = userRole === 'owner' || userRole === 'member'
  const iAmLastMember = members.length <= 1

  // ── Contribution handlers ──────────────────────────────────

  function startEditContribution(member: TeamMember) {
    setContributionEditing(member.id)
    setContributionText(member.contribution_summary || '')
  }

  async function saveContribution() {
    setIsSaving(true)
    try {
      const result = await updateContribution(teamId, sectionId, contributionText)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success('Contribution updated')
      setContributionEditing(null)
      router.refresh()
    } catch {
      toast.error('Failed to save contribution')
    } finally {
      setIsSaving(false)
    }
  }

  // ── Remove handler ─────────────────────────────────────────

  async function handleRemoveMember() {
    if (!removeTarget) return

    try {
      const result = await removeTeamMember(removeTarget.id, teamId, sectionId)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success('Member removed')
      setRemoveTarget(null)
      router.refresh()
    } catch {
      toast.error('Failed to remove member')
    }
  }

  async function handleLeaveTeam() {
    if (leaving) return
    setLeaving(true)
    try {
      const result = await leaveTeam(teamId, sectionId)
      if ('error' in result && result.error) {
        // The refusals (owner must transfer, team has a grade) come back as prose the student
        // can act on, so show them as-is rather than a generic failure.
        toast.error(result.error)
        return
      }
      toast.success(iAmLastMember ? 'You left. The team was removed.' : 'You left the team')
      setLeaveOpen(false)
      router.refresh()
    } catch {
      toast.error('Failed to leave the team')
    } finally {
      setLeaving(false)
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  function getInitials(name: string | null | undefined): string {
    if (!name) return '?'
    return name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
  }

  return (
    <div className="space-y-4">
      {/* Nudge owners to add a team description so outsiders know what the team is building */}
      {isOwner && !teamDescription && (
        <div className="border border-dashed border-border rounded-xl p-4 bg-muted/40 flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-muted border border-border flex items-center justify-center shrink-0">
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">What is your team building?</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Add a team description so classmates browsing teams can see what you&apos;re working on. Click &quot;Edit Team Info&quot; above to add one.
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Team Members</h2>
        {isOwner && (
          <Button size="sm" onClick={() => setAddDialogOpen(true)}>
            <UserPlus className="h-4 w-4 mr-1" />
            Invite Member
          </Button>
        )}
      </div>

      {members.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No team members"
          description="This team has no members yet."
        />
      ) : (
        <div className="space-y-3">
          {members.map((member) => {
            const profile = member.profile || {} as Partial<MemberProfile>
            const RoleIcon = roleIcons[member.role] || Shield
            const roleColor = roleColors[member.role] || roleColors.viewer
            const isCurrentUser = member.user_id === userId
            const isEditingThis = contributionEditing === member.id

            return (
              <div
                key={member.id}
                className={cn(
                  'border border-border rounded-xl p-4',
                  isCurrentUser && 'ring-1 ring-ring/30 bg-muted/40',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  {/* Avatar + Info */}
                  <div className="flex items-start gap-3 min-w-0">
                    <Avatar size="default">
                      {profile.avatar_url && (
                        <AvatarImage src={profile.avatar_url} alt={profile.name || ''} />
                      )}
                      <AvatarFallback>{getInitials(profile.name)}</AvatarFallback>
                    </Avatar>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">
                          {profile.name || profile.email || 'Unknown'}
                        </span>
                        <Badge className={cn('text-[10px] px-1.5 py-0 shrink-0', roleColor)}>
                          <RoleIcon className="h-2.5 w-2.5 mr-0.5" />
                          {MEMBER_ROLE_LABELS[member.role as keyof typeof MEMBER_ROLE_LABELS] || member.role}
                        </Badge>
                        {isCurrentUser && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
                            You
                          </Badge>
                        )}
                      </div>
                      {profile.email && (
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">
                          {profile.email}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  {isOwner && !isCurrentUser && member.role !== 'owner' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
                      onClick={() => setRemoveTarget(member)}
                    >
                      <UserMinus className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>

                {/* Contribution summary */}
                <div className="mt-3">
                  {isEditingThis && isCurrentUser ? (
                    <div className="space-y-2">
                      <Textarea
                        value={contributionText}
                        onChange={(e) => setContributionText(e.target.value)}
                        placeholder="Describe your contribution to the project..."
                        rows={3}
                        className="resize-none text-sm"
                        maxLength={2000}
                      />
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-muted-foreground">
                          {contributionText.length}/2000
                        </span>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setContributionEditing(null)}
                            disabled={isSaving}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            onClick={saveContribution}
                            disabled={isSaving}
                          >
                            <Save className="h-3.5 w-3.5 mr-1" />
                            {isSaving ? 'Saving...' : 'Save'}
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div>
                      {member.contribution_summary ? (
                        <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                          {member.contribution_summary}
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground/60 italic">
                          No contribution summary.
                        </p>
                      )}
                      {isCurrentUser && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-1 h-7 text-xs text-muted-foreground"
                          onClick={() => startEditContribution(member)}
                        >
                          {member.contribution_summary ? 'Edit contribution' : 'Add contribution'}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Sent Invitations (owners only) */}
      {isOwner && (
        <SentInvitationsSection
          sectionId={sectionId}
          teamId={teamId}
          refreshKey={inviteRefreshKey}
        />
      )}

      {/* Join Requests (owners only) */}
      {isOwner && (
        <JoinRequestsSection
          sectionId={sectionId}
          teamId={teamId}
        />
      )}

      {/* Add Member Dialog */}
      {isOwner && (
        <AddMemberDialog
          open={addDialogOpen}
          onOpenChange={setAddDialogOpen}
          sectionId={sectionId}
          projectId={project.id}
          teamId={teamId}
          onInviteSent={() => setInviteRefreshKey((k) => k + 1)}
        />
      )}

      {/* Remove Member Confirmation */}
      <AlertDialog open={!!removeTarget} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Team Member</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove{' '}
              <strong>{removeTarget?.profile?.name || 'this member'}</strong> from the team?
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
            variant="destructive"
              onClick={handleRemoveMember}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Leave team (#699). Only for someone actually in the team — a viewer has nothing to
          leave. Placed at the end of the tab, away from the per-member controls, so it reads as
          an action on yourself rather than another row's remove button. */}
      {isMember && (
        <div className="flex justify-end pt-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setLeaveOpen(true)}
          >
            <LogOut className="h-3.5 w-3.5" />
            Leave team
          </Button>
        </div>
      )}

      <AlertDialog open={leaveOpen} onOpenChange={(open) => !open && setLeaveOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{iAmLastMember ? 'Leave and remove the team?' : 'Leave this team?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {iAmLastMember ? (
                <>
                  You&apos;re the only one left, so the team goes with you — including its planning
                  doc, chat and anything else it holds. This can&apos;t be undone.
                </>
              ) : (
                <>
                  You&apos;ll be removed from <strong>{project.title}</strong>&apos;s team. Your
                  teammates keep the team and everything in it, and you can be invited back.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleLeaveTeam} disabled={leaving}>
              {iAmLastMember ? 'Leave and remove' : 'Leave team'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ── Add Member Dialog ───────────────────────────────────────────

interface AddMemberDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
  projectId: string
  teamId: string
  onInviteSent?: () => void
}

function AddMemberDialog({ open, onOpenChange, sectionId, projectId, teamId, onInviteSent }: AddMemberDialogProps) {
  const router = useRouter()
  const [students, setStudents] = useState<AvailableStudent[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Fetch available students when dialog opens
  useEffect(() => {
    if (!open) return
    setLoading(true)
    setSearch('')
    setSelectedId(null)
    setMessage('')
    /* setLoading(false) in a `finally`, plus a catch (#699 part 1). It used to sit inside the
       `then`, so a rejected action left the dialog on a bare spinner forever with a live
       search box and nothing to search. Browser QA could not reproduce the reported "search
       returns nothing", but did find this: it is the shape that would present as an empty,
       unresponsive invite list, and the first open after creating a team took over 4
       seconds, which is long enough to look broken. */
    getAvailableStudents(sectionId, projectId)
      .then((result) => {
        if (result.data) setStudents(result.data)
        else if (result.error) toast.error(result.error)
      })
      .catch(() => toast.error("Couldn't load your classmates. Please try again."))
      .finally(() => setLoading(false))
  }, [open, sectionId, projectId])

  const filtered = students.filter((s) => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      (s.name?.toLowerCase().includes(q)) ||
      (s.email?.toLowerCase().includes(q))
    )
  })

  function getInitials(name: string | null | undefined): string {
    if (!name) return '?'
    return name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2)
  }

  async function handleInvite() {
    if (!selectedId) {
      toast.error('Please select a student')
      return
    }

    setIsSubmitting(true)
    try {
      const result = await sendTeamInvitation(teamId, projectId, sectionId, selectedId, message)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      const student = students.find((s) => s.userId === selectedId)
      toast.success(`Invitation sent to ${student?.name || 'student'}`)
      setSelectedId(null)
      setMessage('')
      onOpenChange(false)
      onInviteSent?.()
      router.refresh()
    } catch {
      toast.error('Failed to send invitation')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Invite Team Member</DialogTitle>
          <DialogDescription>
            Select a classmate to invite to your team. They&apos;ll need to accept before joining.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Search input */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or email..."
              className="pl-9"
            />
          </div>

          {/* Student list */}
          <div className="border border-border rounded-xl max-h-[240px] overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-sm text-muted-foreground">
                  {students.length === 0 ? 'No available students' : 'No students match your search'}
                </p>
                <p className="text-xs text-muted-foreground/60 mt-1">
                  {students.length === 0 && 'All enrolled students are already in a team.'}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {filtered.map((s) => {
                  const isSelected = selectedId === s.userId
                  return (
                    <button
                      key={s.userId}
                      type="button"
                      onClick={() => setSelectedId(isSelected ? null : s.userId)}
                      className={cn(
                        'w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors',
                        isSelected
                          ? 'bg-foreground/5 ring-1 ring-inset ring-foreground/20'
                          : 'hover:bg-muted/50'
                      )}
                    >
                      <Avatar className="h-8 w-8 shrink-0">
                        <AvatarFallback className="text-xs">
                          {getInitials(s.name)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{s.name || 'Unknown'}</p>
                        <p className="text-xs text-muted-foreground truncate">{s.email}</p>
                      </div>
                      {isSelected && (
                        <Check className="h-4 w-4 text-foreground shrink-0" />
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Optional message */}
          {selectedId && (
            <div>
              <label className="text-sm font-medium">Message (optional)</label>
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Add a personal note to your invitation..."
                rows={2}
                className="mt-1 resize-none text-sm"
                maxLength={500}
              />
              <p className="text-[11px] text-muted-foreground mt-1">{message.length}/500</p>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button onClick={handleInvite} disabled={isSubmitting || !selectedId}>
              <Send className="h-3.5 w-3.5 mr-1.5" />
              {isSubmitting ? 'Sending...' : 'Send Invite'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Sent Invitations Section ────────────────────────────────────

interface SentInvitationsSectionProps {
  sectionId: string
  teamId: string
  refreshKey?: number
}

function SentInvitationsSection({ sectionId, teamId, refreshKey }: SentInvitationsSectionProps) {
  const router = useRouter()
  const [invitations, setInvitations] = useState<TeamInvitationWithProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null)

  const fetchInvitations = useCallback(async () => {
    const result = await getSentInvitations(teamId, sectionId)
    if (result.data) setInvitations(result.data)
    setLoading(false)
  }, [teamId, sectionId])

  useEffect(() => {
    fetchInvitations()
  }, [fetchInvitations, refreshKey])

  async function handleWithdraw(invitationId: string) {
    setWithdrawingId(invitationId)
    try {
      const result = await withdrawInvitation(invitationId, teamId, sectionId)
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success('Invitation withdrawn')
        router.refresh()
        fetchInvitations()
      }
    } catch {
      toast.error('Something went wrong')
    } finally {
      setWithdrawingId(null)
    }
  }

  function getInitials(name: string | null | undefined): string {
    if (!name) return '?'
    return name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2)
  }

  if (loading) return null
  if (invitations.length === 0) return null

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">Pending Invitations</h3>
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
          {invitations.length}
        </Badge>
      </div>

      <div className="space-y-2">
        {invitations.map((inv) => {
          const profile = inv.invited_profile
          const isWithdrawing = withdrawingId === inv.id

          return (
            <div
              key={inv.id}
              className="border rounded-xl p-3 bg-info-muted/40 border-info/20"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Avatar size="default">
                    {profile?.avatar_url && (
                      <AvatarImage src={profile.avatar_url} alt={profile?.name || ''} />
                    )}
                    <AvatarFallback>{getInitials(profile?.name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {profile?.name || profile?.email || 'Unknown student'}
                    </p>
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      Invited {new Date(inv.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </p>
                  </div>
                </div>

                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2.5 text-xs shrink-0"
                  onClick={() => handleWithdraw(inv.id)}
                  disabled={isWithdrawing}
                  title="Withdraw invitation"
                >
                  {isWithdrawing ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                  <span className="ml-1">Withdraw</span>
                </Button>
              </div>

              {inv.message && (
                <div className="mt-2 flex gap-1.5 pl-10">
                  <Mail className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                  <p className="text-xs text-muted-foreground italic">
                    &ldquo;{inv.message}&rdquo;
                  </p>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Join Requests Section ────────────────────────────────────────

interface JoinRequestsSectionProps {
  sectionId: string
  teamId: string
}

function JoinRequestsSection({ sectionId, teamId }: JoinRequestsSectionProps) {
  const router = useRouter()
  const [requests, setRequests] = useState<JoinRequestWithProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [respondingId, setRespondingId] = useState<string | null>(null)

  const fetchRequests = useCallback(async () => {
    const result = await getTeamJoinRequests(teamId, sectionId)
    if (result.data) setRequests(result.data)
    setLoading(false)
  }, [teamId, sectionId])

  useEffect(() => {
    fetchRequests()
  }, [fetchRequests])

  async function handleRespond(requestId: string, accept: boolean) {
    setRespondingId(requestId)
    try {
      const result = await respondToJoinRequest(requestId, teamId, sectionId, accept)
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success(accept ? 'Member added to team' : 'Request declined')
        router.refresh()
        fetchRequests()
      }
    } catch {
      toast.error('Something went wrong')
    } finally {
      setRespondingId(null)
    }
  }

  if (loading) return null
  if (requests.length === 0) return null

  function getInitials(name: string | null | undefined): string {
    if (!name) return '?'
    return name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">Join Requests</h3>
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
          {requests.length}
        </Badge>
      </div>

      <div className="space-y-2">
        {requests.map((req) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const profile = (Array.isArray(req.profiles) ? req.profiles[0] : req.profiles) as any
          const isResponding = respondingId === req.id

          return (
            <div
              key={req.id}
              className="border rounded-xl p-3 bg-warning-muted/40 border-warning/20"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Avatar size="default">
                    {profile?.avatar_url && (
                      <AvatarImage src={profile.avatar_url} alt={profile?.name || ''} />
                    )}
                    <AvatarFallback>{getInitials(profile?.name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {profile?.name || profile?.email || 'Unknown student'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Requested {new Date(req.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => handleRespond(req.id, false)}
                    disabled={isResponding}
                  >
                    {isResponding ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 px-3 text-xs gap-1"
                    onClick={() => handleRespond(req.id, true)}
                    disabled={isResponding}
                  >
                    {isResponding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    Accept
                  </Button>
                </div>
              </div>

              {req.message && (
                <div className="mt-2 flex gap-1.5 pl-10">
                  <MessageSquare className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                  <p className="text-xs text-muted-foreground italic">
                    &ldquo;{req.message}&rdquo;
                  </p>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
