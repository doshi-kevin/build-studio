'use client'

import { useEffect, useState } from 'react'
import { Blocks, Monitor, Smartphone } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Skeleton } from '@/components/ui/skeleton'
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

export function StudioPreview({ sectionId, pluginProjectId, snapshotHash, note, mode, device, onModeChange, onDeviceChange }: StudioPreviewProps) {
  const views: ('professor' | 'student')[] = mode === 'split' ? ['professor', 'student'] : [mode]

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
        <ToggleGroup type="single" variant="outline" value={device} onValueChange={(v) => v && onDeviceChange(v as Device)} aria-label="Preview size">
          <ToggleGroupItem value="desktop" aria-label="Desktop size" className="min-h-11 min-w-11">
            <Monitor className="h-4 w-4" aria-hidden="true" />
          </ToggleGroupItem>
          <ToggleGroupItem value="phone" aria-label="Phone size" className="min-h-11 min-w-11">
            <Smartphone className="h-4 w-4" aria-hidden="true" />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-8">
        {note && <p className="mx-auto mb-4 max-w-3xl text-sm text-muted-foreground">{note}</p>}
        {!snapshotHash ? (
          <EmptyState
            variant="teaching"
            icon={Blocks}
            title="Nothing to preview yet"
            description="Once Athena finishes a build that passes its checks, both views run here on sample data."
            className="mx-auto max-w-3xl"
          />
        ) : (
          <div className={cn('mx-auto flex flex-col gap-6 md:flex-row', views.length === 2 ? 'max-w-6xl' : 'max-w-3xl', device === 'phone' && 'items-center md:items-start md:justify-center')}>
            {views.map((v) => (
              <section key={v} aria-label={v === 'professor' ? 'Professor view' : 'Student view'} className={cn('flex min-w-0 flex-col', device === 'phone' ? 'w-full max-w-sm' : 'w-full')}>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{v === 'professor' ? 'Professor view' : 'Student view'}</p>
                <div className={cn('bg-background p-2 shadow-md', device === 'phone' ? 'rounded-3xl border-8 border-muted' : 'rounded-2xl')}>
                  <DraftFrame key={`${snapshotHash}-${v}`} sectionId={sectionId} pluginProjectId={pluginProjectId} snapshotHash={snapshotHash} view={v} />
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
