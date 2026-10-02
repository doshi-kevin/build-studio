'use client'

import { useState, useTransition } from 'react'
import { Bookmark, CheckCircle2, CircleSlash, Eye, HelpCircle, Loader2, RotateCcw, ShieldCheck, Square, TriangleAlert } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import type { ProgressRead } from './types'

/** Fixed-copy progress lines, consecutive repeats collapsed. Never model reasoning. */
export function ProgressLines({ events, working, loaded, unreachable, onStop, stopping }: {
  events: ProgressRead['events']
  working: boolean
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
  const lines = events.filter((e, i) => i === 0 || e.label !== events[i - 1].label)
  return (
    <div className="space-y-3 rounded-2xl bg-muted p-4">
      <ul className="space-y-1.5 text-sm">
        {lines.slice(-8).map((e) => (
          <li key={e.seq} className="flex items-center gap-2 text-muted-foreground">
            {e.outcome === 'done' ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <CircleSlash className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
            {e.label}
          </li>
        ))}
        {working && (
          <li className="flex items-center gap-2 font-medium">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Working…
          </li>
        )}
      </ul>
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
        <h3 id="approval-heading" className="text-sm font-semibold">This tool would:</h3>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {approval.items.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Approving lets Athena keep building this draft. It doesn’t install the tool or show it to students. If you build without
        it, Athena carries on without these changes.
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
function MemoryProposalItem({ proposal, onDecide }: {
  proposal: ProgressRead['memory']['proposals'][number]
  onDecide: (memoryId: string, approve: boolean) => Promise<string | null>
}) {
  const [pending, start] = useTransition()
  const [clicked, setClicked] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Once answered, the buttons stay gone until the card refreshes, so a second click can't hit a closed suggestion.
  const [answered, setAnswered] = useState<'saved' | 'skipped' | null>(null)
  const decide = (approve: boolean) => {
    setClicked(approve)
    start(async () => {
      const failure = await onDecide(proposal.id, approve)
      setError(failure)
      if (!failure) setAnswered(approve ? 'saved' : 'skipped')
    })
  }
  return (
    <li className="space-y-2">
      <p className="text-sm font-medium">{proposal.statement}</p>
      {proposal.evidence && <p className="text-xs text-muted-foreground">You said: “{proposal.evidence}”</p>}
      {proposal.replaces && <p className="text-xs text-muted-foreground">This replaces: “{proposal.replaces}”</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {answered ? (
        <p className="text-sm text-muted-foreground">{answered === 'saved' ? 'Saved.' : 'Skipped.'}</p>
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
  proposals: ProgressRead['memory']['proposals']
  onDecide: (memoryId: string, approve: boolean) => Promise<string | null>
}) {
  if (proposals.length === 0) return null
  return (
    <section aria-labelledby="memory-heading" className="space-y-3 rounded-xl bg-muted p-3">
      <div className="flex items-center gap-2">
        <Bookmark className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 id="memory-heading" className="text-sm font-semibold">Remember for this tool?</h3>
      </div>
      <ul className="space-y-4">
        {proposals.map((p) => (
          <MemoryProposalItem key={p.id} proposal={p} onDecide={onDecide} />
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
export function EndingCard({ progress, canSave, savesOtherDraft = false, onPreview, onSave, onRetry, retrying = false, onDecideMemory }: {
  progress: ProgressRead
  canSave: boolean
  /** This build's draft was undone, so Save keeps the current draft instead. */
  savesOtherDraft?: boolean
  onPreview: () => void
  onSave: () => Promise<{ ok: boolean; message: string }>
  /** Send the same request again. Offered after a stop or a failure. */
  onRetry?: () => void
  retrying?: boolean
  /** Approve or skip one suggested decision. Resolves to a message when it failed. */
  onDecideMemory?: (memoryId: string, approve: boolean) => Promise<string | null>
}) {
  const [saving, start] = useTransition()
  const [saved, setSaved] = useState<{ ok: boolean; message: string } | null>(null)
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
      {result?.previewHash && savesOtherDraft && <p className="text-sm text-muted-foreground">Your current draft isn’t the one this build made. Saving keeps your current draft.</p>}
      {/* No live role: the conversation log around this card announces it. */}
      {saved && <p className={saved.ok ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>{saved.message}</p>}
      {/* Below the main next step: Save stays the one filled button. */}
      {onDecideMemory && <MemoryProposals proposals={progress.memory.proposals} onDecide={onDecideMemory} />}
      {progress.memory.applied > 0 && (
        <p className="text-xs text-muted-foreground">Applied {progress.memory.applied} saved decision{progress.memory.applied === 1 ? '' : 's'}.</p>
      )}
    </section>
  )
}
