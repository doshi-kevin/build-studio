/**
 * InstitutionPlanCard — what this school has, and how to ask for what it does
 * not. The institution admin can never change an entitlement here; the only
 * write is a request that Scholera reviews.
 *
 * Type: Client Component
 */
'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Loader2, Check, CalendarClock } from 'lucide-react'
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
import {
  ENTITLED_FEATURES,
  evaluateEntitlement,
  type EntitledFeatureKey,
  type EntitlementConfig,
} from '@/lib/entitlements/entitled-features'
import {
  requestFeature,
  withdrawFeatureRequest,
} from '@/app/(dashboard)/admin/settings/entitlement-actions'

/**
 * A scheduled revocation is stored as UTC midnight on the chosen day, so it
 * must be READ back as UTC too. Formatting it in the viewer's local zone shows
 * the previous day anywhere west of Greenwich, which made the date input and
 * the confirm dialog disagree by one day.
 */
function formatRevocationDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

interface Props {
  entitlements: EntitlementConfig
  /** Feature key to the id of this school's open request for it. */
  openRequests: Record<string, string>
}

export function InstitutionPlanCard({ entitlements, openRequests }: Props) {
  const [pending, startTransition] = useTransition()
  const [asking, setAsking] = useState<EntitledFeatureKey | null>(null)
  const [message, setMessage] = useState('')
  const now = new Date()

  function onRequest() {
    if (!asking) return
    const feature = asking
    const note = message
    startTransition(async () => {
      const result = await requestFeature(feature, note)
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      toast.success('Request sent to Scholera')
      setAsking(null)
      setMessage('')
    })
  }

  function onWithdraw(requestId: string) {
    startTransition(async () => {
      const result = await withdrawFeatureRequest(requestId)
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      toast.success('Request withdrawn')
    })
  }

  return (
    <section className="rounded-xl border bg-card p-6">
      <h2 className="text-sm font-semibold text-foreground">Your plan</h2>
      <p className="mt-0.5 text-[13px] text-muted-foreground">
        What your institution has. To add something, ask Scholera and we will get back to you.
        Losing a feature never deletes anything — past work and grades stay visible.
      </p>

      <div className="mt-6 space-y-1">
        {ENTITLED_FEATURES.map((feature) => {
          const verdict = evaluateEntitlement(entitlements, feature.key, now)
          const requestId = openRequests[feature.key]
          return (
            <div
              key={feature.key}
              className="flex flex-wrap items-center justify-between gap-4 rounded-xl px-3 py-3 hover:bg-muted/40"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{feature.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{feature.description}</p>
                {/* The one moment this admin might panic. "Ends on 15 Dec" alone
                    reads as "works through the 15th" — it turns off AT the start
                    of that day — and says nothing about what happens to the work
                    already in it. Both are spelled out. */}
                {verdict.entitled && verdict.pendingRevocationAt && (
                  <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
                    <CalendarClock className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      Turns off on {formatRevocationDate(verdict.pendingRevocationAt)}. Past work
                      and grades stay visible; nothing new can be created after that.
                    </span>
                  </p>
                )}
              </div>

              {verdict.entitled ? (
                <span className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
                  <Check className="size-4" />
                  Included
                </span>
              ) : requestId ? (
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-sm text-muted-foreground">Requested</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => onWithdraw(requestId)}
                  >
                    Withdraw
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => {
                    setAsking(feature.key)
                    setMessage('')
                  }}
                >
                  Request
                </Button>
              )}
            </div>
          )
        })}
      </div>

      <Dialog open={!!asking} onOpenChange={(open) => !open && setAsking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Request {asking ? ENTITLED_FEATURES.find((f) => f.key === asking)?.label : ''}
            </DialogTitle>
            <DialogDescription>
              This goes to Scholera. Tell us what you want to use it for and we will come back to
              you.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="request-message">Message (optional)</Label>
            <Textarea
              id="request-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Two of our engineering courses want to run weekly labs this term."
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAsking(null)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={onRequest} disabled={pending}>
              {pending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Send request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
