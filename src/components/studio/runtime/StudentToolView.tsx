'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { Blocks } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { PluginHost } from './PluginHost'

interface StudentToolViewProps {
  title: string
  installationId: string
  versionId: string
  readOnly: boolean
  sectionId: string
  /** Null when this environment has no plugin runtime origin configured. */
  frameUrl: string | null
  allowedMethods: readonly string[]
}

/** A Studio plugin's student view, inside the course. No editing or publishing here. */
export function StudentToolView({
  title,
  installationId,
  versionId,
  readOnly,
  sectionId,
  frameUrl,
  allowedMethods,
}: StudentToolViewProps) {
  const router = useRouter()
  const [reloading, startReload] = useTransition()
  const course = `/student/courses/${sectionId}`

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="font-[family-name:var(--font-instrument-serif)] text-3xl">{title}</h1>
      {frameUrl ? (
        <div className="rounded-2xl bg-card p-2 shadow-sm">
          <PluginHost
            frameUrl={frameUrl}
            title={title}
            view="student"
            installationId={installationId}
            versionId={versionId}
            readOnly={readOnly}
            allowedMethods={allowedMethods}
            // A fresh frame ticket comes from the server.
            onReload={() => startReload(() => router.refresh())}
            reloading={reloading}
            exitHref={course}
            exitLabel="Back to course"
          />
        </div>
      ) : (
        <EmptyState
          icon={Blocks}
          title="This tool isn’t available right now"
          description="Try again later."
          action={{ label: 'Back to course', href: course }}
        />
      )}
    </div>
  )
}
