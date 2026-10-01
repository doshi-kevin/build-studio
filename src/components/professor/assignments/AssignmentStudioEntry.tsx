/**
 * AssignmentStudioEntry: the full-page chooser (reached from "New assignment").
 *
 * Shows the 3 core creators (via CoreCreatorCards), a featured-templates row of 3 cards,
 * and a banner linking to the full Template Marketplace page.
 *
 * Type: Client Component
 */
'use client'

import Link from 'next/link'
import { useTransition, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Bot, ArrowRight } from 'lucide-react'
import { MARKETPLACE_TEMPLATES, DEFAULT_STEM_QUESTIONS } from '@/lib/assignments/studio/marketplace-catalog'
import { createNotebookAssignment, setTemplateSaved } from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'
import { useAthenaDock } from './athena/AssignmentAthenaDock'
import { CoreCreatorCards } from './CoreCreatorCards'
import { TemplateCard } from './TemplateCard'
import type { TemplateHistoryItem } from '@/lib/assignments/studio/template-history'

/** IDs of the three featured templates shown on the entry screen. */
const FEATURED_IDS = ['stem-biology', 'ml-assignment', 'stem-maths'] as const

const FEATURED_TEMPLATES = FEATURED_IDS
  .map((id) => MARKETPLACE_TEMPLATES.find((t) => t.id === id))
  .filter(Boolean) as (typeof MARKETPLACE_TEMPLATES)[number][]

export function AssignmentStudioEntry({
  sectionId,
  savedTemplateIds = [],
}: {
  sectionId: string
  recentTemplates?: TemplateHistoryItem[]
  savedTemplateIds?: string[]
}) {
  const router = useRouter()
  const { entitled: athenaEntitled } = useAthenaDock()
  const [isPending, startTransition] = useTransition()
  const [, startSaveTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [saved, setSaved] = useState<Set<string>>(() => new Set(savedTemplateIds))

  const assistantUrl = `/professor/courses/${sectionId}/assistant`
  const marketplaceUrl = `/professor/courses/${sectionId}/assignments/new/marketplace`

  function startTemplate(templateId: string, kind: 'notebook' | 'stem') {
    setBusyId(templateId)
    startTransition(async () => {
      const res = await createNotebookAssignment(
        sectionId, templateId, undefined, undefined,
        kind === 'stem' ? DEFAULT_STEM_QUESTIONS : undefined,
      )
      if ('error' in res) {
        toast.error(res.error)
        setBusyId(null)
        return
      }
      router.push(`/professor/courses/${sectionId}/assignments/${res.assignmentId}/studio`)
    })
  }

  function toggleSaved(id: string) {
    const wasSaved = saved.has(id)
    // Optimistic toggle, reverted if the server write fails.
    setSaved((prev) => {
      const next = new Set(prev)
      if (wasSaved) next.delete(id)
      else next.add(id)
      return next
    })
    startSaveTransition(async () => {
      const res = await setTemplateSaved(sectionId, id, !wasSaved)
      if ('error' in res) {
        toast.error(res.error)
        setSaved((prev) => {
          const next = new Set(prev)
          if (wasSaved) next.add(id)
          else next.delete(id)
          return next
        })
      }
    })
  }

  return (
    <section className="space-y-8">
      <div className="space-y-2 text-center">
        <div className="flex flex-wrap items-center justify-center gap-3">
          <h2 className="font-[family-name:var(--font-instrument-serif)] text-3xl tracking-tight text-foreground">
            What kind of assignment do you want to make?
          </h2>
          {athenaEntitled && (
            <Link
              href={assistantUrl}
              title="Open Athena, she can guide you"
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
            >
              <Bot className="h-4 w-4" aria-hidden="true" />
              Athena
            </Link>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {athenaEntitled ? (
            <>
              Pick how students will work, or{' '}
              <Link href={assistantUrl} className="font-medium text-primary hover:underline">
                Athena can guide you
              </Link>
              .{' '}
            </>
          ) : (
            'Pick how students will work. '
          )}
          You&apos;ll name it as you build, and it&apos;s required before publishing.
        </p>
      </div>

      {/* Core creators */}
      <CoreCreatorCards sectionId={sectionId} />

      {/* Featured templates + browse-all card (opens the full marketplace page) */}
      <div className="mx-auto max-w-5xl space-y-3">
        <p className="text-sm font-medium text-muted-foreground">…or start from a template</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURED_TEMPLATES.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              busy={busyId === t.id}
              disabled={isPending}
              saved={saved.has(t.id)}
              onToggleSave={() => toggleSaved(t.id)}
              onUse={() => startTemplate(t.id, t.kind)}
            />
          ))}
          <Link
            href={marketplaceUrl}
            aria-label="Browse all templates"
            className="group flex h-full min-h-56 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border p-6 text-center transition-colors hover:border-primary/40 hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
              Browse all
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </span>
            <span className="text-xs text-muted-foreground">Every subject + your saved templates</span>
          </Link>
        </div>
      </div>
    </section>
  )
}
