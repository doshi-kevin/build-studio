'use client'

import { useEffect, useState } from 'react'
import { Blocks, Check, Clock, GraduationCap, Info, Lock, Presentation, RotateCw, Rows2, TriangleAlert } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PluginHost } from '@/components/studio/runtime/PluginHost'
import type { PreviewSample } from '@/lib/studio/runtime/preview-bridge'
import type { StudioManifest } from '@/lib/studio/manifest'
import { cn } from '@/lib/utils'
import { draftPreviewAction } from '@/app/(dashboard)/professor/courses/[sectionId]/studio/actions'
import { SEGMENT, SEGMENTED, type ViewMode } from './types'

interface StudioPreviewProps {
  sectionId: string
  pluginProjectId: string
  /** The draft snapshot to run, or null when nothing has been built yet. */
  snapshotHash: string | null
  /** Shown above the frames, e.g. that a newer build is still running. */
  note?: string
  /** The note is about Athena still working or waiting: shown as a quiet status, not an aside. */
  noteBusy?: boolean
  /** A build is running. With nothing built yet, the views show as placeholders until it finishes. */
  building?: boolean
  /** The newest request ended without a draft. With nothing built, the preview says so. */
  lastRunFailed?: boolean
  mode: ViewMode
  onModeChange: (mode: ViewMode) => void
}

type Frame = { frameUrl: string; allowedMethods: string[]; manifest: StudioManifest; title: string; sample: PreviewSample | null } | { error: string } | null

/** One view of the draft in the real sandbox, on sample data. Previews never reach real records. */
function DraftFrame({ sectionId, pluginProjectId, snapshotHash, view }: { sectionId: string; pluginProjectId: string; snapshotHash: string; view: 'student' | 'professor' }) {
  const [frame, setFrame] = useState<Frame>(null)
  // Tickets expire: a reload asks the server for a fresh one.
  const [attempt, setAttempt] = useState(0)
  const reloading = frame === null && attempt > 0
  useEffect(() => {
    let live = true
    void draftPreviewAction({ sectionId, pluginProjectId, snapshotHash, view }).then((r) => {
      if (live) setFrame('success' in r ? { frameUrl: r.frameUrl, allowedMethods: r.allowedMethods, manifest: r.manifest, title: r.title, sample: r.sample } : { error: r.error })
    })
    return () => {
      live = false
    }
  }, [sectionId, pluginProjectId, snapshotHash, view, attempt])
  if (!frame) {
    return (
      <div className="p-4">
        <Skeleton className="h-128 w-full rounded-xl" />
      </div>
    )
  }
  if ('error' in frame) {
    return (
      <div className="space-y-2 p-6">
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
      sample={frame.sample}
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
const VIEW_ICON = { professor: Presentation, student: GraduationCap } as const

/** One view in a window: a slim title bar naming it, the frame flush underneath. */
function ViewWindow({ view, highlight = false, children }: { view: 'professor' | 'student'; highlight?: boolean; children: React.ReactNode }) {
  const Icon = VIEW_ICON[view]
  return (
    <section
      aria-label={VIEW_NAME[view]}
      data-updated={highlight || undefined}
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-2xl bg-card shadow-raised ring-1 ring-border motion-safe:transition-shadow motion-safe:duration-700',
        highlight && 'ring-4 ring-primary/40',
      )}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-muted/50 px-4">
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <p className="text-xs font-semibold text-foreground">{VIEW_NAME[view]}</p>
      </div>
      {children}
    </section>
  )
}

export function StudioPreview({ sectionId, pluginProjectId, snapshotHash, note, noteBusy = false, building = false, lastRunFailed = false, mode, onModeChange }: StudioPreviewProps) {
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

  // Both stacks the views: side by side, each frame would fall under the kit's 640px breakpoint
  // and show its phone layout.
  const layout = 'mx-auto grid w-full max-w-5xl gap-6'
  const banner = (text: string, busy: boolean) => (
    <p className={cn('mx-auto mb-6 flex max-w-5xl items-center gap-2 rounded-xl px-4 py-3 text-sm', busy ? 'bg-info-muted text-info-muted-foreground' : 'bg-card text-foreground shadow-card')}>
      {busy ? <Clock className="h-4 w-4 shrink-0" aria-hidden="true" /> : <Info className="h-4 w-4 shrink-0" aria-hidden="true" />}
      {text}
    </p>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-6">
        {(snapshotHash || building) && (
          <ToggleGroup type="single" spacing={1} className={SEGMENTED} value={mode} onValueChange={(v) => v && onModeChange(v as ViewMode)} aria-label="Which view to preview">
            <ToggleGroupItem value="professor" className={cn(SEGMENT, 'gap-2 px-3')}>
              <Presentation className="h-4 w-4" aria-hidden="true" />
              Professor
            </ToggleGroupItem>
            <ToggleGroupItem value="student" className={cn(SEGMENT, 'gap-2 px-3')}>
              <GraduationCap className="h-4 w-4" aria-hidden="true" />
              Student
            </ToggleGroupItem>
            <ToggleGroupItem value="split" className={cn(SEGMENT, 'gap-2 px-3')}>
              <Rows2 className="h-4 w-4" aria-hidden="true" />
              Both
            </ToggleGroupItem>
          </ToggleGroup>
        )}
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {/* No live role: the builder's status region already says "Preview ready." */}
          {updatedAt && snapshotHash && (
            <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-success-muted px-2.5 text-xs font-semibold text-success-muted-foreground">
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              Updated <time dateTime={updatedAt.toISOString()}>{updatedAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
            </span>
          )}
          <span title="Students don’t see drafts. The preview runs on sample data." className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full bg-muted px-3 text-xs font-medium text-muted-foreground">
            <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">Students don’t see drafts · Sample data</span>
          </span>
          {snapshotHash && (
            <Button type="button" variant="ghost" size="icon" className="h-11 w-11 shrink-0" aria-label="Reload preview" onClick={() => setReloads((n) => n + 1)}>
              <RotateCw className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-muted p-8">
        {note && banner(note, noteBusy)}
        {!snapshotHash && building ? (
          <div aria-busy="true">
            {banner('Athena is building your first draft. It appears here once it passes its checks.', true)}
            <div className={layout}>
              {views.map((v) => (
                <ViewWindow key={v} view={v}>
                  <div className="space-y-3 p-6">
                    <Skeleton className="h-8 w-1/2 rounded-xl" />
                    <Skeleton className="h-24 w-full rounded-xl" />
                    <Skeleton className="h-11 w-full rounded-xl" />
                    <Skeleton className="h-11 w-2/3 rounded-xl" />
                  </div>
                </ViewWindow>
              ))}
            </div>
          </div>
        ) : !snapshotHash && lastRunFailed ? (
          <EmptyState
            variant="teaching"
            icon={TriangleAlert}
            title="No draft yet"
            description="Athena’s last build didn’t finish, so there’s nothing to preview. The chat on the right says what happened and what to try next."
            className="mx-auto mt-16 max-w-xl"
          />
        ) : !snapshotHash ? (
          <EmptyState
            variant="teaching"
            icon={Blocks}
            title="Your tool appears here"
            description="Describe it in the chat. When Athena finishes a build that passes its checks, the professor view and the student view run here on sample data."
            className="mx-auto mt-16 max-w-xl"
          />
        ) : (
          <div className={layout}>
            {views.map((v) => (
              <ViewWindow key={v} view={v} highlight={highlight}>
                <DraftFrame key={`${snapshotHash}-${v}-${reloads}`} sectionId={sectionId} pluginProjectId={pluginProjectId} snapshotHash={snapshotHash} view={v} />
              </ViewWindow>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
