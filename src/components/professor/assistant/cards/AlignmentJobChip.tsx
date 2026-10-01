'use client'

/**
 * AlignmentJobChip — the live status of an ABET outcome-alignment job, shown as
 * a COMPACT chip inside the composer toolbar (beside the model picker / send),
 * so it costs no extra vertical space and never pins a row over the last message.
 *
 * While running it shows one animated, contextual line — Athenamite("Mapping
 * ‹Lecture 9›…") + elapsed — whose text follows the pipeline's actual phase
 * (gather → map → reduce), derived live from the job's progress/status; amber
 * pulsing dot. Once DONE it renders nothing: the coverage card + Athena's summary
 * are already in the chat, so the toolbar returns to clean. A failed run keeps a
 * small red chip so it isn't silent.
 *
 * On completion it fires onComplete(summary) ONCE (only if we actually watched it
 * finish this session, never on a reload of an already-done job) so the parent can
 * nudge Athena to display the coverage card + talk through it — the
 * task-notification pattern.
 *
 * Reads use the browser (anon) client and are RLS-gated: the job row is visible
 * only to section staff. No admin client here (client component).
 */

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

function elapsedLabel(startedAt: string, now: number): string {
  return `${Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000))}s`
}

/** After this long in the finalising state, the chip admits the wait instead of
 *  looking like steady progress. The reduce step is deterministic string assembly
 *  with no model call, so anything past this is not the work it used to claim. */
const SLOW_FINALISE_MS = 30_000

/** The contextual line that narrates the pipeline's current phase (drives the animation). */
function narratePhase(job: JobRow | null, finalisingForMs: number): string {
  if (!job || job.status === 'pending') return 'Reading your course content'
  const running = job.progress.filter((p) => p.status === 'running')
  if (running.length > 0) {
    const latest = running[running.length - 1]
    return `Mapping ${latest.label} to ABET outcomes`
  }
  if (job.status === 'running') {
    if (job.progress.length === 0) return 'Reading your course content'
    /* Every mapping step has finished and the job has not flipped to done. We do NOT
       know what the remaining time is spent on (#632): on a real cold run all steps
       reported done at ~50s and the status stayed `running` for ~3 minutes more, while
       this chip said "Rolling up coverage and finding gaps" — naming a phase that
       `reduce.ts` does deterministically, with no model call, in about a second.
       Four candidates have been ruled out on the issue and the cause is still open,
       so the honest line is one that claims no phase at all. Past the threshold it
       stops pretending the wait is normal, which is what the issue asks for. */
    return finalisingForMs > SLOW_FINALISE_MS
      ? 'Still finishing up — this is taking longer than usual'
      : 'Finishing up'
  }
  return 'Working'
}

interface ProgressEntry { label: string; status: 'running' | 'done' | 'error'; startedAt: string }
interface JobRow { status: string; progress: ProgressEntry[]; summary: string | null; started_at: string | null }

export function AlignmentJobChip({
  jobId,
  justTriggered = false,
  hasAnnouncement = false,
  onComplete,
  onFailed,
}: {
  jobId: string
  /** True when this job was started live in this pane session (not restored from
   * chat history). A fast run (cache hits / early abort) can be terminal on the
   * chip's FIRST poll — `sawActive` never trips — so this substitutes for it:
   * the professor just asked and must still get the completion announcement. */
  justTriggered?: boolean
  /** Whether this chat's history already contains the completion announcement
   * (the persisted nudge turn). Gates the "Review results" CTA. */
  hasAnnouncement?: boolean
  /** Fired once when the job finishes AND we watched it happen (not on reload). */
  onComplete?: (summary: string | null) => void
  /** Fired once when the job fails AND we watched it happen (not on reload). */
  onFailed?: () => void
}) {
  const [job, setJob] = useState<JobRow | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [dismissed, setDismissed] = useState(false)
  const [ctaFired, setCtaFired] = useState(false)
  // Whether we observed pending/running before a terminal state. State (not a ref)
  // because the render path reads it to gate the failure chip — a ref read during
  // render isn't reactive (react-hooks/refs).
  const [sawActive, setSawActive] = useState(false)
  /* When we first saw "every mapping step finished, job still running" (#632). State
     rather than a ref for the same reason as sawActive: the render path reads it. */
  const [finalisingSince, setFinalisingSince] = useState<number | null>(null)
  const notifiedRef = useRef(false)

  const status = job?.status ?? 'pending'
  const isRunning = !job || status === 'running' || status === 'pending'
  const isDone = status === 'done' || status === 'partial'
  const isFailed = status === 'failed'

  // Poll the job while it runs; stop once terminal.
  useEffect(() => {
    if (!jobId) return
    const supabase = createClient()
    let mounted = true
    const timerRef = { current: null as ReturnType<typeof setInterval> | null }
    const tick = async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any)
        .from('background_jobs')
        .select('status, progress, summary, started_at')
        .eq('id', jobId)
        .maybeSingle()
      if (!mounted || !data) return
      setJob(data as JobRow)
      if (data.status === 'pending' || data.status === 'running') setSawActive(true)
      /* Latch the start of the finalising window — every mapping step finished, job still
         running (#632) — and clear it if a step starts running again (a retry), so a later
         wait is timed from its own beginning rather than the first. Done HERE, in the poll,
         rather than in an effect keyed on the derived boolean: the derived-then-set-state
         version trips react-hooks/set-state-in-effect and costs an extra render per tick. */
      const finalising =
        data.status === 'running' &&
        data.progress.length > 0 &&
        data.progress.every((p: ProgressEntry) => p.status !== 'running')
      setFinalisingSince((prev) => (finalising ? prev ?? Date.now() : null))
      const terminal = data.status === 'done' || data.status === 'partial' || data.status === 'failed'
      if (terminal && timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
    void tick()
    timerRef.current = setInterval(tick, 1000)
    return () => {
      mounted = false
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [jobId])

  // 1s clock so the elapsed counter ticks live while running.
  useEffect(() => {
    if (!isRunning) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [isRunning])

  // Nudge Athena exactly once, only if we watched the job reach a terminal state
  // this session (never on a reload of an already-finished job) — success OR failure,
  // so a failed run isn't silent in the chat.
  useEffect(() => {
    if ((isDone || isFailed) && (sawActive || justTriggered) && !notifiedRef.current) {
      notifiedRef.current = true
      if (isDone) onComplete?.(job?.summary ?? null)
      else onFailed?.()
    }
  }, [isDone, isFailed, sawActive, justTriggered, onComplete, onFailed, job?.summary])

  if (!jobId) return null

  // Done + we watched it (or it's already announced here) → nothing: the
  // coverage card + Athena's summary live (or are landing) in the chat.
  if (isDone) {
    if (sawActive || justTriggered || hasAnnouncement || ctaFired) return null
    // The job finished while this chat wasn't on screen (switched away, reload):
    // offer the result on demand instead of auto-typing into the conversation.
    return (
      <button
        type="button"
        onClick={() => {
          setCtaFired(true)
          notifiedRef.current = true
          onComplete?.(job?.summary ?? null)
        }}
        className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-1 text-xs text-foreground transition hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <CheckCircle2 className="h-3 w-3 flex-none text-primary" />
        <span className="truncate">
          Analysis ready — <span className="font-medium">Review results</span>
        </span>
      </button>
    )
  }

  // Failure: surface the red chip ONLY in the session that watched it fail — on a
  // later reload the durable record is Athena's "couldn't finish" chat message, so a
  // pinned error badge just reads as stuck. Dismissible in the live session too.
  if (isFailed) {
    if ((!sawActive && !justTriggered) || dismissed) return null
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-destructive-muted py-1 pl-2.5 pr-1 text-xs text-destructive-muted-foreground">
        <AlertTriangle className="h-3 w-3 flex-none" />
        <span className="truncate">Analysis couldn&apos;t finish</span>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          className="-my-0.5 flex-none rounded-full p-1 transition hover:bg-destructive-muted-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <X className="h-3 w-3" />
        </button>
      </span>
    )
  }

  const elapsed = job?.started_at ? elapsedLabel(job.started_at, now) : null
  const line = narratePhase(job, finalisingSince ? now - finalisingSince : 0)

  return (
    <span
      title={`Athenamite("${line}…")`}
      className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-warning/30 bg-warning-muted px-2.5 py-1 font-mono text-xs"
    >
      <span className="h-1.5 w-1.5 flex-none rounded-full bg-warning animate-pulse" />
      {/* key on the phrase so each phase change fades/slides in. */}
      <span
        key={line}
        className="min-w-0 truncate text-warning-muted-foreground motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
      >
        <span className="font-medium">Athenamite</span>(&quot;{line}
        <span className="animate-pulse">…</span>&quot;)
      </span>
      {elapsed && <span className="flex-none tabular-nums text-warning-muted-foreground">{elapsed}</span>}
    </span>
  )
}
