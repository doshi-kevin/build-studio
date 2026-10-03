'use client'

import { AlertTriangle } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import type { Issue, WarningCode } from '@/lib/studio/student-visibility'

/** "Oct 9" in the reader's own time zone. */
const opensOn = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/**
 * The warnings a professor reads before a tool or version reaches students, with the
 * course material each unreleased_material warning names. With `onAcknowledge`, a
 * checkbox the professor ticks to continue; the server asks again on submit.
 */
export function IssueWarnings({
  id,
  warnings,
  acknowledged,
  onAcknowledge,
}: {
  /** Unique on the page: names the checkbox. */
  id: string
  warnings: Issue<WarningCode>[]
  acknowledged?: boolean
  onAcknowledge?: (value: boolean) => void
}) {
  if (warnings.length === 0) return null
  return (
    <Alert>
      <AlertTriangle className="h-4 w-4" aria-hidden="true" />
      <AlertTitle>Before you continue</AlertTitle>
      <AlertDescription className="space-y-3">
        <ul className="list-disc space-y-1 pl-5">
          {warnings.map((w) => (
            <li key={w.code}>
              {w.message}
              {w.sources && w.sources.length > 0 && (
                <ul className="mt-1 list-[circle] space-y-0.5 break-words pl-5">
                  {w.sources.map((s, i) => (
                    <li key={`${i}-${s.label}`}>
                      {s.label}
                      {s.opensAt ? `. Students can’t see this until ${opensOn(s.opensAt)}.` : '. Students can’t see this.'}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
        {onAcknowledge && (
          <div className="flex min-h-11 items-center gap-2">
            <Checkbox id={id} checked={acknowledged} onCheckedChange={(v) => onAcknowledge(v === true)} />
            <Label htmlFor={id}>I’ve read these and want to continue</Label>
          </div>
        )}
      </AlertDescription>
    </Alert>
  )
}
