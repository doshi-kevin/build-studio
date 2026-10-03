'use client'

import { useEffect, useState } from 'react'
import { Blocks, Check, Monitor, RotateCw, Smartphone } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PluginHost } from '@/components/studio/runtime/PluginHost'
import type { StudioManifest } from '@/lib/studio/manifest'
import { cn } from '@/lib/utils'
import { draftPreviewAction } from '@/app/(dashboard)/professor/courses/[sectionId]/studio/actions'
import type { Device, ViewMode } from './types'

interface StudioPreviewProps {
  sectionId: string
  pluginProjectId: string
  /** The draft snapshot to run, or null when nothing has been built yet. */
  snapshotHash: string | null
  /** Shown above the frames, e.g. that a newer build is still running. */
  note?: string
  /** A build is running. With nothing built yet, the views show as placeholders until it finishes. */
  building?: boolean
  mode: ViewMode
  device: Device
  onModeChange: (mode: ViewMode) => void
  onDeviceChange: (device: Device) => void
}

type Frame = { frameUrl: string; allowedMethods: string[]; manifest: StudioManifest; title: string } | { error: string } | null

/** One view of the draft in the real sandbox, on sample data. Previews never reach real records. */
function DraftFrame({ sectionId, pluginProjectId, snapshotHash, view }: { sectionId: string; pluginProjectId: string; snapshotHash: string; view: 'student' | 'professor' }) {
  const [frame, setFrame] = useState<Frame>(null)
  // Tickets expire: a reload asks the server for a fresh one.
  const [attempt, setAttempt] = useState(0)
  const reloading = frame === null && attempt > 0
  useEffect(() => {
    let live = true
    void draftPreviewAction({ sectionId, pluginProjectId, snapshotHash, view }).then((r) => {
      if (live) setFrame('success' in r ? { frameUrl: r.frameUrl, allowedMethods: r.allowedMethods, manifest: r.manifest, title: r.title } : { error: r.error })
    })
    return () => {
      live = false
    }
  }, [sectionId, pluginProjectId, snapshotHash, view, attempt])
  if (!frame) return <Skeleton className="h-128 w-full rounded-xl" />
  if ('error' in frame) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{frame.error}</p>
        <Button type="button" variant="outline" className="min-h-11" onClick={() => { setFrame(null); setAttempt((n) => n + 1) }}>
          Try again
        </Button>
      </div>
    )
  }
  return (
    <PluginHost
      frameUrl={frame.frameUrl}
      title={frame.title}
      view={view}
      allowedMethods={frame.allowedMethods}
      preview={frame.manifest}
      reloading={reloading}
      onReload={() => {
        setFrame(null)
        setAttempt((n) => n + 1)
      }}
    />
  )
}

/** How long the frames stay highlighted after the draft they show changes. */
const HIGHLIGHT_MS = 2400

const VIEW_NAME = { professor: 'Professor view', student: 'Student view' } as const

export function StudioPreview({ sectionId, pluginProjectId, snapshotHash, note, building = false, mode, device, onModeChange, onDeviceChange }: StudioPreviewProps) {
  const views: ('professor' | 'student')[] = mode === 'split' ? ['professor', 'student'] : [mode]
  // The draft on screen, and when it last replaced another one. The first draft, and the one the
  // builder opened on, are not updates.
  const [shown, setShown] = useState(snapshotHash)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [highlight, setHighlight] = useState(false)
  // Refresh remounts the frames, which asks the server for fresh tickets.
  const [reloads, setReloads] = useState(0)
  if (snapshotHash !== shown) {
    setShown(snapshotHash)
    if (shown && snapshotHash) {
      setUpdatedAt(new Date())
      setHighlight(true)
    }
  }
  useEffect(() => {
    if (!highlight) return
    const timer = setTimeout(() => setHighlight(false), HIGHLIGHT_MS)
    return () => clearTimeout(timer)
  }, [highlight, updatedAt])

  const layout = cn('mx-auto flex flex-col gap-6 md:flex-row', views.length === 2 ? 'max-w-6xl' : 'max-w-3xl', device === 'phone' && 'items-center md:items-start md:justify-center')
  const column = cn('flex min-w-0 flex-col', device === 'phone' ? 'w-full max-w-sm' : 'w-full')
  const box = cn('bg-background p-2 shadow-md', device === 'phone' ? 'rounded-3xl border-8 border-muted' : 'rounded-2xl')

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/40">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-background px-4 py-2">
        <ToggleGroup type="single" variant="outline" value={mode} onValueChange={(v) => v && onModeChange(v as ViewMode)} aria-label="Which view to preview">
          <ToggleGroupItem value="professor" className="min-h-11 min-w-11">
            Professor
          </ToggleGroupItem>
          <ToggleGroupItem value="student" className="min-h-11 min-w-11">
            Student
          </ToggleGroupItem>
          <ToggleGroupItem value="split" className="min-h-11 min-w-11">
            Both
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="flex flex-wrap items-center gap-2">
          {/* No live role: the builder's status region already says "Preview ready." */}
          {updatedAt && snapshotHash && (
            <Badge variant="secondary">
              <Check aria-hidden="true" />
              Updated <time dateTime={updatedAt.toISOString()}>{updatedAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
            </Badge>
          )}
          {snapshotHash && (
            <Button type="button" variant="outline" size="icon" className="h-11 w-11" aria-label="Reload preview" onClick={() => setReloads((n) => n + 1)}>
              <RotateCw className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
          <ToggleGroup type="single" variant="outline" value={device} onValueChange={(v) => v && onDeviceChange(v as Device)} aria-label="Preview size">
            <ToggleGroupItem value="desktop" aria-label="Desktop size" className="min-h-11 min-w-11">
              <Monitor className="h-4 w-4" aria-hidden="true" />
            </ToggleGroupItem>
            <ToggleGroupItem value="phone" aria-label="Phone size" className="min-h-11 min-w-11">
              <Smartphone className="h-4 w-4" aria-hidden="true" />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-8">
        {note && <p className="mx-auto mb-4 max-w-3xl text-sm text-muted-foreground">{note}</p>}
        {!snapshotHash && building ? (
          <div aria-busy="true" className="space-y-4">
            <p className="mx-auto max-w-3xl text-sm text-muted-foreground">Athena is building your first draft. It appears here once it passes its checks.</p>
            <div className={layout}>
              {views.map((v) => (
                <section key={v} aria-label={VIEW_NAME[v]} className={column}>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{VIEW_NAME[v]}</p>
                  <div className={cn(box, 'space-y-3 p-4')}>
                    <Skeleton className="h-8 w-1/2 rounded-xl" />
                    <Skeleton className="h-24 w-full rounded-xl" />
                    <Skeleton className="h-11 w-full rounded-xl" />
                    <Skeleton className="h-11 w-2/3 rounded-xl" />
                  </div>
                </section>
              ))}
            </div>
          </div>
        ) : !snapshotHash ? (
          <EmptyState
            variant="teaching"
            icon={Blocks}
            title="Your tool appears here"
            description="Describe it in the chat. When Athena finishes a build that passes its checks, the professor view and the student view run here on sample data, at desktop or phone size."
            className="mx-auto max-w-3xl"
          />
        ) : (
          <div className={layout}>
            {views.map((v) => (
              <section key={v} aria-label={VIEW_NAME[v]} className={column}>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{VIEW_NAME[v]}</p>
                <div
                  data-updated={highlight || undefined}
                  className={cn(box, 'ring-primary/40 motion-safe:transition-shadow motion-safe:duration-700', highlight && 'ring-4')}
                >
                  <DraftFrame key={`${snapshotHash}-${v}-${reloads}`} sectionId={sectionId} pluginProjectId={pluginProjectId} snapshotHash={snapshotHash} view={v} />
                </div>
              </section>
            ))}
          </div>
        )}
        <p className="mx-auto mt-4 max-w-3xl text-xs text-muted-foreground">Sample data. Students don’t see drafts.</p>
      </div>
    </div>
  )
}
