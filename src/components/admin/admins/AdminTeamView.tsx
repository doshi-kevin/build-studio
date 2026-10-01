// Client view for /admin/admins. Shows the current admin list (pending +
// accepted), an invite form when under cap, and Resend / Revoke for pending
// invites. Reuses the editorial monochrome theme + shadcn primitives.

'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
  inviteInstitutionAdmin,
  resendCoAdminInvite,
  revokeCoAdminInvite,
} from '@/app/(dashboard)/admin/admins/actions'

interface AdminRow {
  id: string
  email: string
  name: string | null
  invite_status: string | null
  invited_at: string | null
  last_login_at: string | null
  onboarding_completed: boolean | null
}

interface Props {
  admins: AdminRow[]
  currentUserId: string
  cap: number
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function StatusPill({ status }: { status: string | null }) {
  const isPending = status === 'pending'
  const label = isPending ? 'Pending' : 'Active'
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-foreground">
      {label}
    </span>
  )
}

export function AdminTeamView({ admins, currentUserId, cap }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [revokeTarget, setRevokeTarget] = useState<AdminRow | null>(null)

  const atCap = admins.length >= cap
  const remaining = Math.max(0, cap - admins.length)

  function onInvite(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !email.trim()) {
      toast.error('Name and email are required')
      return
    }
    startTransition(async () => {
      const result = await inviteInstitutionAdmin({ name: name.trim(), email: email.trim() })
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      toast.success(`Invite sent to ${email.trim()}`)
      setName('')
      setEmail('')
      router.refresh()
    })
  }

  function onResend(adminId: string, adminEmail: string) {
    startTransition(async () => {
      const result = await resendCoAdminInvite(adminId)
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      toast.success(`Invite resent to ${adminEmail}`)
      router.refresh()
    })
  }

  function onConfirmRevoke() {
    if (!revokeTarget) return
    const target = revokeTarget
    startTransition(async () => {
      const result = await revokeCoAdminInvite(target.id)
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      toast.success(`Invite revoked for ${target.email}`)
      setRevokeTarget(null)
      router.refresh()
    })
  }

  return (
    <div className="space-y-6">
      {/* Count + invite form */}
      <section className="rounded-2xl border border-border bg-background p-6">
        <div className="flex items-center justify-between gap-4 mb-5">
          <div>
            <h2 className="font-[family-name:var(--font-instrument-serif)] text-xl">Invite an administrator</h2>
            <p className="text-[13px] text-muted-foreground mt-1 tabular-nums">
              {admins.length} of {cap} {cap === 1 ? 'admin' : 'admins'} ·{' '}
              {atCap ? 'cap reached' : `${remaining} ${remaining === 1 ? 'slot' : 'slots'} remaining`}
            </p>
          </div>
        </div>

        {atCap ? (
          <p className="text-[13px] text-muted-foreground bg-muted/30 rounded-xl px-4 py-3 border border-border">
            You&apos;ve reached the maximum of {cap} administrators. Revoke a pending invite below to free a slot.
          </p>
        ) : (
          <form
            onSubmit={onInvite}
            className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end"
          >
            <div className="space-y-1.5">
              <Label htmlFor="adminName">Name</Label>
              <Input
                id="adminName"
                placeholder="Jane Doe"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isPending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="adminEmail">Email</Label>
              <Input
                id="adminEmail"
                type="email"
                placeholder="admin@example.edu"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isPending}
              />
            </div>
            <Button type="submit" disabled={isPending}>
              <UserPlus className="h-4 w-4 mr-2" />
              {isPending ? 'Sending…' : 'Invite'}
            </Button>
          </form>
        )}
      </section>

      {/* Admin list */}
      <section className="rounded-2xl border border-border bg-background overflow-hidden">
        <header className="px-4 py-3 border-b border-border bg-muted/30">
          <h2 className="text-[11px] tracking-[0.2em] uppercase font-semibold text-muted-foreground">
            Current administrators
          </h2>
        </header>
        {admins.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm text-muted-foreground">No administrators yet — invite one above.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-2 font-semibold">Name</th>
                  <th className="text-left px-4 py-2 font-semibold">Email</th>
                  <th className="text-left px-4 py-2 font-semibold">Status</th>
                  <th className="text-left px-4 py-2 font-semibold">Invited</th>
                  <th className="text-left px-4 py-2 font-semibold">Last login</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {admins.map((row) => {
                  const isSelf = row.id === currentUserId
                  const isPendingInvite = row.invite_status === 'pending'
                  const displayName = row.name || <span className="text-muted-foreground">—</span>
                  return (
                    <tr key={row.id} className="border-t border-border hover:bg-muted/20">
                      <td className="px-4 py-2">
                        {displayName}
                        {isSelf && <span className="ml-2 text-[10px] text-muted-foreground/70 italic">(you)</span>}
                      </td>
                      <td
                        className="px-4 py-2 font-mono text-[12px] text-muted-foreground truncate max-w-[260px]"
                        title={row.email}
                      >
                        {row.email}
                      </td>
                      <td className="px-4 py-2"><StatusPill status={row.invite_status} /></td>
                      <td className="px-4 py-2 text-muted-foreground">{formatDate(row.invited_at)}</td>
                      <td className="px-4 py-2 text-muted-foreground">{formatDate(row.last_login_at)}</td>
                      <td className="px-4 py-2 text-right">
                        {isPendingInvite && !isSelf && (
                          <div className="inline-flex gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={isPending}
                              onClick={() => onResend(row.id, row.email)}
                            >
                              Resend
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={isPending}
                              onClick={() => setRevokeTarget(row)}
                            >
                              Revoke
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke invite for {revokeTarget?.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              The pending invite will be deleted and the temporary password will stop working. The
              email address will be free for re-invitation. This frees a slot under your{' '}
              <span className="font-medium text-foreground">{cap}-admin</span> cap.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={(event) => {
                event.preventDefault()
                onConfirmRevoke()
              }}
            >
              {isPending ? 'Revoking…' : 'Revoke invite'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
