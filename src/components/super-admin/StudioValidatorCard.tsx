'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
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
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { ValidatorPanel } from '@/lib/studio/validator/service'
import { queueRevalidationAgain, raiseValidatorRuleset } from '@/app/(dashboard)/super-admin/ai-controls/studio-actions'

/** The validator's accepted checks: raise the minimum to this code's, and see the re-checks it started. */
export function StudioValidatorCard({ panel }: { panel: ValidatorPanel }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [pending, startTransition] = useTransition()
  const canRaise = panel.minAccepted !== null && panel.minAccepted < panel.codeRuleset
  // The database raises one step at a time.
  const next = panel.minAccepted === null ? panel.codeRuleset : Math.min(panel.minAccepted + 1, panel.codeRuleset)

  const requeue = () =>
    startTransition(async () => {
      const r = await queueRevalidationAgain()
      if ('error' in r) toast.error(r.error)
      else toast.success('Re-checks have started.')
      router.refresh()
    })

  const raise = () =>
    startTransition(async () => {
      const result = await raiseValidatorRuleset()
      setConfirming(false)
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      if (result.queued === null) {
        toast.error('Accepted checks raised, but the re-checks couldn’t all be queued.', { duration: 15000, action: { label: 'Queue them again', onClick: requeue } })
      } else toast.success('Accepted checks raised. Re-checks have started.')
      router.refresh()
    })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Studio validator</CardTitle>
        <CardDescription>
          Raising the accepted checks makes every tool earn a pass under the newest ones. Tools students already see stay visible while
          they’re re-checked; nothing is hidden automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Checks in this release</dt>
          <dd>Version {panel.codeRuleset}</dd>
          <dt className="text-muted-foreground">Accepted from</dt>
          <dd>{panel.minAccepted === null ? 'Couldn’t be read' : `Version ${panel.minAccepted}`}</dd>
          <dt className="text-muted-foreground">Schools being re-checked</dt>
          <dd>
            {panel.revalidating}
            {panel.waitingOnCapacity > 0 && ` (${panel.waitingOnCapacity} waiting for browser-check capacity)`}
          </dd>
          <dt className="text-muted-foreground">Waiting for a reviewer</dt>
          <dd>
            {panel.reviewsWaiting === null ? (
              'Couldn’t be read'
            ) : (
              <Link href="/super-admin/studio-reviews" className="text-primary underline-offset-4 hover:underline">
                {panel.reviewsWaiting} {panel.reviewsWaiting === 1 ? 'check' : 'checks'}
              </Link>
            )}
          </dd>
        </dl>
        {canRaise && (
          <Button type="button" className="min-h-11" onClick={() => setConfirming(true)} disabled={pending}>
            Accept only version {next} checks
          </Button>
        )}
      </CardContent>

      <AlertDialog open={confirming} onOpenChange={(open) => !pending && setConfirming(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Accept only version {next} checks?</AlertDialogTitle>
            <AlertDialogDescription>
              Every school’s tools are re-checked in the background. Until a tool passes again, its professor can’t show it to more
              students or switch its version, and its page says it’s being re-checked. This can’t be lowered again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11" disabled={pending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="min-h-11"
              disabled={pending}
              onClick={(e) => {
                e.preventDefault()
                raise()
              }}
            >
              {pending ? 'Raising…' : 'Raise and re-check'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
