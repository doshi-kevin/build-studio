'use client'

import { useId, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Inbox } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { ReviewQueueView } from '@/lib/studio/validator/service'
import { resolveReviewAction } from '@/app/(dashboard)/super-admin/studio-reviews/actions'

function ReviewItem({ item }: { item: ReviewQueueView }) {
  const router = useRouter()
  const reasonId = useId()
  const [reason, setReason] = useState('')
  const [pending, start] = useTransition()
  const decide = (decision: 'approved' | 'rejected') =>
    start(async () => {
      const r = await resolveReviewAction({ validationId: item.validationId, checkId: item.checkId, artifactSha256: item.artifactSha256, decision, reason })
      if ('error' in r) {
        toast.error(r.error)
        return
      }
      toast.success(decision === 'approved' ? 'Approved' : 'Rejected')
      router.refresh()
    })
  const ready = reason.trim().length > 0 && !pending && !item.publishedByYou

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {item.pluginName} <span className="font-normal text-muted-foreground">v{item.version}</span>
          <Badge variant="secondary">{item.stage === 'static' ? 'Code checks' : 'Browser checks'}</Badge>
        </CardTitle>
        <CardDescription>
          {item.institution}
          {item.courses.length > 0 ? ` · ${item.courses.join(', ')}` : ' · not in a course yet'}
          {item.recheck ? ' · re-check after the accepted checks were raised' : ''} · waiting since{' '}
          {/* The reader's own time zone: the server's render can differ by a day near midnight. */}
          <span suppressHydrationWarning>
            {new Date(item.waitingSince).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <section className="space-y-1">
          <h3 className="font-semibold">{item.checkSummary}</h3>
          <p className="text-muted-foreground">{item.message}</p>
          {item.findings.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              {item.findings.map((f, i) => (
                <li key={i}>
                  {f.view && <span className="font-medium text-foreground">{f.view} view: </span>}
                  {f.detail}
                </li>
              ))}
            </ul>
          )}
        </section>
        {item.purpose && (
          <section className="space-y-1">
            <h3 className="font-semibold">What the professor says it’s for</h3>
            <p className="text-muted-foreground">{item.purpose}</p>
          </section>
        )}
        {item.source && (
          <section className="space-y-1">
            <h3 className="font-semibold">{item.source.view === 'student' ? 'Student' : 'Professor'} view source</h3>
            {/* Plugin code is untrusted: shown as text only, which React escapes. Never rendered or run. */}
            <pre className="max-h-96 overflow-auto whitespace-pre rounded-xl bg-muted p-3 font-mono text-xs" tabIndex={0} aria-label="Source code, read only">
              {item.source.text}
            </pre>
          </section>
        )}
        {item.publishedByYou ? (
          <p className="text-muted-foreground">You published this version, so another reviewer has to decide.</p>
        ) : (
          <div className="space-y-2">
            <Label htmlFor={reasonId}>Reason for the professor (required)</Label>
            <Textarea id={reasonId} required value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} rows={3} />
            <div className="flex flex-wrap gap-2">
              <Button type="button" className="min-h-11" disabled={!ready} onClick={() => decide('approved')}>
                Approve
              </Button>
              <Button type="button" variant="outline" className="min-h-11" disabled={!ready} onClick={() => decide('rejected')}>
                Reject
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** The super admin's queue of Studio checks waiting for a decision, oldest first. */
export function StudioReviewQueue({ items }: { items: ReviewQueueView[] }) {
  if (items.length === 0) {
    return <EmptyState icon={Inbox} title="Nothing to review" description="When Studio can’t decide a check on its own, it shows up here." />
  }
  return (
    <div className="space-y-4">
      {items.map((item) => (
        <ReviewItem key={`${item.validationId}|${item.checkId}`} item={item} />
      ))}
    </div>
  )
}
