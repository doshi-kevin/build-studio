'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { ValidationSummary } from '@/lib/studio/validator/service'
import { requestRuntimeChecksAction } from '@/app/(dashboard)/professor/courses/[sectionId]/studio/[installationId]/actions'

const STATUS: Record<string, string> = {
  passed: 'Passed',
  failed: 'Didn’t pass',
  needs_review: 'Waiting for a Scholera reviewer. You don’t need to do anything; this page updates when they decide.',
  error: 'Couldn’t finish',
  running: 'Running',
  pending: 'Running',
}

/** Each finding says what kind it is; the worst come first. */
const FINDING: Record<string, { label: string; rank: number }> = {
  failed: { label: 'Didn’t pass', rank: 0 },
  needs_review: { label: 'Needs a reviewer', rank: 1 },
  error: { label: 'Couldn’t run', rank: 2 },
  warning: { label: 'Worth a look', rank: 3 },
}

const MAX_SHOWN = 6
/** How often the page re-reads the checks while one is running. */
const POLL_MS = 5000
const REVIEW_POLL_MS = 30_000

type Stage = ValidationSummary['stages']['static']

function StageLine({ label, value }: { label: string; value: Stage }) {
  const [all, setAll] = useState(false)
  const findings = [...(value?.findings ?? [])].sort((a, b) => (FINDING[a.status]?.rank ?? 9) - (FINDING[b.status]?.rank ?? 9))
  const shown = all ? findings : findings.slice(0, MAX_SHOWN)
  return (
    <div className="space-y-1">
      <p>
        <span className="font-medium text-foreground">{label}:</span> {value ? (STATUS[value.status] ?? value.status) : 'Not run yet'}
      </p>
      {shown.length > 0 && (
        <ul className="list-disc space-y-1 pl-5">
          {shown.map((f) => (
            <li key={f.checkId}>
              {f.review ? (
                <span className="font-medium text-foreground">
                  {f.review.decision === 'approved' ? 'Approved by a Scholera reviewer: ' : 'Rejected by a Scholera reviewer: '}
                </span>
              ) : (
                FINDING[f.status] && <span className="font-medium text-foreground">{FINDING[f.status].label}: </span>
              )}
              {f.message}
              {/* The reviewer wrote this for the professor; React escapes it. */}
              {f.review && <span className="block">Reviewer’s note: {f.review.reason}</span>}
            </li>
          ))}
        </ul>
      )}
      {findings.length > shown.length && (
        <Button type="button" variant="ghost" className="min-h-11 px-2" onClick={() => setAll(true)}>
          Show all {findings.length}
        </Button>
      )}
    </div>
  )
}

/** What Studio's automatic checks found. Read-only, apart from starting the checks;
 * the verdict is the server's (validator/service.ts). */
export function ValidationChecks({
  sectionId,
  installationId,
  validation,
}: {
  sectionId: string
  installationId: string
  validation: ValidationSummary | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const stages = [validation?.stages.static, validation?.stages.runtime]
  const running = stages.some((s) => s?.status === 'running' || s?.status === 'pending')
  const awaitingReview = stages.some((s) => s?.status === 'needs_review')

  // A run finishes in the background, and a reviewer decides in theirs: re-read the page
  // until it does (a review takes longer, so less often).
  useEffect(() => {
    if (!running && !awaitingReview) return
    const timer = setInterval(() => router.refresh(), running ? POLL_MS : REVIEW_POLL_MS)
    return () => clearInterval(timer)
  }, [running, awaitingReview, router])

  if (!validation) return <p>Couldn’t load the checks just now. Close this and open it again.</p>

  const runtimeDone = validation.stages.runtime?.status === 'passed'
  const retry = validation.stages.static?.status === 'error' || validation.stages.runtime?.status === 'error'
  const run = () =>
    startTransition(async () => {
      const result = await requestRuntimeChecksAction(sectionId, installationId)
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      router.refresh()
    })

  return (
    <div className="space-y-3">
      <div className="space-y-3" aria-live="polite">
        <StageLine label="Code checks" value={validation.stages.static} />
        <StageLine label="Browser checks" value={validation.stages.runtime} />
        {running && <p>This can take a few minutes. You can close this and come back.</p>}
      </div>
      {validation.canRequestRuntime && !runtimeDone && !running && (
        validation.runnerAvailable ? (
          <Button type="button" variant="outline" className="min-h-11" onClick={run} disabled={pending}>
            {pending ? 'Starting…' : retry ? 'Run the checks again' : 'Run browser checks'}
          </Button>
        ) : (
          <p>Browser checks aren’t available yet. Until they are, students can’t see this tool.</p>
        )
      )}
    </div>
  )
}
