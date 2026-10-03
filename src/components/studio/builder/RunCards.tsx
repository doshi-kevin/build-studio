'use client'

import { useEffect, useId, useRef, useState, useTransition } from 'react'
import { Bookmark, CheckCircle2, ChevronRight, CircleSlash, Eye, HelpCircle, ListChecks, Loader2, RotateCcw, ShieldCheck, Square, TriangleAlert } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { STUDIO_BUILDER_QUEUE_NOTICE_MS } from '@/lib/studio/limits'
import type { ProgressRead } from './types'

/** What Athena is doing right now, from the run's own phase. Fixed copy, never model text. */
const PHASE_COPY: Record<string, string> = {
  understanding: 'Understanding your request…',
  planning: 'Planning the tool…',
  editing: 'Building your tool…',
  checking: 'Running checks…',
  repairing: 'Fixing what the checks found…',
  reviewing: 'Reviewing the design…',
  improving: 'Improving the interface…',
}

/** A queued run no worker has picked up for this long gets a hint under the lines. */
export const queuedTooLong = (queuedMs: number | null | undefined) => queuedMs != null && queuedMs > STUDIO_BUILDER_QUEUE_NOTICE_MS

/**
 * The line with the spinner. A run no worker has picked up says so, rather than "Working…" for
 * minutes. The phase only moves when a tool sets it, so a line that would repeat the step just
 * finished ("Checks passed", then "Running checks…") says what comes next instead: the design
 * review when the run has moved on to it, otherwise the commit.
 */
export function workingCopy(phase: string | null | undefined, queuedMs: number | null | undefined, lastLabel?: string): string {
  if (queuedMs != null) return queuedTooLong(queuedMs) ? 'Still waiting to start…' : 'Starting…'
  if (lastLabel === 'Checks passed' && phase !== 'reviewing') return 'Finishing up…'
  if (lastLabel === 'Design review passed') return 'Finishing up…'
  const copy = PHASE_COPY[phase ?? 'understanding'] ?? 'Working…'
  return lastLabel && copy.startsWith(lastLabel) ? 'Working on the next step…' : copy
}

/** The run's steps as lines, consecutive repeats collapsed. */
const stepLines = (events: ProgressRead['events']) => events.filter((e, i) => i === 0 || e.label !== events[i - 1].label)

function StepLines({ lines, children }: { lines: ProgressRead['events']; children?: React.ReactNode }) {
  return (
    <ul className="space-y-1.5 text-sm">
      {lines.map((e) => (
        <li key={e.seq} className="flex items-center gap-2 text-muted-foreground">
          {e.outcome === 'done' ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <CircleSlash className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}
          {e.label}
        </li>
      ))}
      {children}
    </ul>
  )
}

/** Fixed-copy progress lines, consecutive repeats collapsed. Never model reasoning. */
export function ProgressLines({ events, working, phase, queuedMs, loaded, unreachable, onStop, stopping }: {
  events: ProgressRead['events']
  working: boolean
  phase?: string | null
  queuedMs?: number | null
  /** False until the first progress read answers: show nothing that might be wrong. */
  loaded: boolean
  unreachable: boolean
  onStop: () => void
  stopping: boolean
}) {
  const offline = unreachable && <p className="text-sm text-muted-foreground">Can’t reach Scholera right now. Still trying…</p>
  if (!loaded) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 w-full rounded-2xl" />
        {offline}
      </div>
    )
  }
  const lines = stepLines(events)
  return (
    <div className="space-y-3 rounded-2xl bg-muted p-4">
      <StepLines lines={lines.slice(-8)}>
        {working && (
          <li className="flex items-center gap-2 font-medium">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {workingCopy(phase, queuedMs, lines.at(-1)?.label)}
          </li>
        )}
      </StepLines>
      {working && queuedTooLong(queuedMs) && <p className="text-sm text-muted-foreground">This is taking longer than usual. You can stop and try again.</p>}
      {offline}
      {working && (
        <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={onStop} disabled={stopping}>
          <Square className="h-3.5 w-3.5" aria-hidden="true" />
          {stopping ? 'Stopping…' : 'Stop'}
        </Button>
      )}
    </div>
  )
}

/** Every step of a finished run, closed until the professor opens it. */
export function RunTimeline({ events }: { events: ProgressRead['events'] }) {
  const lines = stepLines(events)
  if (lines.length === 0) return null
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="min-h-11 gap-1.5 px-2 text-muted-foreground [&[data-state=open]>svg]:rotate-90">
          <ChevronRight className="h-4 w-4 motion-safe:transition-transform" aria-hidden="true" />
          What Athena did ({lines.length} {lines.length === 1 ? 'step' : 'steps'})
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="rounded-2xl bg-muted p-4">
        <StepLines lines={lines} />
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Athena's plan: her own words, labelled as hers and shown as plain text. */
export function PlanCard({ plan }: { plan: NonNullable<ProgressRead['plan']> }) {
  const views = [
    { name: 'Professor view', items: plan.professor },
    { name: 'Student view', items: plan.student },
  ].filter((v) => v.items.length > 0)
  return (
    <section aria-label="Athena’s plan" className="space-y-3 rounded-2xl bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <ListChecks className="h-4 w-4 text-primary" aria-hidden="true" />
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Athena’s plan</p>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">{plan.goal}</p>
      {views.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
          {views.map((v) => (
            <div key={v.name} className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">{v.name}</p>
              <ul className="list-disc space-y-0.5 break-words pl-5 text-sm">
                {v.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** "3:40 PM" today, "Fri 3:40 PM" on another day, in the viewer's locale. */
function deadlineLabel(expiresAt: string): string | null {
  const at = new Date(expiresAt)
  if (Number.isNaN(at.getTime())) return null
  const sameDay = at.toDateString() === new Date().toDateString()
  return at.toLocaleString(undefined, sameDay ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

/** How long a card or question waits before the run expires (the server ends it then). */
function WaitingUntil({ expiresAt }: { expiresAt: string | null }) {
  const label = expiresAt ? deadlineLabel(expiresAt) : null
  if (!expiresAt || !label) return null
  return (
    <p className="text-xs text-muted-foreground">
      Waiting for you until <time dateTime={expiresAt}>{label}</time>. After that this request stops, and your tool stays as it is.
    </p>
  )
}

/** The approval card: every line comes from the change itself, never from Athena's words. */
export function ApprovalCard({ approval, onDecide }: {
  approval: NonNullable<ProgressRead['approval']>
  onDecide: (approve: boolean) => Promise<string | null>
}) {
  const [pending, start] = useTransition()
  const [clicked, setClicked] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const decide = (approve: boolean) => {
    setClicked(approve)
    start(async () => setError(await onDecide(approve)))
  }
  return (
    <section aria-labelledby="approval-heading" className="space-y-3 rounded-2xl bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 id="approval-heading" className="text-sm font-semibold">Athena needs your OK to keep building</h3>
      </div>
      {approval.summary.length > 0 && (
        <ul className="space-y-2 text-sm">
          {approval.summary.map((line, i) => (
            <li key={i} className="flex gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      )}
      <details className="group rounded-xl bg-muted px-3 py-2 text-sm" open={approval.summary.length === 0 || undefined}>
        <summary className="flex min-h-11 cursor-pointer items-center font-medium">Show exactly what changes</summary>
        <ul className="list-disc space-y-1 pb-2 pl-5 text-muted-foreground">
          {approval.items.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </details>
      <p className="text-xs text-muted-foreground">
        This only lets Athena keep building your draft. Nothing is installed or shown to students until you choose to.
      </p>
      <WaitingUntil expiresAt={approval.expiresAt} />
      {/* No live role: the conversation log around this card announces it. */}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" className="min-h-11" onClick={() => decide(true)} disabled={pending}>
          {pending && clicked === true ? 'Approving…' : 'Approve'}
        </Button>
        <Button type="button" variant="outline" className="min-h-11" onClick={() => decide(false)} disabled={pending}>
          {pending && clicked === false ? 'Declining…' : 'Build without this'}
        </Button>
      </div>
    </section>
  )
}

/** One suggestion to remember. The words are Athena's; the quote under them is the professor's own. */
type Proposal = ProgressRead['memory']['proposals'][number]
type Answer = 'saved' | 'skipped'

/** "“A”" or "“A” and “B”": what approving would replace. */
const quoted = (items: string[]) => items.map((s) => `“${s}”`).join(' and ')

/** One suggestion to remember. The words are Athena's; the quote under them is the professor's own. */
function MemoryProposalItem({ proposal, answered, onDecide }: {
  proposal: Proposal
  /** Set once the professor has answered. The item stays on screen after the card refreshes. */
  answered: Answer | null
  onDecide: (proposal: Proposal, approve: boolean) => Promise<string | null>
}) {
  const [pending, start] = useTransition()
  const [clicked, setClicked] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The buttons go away on an answer, so focus moves to the line that replaces them. The item
  // outlives the refresh that drops the proposal from the server's list, so focus stays put.
  const done = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (answered) done.current?.focus()
  }, [answered])
  const decide = (approve: boolean) => {
    setClicked(approve)
    start(async () => setError(await onDecide(proposal, approve)))
  }
  return (
    <li className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{proposal.categoryLabel}</p>
      <p className="text-sm font-medium">{proposal.statement}</p>
      {proposal.evidence && <p className="text-xs text-muted-foreground">You said: “{proposal.evidence}”</p>}
      {proposal.replaces.length > 0 && <p className="text-xs text-muted-foreground">This replaces: {quoted(proposal.replaces)}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {answered ? (
        <p ref={done} tabIndex={-1} className="text-sm text-muted-foreground focus:outline-none">
          {answered === 'saved' ? 'Saved.' : 'Skipped.'}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" className="min-h-11" onClick={() => decide(true)} disabled={pending}>
            {pending && clicked === true ? 'Saving…' : 'Remember'}
          </Button>
          <Button type="button" size="sm" variant="ghost" className="min-h-11" onClick={() => decide(false)} disabled={pending}>
            {pending && clicked === false ? 'Skipping…' : 'Not now'}
          </Button>
        </div>
      )}
    </li>
  )
}

/** Decisions Athena heard in this build and suggests keeping for the tool. Nothing is saved until the professor says yes. */
export function MemoryProposals({ proposals, onDecide }: {
  proposals: Proposal[]
  onDecide: (memoryId: string, approve: boolean) => Promise<string | null>
}) {
  // Every suggestion this card has shown, in the order it first appeared, and the answers given.
  // The server stops listing a suggestion once it is decided; the card keeps it, in place.
  const [seen, setSeen] = useState<Proposal[]>(proposals)
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  const fresh = proposals.filter((p) => !seen.some((s) => s.id === p.id))
  if (fresh.length > 0) setSeen([...seen, ...fresh])
  const decide = async (proposal: Proposal, approve: boolean) => {
    const failure = await onDecide(proposal.id, approve)
    if (!failure) setAnswers((prev) => ({ ...prev, [proposal.id]: approve ? 'saved' : 'skipped' }))
    return failure
  }
  const answerOf = (id: string) => answers[id] ?? null
  // A suggestion that left the list without an answer here (it expired) is not shown.
  const shown = seen.filter((s) => answerOf(s.id) !== null || proposals.some((p) => p.id === s.id))
  if (shown.length === 0) return null
  return (
    <section aria-labelledby="memory-heading" className="space-y-3 rounded-xl bg-muted p-3">
      <div className="flex items-center gap-2">
        <Bookmark className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 id="memory-heading" className="text-sm font-semibold">Remember for this tool?</h3>
      </div>
      <ul className="space-y-4">
        {shown.map((p) => (
          <MemoryProposalItem key={p.id} proposal={p} answered={answerOf(p.id)} onDecide={decide} />
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">Studio will remember it the next time you build this tool. Anything you ask for later still comes first.</p>
    </section>
  )
}

/** Athena's question. The professor answers in the chat box below, which sends to this question. */
export function QuestionCard({ question }: { question: NonNullable<ProgressRead['question']> }) {
  return (
    <section aria-label="Athena's question" className="space-y-2 rounded-2xl bg-card p-4 shadow-sm">
      <div className="flex items-start gap-2">
        <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <p className="whitespace-pre-wrap text-sm">{question.text}</p>
      </div>
      <p className="text-xs text-muted-foreground">Type your answer in the box below.</p>
      <WaitingUntil expiresAt={question.expiresAt} />
    </section>
  )
}

/** What the professor can do next, where the ending line doesn't already say it.
 * Blocked and budget endings name their own next step. */
const NEXT_STEP: Partial<Record<ProgressRead['status'], string>> = {
  completed: 'If you expected a change, describe it in more detail below.',
  cancelled: 'Send it again, or describe something different below.',
  failed: 'Try again now. If it keeps happening, try again later.',
}

// Two of the service's fixed endings (endingCopy) need different handling here. The
// progress read has no reason code, so they are matched by their copy.

/** How the build ended: fixed copy first, then Athena's note, then what to do next. */
export function EndingCard({ progress, canSave, savesOtherDraft = false, onPreview, onSave, afterSave, onRetry, retrying = false, onDecideMemory }: {
  progress: ProgressRead
  canSave: boolean
  /** This build's draft was undone, so Save keeps the current draft instead. */
  savesOtherDraft?: boolean
  onPreview: () => void
  onSave: () => Promise<{ ok: boolean; message: string; saved?: { versionId: string; version: string } }>
  afterSave?: (saved: { versionId: string; version: string }) => React.ReactNode
  /** Send the same request again. Offered after a stop or a failure. */
  onRetry?: () => void
  retrying?: boolean
  /** Approve or skip one suggested decision. Resolves to a message when it failed. */
  onDecideMemory?: (memoryId: string, approve: boolean) => Promise<string | null>
}) {
  const [saving, start] = useTransition()
  const [saved, setSaved] = useState<{ ok: boolean; message: string; saved?: { versionId: string; version: string } } | null>(null)
  const materialListId = useId()
  const result = progress.result
  const success = progress.status === 'preview_ready' || progress.status === 'completed'
  const stopped = progress.status === 'cancelled'
  // A replaced run has nothing to retry: the newer request is already running.
  const superseded = stopped && progress.endingReason === 'superseded'
  const ending = progress.ending
  const next = superseded ? undefined : NEXT_STEP[progress.status]
  const retry = onRetry && !superseded && (stopped || progress.status === 'failed')
  const questions = [...new Set(result?.openQuestions ?? [])]
  return (
    <section className="space-y-3 rounded-2xl bg-card p-4 shadow-sm">
      <div className="flex items-start gap-2">
        {success ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        ) : stopped ? (
          <Square className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        )}
        <div className="space-y-1">
          <p className="text-sm font-medium">{ending}</p>
          {next && <p className="text-sm text-muted-foreground">{next}</p>}
        </div>
      </div>
      {result && result.unresolved.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {[...new Set(result.unresolved.map((u) => u.check))].slice(0, 5).map((check) => (
            <li key={check}>{check}</li>
          ))}
        </ul>
      )}
      {result?.previewHash && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="min-h-11 lg:hidden" onClick={onPreview}>
            <Eye className="h-4 w-4" aria-hidden="true" />
            Preview
          </Button>
          {canSave && !saved?.ok && (
            <Button type="button" className="min-h-11" disabled={saving} onClick={() => start(async () => setSaved(await onSave()))}>
              {saving ? 'Checking and saving…' : savesOtherDraft ? 'Save current draft as version' : 'Save as version'}
            </Button>
          )}
        </div>
      )}
      {(result?.summary || questions.length > 0) && (
        <div className="space-y-2 rounded-xl bg-muted p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Athena’s note</p>
          {result?.summary && <p className="whitespace-pre-wrap text-sm">{result.summary}</p>}
          {questions.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {questions.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {retry && (
        <Button type="button" variant="outline" className="min-h-11" disabled={retrying} onClick={onRetry}>
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          {retrying ? 'Sending…' : 'Try again'}
        </Button>
      )}
      {result?.previewHash && savesOtherDraft && <p className="text-sm text-muted-foreground">Your current draft isn’t the one this build made. Saving keeps your current draft.</p>}
      {/* No live role: the conversation log around this card announces it. */}
      {saved && <p className={saved.ok ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>{saved.message}</p>}
      {saved?.ok && saved.saved && afterSave?.(saved.saved)}
      {/* Below the main next step: Save stays the one filled button. */}
      {onDecideMemory && <MemoryProposals proposals={progress.memory.proposals} onDecide={onDecideMemory} />}
      {progress.memory.applied > 0 && (
        <p className="text-xs text-muted-foreground">Applied {progress.memory.applied} saved decision{progress.memory.applied === 1 ? '' : 's'}.</p>
      )}
      {result && result.materialRead.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <p id={materialListId}>Athena read these from your course:</p>
          <ul aria-labelledby={materialListId} className="mt-1 list-disc space-y-0.5 break-words pl-4">
            {result.materialRead.map((m) => (
              <li key={m.label}>
                {m.label}
                {!m.visible && (
                  <span className="text-foreground">
                    {m.opensAt ? ` (students can’t see this until ${new Date(m.opensAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})` : ' (students can’t see this)'}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {result.materialRead.some((m) => !m.visible) && (
            <p className="mt-1">Athena uses material students can’t see yet only to shape the tool, never its wording.</p>
          )}
        </div>
      )}
    </section>
  )
}
