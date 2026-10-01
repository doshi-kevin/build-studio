/**
 * ProfessorCardGrid — rich card grid for the admin Professors landing page.
 *
 * Replaces the old ProfessorTable with a more visual, scannable layout.
 * Each card shows: name, email, department, position, status.
 * Clicking a card navigates to /admin/professors/[id] (full detail page).
 *
 * Toolbar provides:
 * - Client-side search (filters by name, email, or department)
 * - Status filter
 * - "Invite Professor" button → CreateProfessorDialog
 *
 * Per-card menu: View Details (link to detail page) and Delete.
 *
 * Type: Client Component
 */
'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import {
  Users,
  Building2,
  Plus,
  Search,
  MoreHorizontal,
  Eye,
  Trash2,
  Mail,
  Ban,
  Send,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CreateProfessorDialog } from '@/components/admin/professors/CreateProfessorDialog'
import { DeleteProfessorDialog } from '@/components/admin/professors/DeleteProfessorDialog'
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
  POSITION_LABELS,
  INVITE_STATUS_LABELS as SHARED_INVITE_LABELS,
  INVITE_STATUS_TOOLTIPS,
  type Position,
} from '@/lib/validations/professor'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { revokeProfessorInvite, resendProfessorInvite } from '@/app/(dashboard)/admin/professors/actions'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  inactive: 'Inactive',
  on_leave: 'On Leave',
}

/* Invite-status labels are shared with the table + detail page so all admin
   surfaces stay in lockstep. */
const INVITE_STATUS_LABELS = SHARED_INVITE_LABELS

interface Department {
  id: string
  name: string
  code: string
}

interface Professor {
  id: string
  email: string
  name: string | null
  first_name: string | null
  last_name: string | null
  phone: string | null
  status: string
  primary_department: { id: string; name: string; code: string } | null
  position: string | null
  faculty_status: string | null
  invite_status: string
  department_count: number
}

interface ProfessorCardGridProps {
  professors: Professor[]
  departments: Department[]
}

export function ProfessorCardGrid({ professors, departments }: ProfessorCardGridProps) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string
    name: string
    email: string
  } | null>(null)
  /* Revoking frees the email by deleting the auth user, which cascades the
     profile away — so it is irreversible and the person leaves the console
     entirely (#723). That needs a confirm; it used to fire straight off the
     menu item. */
  const [revokeTarget, setRevokeTarget] = useState<{
    id: string
    name: string
    email: string
  } | null>(null)
  const [revoking, setRevoking] = useState(false)
  /* Guards against a double resend — each resend rotates the temp password and
   * invalidates the previous one, so a second click would silently break the
   * just-sent invite. Tracks which professor is mid-resend. */
  const [resendingId, setResendingId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    return professors.filter((prof) => {
      const searchLower = search.toLowerCase()
      const matchSearch =
        search === '' ||
        (prof.name || '').toLowerCase().includes(searchLower) ||
        prof.email.toLowerCase().includes(searchLower) ||
        (prof.primary_department?.name || '').toLowerCase().includes(searchLower)
      const matchStatus =
        statusFilter === 'all' ||
        statusFilter === prof.faculty_status ||
        statusFilter === prof.invite_status
      return matchSearch && matchStatus
    })
  }, [professors, search, statusFilter])

  const getDisplayName = (prof: Professor) =>
    prof.name || `${prof.first_name || ''} ${prof.last_name || ''}`.trim() || prof.email

  const getInitials = (prof: Professor) => {
    const name = prof.name || `${prof.first_name || ''} ${prof.last_name || ''}`.trim()
    if (!name) return prof.email[0].toUpperCase()
    return name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
  }

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
        <div className="flex flex-1 gap-3">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search professors..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="pending">Pending Invite</SelectItem>
              <SelectItem value="accepted">Onboarding</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
              <SelectItem value="on_leave">On Leave</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Invite Professor
        </Button>
      </div>

      {/* Summary line */}
      <p className="text-sm text-muted-foreground">
        {filtered.length} {filtered.length === 1 ? 'professor' : 'professors'}
        {search && ` matching "${search}"`}
      </p>

      {/* Empty state */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center text-muted-foreground gap-3 rounded-xl border border-dashed">
          <Users className="w-8 h-8" />
          <p className="text-sm font-medium">
            {professors.length === 0
              ? 'No professors yet. Click "Invite Professor" to add one.'
              : 'No professors match your search.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((prof) => (
            <div
              key={prof.id}
              className="group relative rounded-xl border border-border bg-card hover:border-foreground/30 hover:shadow-sm transition-[border-color,box-shadow]"
            >
              {/* Menu overlay */}
              <div className="absolute top-3 right-3 z-10">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={(e) => e.preventDefault()}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                      <span className="sr-only">Actions</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {prof.invite_status === 'active' && (
                      <DropdownMenuItem asChild>
                        <Link href={`/admin/professors/${prof.id}`}>
                          <Eye className="h-4 w-4 mr-2" />
                          View Details
                        </Link>
                      </DropdownMenuItem>
                    )}
                    {prof.invite_status === 'pending' && (
                      <>
                        <DropdownMenuItem
                          disabled={resendingId === prof.id}
                          onClick={async () => {
                            if (resendingId) return
                            setResendingId(prof.id)
                            try {
                              const result = await resendProfessorInvite(prof.id)
                              if ('error' in result && result.error) {
                                toast.error(result.error)
                              } else if ('emailWarning' in result && result.emailWarning) {
                                toast.warning(result.emailWarning, { duration: 8000 })
                              } else {
                                toast.success(`Invite resent to ${getDisplayName(prof)}`)
                              }
                            } finally {
                              setResendingId(null)
                            }
                          }}
                        >
                          <Send className="h-4 w-4 mr-2" />
                          {resendingId === prof.id ? 'Sending…' : 'Resend Invite'}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-warning-muted-foreground focus:text-warning-muted-foreground"
                          onClick={() =>
                            setRevokeTarget({
                              id: prof.id,
                              name: getDisplayName(prof),
                              email: prof.email,
                            })
                          }
                        >
                          <Ban className="h-4 w-4 mr-2" />
                          Revoke Invite
                        </DropdownMenuItem>
                      </>
                    )}
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() =>
                        setDeleteTarget({
                          id: prof.id,
                          name: getDisplayName(prof),
                          email: prof.email,
                        })
                      }
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {/* Card body */}
              {(() => {
                const isPending = prof.invite_status === 'pending' || prof.invite_status === 'revoked'
                const Wrapper = isPending ? 'div' : Link
                const wrapperProps = isPending
                  ? { className: 'block p-5 pr-10' }
                  : { href: `/admin/professors/${prof.id}`, className: 'block p-5 pr-10' }

                return (
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  <Wrapper {...(wrapperProps as any)}>
                    {/* Avatar + Name */}
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-10 h-10 rounded-full border border-border bg-muted/50 text-foreground flex items-center justify-center text-sm font-semibold shrink-0">
                        {getInitials(prof)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium leading-snug line-clamp-1">
                          {getDisplayName(prof)}
                        </p>
                        <p className="text-xs text-muted-foreground line-clamp-1 flex items-center gap-1">
                          <Mail className="w-3 h-3 shrink-0" />
                          {prof.email}
                        </p>
                      </div>
                    </div>

                    {/* Position */}
                    {prof.position && (
                      <p className="text-xs text-muted-foreground mb-1">
                        {POSITION_LABELS[prof.position as Position] || prof.position}
                      </p>
                    )}

                    {/* Status badge — invite_status takes priority for non-active professors */}
                    <div className="flex items-center gap-2 mb-3">
                      {prof.invite_status !== 'active' ? (
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span
                                className={cn(
                                  'text-[11px] font-medium px-2 py-0.5 rounded-full border cursor-help',
                                  prof.invite_status === 'pending'
                                    ? 'bg-foreground/10 text-foreground border-border'
                                    : prof.invite_status === 'accepted'
                                      ? 'bg-foreground/10 text-foreground border-border'
                                      : 'bg-destructive/10 text-destructive border-destructive/20'
                                )}
                              >
                                {INVITE_STATUS_LABELS[prof.invite_status] || prof.invite_status}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <p>{INVITE_STATUS_TOOLTIPS[prof.invite_status] || ''}</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <span
                          className={cn(
                            'text-[11px] font-medium px-2 py-0.5 rounded-full border capitalize',
                            prof.faculty_status === 'active'
                              ? 'bg-success-muted text-success-muted-foreground border-success/30'
                              : prof.faculty_status === 'on_leave'
                                ? 'bg-warning-muted text-warning-muted-foreground border-warning/30'
                                : 'bg-muted text-muted-foreground border-border'
                          )}
                        >
                          {STATUS_LABELS[prof.faculty_status || ''] || prof.faculty_status || 'Unknown'}
                        </span>
                      )}
                    </div>

                    {/* Stats row */}
                    <div className="flex items-center gap-3 pt-3 border-t border-border/50">
                      <StatPill
                        icon={<Building2 className="w-3 h-3" />}
                        value={prof.department_count}
                        label={prof.department_count === 1 ? 'department' : 'departments'}
                      />
                      {prof.primary_department && (
                        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <span className="font-mono font-medium text-foreground">
                            {prof.primary_department.code}
                          </span>
                          <span className="line-clamp-1">{prof.primary_department.name}</span>
                        </div>
                      )}
                    </div>
                  </Wrapper>
                )
              })()}
            </div>
          ))}
        </div>
      )}

      <CreateProfessorDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        departments={departments}
      />
      <DeleteProfessorDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        professor={deleteTarget}
      />
      <AlertDialog
        open={!!revokeTarget}
        onOpenChange={(open) => {
          if (!open && !revoking) setRevokeTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this invite?</AlertDialogTitle>
            <AlertDialogDescription>
              {revokeTarget?.name} will be removed from the console entirely and{' '}
              {revokeTarget?.email}{' '}
              becomes available to invite again. This can&apos;t be undone — the record is
              kept only in the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>Keep the invite</AlertDialogCancel>
            {/* destructive, not the default primary: this deletes the auth user and
                cascades the profile away. AlertDialogAction defaults to variant
                "default", which rendered the irreversible action as the visually
                recommended one while "Keep the invite" sat in muted outline —
                the opposite of what the copy says. */}
            <AlertDialogAction
              variant="destructive"
              disabled={revoking}
              onClick={async (e) => {
                /* Keep the dialog mounted while the action runs so the button can
                   show its pending state instead of the row vanishing under a
                   dialog that already closed. */
                e.preventDefault()
                if (!revokeTarget) return
                setRevoking(true)
                const result = await revokeProfessorInvite(revokeTarget.id)
                setRevoking(false)
                if ('error' in result && result.error) {
                  toast.error(result.error)
                } else {
                  toast.success(`Invite revoked — ${revokeTarget.email} is free to reuse`)
                  setRevokeTarget(null)
                }
              }}
            >
              {revoking ? 'Revoking…' : 'Revoke invite'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function StatPill({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
      {icon}
      <span className="font-medium text-foreground">{value}</span>
      <span>{label}</span>
    </div>
  )
}
