/**
 * VerbalCompose: the verbal assessment page BEFORE a preset is chosen. Mirrors NotebookCompose.
 * Picking a preset creates the assignment seeded with that interview layout and opens the
 * editor. No assignment is created until a preset is picked (no orphan drafts).
 *
 * Type: Client Component
 */
'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, Loader2, Microscope, Layers, FilePlus2, Mic, type LucideIcon } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { VERBAL_TEMPLATES } from '@/lib/assignments/verbal/verbal-templates'
import type { TemplateHistoryItem } from '@/lib/assignments/studio/template-history'
import { TemplateHistoryList } from '@/components/professor/assignments/studio/shared/TemplateHistoryList'
import { createVerbalAssessment, cloneStudioAssignment } from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'
import { setResourcePlacement } from '@/lib/roadmap/placement-actions'

const VERBAL_ICONS: Record<string, LucideIcon> = {
  'deep-dive': Microscope,
  'broad-sweep': Layers,
  blank: FilePlus2,
}

export function VerbalCompose({ sectionId, name, templates = [], placementModuleId }: { sectionId: string; name?: string; templates?: TemplateHistoryItem[]; placementModuleId?: string }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [creatingId, setCreatingId] = useState<string | null>(null)
  const [cloningId, setCloningId] = useState<string | null>(null)

  function pick(templateId: string) {
    setCreatingId(templateId)
    startTransition(async () => {
      const res = await createVerbalAssessment(sectionId, templateId, name)
      if ('error' in res) {
        toast.error(res.error)
        setCreatingId(null)
        return
      }
      // Place it under the module picked in the entry-page setup spotlight
      // (best-effort — the publish dialog re-confirms at the commit point).
      if (placementModuleId) {
        const placed = await setResourcePlacement(sectionId, 'assignment', res.assignmentId, placementModuleId)
        if (placed.error) toast.error(placed.error)
      }
      router.push(`/professor/courses/${sectionId}/assignments/${res.assignmentId}/verbal`)
    })
  }

  function reuse(id: string) {
    setCloningId(id)
    startTransition(async () => {
      const res = await cloneStudioAssignment(sectionId, id)
      if ('error' in res) {
        toast.error(res.error)
        setCloningId(null)
        return
      }
      router.push(`/professor/courses/${sectionId}/assignments/${res.assignmentId}/verbal`)
    })
  }

  return (
    <div className="flex h-[calc(100dvh-7rem)] flex-col gap-3">
      <div className="flex items-center gap-3">
        <Link
          href={`/professor/courses/${sectionId}/assignments/new`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">All types</span>
        </Link>
        <span className="h-5 w-px bg-border" />
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Mic className="h-4 w-4" /> {name?.trim() || 'New verbal assessment'}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-border bg-background p-4">
        <div className="mx-auto max-w-3xl space-y-6 py-6">
          <div className="text-center">
            <h2 className="font-[family-name:var(--font-instrument-serif)] text-2xl tracking-tight text-foreground">
              Choose a verbal assessment template
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">Pick a layout to start. Edit the questions, options, and flow in the editor.</p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {VERBAL_TEMPLATES.map((vt) => {
              const Icon = VERBAL_ICONS[vt.id] ?? Mic
              const loading = creatingId === vt.id
              return (
                <button
                  key={vt.id}
                  type="button"
                  disabled={isPending}
                  onClick={() => pick(vt.id)}
                  className="rounded-2xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                >
                  <Card className="h-full gap-0 py-0 transition-[box-shadow,transform] hover:-translate-y-0.5 hover:shadow-md">
                    <CardContent className="flex flex-col gap-3 p-5">
                      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Icon className="h-5 w-5" aria-hidden="true" />}
                      </span>
                      <div>
                        <p className="font-medium text-foreground">{vt.title}</p>
                        <p className="mt-1 text-sm text-muted-foreground">{vt.description}</p>
                      </div>
                    </CardContent>
                  </Card>
                </button>
              )
            })}
          </div>

          <TemplateHistoryList items={templates} onPick={reuse} busyId={cloningId} disabled={isPending} />
        </div>
      </div>
    </div>
  )
}
