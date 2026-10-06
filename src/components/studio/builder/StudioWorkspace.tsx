'use client'

import { useCallback, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Blocks, Check, ChevronRight, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Textarea } from '@/components/ui/textarea'
import { startBuildAction } from '@/app/(dashboard)/professor/courses/[sectionId]/studio/actions'
import { AthenaMascot } from './AthenaMascot'
import { Chip, StatusChip } from './RunCards'
import { StudioBuilder } from './StudioBuilder'
import { ACTIVE_STATUSES, ENDED_UNBUILT, type DraftSummary, type OpenProject } from './types'

/** Starting points. Each fills the box with a request the professor can edit; none sends on its own. */
const IDEAS = [
  { label: 'Flashcards for this week’s terms', text: 'Flashcards my students can flip through for this week’s key terms, with the term on the front and the definition on the back.' },
  { label: 'Office-hours queue', text: 'An office-hours queue where students join with a short note about what they need, and I call the next student.' },
  { label: 'Exit ticket', text: 'A one-question exit ticket students answer at the end of class, and I see every answer in one list.' },
  { label: 'Attendance', text: 'Attendance I mark from the class roster, where each student sees only their own record.' },
]

/** A tool card's state, from what the drafts list already knows. */
function ToolState({ draft }: { draft: DraftSummary }) {
  const run = draft.latestRun
  const active = !!run && (ACTIVE_STATUSES as readonly string[]).includes(run.status)
  const chips = [
    active && run && <StatusChip key="run" status={run.status} />,
    draft.savedVersion ? (
      <Chip key="saved" tone="success" icon={Check}>
        Saved as v{draft.savedVersion}
      </Chip>
    ) : draft.hasDraft ? (
      <Chip key="draft" tone="neutral">
        Unsaved draft
      </Chip>
    ) : run && ENDED_UNBUILT.includes(run.status) ? (
      <StatusChip key="failed" status={run.status} />
    ) : null,
  ].filter(Boolean)
  if (chips.length === 0) return <span className="text-xs text-muted-foreground">No draft yet</span>
  return <span className="flex flex-wrap gap-2">{chips}</span>
}

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
  const promptRef = useRef<HTMLTextAreaElement>(null)
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
    <div className="studio-brand mx-auto max-w-5xl space-y-10">
      <section aria-labelledby="studio-heading" className="athena-surface space-y-6 rounded-3xl px-6 py-8 shadow-raised sm:px-10 sm:py-10">
        <div className="flex items-start gap-6">
          <div className="min-w-0 flex-1 space-y-3">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-on-athena">
              <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" aria-hidden="true" />
              Studio
              <Badge variant="secondary">Beta</Badge>
            </p>
            <h1 id="studio-heading" className="text-3xl font-bold leading-tight text-primary-foreground sm:text-4xl">
              Describe a tool. Athena <span className="font-serif font-normal italic">builds</span> it.
            </h1>
            <p className="max-w-prose text-sm leading-relaxed text-on-athena">
              Describe a tool you want for this course, the way you teach it. Athena builds a view for you and a view for your
              students, checks it, and shows you a preview. Nothing reaches students until you save it, add it to the course and show it.
            </p>
          </div>
          <AthenaMascot size={112} className="hidden sm:block" />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            start()
          }}
          className="space-y-2"
        >
          <div className="flex flex-col gap-2 rounded-2xl bg-card p-2 shadow-raised sm:flex-row sm:items-end focus-within:ring-4 focus-within:ring-on-athena/50">
            <Textarea
              ref={promptRef}
              aria-label="Describe the tool you want"
              placeholder="For example: flashcards my students can flip through for this week’s terms"
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.repeat) {
                  e.preventDefault()
                  start()
                }
              }}
              className="min-h-0 resize-none border-0 shadow-none focus-visible:ring-0"
            />
            <Button type="submit" className="min-h-11 shrink-0 self-end shadow-glow-brand" disabled={!prompt.trim() || starting}>
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              {starting ? 'Starting…' : 'Build'}
            </Button>
          </div>
          {error && (
            <p role="alert" className="rounded-xl bg-card px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
        {(!prompt || IDEAS.some((i) => i.text === prompt)) && (
          <div role="group" aria-label="Ideas to start from" className="flex flex-wrap gap-2">
            {IDEAS.map((idea) => (
              <button
                key={idea.label}
                type="button"
                aria-pressed={prompt === idea.text}
                onClick={() => {
                  setPrompt(idea.text)
                  promptRef.current?.focus()
                }}
                className="min-h-11 rounded-full border border-on-athena/40 px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-foreground/10 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-on-athena/50"
              >
                {idea.label}
              </button>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="drafts-heading" className="space-y-3">
        <h2 id="drafts-heading" className="text-xl font-bold text-ink">
          Your tools
        </h2>
        {drafts.length === 0 ? (
          <EmptyState variant="teaching" icon={Blocks} title="No tools yet" description="Describe a tool above to start one." />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {drafts.map((d) => (
              <li key={d.pluginProjectId}>
                <button
                  type="button"
                  onClick={() => setOpen({ project: { pluginProjectId: d.pluginProjectId, name: d.name, headHash: d.headHash }, runId: d.latestRun?.runId ?? null })}
                  className="group flex min-h-11 w-full items-center gap-4 rounded-2xl border border-border bg-card p-5 text-left shadow-card transition-[transform,border-color] duration-200 ease-out-quint hover:border-primary/30 motion-safe:hover:-translate-y-0.5"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-primary">
                    <Blocks className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 space-y-2">
                    <span className="block truncate font-display font-semibold text-ink">{d.name}</span>
                    <ToolState draft={d} />
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5" aria-hidden="true" />
                </button>
              </li>
            ))}
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
