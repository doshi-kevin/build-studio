// Client view for /super-admin/team. Lists every super_admin with the
// platform owner clearly marked, supports invite (under cap), resend +
// revoke for pending invites, and transfer-ownership for the platform
// owner. Mirrors AdminTeamView but adds the owner concept.

'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { UserPlus, Crown, ArrowRightLeft } from 'lucide-react'
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
  inviteSuperAdmin,
  resendSuperAdminInvite,
  revokeSuperAdmin,
  transferPlatformOwnership,
} from '@/app/(dashboard)/super-admin/team/actions'

export interface SuperAdminRow {
  id: string
  email: string
  name: string | null
  invite_status: string | null
  invited_at: string | null
  last_login_at: string | null
  is_platform_owner: boolean
  onboarding_completed: boolean | null
}

interface Props {
  superAdmins: SuperAdminRow[]
  currentUserId: string
  currentUserIsOwner: boolean
  cap: number
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/* "Pending" only when the user genuinely hasn't accepted yet — i.e.
 * invite_status is 'pending' AND onboarding hasn't completed. Defends
 * against stale invite_status rows where a user completed onboarding
 * but the status field was never updated. */
function StatusPill({
  status,
  onboardingCompleted,
}: {
  status: string | null
  onboardingCompleted: boolean | null
}) {
  const isPending = status === 'pending' && !onboardingCompleted
  const label = isPending ? 'Pending' : 'Active'
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-foreground">
      {label}
    </span>
  )
}

function OwnerBadge() {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-foreground/30 bg-foreground/5 px-2 py-0.5 text-[11px] font-medium text-foreground">
      <Crown className="h-3 w-3 shrink-0" />
      Platform Owner
    </span>
  )
}

export function SuperAdminTeamView({ superAdmins, currentUserId, currentUserIsOwner, cap }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [revokeTarget, setRevokeTarget] = useState<SuperAdminRow | null>(null)
  const [transferTarget, setTransferTarget] = useState<SuperAdminRow | null>(null)

  const atCap = superAdmins.length >= cap
  const remaining = Math.max(0, cap - superAdmins.length)

  function onInvite(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !email.trim()) {
      toast.error('Name and email are required')
      return
    }
    startTransition(async () => {
      const result = await inviteSuperAdmin({ name: name.trim(), email: email.trim() })
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
      const result = await resendSuperAdminInvite(adminId)
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
      const result = await revokeSuperAdmin(target.id)
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      toast.success(`Revoked ${target.email}`)
      setRevokeTarget(null)
      router.refresh()
    })
  }

  function onConfirmTransfer() {
    if (!transferTarget) return
    const target = transferTarget
    startTransition(async () => {
      const result = await transferPlatformOwnership(target.id)
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      toast.success(`Platform ownership transferred to ${target.email}`)
      setTransferTarget(null)
      router.refresh()
    })
  }

  return (
    <div className="space-y-6">
      {/* Count + invite form */}
      <section className="rounded-2xl border border-border bg-background p-6">
        <div className="flex items-center justify-between gap-4 mb-5">
          <div>
            <h2 className="font-[family-name:var(--font-instrument-serif)] text-xl">Invite a super admin</h2>
            <p className="text-[13px] text-muted-foreground mt-1 tabular-nums">
              {superAdmins.length} of {cap} super admins ·{' '}
              {atCap ? 'cap reached' : `${remaining} ${remaining === 1 ? 'slot' : 'slots'} remaining`}
            </p>
          </div>
        </div>

        {atCap ? (
          <p className="text-[13px] text-muted-foreground bg-muted/30 rounded-xl px-4 py-3 border border-border">
            You&apos;ve reached the maximum of {cap} super admins. Revoke a pending invite below to free a slot.
          </p>
        ) : (
          <form
            onSubmit={onInvite}
            className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end"
          >
            <div className="space-y-1.5">
              <Label htmlFor="superName">Name</Label>
              <Input
                id="superName"
                placeholder="Jane Doe"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isPending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="superEmail">Email</Label>
              <Input
                id="superEmail"
                type="email"
                placeholder="teammate@scholera-inc.com"
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

      {/* Super admin list */}
      <section className="rounded-2xl border border-border bg-background overflow-hidden">
        <header className="px-4 py-3 border-b border-border bg-muted/30">
          <h2 className="text-[11px] tracking-[0.2em] uppercase font-semibold text-muted-foreground">
            Super admins
          </h2>
        </header>
        {superAdmins.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm text-muted-foreground">No super admins yet — invite one above.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-2 font-semibold">Name</th>
                  <th className="text-left px-4 py-2 font-semibold">Email</th>
                  <th className="text-left px-4 py-2 font-semibold">Role</th>
                  <th className="text-left px-4 py-2 font-semibold">Status</th>
                  <th className="text-left px-4 py-2 font-semibold">Invited</th>
                  <th className="text-left px-4 py-2 font-semibold">Last login</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {superAdmins.map((row) => {
                  const isSelf = row.id === currentUserId
                  const isPendingInvite = row.invite_status === 'pending'
                  const isAccepted = row.invite_status !== 'pending'
                  const isOwner = row.is_platform_owner
                  const displayName = row.name || <span className="text-muted-foreground">—</span>
                  /* Owner cannot be revoked — must transfer first.
                   * Self-revoke is also blocked at the action layer. */
                  const canRevoke = !isOwner && !isSelf
                  /* Transfer ownership: only the current owner can initiate,
                   * and only TO another already-accepted super_admin. */
                  const canTransferTo = currentUserIsOwner && !isOwner && !isSelf && isAccepted
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
                      <td className="px-4 py-2">
                        {isOwner ? <OwnerBadge /> : <span className="text-[12px] text-muted-foreground">Super admin</span>}
                      </td>
                      <td className="px-4 py-2"><StatusPill status={row.invite_status} onboardingCompleted={row.onboarding_completed} /></td>
                      <td className="px-4 py-2 text-muted-foreground">{formatDate(row.invited_at)}</td>
                      <td className="px-4 py-2 text-muted-foreground">{formatDate(row.last_login_at)}</td>
                      <td className="px-4 py-2 text-right">
                        <div className="flex flex-wrap justify-end gap-2">
                          {isPendingInvite && !isSelf && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={isPending}
                              onClick={() => onResend(row.id, row.email)}
                            >
                              Resend
                            </Button>
                          )}
                          {canTransferTo && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={isPending}
                              onClick={() => setTransferTarget(row)}
                            >
                              <ArrowRightLeft className="h-3.5 w-3.5 mr-1.5" />
                              Make owner
                            </Button>
                          )}
                          {canRevoke && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={isPending}
                              onClick={() => setRevokeTarget(row)}
                            >
                              Revoke
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Revoke confirmation */}
      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revokeTarget?.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              Their super admin access will be removed and their account will be deleted. The
              email address will be free for re-invitation. This frees a slot under the{' '}
              <span className="font-medium text-foreground">{cap}-super-admin</span> cap.
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
              {isPending ? 'Revoking…' : 'Revoke access'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Transfer ownership confirmation */}
      <AlertDialog open={!!transferTarget} onOpenChange={(open) => !open && setTransferTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Transfer platform ownership to {transferTarget?.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              You will be demoted to a regular super admin in the same step.{' '}
              <span className="font-medium text-foreground">{transferTarget?.name || transferTarget?.email}</span>{' '}
              will become the new platform owner. Only the new owner can transfer ownership again, so
              make sure you trust them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={(event) => {
                event.preventDefault()
                onConfirmTransfer()
              }}
            >
              {isPending ? 'Transferring…' : 'Transfer ownership'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
