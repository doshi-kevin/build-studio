'use client'

import { useEffect, useId, useRef, useState, useTransition } from 'react'
import {
  Bookmark,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  GraduationCap,
  Hammer,
  HelpCircle,
  ListChecks,
  Loader2,
  Pencil,
  Presentation,
  RotateCcw,
  ShieldCheck,
  Square,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { STUDIO_BUILDER_QUEUE_NOTICE_MS } from '@/lib/studio/limits'
import { cn } from '@/lib/utils'
import { RUN_STATUS, TONE_CHIP, type ProgressRead, type Tone } from './types'

/** A small tinted label. Text and an icon carry the meaning; the tint only supports it. */
export function Chip({ tone, icon: Icon, children }: { tone: Tone; icon?: LucideIcon; children: React.ReactNode }) {
  return (
    <span className={cn('inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold', TONE_CHIP[tone])}>
      {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
      {children}
    </span>
  )
}

const STATUS_ICON: Record<ProgressRead['status'], LucideIcon> = {
  queued: Hammer,
  running: Hammer,
  waiting_for_approval: ShieldCheck,
  waiting_for_professor: HelpCircle,
  preview_ready: CheckCircle2,
  completed: Check,
  cancelled: Square,
  failed: TriangleAlert,
  blocked: TriangleAlert,
  budget_exhausted: TriangleAlert,
}

/** A build's status in the one vocabulary the builder uses everywhere. */
export function StatusChip({ status }: { status: ProgressRead['status'] }) {
  const { label, tone } = RUN_STATUS[status]
  return (
    <Chip tone={tone} icon={STATUS_ICON[status]}>
      {label}
    </Chip>
  )
}

const RELEASE_STEPS = ['Save a version', 'Add to course', 'Show to students'] as const

/** How a draft reaches students, with the professor's place in it. `step` is the current one. */
export function ReleaseSteps({ step }: { step: 1 | 2 | 3 }) {
  return (
    <ol aria-label="Before students see it" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {RELEASE_STEPS.map((label, i) => {
        const n = i + 1
        const done = n < step
        const current = n === step
        return (
          <li key={label} aria-current={current ? 'step' : undefined} className="inline-flex items-center gap-1.5">
            {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" />}
            <span
              className={cn(
                'flex size-5 items-center justify-center rounded-full font-semibold',
                current ? 'bg-primary text-primary-foreground' : done ? 'bg-success-muted text-success-muted-foreground' : 'bg-muted text-muted-foreground',
              )}
              aria-hidden="true"
            >
              {done ? <Check className="h-3 w-3" /> : n}
            </span>
            <span className={current ? 'font-semibold text-ink' : 'text-muted-foreground'}>
              {label}
              {done && <span className="sr-only">, done</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

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

/** The four stages a professor sees. Phases and fixed progress labels map onto them. */
const STAGES = ['Plan', 'Build', 'Check', 'Polish'] as const
const STAGE_OF_PHASE: Record<string, number> = { understanding: 0, planning: 0, editing: 1, checking: 2, repairing: 2, reviewing: 3, improving: 3 }
// The phase steps back to editing and checking during repair and improve rounds, so the stage
// reached is also read from the run's fixed progress labels. Stateless, so it is right on reopen too.
const STAGE_OF_LABEL: Record<string, number> = {
  'Checks passed': 2,
  'Found issues to fix': 2,
  'Fixing what the checks found': 2,
  'Rendering the preview': 3,
  'Design review passed': 3,
  'Found improvements to make': 3,
  'Improving the interface': 3,
}

/** The stage a run has reached; -1 while it waits for a worker. */
export function buildStage(phase: string | null | undefined, events: ProgressRead['events'], queuedMs: number | null | undefined): number {
  if (queuedMs != null) return -1
  return Math.max(STAGE_OF_PHASE[phase ?? 'understanding'] ?? 0, ...events.map((e) => STAGE_OF_LABEL[e.label] ?? -1))
}

function StageBar({ stage }: { stage: number }) {
  return (
    <ol aria-label="Build stages" className="grid grid-cols-4 gap-2">
      {STAGES.map((label, i) => (
        <li key={label} aria-current={i === stage ? 'step' : undefined} className="space-y-1.5">
          <span className={cn('block h-1 rounded-full', i <= stage ? 'bg-primary' : 'bg-muted')} aria-hidden="true" />
          <span className={cn('block text-xs', i === stage ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
            {label}
            {i < stage && <span className="sr-only">, done</span>}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** The run's steps as lines, consecutive repeats collapsed. */
const stepLines = (events: ProgressRead['events']) => events.filter((e, i) => i === 0 || e.label !== events[i - 1].label)

function StepLines({ lines, children }: { lines: ProgressRead['events']; children?: React.ReactNode }) {
  return (
    <ul className="space-y-1.5 text-sm">
      {lines.map((e) => (
        <li key={e.seq} className="flex items-center gap-2 text-muted-foreground">
          {e.outcome === 'done' ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
          ) : (
            <CircleSlash className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          {e.label}
        </li>
      ))}
      {children}
    </ul>
  )
}

/** The live build: four stages, then the latest fixed-copy steps. Never model reasoning. Stop is in the composer. */
export function ProgressLines({ events, working, phase, queuedMs, loaded, unreachable }: {
  events: ProgressRead['events']
  working: boolean
  phase?: string | null
  queuedMs?: number | null
  /** False until the first progress read answers: show nothing that might be wrong. */
  loaded: boolean
  unreachable: boolean
}) {
  const offline = unreachable && (
    <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      Can’t reach Scholera right now. Still trying…
    </p>
  )
  if (!loaded) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-24 w-full rounded-2xl" />
        {offline}
      </div>
    )
  }
  const lines = stepLines(events)
  return (
    <div className="space-y-4 rounded-2xl border border-border bg-card p-4 shadow-card">
      <StageBar stage={buildStage(phase, events, queuedMs)} />
      <StepLines lines={lines.slice(-4)}>
        {working && (
          <li className="flex items-center gap-2 font-medium text-ink">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
            {workingCopy(phase, queuedMs, lines.at(-1)?.label)}
          </li>
        )}
      </StepLines>
      {working && queuedTooLong(queuedMs) && <p className="text-sm text-muted-foreground">This is taking longer than usual. You can stop and try again.</p>}
      {offline}
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
      <CollapsibleContent className="rounded-2xl border border-border bg-card p-4">
        <StepLines lines={lines} />
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Plain-text items with small brand dots. */
function DotList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1 text-sm">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2 break-words">
          <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary/40" aria-hidden="true" />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  )
}

/** Athena's plan: her own words, labelled as hers and shown as plain text. `notBuilt`: the run ended without building it. */
export function PlanCard({ plan, notBuilt = false }: { plan: NonNullable<ProgressRead['plan']>; notBuilt?: boolean }) {
  const views = [
    { name: 'Professor view', icon: Presentation, items: plan.professor },
    { name: 'Student view', icon: GraduationCap, items: plan.student },
  ].filter((v) => v.items.length > 0)
  return (
    <section aria-label="Athena’s plan" className="space-y-3 rounded-2xl border border-border bg-card p-4 shadow-card">
      <div className="flex items-center gap-2">
        <ListChecks className="h-4 w-4 text-primary" aria-hidden="true" />
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Athena’s plan</p>
        {notBuilt && (
          <Badge variant="outline" className="ml-auto">
            Not built
          </Badge>
        )}
      </div>
      <p className={cn('whitespace-pre-wrap break-words text-sm font-medium', notBuilt ? 'text-muted-foreground' : 'text-ink')}>{plan.goal}</p>
      {views.length > 0 && (
        <div className="space-y-3">
          {views.map((v) => (
            <div key={v.name} className="space-y-1">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                <v.icon className="h-3.5 w-3.5" aria-hidden="true" />
                {v.name}
              </p>
              <DotList items={v.items} />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** The card for anything waiting on the professor: a tinted strip naming it, then the body. */
function NeedsYou({ icon: Icon, strip, label, labelledBy, children }: {
  icon: LucideIcon
  strip: string
  label?: string
  labelledBy?: string
  children: React.ReactNode
}) {
  return (
    <section aria-label={label} aria-labelledby={labelledBy} className="overflow-hidden rounded-2xl border border-primary/30 bg-card shadow-raised ring-4 ring-primary/10">
      <p className="flex items-center gap-2 bg-accent px-4 py-2 text-xs font-semibold text-accent-foreground">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {strip}
      </p>
      <div className="space-y-3 p-4">{children}</div>
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
  const headingId = useId()
  const decide = (approve: boolean) => {
    setClicked(approve)
    start(async () => setError(await onDecide(approve)))
  }
  return (
    <NeedsYou icon={ShieldCheck} strip="Approval needed" labelledBy={headingId}>
      <h3 id={headingId} className="text-sm font-semibold text-ink">
        Athena needs your OK to keep building
      </h3>
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
      <details className="group rounded-xl bg-muted px-3 py-1 text-sm" open={approval.summary.length === 0 || undefined}>
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 font-medium [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-4 w-4 group-open:rotate-90 motion-safe:transition-transform" aria-hidden="true" />
          Show exactly what changes
        </summary>
        <ul className="list-disc space-y-1 pb-2 pl-5 text-muted-foreground">
          {approval.items.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </details>
      {/* After the details: with no summary, the open list is what's being approved. */}
      <div className="flex flex-wrap gap-2">
        <Button type="button" className="min-h-11 flex-1" onClick={() => decide(true)} disabled={pending}>
          {pending && clicked === true ? 'Approving…' : 'Approve'}
        </Button>
        <Button type="button" variant="outline" className="min-h-11 flex-1" onClick={() => decide(false)} disabled={pending}>
          {pending && clicked === false ? 'Declining…' : 'Build without this'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        This only lets Athena keep building your draft. Nothing is installed or shown to students until you choose to.
      </p>
      <WaitingUntil expiresAt={approval.expiresAt} />
      {/* No live role: the conversation log around this card announces it. */}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </NeedsYou>
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
    <li className="space-y-2 rounded-xl bg-card p-3">
      <p className="text-xs font-medium text-muted-foreground">{proposal.categoryLabel}</p>
      <p className="text-sm font-medium text-ink">{proposal.statement}</p>
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
    <section aria-labelledby="memory-heading" className="space-y-3 rounded-2xl bg-accent p-4">
      <div className="flex items-center gap-2">
        <Bookmark className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 id="memory-heading" className="text-sm font-semibold">Remember for this tool?</h3>
      </div>
      <ul className="space-y-2">
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
    <NeedsYou icon={HelpCircle} strip="Athena’s question" label="Athena's question">
      <p className="whitespace-pre-wrap break-words text-sm font-medium text-ink">{question.text}</p>
      <p className="text-xs text-muted-foreground">Type your answer in the box below.</p>
      <WaitingUntil expiresAt={question.expiresAt} />
    </NeedsYou>
  )
}

/** What the professor can do next, where the ending line doesn't already say it.
 * Blocked and budget endings name their own next step. */
const NEXT_STEP: Partial<Record<ProgressRead['status'], string>> = {
  completed: 'If you expected a change, describe it in more detail below.',
  cancelled: 'Send it again, or describe something different below.',
  failed: 'Try again now. If it keeps happening, try again later.',
}

/** Endings where rewording the request can't help: access, pauses and spending limits. */
const NO_EDIT = new Set(['studio_paused', 'not_entitled', 'ai_disabled', 'access_lost', 'project_archived', 'limit_daily_cost'])

/** The outcome's icon tile: success, stopped, a limit, or a failure. */
function OutcomeTile({ status }: { status: ProgressRead['status'] }) {
  const [Icon, tone] =
    status === 'preview_ready' || status === 'completed'
      ? [CheckCircle2, 'bg-success-muted text-success-muted-foreground']
      : status === 'cancelled'
        ? [Square, 'bg-muted text-muted-foreground']
        : status === 'budget_exhausted'
          ? [TriangleAlert, 'bg-warning-muted text-warning-muted-foreground']
          : [TriangleAlert, 'bg-destructive-muted text-destructive-muted-foreground']
  return (
    <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-xl', tone)}>
      <Icon className="h-4 w-4" aria-hidden="true" />
    </span>
  )
}

/** How the build ended: fixed copy first, then what didn't pass, Athena's note, and the next step.
 * Saving lives in the builder's header, so it is there whatever the latest request did. */
export function EndingCard({ progress, saveAvailable = false, onRetry, retrying = false, onEdit, onDecideMemory }: {
  progress: ProgressRead
  /** The draft on screen can be saved: point at the header's Save. */
  saveAvailable?: boolean
  /** Send the same request again. Offered after a stop or a failure. */
  onRetry?: () => void
  retrying?: boolean
  /** Put this request back in the chat box to reword it. */
  onEdit?: () => void
  /** Approve or skip one suggested decision. Resolves to a message when it failed. */
  onDecideMemory?: (memoryId: string, approve: boolean) => Promise<string | null>
}) {
  const materialListId = useId()
  const result = progress.result
  const success = progress.status === 'preview_ready' || progress.status === 'completed'
  const stopped = progress.status === 'cancelled'
  // A replaced run has nothing to retry: the newer request is already running.
  const superseded = stopped && progress.endingReason === 'superseded'
  const ending = progress.ending
  const next = superseded ? undefined : NEXT_STEP[progress.status]
  const retry = onRetry && !superseded && (stopped || progress.status === 'failed')
  const edit = onEdit && !success && !superseded && !NO_EDIT.has(progress.endingReason ?? '')
  const questions = [...new Set(result?.openQuestions ?? [])]
  return (
    <section className="space-y-4 rounded-2xl border border-border bg-card p-4 shadow-card">
      <div className="flex items-start gap-3">
        <OutcomeTile status={progress.status} />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold text-ink">{ending}</p>
          {next && <p className="text-sm text-muted-foreground">{next}</p>}
        </div>
      </div>
      {result && result.unresolved.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What didn’t pass</p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {[...new Set(result.unresolved.map((u) => u.check))].slice(0, 5).map((check) => (
              <li key={check} className="flex gap-2">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
                <span className="min-w-0">{check}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(result?.summary || questions.length > 0) && (
        <div className="space-y-2 border-l-2 border-primary/30 pl-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Athena’s note</p>
          {result?.summary && <p className="whitespace-pre-wrap break-words text-sm text-foreground">{result.summary}</p>}
          {questions.length > 0 && <DotList items={questions} />}
        </div>
      )}
      {(retry || edit) && (
        <div className="flex flex-wrap gap-2">
          {retry && (
            <Button type="button" variant="outline" className="min-h-11 gap-2" disabled={retrying} onClick={onRetry}>
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              {retrying ? 'Sending…' : 'Try again'}
            </Button>
          )}
          {edit && (
            <Button type="button" variant="ghost" className="min-h-11 gap-2" onClick={onEdit}>
              <Pencil className="h-4 w-4" aria-hidden="true" />
              Edit request
            </Button>
          )}
        </div>
      )}
      {success && saveAvailable && <p className="text-sm text-muted-foreground">When both views look right, choose Save at the top right.</p>}
      {onDecideMemory && <MemoryProposals proposals={progress.memory.proposals} onDecide={onDecideMemory} />}
      {progress.memory.applied > 0 && (
        <p className="text-xs text-muted-foreground">Applied {progress.memory.applied} saved decision{progress.memory.applied === 1 ? '' : 's'}.</p>
      )}
      {result && result.materialRead.length > 0 && (
        <div className="border-t border-border pt-3 text-xs text-muted-foreground">
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
