/**
 * NotebookCompose: the notebook page BEFORE a template is chosen.
 *
 * Shows the sub-template choices (including a Blank notebook and an .ipynb upload). Picking
 * one creates the assignment seeded with that layout and opens the Studio. No assignment is
 * created until a template is picked (no orphan drafts). The assignment `name` is collected
 * on the entry page and threaded through as the new assignment's title.
 *
 * Type: Client Component
 */
'use client'

import { useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, Loader2, FlaskConical, LineChart, Upload, FilePlus2, NotebookPen, type LucideIcon } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { NOTEBOOK_TEMPLATES } from '@/lib/assignments/studio/notebook-templates'
import type { TemplateHistoryItem } from '@/lib/assignments/studio/template-history'
import { TemplateHistoryList } from './shared/TemplateHistoryList'
import { parseNotebookModel } from '@/lib/assignments/studio/notebook-model'
import { createNotebookAssignment, cloneStudioAssignment } from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'
import { setResourcePlacement } from '@/lib/roadmap/placement-actions'

const NOTEBOOK_ICONS: Record<string, LucideIcon> = {
  'ml-assignment': FlaskConical,
  'data-science': LineChart,
  blank: FilePlus2,
}

export function NotebookCompose({ sectionId, name, templates = [], placementModuleId }: { sectionId: string; name?: string; templates?: TemplateHistoryItem[]; placementModuleId?: string }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [creatingId, setCreatingId] = useState<string | null>(null)
  const [cloningId, setCloningId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function create(templateId: string, uploadedNotebook?: unknown) {
    setCreatingId(templateId)
    startTransition(async () => {
      const res = await createNotebookAssignment(sectionId, templateId, uploadedNotebook, name)
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
      router.push(`/professor/courses/${sectionId}/assignments/${res.assignmentId}/studio`)
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
      router.push(`/professor/courses/${sectionId}/assignments/${res.assignmentId}/studio`)
    })
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    const parsed = parseNotebookModel(await file.text())
    if (!parsed) {
      toast.error("That file isn't a valid .ipynb notebook.")
      return
    }
    create('upload', parsed)
  }

  return (
    <div className="flex h-[calc(100dvh-7rem)] flex-col gap-3">
      {/* Top bar */}
      <div className="flex items-center gap-3">
        <Link
          href={`/professor/courses/${sectionId}/assignments/new`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">All types</span>
        </Link>
        <span className="h-5 w-px bg-border" />
        <span className="text-sm font-medium text-foreground">{name?.trim() || 'New notebook'}</span>
      </div>

      {/* Body: template choices */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-border bg-background p-4">
        <div className="mx-auto max-w-3xl space-y-6 py-6">
          <div className="text-center">
            <h2 className="font-[family-name:var(--font-instrument-serif)] text-2xl tracking-tight text-foreground">
              Choose a notebook template
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">Pick a layout to start, or upload your own .ipynb.</p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {NOTEBOOK_TEMPLATES.map((nt) => {
              const Icon = NOTEBOOK_ICONS[nt.id] ?? NotebookPen
              const loading = creatingId === nt.id
              return (
                <TemplateCard
                  key={nt.id}
                  icon={Icon}
                  title={nt.title}
                  description={nt.description}
                  loading={loading}
                  disabled={isPending}
                  onClick={() => create(nt.id)}
                />
              )
            })}

            {/* Upload an existing .ipynb — opens as an editable notebook in the studio */}
            <TemplateCard
              icon={Upload}
              title="Upload Template"
              description="Import an .ipynb file and edit it as a notebook."
              loading={creatingId === 'upload'}
              disabled={isPending}
              onClick={() => fileInputRef.current?.click()}
            />
          </div>

          <TemplateHistoryList items={templates} onPick={reuse} busyId={cloningId} disabled={isPending} />
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".ipynb,application/x-ipynb+json,application/json"
        className="hidden"
        onChange={onFilePicked}
      />
    </div>
  )
}

function TemplateCard({
  icon: Icon, title, description, loading, disabled, onClick,
}: {
  icon: LucideIcon
  title: string
  description: string
  loading: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-2xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
    >
      <Card className="h-full gap-0 py-0 transition-[box-shadow,transform] hover:-translate-y-0.5 hover:shadow-md">
        <CardContent className="flex flex-col gap-3 p-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Icon className="h-5 w-5" aria-hidden="true" />}
          </span>
          <div>
            <p className="font-medium text-foreground">{title}</p>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          </div>
        </CardContent>
      </Card>
    </button>
  )
}
