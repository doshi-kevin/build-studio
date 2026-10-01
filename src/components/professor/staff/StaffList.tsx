// Unified roster of teaching staff and requests — active members, pending
// candidates, and rejected requests render as a single sorted grid so the
// professor sees the full TA/Grader picture without switching tabs.
'use client'

import { useTransition } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Mail, Clock, X, CheckCircle2, Hourglass, XCircle, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { STAFF_ROLE_LABELS } from '@/lib/validations/section-staff'
import { withdrawStaffRequest } from '@/app/(dashboard)/professor/courses/[sectionId]/staff/actions'

export type StaffEntryStatus = 'active' | 'pending' | 'rejected'

export interface StaffEntry {
  key: string
  name: string
  email: string
  role: 'ta' | 'grader'
  status: StaffEntryStatus
  endsAt: string | null
  message?: string | null
  reviewNote?: string | null
  invitePending?: boolean
  requestId?: string
  /** Profile id of an onboarded staff member — present only once the
   *  candidate has an account, which is what makes a DM reachable. */
  userId?: string | null
}

interface StaffListProps {
  entries: StaffEntry[]
  sectionId: string
}

function formatEnds(iso: string | null): string | null {
  if (!iso) return null
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function initials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .filter(Boolean)
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

const STATUS_META: Record<
  StaffEntryStatus,
  { label: string; icon: typeof CheckCircle2; className: string; avatarClassName: string }
> = {
  active: {
    label: 'Active',
    icon: CheckCircle2,
    className: 'border-success/30 bg-success-muted text-success-muted-foreground',
    avatarClassName: 'border-success/30 bg-success-muted text-success-muted-foreground',
  },
  pending: {
    label: 'Pending approval',
    icon: Hourglass,
    className: 'border-warning/30 bg-warning-muted text-warning-muted-foreground',
    avatarClassName: 'border-warning/30 bg-warning-muted text-warning-muted-foreground',
  },
  rejected: {
    label: 'Rejected',
    icon: XCircle,
    className: 'border-border bg-muted text-muted-foreground',
    avatarClassName: 'border-border bg-muted text-muted-foreground',
  },
}

export function StaffList({ entries, sectionId }: StaffListProps) {
  const [isPending, startTransition] = useTransition()

  function handleWithdraw(requestId: string) {
    if (!confirm('Withdraw this request? The admin will no longer see it in their queue.')) return
    startTransition(async () => {
      const res = await withdrawStaffRequest(requestId, sectionId)
      if (res.error) {
        toast.error(res.error)
      } else {
        toast.success('Request withdrawn')
      }
    })
  }

  return (
    /* No entrance animation, deliberately. A staff directory is a lookup
       surface, not a reveal, and the frequency rule in src/lib/motion.ts gives
       a directory nothing. */
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {entries.map((entry) => {
        const meta = STATUS_META[entry.status]
        const StatusIcon = meta.icon
        const endsLabel = formatEnds(entry.endsAt)
        const canWithdraw = entry.status === 'pending' && entry.requestId
        // A DM needs an account on the other end: only active staff have one.
        const canMessage = entry.status === 'active' && Boolean(entry.userId)
        const displayName = entry.name || entry.email || 'Unknown'

        return (
          <div key={entry.key}>
            <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 transition duration-200 ease-out hover:border-ring/40 hover:shadow-sm">
              <div
                className={cn(
                  'flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-sm font-semibold',
                  meta.avatarClassName,
                )}
              >
                {initials(displayName)}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">{displayName}</h3>
                  {canMessage && (
                    <Button
                      asChild
                      variant="ghost"
                      size="xs"
                      className="-mr-1 -mt-1 shrink-0 text-muted-foreground"
                    >
                      <Link
                        href={`/professor/courses/${sectionId}/discussions?dm=${entry.userId}`}
                        title={`Send ${displayName} a direct message`}
                      >
                        <MessageSquare className="h-3 w-3" aria-hidden="true" />
                        Message
                      </Link>
                    </Button>
                  )}
                  {canWithdraw && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={isPending}
                      onClick={() => handleWithdraw(entry.requestId!)}
                      className="-mr-1 -mt-1 shrink-0 text-muted-foreground"
                      title="Withdraw this pending request"
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                      Withdraw
                    </Button>
                  )}
                </div>

                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge
                    variant={entry.role === 'ta' ? 'secondary' : 'outline'}
                    className="uppercase tracking-wider"
                  >
                    {STAFF_ROLE_LABELS[entry.role]}
                  </Badge>
                  <Badge variant="outline" className={cn('gap-1', meta.className)}>
                    <StatusIcon className="h-3 w-3" />
                    {meta.label}
                  </Badge>
                  {entry.invitePending && entry.status === 'active' && (
                    <Badge variant="outline" className="border-warning/30 bg-warning-muted text-warning-muted-foreground">
                      Invite pending
                    </Badge>
                  )}
                </div>

                {entry.email && (
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Mail className="h-3 w-3 shrink-0" />
                    <span className="truncate">{entry.email}</span>
                  </div>
                )}
                {endsLabel && (
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3 shrink-0" />
                    {entry.status === 'active' ? 'Access ends' : 'Access through'} {endsLabel}
                  </div>
                )}
                {entry.message && entry.status !== 'rejected' && (
                  <p className="mt-2 line-clamp-2 text-xs italic text-muted-foreground">
                    &ldquo;{entry.message}&rdquo;
                  </p>
                )}
                {entry.status === 'rejected' && entry.reviewNote && (
                  <div className="mt-2 rounded-xl border border-border bg-muted px-3 py-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Admin note
                    </p>
                    <p className="mt-0.5 text-xs text-foreground">{entry.reviewNote}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
