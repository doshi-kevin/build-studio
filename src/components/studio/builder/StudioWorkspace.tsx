'use client'

import { useCallback, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowUp, Blocks } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Textarea } from '@/components/ui/textarea'
import { startBuildAction } from '@/app/(dashboard)/professor/courses/[sectionId]/studio/actions'
import { StudioBuilder } from './StudioBuilder'
import { STATUS_BADGE, type DraftSummary, type OpenProject } from './types'

interface StudioWorkspaceProps {
  sectionId: string
  drafts: DraftSummary[]
}

export function StudioWorkspace({ sectionId, drafts }: StudioWorkspaceProps) {
  const router = useRouter()
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [starting, startTransition] = useTransition()
  const [open, setOpen] = useState<{ project: OpenProject; runId: string | null } | null>(null)
  const refreshDrafts = useCallback(() => router.refresh(), [router])

  const start = () => {
    const text = prompt.trim()
    if (!text || starting) return
    setError(null)
    startTransition(async () => {
      const r = await startBuildAction({ sectionId, pluginProjectId: null, request: text, clientRequestId: crypto.randomUUID() })
      if ('error' in r) {
        setError(r.error)
        return
      }
      setPrompt('')
      setOpen({ project: { pluginProjectId: r.pluginProjectId, name: 'New tool', headHash: null }, runId: r.runId })
      refreshDrafts()
    })
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-[family-name:var(--font-instrument-serif)] text-3xl">Studio</h1>
          <Badge variant="secondary">Beta</Badge>
        </div>
        <p className="max-w-prose text-sm text-muted-foreground">
          Describe a tool you want for this course, the way you teach it. Athena builds a view for you and a view for your
          students, checks it, and shows you a preview. Nothing reaches students until you save it, install it and show it.
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          start()
        }}
        className="space-y-2 rounded-2xl bg-card p-4 shadow-sm"
      >
        <div className="flex items-end gap-2 rounded-2xl border border-border bg-background p-2 focus-within:ring-2 focus-within:ring-ring">
          <Textarea
            aria-label="Describe the tool you want"
            placeholder="For example: flashcards my students can flip through for this week’s terms"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                start()
              }
            }}
            className="min-h-0 resize-none border-0 shadow-none focus-visible:ring-0"
          />
          <Button type="submit" className="min-h-11 shrink-0" disabled={!prompt.trim() || starting}>
            <ArrowUp className="h-4 w-4" aria-hidden="true" />
            {starting ? 'Starting…' : 'Build'}
          </Button>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </form>

      <section aria-labelledby="drafts-heading" className="space-y-3">
        <h2 id="drafts-heading" className="text-base font-semibold">
          Your tools
        </h2>
        {drafts.length === 0 ? (
          <EmptyState variant="teaching" icon={Blocks} title="No tools yet" description="Describe a tool above to start one." />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {drafts.map((d) => {
              const badge = d.latestRun ? STATUS_BADGE[d.latestRun.status] : undefined
              return (
                <li key={d.pluginProjectId}>
                  <button
                    type="button"
                    onClick={() => setOpen({ project: { pluginProjectId: d.pluginProjectId, name: d.name, headHash: d.headHash }, runId: d.latestRun?.runId ?? null })}
                    className="flex min-h-11 w-full flex-col items-start gap-2 rounded-2xl bg-card p-4 text-left shadow-sm transition-shadow hover:shadow-md"
                  >
                    <span className="font-medium">{d.name}</span>
                    <span className="flex flex-wrap gap-2">
                      {badge && <Badge variant="secondary">{badge}</Badge>}
                      {d.savedVersion ? <Badge variant="outline">Saved as v{d.savedVersion}</Badge> : d.hasDraft ? <Badge variant="outline">Unsaved draft</Badge> : null}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <StudioBuilder
        key={open ? `${open.project.pluginProjectId}:${open.runId}` : 'closed'}
        sectionId={sectionId}
        project={open?.project ?? null}
        runId={open?.runId ?? null}
        onClose={() => setOpen(null)}
        onChanged={refreshDrafts}
      />
    </div>
  )
}
