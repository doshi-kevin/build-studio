'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { Blocks } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import type { StudioManifest } from '@/lib/studio/manifest'
import type { PluginView } from '@/lib/studio/runtime/protocol'
import { PublicationControls, type PublicationState } from '../publication/PublicationControls'
import { VersionPreviewPicker } from '../publication/VersionPreviewPicker'
import { PluginHost } from './PluginHost'

interface StudioRuntimeViewProps {
  title: string
  view: PluginView
  installationId: string
  versionId: string
  readOnly: boolean
  sectionId: string
  /** Null when this environment has no plugin runtime origin configured. */
  frameUrl: string | null
  allowedMethods: readonly string[]
  preview?: StudioManifest
  /** Previewing a published version that isn't active in this course yet. */
  candidate?: { versionId: string; version: string }
  /** Who can see this tool and the controls to change it; null if it couldn't be read. */
  publication: PublicationState | null
  /** Published versions, newest first, and the one active in this course. */
  versions: { id: string; version: string }[]
  activeVersionId: string
  /** Why the tool is read-only, in a sentence. */
  readOnlyNotice?: string
}

/** The minimal page body for running one plugin. Studio's real UX comes later. */
export function StudioRuntimeView({
  title,
  view,
  installationId,
  versionId,
  readOnly,
  sectionId,
  frameUrl,
  allowedMethods,
  preview,
  candidate,
  publication,
  versions,
  activeVersionId,
  readOnlyNotice,
}: StudioRuntimeViewProps) {
  const router = useRouter()
  const [reloading, startReload] = useTransition()
  const studio = `/professor/courses/${sectionId}/studio`
  const base = `${studio}/${installationId}`
  // Not the Studio page: a school that lost Studio keeps its tools read-only, but its
  // Studio page is a dead end.
  const course = `/professor/courses/${sectionId}`
  // Switching views keeps the version being previewed.
  const withVersion = (path: string, view?: 'student') => {
    const params = new URLSearchParams()
    if (view) params.set('view', view)
    if (candidate) params.set('version', candidate.versionId)
    const query = params.toString()
    return query ? `${path}?${query}` : path
  }
  const studentPreview = view === 'student'
  const activeVersion = versions.find((v) => v.id === activeVersionId)?.version

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-[family-name:var(--font-instrument-serif)] text-3xl">{title}</h1>
          {preview && <Badge variant="secondary">{candidate ? `Preview · v${candidate.version}` : 'Preview'}</Badge>}
        </div>
        <Link
          href={studentPreview ? withVersion(base) : withVersion(base, 'student')}
          className="inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-medium text-primary hover:bg-accent"
        >
          {studentPreview ? (candidate ? 'Preview the professor view' : 'Back to your view') : 'Preview as a student'}
        </Link>
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          {publication ? (
            <PublicationControls
              sectionId={sectionId}
              installationId={installationId}
              previewingOtherVersion={!!candidate}
              {...publication}
            />
          ) : (
            <span />
          )}
          <VersionPreviewPicker
            basePath={base}
            versions={versions}
            activeVersionId={activeVersionId}
            previewingVersionId={candidate?.versionId}
            view={view}
          />
        </div>
        {preview && (
          <p className="w-full text-sm text-muted-foreground">
            {candidate
              ? `Sample data. Your course still uses ${activeVersion ? `v${activeVersion}` : 'the active version'}.`
              : 'Sample data. Students don’t see this.'}
          </p>
        )}
      </header>

      {frameUrl ? (
        <div className="rounded-2xl bg-card p-2 shadow-sm">
          <PluginHost
            frameUrl={frameUrl}
            title={title}
            view={view}
            installationId={installationId}
            versionId={versionId}
            readOnly={readOnly}
            readOnlyNotice={readOnlyNotice}
            allowedMethods={allowedMethods}
            preview={preview}
            // A fresh frame ticket comes from the server; the transition keeps the button
            // honest while that round trip runs.
            onReload={() => startReload(() => router.refresh())}
            reloading={reloading}
            exitHref={course}
            exitLabel="Back to course"
          />
        </div>
      ) : (
        <EmptyState
          icon={Blocks}
          title="Studio tools aren’t available right now"
          description="Try again later. If this keeps happening, ask your administrator."
          action={{ label: 'Back to course', href: course }}
        />
      )}
    </div>
  )
}
