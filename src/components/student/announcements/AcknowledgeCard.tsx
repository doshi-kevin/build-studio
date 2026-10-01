/**
 * AcknowledgeCard — the "I have read this" acknowledgement control for
 * announcements that require acknowledgement.
 *
 * Scroll gate: the button stays disabled until the student has scrolled to the
 * end of the announcement content. The card sits directly below the content, so
 * a sentinel at its top entering the viewport means everything above has been
 * scrolled past. Short announcements that fit on screen enable immediately.
 *
 * Type: Client Component
 */
'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { CheckCircle2, ArrowDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { acknowledgeAnnouncement } from '@/app/(dashboard)/student/courses/[sectionId]/announcements/actions'

interface AcknowledgeCardProps {
  announcementId: string
  sectionId: string
  acknowledgedAt: string | null
}

export function AcknowledgeCard({ announcementId, sectionId, acknowledgedAt }: AcknowledgeCardProps) {
  const [acknowledged, setAcknowledged] = useState(!!acknowledgedAt)
  const [ackDate, setAckDate] = useState<string | null>(acknowledgedAt)
  const [reachedEnd, setReachedEnd] = useState(false)
  const [isPending, startTransition] = useTransition()
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (acknowledged) return
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setReachedEnd(true)
      },
      { threshold: 0.1 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [acknowledged])

  const handleAcknowledge = () => {
    startTransition(async () => {
      const result = await acknowledgeAnnouncement(announcementId, sectionId)
      if (result.error) {
        toast.error(result.error)
        return
      }
      setAcknowledged(true)
      setAckDate(new Date().toISOString())
      toast.success('Acknowledged')
    })
  }

  if (acknowledged) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-primary">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span>
          You acknowledged this announcement
          {ackDate ? ` on ${new Date(ackDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}` : ''}.
        </span>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4">
      {/* Sentinel at the top of the card = end of the content above it. */}
      <div ref={sentinelRef} aria-hidden className="h-px w-full" />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-foreground">Acknowledgement required</p>
          <p className="text-xs text-muted-foreground">
            {reachedEnd
              ? 'Confirm you have read this announcement.'
              : 'Scroll to the end of the announcement to acknowledge.'}
          </p>
        </div>
        <Button onClick={handleAcknowledge} disabled={!reachedEnd || isPending} className="shrink-0">
          {reachedEnd ? <CheckCircle2 className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
          {isPending ? 'Saving…' : 'I have read this'}
        </Button>
      </div>
    </div>
  )
}
