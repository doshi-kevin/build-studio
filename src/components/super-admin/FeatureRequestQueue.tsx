/**
 * FeatureRequestQueue — schools asking for a feature their plan does not
 * include. Approving grants it immediately and closes the row.
 *
 * Modelled on StaffRequestQueue: a list, two dialogs, an "all caught up" empty
 * state. Declining requires a reason, because a school that hears nothing back
 * just asks again.
 *
 * Type: Client Component
 */
'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Loader2, Inbox } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { ENTITLED_FEATURES } from '@/lib/entitlements/entitled-features'
import {
  approveFeatureRequest,
  declineFeatureRequest,
} from '@/app/(dashboard)/super-admin/institutions/entitlement-actions'

export interface FeatureRequestRow {
  id: string
  feature_key: string
  message: string | null
  created_at: string
  institutionName: string
  requesterName: string
}

const labelFor = (key: string) => ENTITLED_FEATURES.find((f) => f.key === key)?.label ?? key

export function FeatureRequestQueue({ requests }: { requests: FeatureRequestRow[] }) {
  const [pending, startTransition] = useTransition()
  const [approving, setApproving] = useState<FeatureRequestRow | null>(null)
  const [declining, setDeclining] = useState<FeatureRequestRow | null>(null)
  const [note, setNote] = useState('')

  if (requests.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="No open requests"
        description="When a school asks for a feature their plan does not include, it lands here."
      />
    )
  }

  function onApprove() {
    if (!approving) return
    const request = approving
    const reviewNote = note
    startTransition(async () => {
      const result = await approveFeatureRequest(request.id, reviewNote)
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      toast.success(`${labelFor(request.feature_key)} is now on for ${request.institutionName}`)
      setApproving(null)
      setNote('')
    })
  }

  function onDecline() {
    if (!declining) return
    const request = declining
    const reason = note
    startTransition(async () => {
      const result = await declineFeatureRequest(request.id, reason)
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      toast.success('Request declined')
      setDeclining(null)
      setNote('')
    })
  }

  return (
    <>
      <ul className="space-y-3">
        {requests.map((request) => (
          <li key={request.id} className="rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="font-medium">
                  {request.institutionName} wants {labelFor(request.feature_key)}
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Asked by {request.requesterName} on{' '}
                  {new Date(request.created_at).toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                </p>
                {request.message && (
                  <p className="mt-2 whitespace-pre-wrap text-sm">{request.message}</p>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDeclining(request)
                    setNote('')
                  }}
                >
                  Decline
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setApproving(request)
                    setNote('')
                  }}
                >
                  Approve
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      <Dialog open={!!approving} onOpenChange={(open) => !open && setApproving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Turn on {approving ? labelFor(approving.feature_key) : ''}?
            </DialogTitle>
            <DialogDescription>
              {approving?.institutionName} gets it straight away. Professors can start using it in
              every section immediately.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="approve-note">Note (optional)</Label>
            <Textarea
              id="approve-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Anything worth recording about this decision"
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setApproving(null)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={onApprove} disabled={pending}>
              {pending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!declining} onOpenChange={(open) => !open && setDeclining(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Decline this request?</DialogTitle>
            <DialogDescription>
              Say why, so the school knows what would change the answer.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="decline-note">Reason</Label>
            {/* Decline stays disabled until this has content, and a disabled
                button is not focusable — so without aria-required a screen-reader
                user tabs the dialog, finds only Cancel, and cannot tell why. */}
            <Textarea
              id="decline-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              aria-required="true"
              placeholder="Not part of their contract; renewal is in March"
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeclining(null)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onDecline} disabled={pending || !note.trim()}>
              {pending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Decline
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
