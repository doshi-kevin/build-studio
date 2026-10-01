/**
 * StemCompose: the STEM Problem Set page BEFORE a subject is chosen.
 *
 * Shows the subject choices (Maths / Physics / Chemistry / Biology / Blank). Picking a subject
 * opens a small dialog that prompts for the number of questions; on confirm it creates the
 * assignment seeded with that many markdown question cells (ready-made first, subject-scaffolded
 * beyond) and opens the Studio, where each question is edited in markdown and previewed via
 * "View as student". No assignment is created until the dialog is confirmed (no orphan drafts).
 *
 * Type: Client Component
 */
'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, Loader2, Minus, Plus, Sigma, Atom, FlaskConical, Dna, FilePlus2, NotebookPen, type LucideIcon } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { STEM_TEMPLATES, type NotebookTemplate } from '@/lib/assignments/studio/notebook-templates'
import type { TemplateHistoryItem } from '@/lib/assignments/studio/template-history'
import { TemplateHistoryList } from './shared/TemplateHistoryList'
import { createNotebookAssignment, cloneStudioAssignment } from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'

const SUBJECT_ICONS: Record<string, LucideIcon> = {
  'stem-maths': Sigma,
  'stem-physics': Atom,
  'stem-chemistry': FlaskConical,
  'stem-biology': Dna,
  'stem-blank': FilePlus2,
}

const MIN_QUESTIONS = 1
const MAX_QUESTIONS = 20
const DEFAULT_QUESTIONS = 3

export function StemCompose({ sectionId, name, templates = [] }: { sectionId: string; name?: string; templates?: TemplateHistoryItem[] }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [selected, setSelected] = useState<NotebookTemplate | null>(null)
  const [count, setCount] = useState(DEFAULT_QUESTIONS)
  const [cloningId, setCloningId] = useState<string | null>(null)

  function choose(t: NotebookTemplate) {
    setSelected(t)
    setCount(DEFAULT_QUESTIONS)
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

  function create() {
    if (!selected) return
    const templateId = selected.id
    startTransition(async () => {
      const res = await createNotebookAssignment(sectionId, templateId, undefined, name, count)
      if ('error' in res) {
        toast.error(res.error)
        return
      }
      router.push(`/professor/courses/${sectionId}/assignments/${res.assignmentId}/studio`)
    })
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
        <span className="text-sm font-medium text-foreground">{name?.trim() || 'STEM Problem Set'}</span>
      </div>

      {/* Body: subject choices */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-border bg-background p-4">
        <div className="mx-auto max-w-3xl space-y-6 py-6">
          <div className="text-center">
            <h2 className="font-[family-name:var(--font-instrument-serif)] text-2xl tracking-tight text-foreground">
              Choose a subject
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Each subject comes with ready-made questions. Pick one, choose how many questions, then edit each in markdown.
            </p>
          </div>

          <div className="flex flex-wrap justify-center gap-4">
            {STEM_TEMPLATES.map((t) => {
              const Icon = SUBJECT_ICONS[t.id] ?? NotebookPen
              return (
                <button
                  key={t.id}
                  type="button"
                  disabled={isPending}
                  onClick={() => choose(t)}
                  className="w-full rounded-2xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:w-60"
                >
                  <Card className="h-full gap-0 py-0 transition-[box-shadow,transform] hover:-translate-y-0.5 hover:shadow-md">
                    <CardContent className="flex flex-col gap-3 p-5">
                      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <Icon className="h-5 w-5" aria-hidden="true" />
                      </span>
                      <div>
                        <p className="font-medium text-foreground">{t.title}</p>
                        <p className="mt-1 text-sm text-muted-foreground">{t.description}</p>
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

      {/* Prompt for the number of questions once a subject is picked */}
      <Dialog open={selected !== null} onOpenChange={(open) => { if (!open && !isPending) setSelected(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{selected?.title} problem set</DialogTitle>
            <DialogDescription>How many questions do you want? Each becomes a text block you can edit.</DialogDescription>
          </DialogHeader>

          <div className="flex items-center justify-center gap-3 py-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={() => setCount((c) => Math.max(MIN_QUESTIONS, c - 1))}
              disabled={isPending || count <= MIN_QUESTIONS}
              aria-label="Fewer questions"
            >
              <Minus className="h-4 w-4" />
            </Button>
            <span className="w-10 text-center text-2xl font-semibold tabular-nums text-foreground" aria-live="polite">{count}</span>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={() => setCount((c) => Math.min(MAX_QUESTIONS, c + 1))}
              disabled={isPending || count >= MAX_QUESTIONS}
              aria-label="More questions"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setSelected(null)} disabled={isPending}>Cancel</Button>
            <Button type="button" onClick={create} disabled={isPending}>
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Create {count} {count === 1 ? 'question' : 'questions'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
