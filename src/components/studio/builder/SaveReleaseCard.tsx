'use client'

import { useEffect, useId, useState, useTransition } from 'react'
import Link from 'next/link'
import { Check, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { VersionRelease } from '@/lib/studio/builder/service'
import type { BlockerCode, Issue, WarningCode } from '@/lib/studio/student-visibility'
import { IssueWarnings } from '../publication/IssueWarnings'
import { ReleaseSteps } from './RunCards'
import { addVersionToCourseAction, versionReleaseAction } from '@/app/(dashboard)/professor/courses/[sectionId]/studio/actions'

/**
 * The step after Save, in the flow the professor is already in: Add to this course when
 * the course doesn't have the tool, Use this version in the course when it has another
 * one. Shows the plugin card first (rule 8.2); Studio's browser checks then start on
 * their own. Every rule is the server's: this only shows what it answered.
 */
export function SaveReleaseCard({ sectionId, versionId, version }: { sectionId: string; versionId: string; version: string }) {
  const headingId = useId()
  const [release, setRelease] = useState<VersionRelease | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const [acknowledged, setAcknowledged] = useState(false)
  const [refused, setRefused] = useState<{ error: string; blockers?: Issue<BlockerCode>[]; warnings?: Issue<WarningCode>[] } | null>(null)
  const [done, setDone] = useState<{ installationId: string; added: boolean; checks: string } | null>(null)

  useEffect(() => {
    let live = true
    void versionReleaseAction({ sectionId, versionId }).then((r) => {
      if (!live) return
      if ('error' in r) setLoadError(r.error)
      else setRelease(r)
    })
    return () => {
      live = false
    }
  }, [sectionId, versionId])

  if (loadError) return <p className="text-sm text-muted-foreground">{loadError}</p>
  if (!release) return <Skeleton className="h-24 w-full rounded-2xl" />

  const toolHref = (installationId: string) => `/professor/courses/${sectionId}/studio/${installationId}`
  if (done) {
    return (
      <section aria-labelledby={headingId} className="space-y-3 rounded-2xl bg-muted p-4" aria-live="polite">
        {done.added && <ReleaseSteps step={3} />}
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
          <div className="space-y-1">
            <h3 id={headingId} className="text-sm font-medium">
              {done.added ? 'Added to this course. Students can’t see it until you show it.' : `Your course now uses version ${version}.`}
            </h3>
            <p className="text-sm text-muted-foreground">{done.checks}</p>
          </div>
        </div>
        <Link href={toolHref(done.installationId)} className="inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-medium text-accent-foreground hover:bg-accent">
          Open the tool
        </Link>
      </section>
    )
  }
  if (release.mode === 'current') return null

  const warnings = refused?.warnings ?? []
  const blockers = refused?.blockers ?? []
  const confirm = () =>
    start(async () => {
      const r = await addVersionToCourseAction({ sectionId, versionId, acknowledgeWarnings: acknowledged })
      if ('error' in r) {
        // New warnings need reading again.
        if (r.warnings) setAcknowledged(false)
        setRefused(r)
        return
      }
      setDone(r)
    })
  const add = release.mode === 'add'
  const { card } = release
  const lines = add ? [...card.students.map((l) => `Students can: ${l}`), ...card.professors.map((l) => `You can: ${l}`)] : release.added

  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-2xl bg-muted p-4">
      {add && <ReleaseSteps step={2} />}
      <div className="space-y-1">
        <h3 id={headingId} className="text-sm font-medium">
          {add ? `Add ${card.name} to this course?` : `Use version ${version} in this course?`}
        </h3>
        {/* Once blocked, the refusal below says why; "right away" would no longer be true. */}
        {blockers.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {add
              ? 'It starts hidden from students. Studio’s automatic checks start on their own.'
              : release.visible
                ? 'Students can see this tool, so they get this version right away.'
                : 'Students can’t see this tool yet. Studio’s automatic checks start on their own.'}
          </p>
        )}
      </div>
      {lines.length > 0 && (
        <div className="text-sm text-muted-foreground">
          {!add && <p>New in this version:</p>}
          <ul className="space-y-1.5">
            {lines.map((l) => (
              <li key={l} className="flex gap-2">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                <span className="min-w-0">{l}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {add && (
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>{card.data.length === 0 ? 'It saves nothing.' : `It saves: ${card.data.map((d) => d.name).join(', ')}.`}</p>
          <p>{card.ai}</p>
          <p>{card.grading}</p>
        </div>
      )}
      {refused && blockers.length === 0 && warnings.length === 0 && <p className="text-sm text-destructive">{refused.error}</p>}
      {blockers.length > 0 && (
        <div className="text-sm">
          <p className="text-destructive">{refused?.error}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
            {blockers.map((b) => (
              <li key={b.code}>{b.message}</li>
            ))}
          </ul>
          {release.installationId && (
            <>
              <p className="mt-2 text-muted-foreground">You can use this version later from the tool’s page.</p>
              <Link href={toolHref(release.installationId)} className="inline-flex min-h-11 items-center rounded-xl text-sm font-medium text-accent-foreground hover:underline">
                Open the tool
              </Link>
            </>
          )}
        </div>
      )}
      <IssueWarnings id={`${headingId}-ack`} warnings={warnings} acknowledged={acknowledged} onAcknowledge={blockers.length > 0 ? undefined : setAcknowledged} />
      {blockers.length === 0 && (
        <Button type="button" className="min-h-11 w-full" disabled={pending || (warnings.length > 0 && !acknowledged)} onClick={confirm}>
          {pending ? (add ? 'Adding…' : 'Switching…') : add ? 'Add to this course' : 'Use this version in the course'}
        </Button>
      )}
    </section>
  )
}
