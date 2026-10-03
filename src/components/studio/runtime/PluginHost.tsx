'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Lock, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { rosterNamesAction } from '@/app/(dashboard)/professor/courses/[sectionId]/studio/roster-actions'
import type { StudioManifest } from '@/lib/studio/manifest'
import { createBridgeClient } from '@/lib/studio/runtime/bridge-client'
import { mountPluginFrame, type FrameSnapshot, type StopReason } from '@/lib/studio/runtime/host'
import type { ToastTone } from '@/lib/studio/runtime/host-methods'
import { createPreviewBridge, type PreviewSample } from '@/lib/studio/runtime/preview-bridge'
import { previewRosterNames } from '@/lib/studio/runtime/preview-roster'
import type { PluginView } from '@/lib/studio/runtime/protocol'

interface CommonProps {
  /** A signed frame URL on the runtime origin, from issueFrameUrl or the builder's draft preview. */
  frameUrl: string
  title: string
  view: PluginView
  /** From allowedBridgeMethods on the server. */
  allowedMethods: readonly string[]
  /** The viewer may look but not change anything (archived, the school's plan, a
   * finished course). The frame's heartbeat can change this while it runs. */
  readOnly?: boolean
  /** Why, in a sentence, for the professor. Students get the generic notice. */
  readOnlyNotice?: string

  /** Gets a fresh frame URL; tickets expire, so a reload needs a new one. */
  onReload?: () => void
  /** A reload is in progress: the Reload button shows it and can't be pressed twice. */
  reloading?: boolean
  /** Where to go when reloading can't help, e.g. the course's Studio page. */
  exitHref?: string
  /** The label on the exit button. */
  exitLabel?: string
}

/** Live: requests go to the server for this installation's version, and the roster's
 * names come from rosterNamesAction. Preview (rule 8.3): requests go to an in-memory
 * bridge with the draft's sample data (or placeholders built from the manifest) and the
 * synthetic class, and never to the server. A builder draft is preview only: it has no
 * installation or version. */
type PluginHostProps = CommonProps &
  (
    | { preview?: undefined; sample?: undefined; installationId: string; versionId: string }
    | { preview: StudioManifest; sample?: PreviewSample | null; installationId?: string; versionId?: string }
  )

// Plain language only: a stop reason is never shown as a code (ui-design rules).
// `retry`: a reload can help. Otherwise the same thing would happen again.
const STOPPED: Record<Exclude<StopReason, 'destroyed'>, { title: string; description: string; retry: boolean }> = {
  // The frame's page never arrived: the tool runner is unreachable from this browser, not the tool.
  'start-timeout': { title: 'The preview couldn’t connect', description: 'Your browser couldn’t reach Studio’s tool runner. Check your connection and reload.', retry: true },
  // The page arrived but Studio's runtime in it never started.
  'hello-timeout': { title: 'This tool didn’t start', description: 'Studio’s runtime didn’t answer in time. Reload to try again.', retry: true },
  'unsupported-runtime': {
    title: 'This tool needs an update',
    description: 'It was built for an older version of Studio. Rebuild it in Studio to run it again.',
    retry: false,
  },
  navigated: { title: 'This tool was stopped', description: 'It tried to leave its own window, which tools aren’t allowed to do.', retry: false },
  malformed: { title: 'This tool was stopped', description: 'It sent Scholera messages it isn’t allowed to send.', retry: false },
  throttled: { title: 'This tool was stopped', description: 'It kept sending requests faster than Scholera allows.', retry: true },
  crashed: { title: 'This tool couldn’t render', description: 'Something inside the tool stopped working. If this keeps happening in a draft, ask Athena to fix it.', retry: true },
  // Hidden, switched off, or no longer yours to use. Never says which.
  unavailable: {
    title: 'This tool isn’t available right now',
    description: 'It may have been turned off, or you may no longer have access to it.',
    retry: false,
  },
}

const TOAST: Record<ToastTone, typeof toast.success> = { info: toast.info, success: toast.success, error: toast.error }

export function PluginHost({
  frameUrl,
  title,
  view,
  installationId,
  versionId,
  allowedMethods,
  readOnly = false,
  readOnlyNotice,
  preview,
  sample,
  onReload,
  reloading = false,
  exitHref,
  exitLabel = 'Back to Studio',
}: PluginHostProps) {
  const container = useRef<HTMLDivElement>(null)
  const stoppedNotice = useRef<HTMLDivElement>(null)
  const [frame, setFrame] = useState<FrameSnapshot>({ status: 'loading', loads: 0, strikes: 0 })

  useEffect(() => {
    if (!container.current) return
    const live = preview || !installationId || !versionId ? null : createBridgeClient({ installationId, versionId })
    const bridge = preview ? createPreviewBridge(preview, view, { sample }) : live
    if (!bridge) return
    // Only a professor view draws the roster; the host refuses it anywhere else.
    const liveId = live && view === 'professor' ? installationId : null
    const rosterNames = preview
      ? async () => previewRosterNames()
      : liveId
        ? async () => {
            const result = await rosterNamesAction({ installationId: liveId })
            if ('error' in result) throw new Error(result.error)
            return result.names
          }
        : undefined
    const mounted = mountPluginFrame({
      container: container.current,
      frameUrl,
      title,
      view,
      readOnly: preview ? false : readOnly,
      allowedMethods,
      // Tall enough to use a tool that never asks for ui.resize (the frame scrolls inside); one that asks gets its own height.
      className: 'block h-128 w-full border-0',
      handleRequest: (method, args) => bridge.handleRequest(method, args),
      // Rendered as text by the toast library, and labelled with the plugin's name so it
      // can't pass for a message from Scholera itself.
      onToast: (message, tone) => TOAST[tone](message, { description: `From ${title}` }),
      // Preview never reports to the server; live stops are logged there.
      onStopped: (reason) => live?.reportStop(reason),
      // Preview has no server to ask; a live frame checks it can keep running.
      checkStatus: live ? () => live.checkStatus() : undefined,
      // Names stay on this page; a failed load shows "Unknown student" rather than nothing.
      rosterNames,
      onChange: setFrame,
    })
    return () => mounted.destroy()
  }, [frameUrl, title, view, installationId, versionId, allowedMethods, readOnly, preview, sample])

  const stopped = frame.status === 'stopped' && frame.reason !== 'destroyed' ? STOPPED[frame.reason] : null
  const starting = frame.status === 'loading' || frame.status === 'handshaking'

  // The frame (often holding focus) was just removed: move focus to the notice that
  // replaced it, so keyboard and screen-reader users aren't dropped on the page body.
  useEffect(() => {
    if (stopped) stoppedNotice.current?.focus()
  }, [stopped])

  const reload = onReload && (
    <Button type="button" className="min-h-11" onClick={onReload} disabled={reloading}>
      <RefreshCw className="h-4 w-4" aria-hidden="true" />
      {reloading ? 'Reloading…' : 'Reload tool'}
    </Button>
  )
  const exit = exitHref && (
    <Button asChild variant="outline" className="min-h-11">
      <Link href={exitHref}>{exitLabel}</Link>
    </Button>
  )

  return (
    <div className="w-full space-y-3">
      {frame.status === 'stale' && (
        <Alert>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>A newer version of this tool is in use</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>This copy has stopped saving. Reload to continue with the current version.</p>
            {reload}
          </AlertDescription>
        </Alert>
      )}
      {frame.status === 'ready' && frame.readOnly && (
        // A standing notice, not an interruption: polite, not the Alert's default role="alert".
        <Alert role="status">
          <Lock className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>This tool is read-only</AlertTitle>
          <AlertDescription>{readOnlyNotice ?? 'You can look through it, but changes won’t be saved.'}</AlertDescription>
        </Alert>
      )}

      <div className="relative">
        <div ref={container} aria-busy={starting} hidden={!!stopped} />
        {starting && (
          <div role="status" className="absolute inset-0 flex flex-col gap-3 bg-card p-4">
            <span className="sr-only">Loading {title}</span>
            <Skeleton className="h-5 w-1/3 rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        )}
      </div>

      {stopped && (
        <div ref={stoppedNotice} role="alert" tabIndex={-1} className="rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <EmptyState variant="teaching" icon={AlertTriangle} title={stopped.title} description={stopped.description}>
            {stopped.retry ? reload : exit}
          </EmptyState>
        </div>
      )}
    </div>
  )
}
