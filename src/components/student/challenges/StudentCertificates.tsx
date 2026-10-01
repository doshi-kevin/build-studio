/**
 * StudentCertificates — earned-certificate list + a celebration moment.
 *
 * Sharing (LinkedIn / copy / PDF) lives on the public page (/c/[publicId]); the
 * in-app UI celebrates the win and links there, so no PII is plumbed client-side.
 *
 * Type: Client Component
 */
'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import { Award, ExternalLink, PartyPopper } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { markCertificatesSeen } from '@/app/(dashboard)/student/courses/[sectionId]/challenges/actions'

export interface StudentCertificate {
  id: string
  public_id: string
  title: string
  description: string
  skills_snapshot: string[]
  issued_at: string
  seen_at: string | null
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Celebration modal (fires once for unseen certificates) ──────

export function CertificateCelebration({
  sectionId,
  certificates,
}: {
  sectionId: string
  certificates: StudentCertificate[]
}) {
  const unseen = certificates.filter((c) => !c.seen_at)
  const [open, setOpen] = useState(false)
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    if (unseen.length > 0) setOpen(true)
    // Only react to the set of unseen ids, not object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unseen.map((c) => c.id).join(',')])

  if (unseen.length === 0) return null

  // Lead with the newest; if several landed at once, note the rest.
  const featured = unseen[0]
  const extra = unseen.length - 1

  // Marks all unseen as seen. Fires whenever the dialog closes (button, Escape,
  // overlay click, or the built-in close) so the celebration never re-shows.
  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) void markCertificatesSeen(sectionId, unseen.map((c) => c.id))
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md text-center">
        <DialogTitle className="sr-only">Certificate earned</DialogTitle>
        <div className="flex flex-col items-center pt-2">
          <motion.div
            className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10"
            initial={reduceMotion ? false : { rotate: -12, scale: 0.8 }}
            animate={reduceMotion ? undefined : { rotate: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 260, damping: 14, delay: 0.1 }}
          >
            <PartyPopper className="h-8 w-8 text-primary" aria-hidden="true" />
          </motion.div>
          <h2 className="mt-5 text-lg font-semibold">Congratulations! 🎓</h2>
          <p className="mt-1 text-sm text-muted-foreground">You earned a certificate</p>
          <p className="mt-4 text-xl font-semibold text-primary">{featured.title}</p>
          {extra > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">+ {extra} more certificate{extra === 1 ? '' : 's'}</p>
          )}
        </div>
        <DialogFooter className="mt-6 flex-col gap-2 sm:flex-col sm:space-x-0">
          <Button asChild onClick={() => handleOpenChange(false)}>
            <Link href={`/c/${featured.public_id}`} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              View &amp; share
            </Link>
          </Button>
          <Button variant="ghost" onClick={() => handleOpenChange(false)}>
            Maybe later
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Persistent earned-certificate list ──────────────────────────

export function StudentCertificatesList({ certificates }: { certificates: StudentCertificate[] }) {
  if (certificates.length === 0) {
    return (
      <EmptyState
        icon={Award}
        title="No certificates yet"
        description="Complete a certificate's full set of challenges to earn a shareable credential."
      />
    )
  }

  return (
    <div className="space-y-3">
      {certificates.map((cert) => (
        <div key={cert.id} className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Award className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <h4 className="truncate text-sm font-semibold">{cert.title}</h4>
              </div>
              {cert.skills_snapshot.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {cert.skills_snapshot.map((s) => (
                    <Badge key={s} variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
                      {s}
                    </Badge>
                  ))}
                </div>
              )}
              <p className="mt-2 text-xs text-muted-foreground">Earned {formatDate(cert.issued_at)}</p>
            </div>
            <Button asChild size="sm" variant="outline" className="shrink-0">
              <Link href={`/c/${cert.public_id}`} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                View &amp; share
              </Link>
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
