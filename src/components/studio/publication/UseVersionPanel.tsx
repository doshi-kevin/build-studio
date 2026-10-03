'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { BlockerCode, Issue, WarningCode } from '@/lib/studio/student-visibility'
import { IssueWarnings } from './IssueWarnings'
import { switchVersionAction } from '@/app/(dashboard)/professor/courses/[sectionId]/studio/[installationId]/actions'

/**
 * Shown while previewing a version the course doesn't use: make it the course's version
 * (Use this version, or Roll back to an older one). The server reviews it again on
 * submit; this only shows what it answered.
 */
export function UseVersionPanel({
  sectionId,
  installationId,
  versionId,
  version,
  older,
  visible,
  added,
  basePath,
}: {
  sectionId: string
  installationId: string
  versionId: string
  version: string
  /** Older than the course's version: offered as a roll back. */
  older: boolean
  /** Students can see the tool, so the switch reaches them at once. */
  visible: boolean
  /** What this version can do that the course's version can't (rule 8.2). */
  added: string[]
  basePath: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [acknowledged, setAcknowledged] = useState(false)
  const [refused, setRefused] = useState<{ error: string; blockers?: Issue<BlockerCode>[]; warnings?: Issue<WarningCode>[] } | null>(null)
  const blockers = refused?.blockers ?? []
  const warnings = refused?.warnings ?? []
  const label = older ? `Roll back to v${version}` : `Use v${version} in the course`

  const confirm = () =>
    start(async () => {
      const r = await switchVersionAction(sectionId, installationId, versionId, acknowledged)
      if ('error' in r) {
        if (r.warnings) setAcknowledged(false)
        setRefused(r)
        if (!r.blockers && !r.warnings) toast.error(r.error)
        return
      }
      toast.success(older ? `Rolled back to v${version}` : `Your course now uses v${version}`)
      if (r.checks) toast.message(r.checks)
      router.push(basePath)
    })

  return (
    <div className="w-full space-y-3 rounded-2xl bg-muted p-4 text-sm">
      {/* Once blocked, the refusal below says why; "right away" would no longer be true. */}
      {blockers.length === 0 && (
        <p className="text-muted-foreground">
          {visible ? 'Students can see this tool, so they get this version right away.' : 'Students can’t see this tool, so nothing changes for them.'}
        </p>
      )}
      {added.length > 0 && (
        <div className="text-muted-foreground">
          <p>New in this version:</p>
          <ul className="list-disc space-y-1 pl-5">
            {added.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      )}
      {blockers.length > 0 && (
        <div>
          <p className="text-destructive">{refused?.error}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
            {blockers.map((b) => (
              <li key={b.code}>{b.message}</li>
            ))}
          </ul>
        </div>
      )}
      <IssueWarnings id="use-version-acknowledge" warnings={warnings} acknowledged={acknowledged} onAcknowledge={blockers.length > 0 ? undefined : setAcknowledged} />
      {blockers.length === 0 && (
        <Button type="button" className="min-h-11" onClick={confirm} disabled={pending || (warnings.length > 0 && !acknowledged)}>
          {pending ? 'Switching…' : label}
        </Button>
      )}
    </div>
  )
}
