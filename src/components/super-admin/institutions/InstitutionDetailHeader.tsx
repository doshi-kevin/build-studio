// Header for the Institution Detail page: name, slug, monochrome status pill,
// summary stats, and a Suspend / Reactivate control. Suspend goes through an
// AlertDialog because it logs out every member of the tenant globally — too
// destructive for a native browser confirm.

'use client'

import { useState, useTransition, useOptimistic } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { setInstitutionStatus } from '@/app/(dashboard)/super-admin/institutions/actions'
import { Button } from '@/components/ui/button'
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
import { StatusPill } from './StatusPill'

interface Institution {
  id: string
  name: string
  slug: string
  status: 'active' | 'suspended' | 'archived' | string
  created_at: string
}

interface Props {
  institution: Institution
  totalUsers: number
  adminCount: number
}

export function InstitutionDetailHeader({ institution, totalUsers, adminCount }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [confirmOpen, setConfirmOpen] = useState(false)
  /* Optimistic status flips the pill the instant the user confirms; if the
   * server action errors we toast and let router.refresh() restore truth. */
  const [optimisticStatus, setOptimisticStatus] = useOptimistic(institution.status)
  const isSuspended = optimisticStatus === 'suspended'

  function applyStatus(next: 'active' | 'suspended') {
    startTransition(async () => {
      setOptimisticStatus(next)
      const result = await setInstitutionStatus(institution.id, next)
      if ('error' in result) {
        toast.error(result.error)
        router.refresh()
        return
      }
      toast.success(next === 'suspended' ? `${institution.name} suspended.` : `${institution.name} reactivated.`)
      router.refresh()
    })
  }

  function handleClick() {
    if (isSuspended) {
      applyStatus('active')
    } else {
      setConfirmOpen(true)
    }
  }

  return (
    <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
      <div>
        <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.2em] uppercase mb-2">
          Platform · Institution
        </p>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-[36px] tracking-tight leading-none">
          {institution.name}
        </h1>
        <div className="flex items-center gap-3 mt-3">
          <code className="text-[12px] text-muted-foreground">{institution.slug}</code>
          <span className="text-muted-foreground/50">·</span>
          <StatusPill status={optimisticStatus} />
          <span className="text-muted-foreground/50">·</span>
          <span className="text-[12px] text-muted-foreground tabular-nums">
            {totalUsers} {totalUsers === 1 ? 'user' : 'users'}
          </span>
          <span className="text-muted-foreground/50">·</span>
          <span className="text-[12px] text-muted-foreground tabular-nums">
            {adminCount} {adminCount === 1 ? 'admin' : 'admins'}
          </span>
        </div>
      </div>

      <Button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        variant={isSuspended ? 'default' : 'outline'}
      >
        {isPending ? 'Working…' : isSuspended ? 'Reactivate' : 'Suspend institution'}
      </Button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Suspend {institution.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              All <span className="font-medium text-foreground">{totalUsers}</span> members of this
              institution will be signed out immediately and blocked from logging in until you
              reactivate. Their data is preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={(event) => {
                event.preventDefault()
                applyStatus('suspended')
                setConfirmOpen(false)
              }}
            >
              {isPending ? 'Suspending…' : 'Suspend institution'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
