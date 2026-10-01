/**
 * The calm Athena rate-limit UI shown beside a composer.
 *
 * Shared by BOTH Athena chat surfaces — the sidebar console and the assignment /
 * quiz / grading side panel — because each now has its own independent pool and
 * both need to say the same three things about it. Extracted from AssistantConsole
 * when the side panels gained usage state; it is deliberately presentational, so
 * each host owns its own fetching and its own Send gating.
 *
 * Four states, all derived from the server-authoritative usage status:
 *  - below threshold      → nothing
 *  - nearing              → quiet "X% left" line (a percentage — never a raw count)
 *  - one model exhausted  → dismissible "using a backup model" note (never names
 *                           the model — which tier is in play is not the professor's concern)
 *  - all exhausted        → blocking line + live reset countdown (recovers by itself)
 */

'use client'

import { useEffect, useState } from 'react'
import { Clock, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  failoverCandidates,
  percentRemaining,
  type AthenaModelId,
  type AthenaUsageStatus,
} from '@/lib/ai/professor-assistant/models'

/** Format the time until `resetsAt` as "~Xh Ym" / "~Ym"; null once it's passed.
 *  Module-level so the render path never calls Date.now() directly (purity). */
function formatReset(resetsAt: string | null): string | null {
  if (!resetsAt) return null
  const ms = new Date(resetsAt).getTime() - Date.now()
  if (ms <= 0) return null
  const totalMin = Math.ceil(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `~${h}h ${m}m` : `~${m}m`
}

/** Live "resets in ~Xh Ym" countdown. Ticks each half-minute; fires onElapsed once
 *  the window lapses so usage re-fetches and Send re-enables — no manual refresh. */
export function ResetCountdown({
  resetsAt,
  onElapsed,
}: {
  resetsAt: string | null
  onElapsed: () => void
}) {
  const [label, setLabel] = useState(() => formatReset(resetsAt))

  // onElapsed is a stable useCallback (refreshUsage), so depending on it directly
  // doesn't churn the interval.
  useEffect(() => {
    let fired = false
    const tick = () => {
      const next = formatReset(resetsAt)
      setLabel(next)
      if (next === null && !fired) {
        fired = true
        onElapsed()
      }
    }
    tick()
    const id = setInterval(tick, 30_000)
    return () => clearInterval(id)
  }, [resetsAt, onElapsed])

  return label ? <>resets in {label}</> : null
}

/**
 * Stable id so a host can point its disabled Send at the reason with
 * aria-describedby — a button that says only "unavailable" explains nothing.
 */
export const ATHENA_USAGE_NOTICE_ID = 'athena-usage-notice'

export function AthenaUsageNotice({
  usage,
  selectedModelId,
  allExhausted,
  onUsageReset,
  className,
}: {
  usage: AthenaUsageStatus | null
  /** The model this surface asks for. Surfaces with no picker pass the default. */
  selectedModelId: AthenaModelId
  allExhausted: boolean
  onUsageReset: () => void
  /** Host-supplied spacing. The two composers position this differently. */
  className?: string
}) {
  // Dismissal is keyed to the specific switch, so a NEW situation (different pick
  // or failover target) re-shows the note without a setState-in-effect.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)

  const selectedExhausted = usage?.models.find((m) => m.id === selectedModelId)?.exhausted ?? false
  // The model that actually has budget given the pick (registry failover order).
  const activeDef = usage
    ? failoverCandidates(selectedModelId).find((d) => !usage.models.find((m) => m.id === d.id)?.exhausted)
    : undefined
  const activeUsage = activeDef ? usage?.models.find((m) => m.id === activeDef.id) : undefined
  const switched = !!activeDef && selectedExhausted && activeDef.id !== selectedModelId
  const noteKey = switched && activeDef ? `${selectedModelId}->${activeDef.id}` : null

  // Compact, inline — sits in the composer toolbar, not on its own line. Full
  // sentence kept in `title` for hover; usage shown as a percentage or a word
  // state, never a raw request count.
  //
  // Weight escalates with what the professor can still DO:
  //  - nearing  → bare muted text, no chrome. Nothing is required of them.
  //  - switched → tinted chip. Advisory: Athena handled it, work continues. Must NOT
  //    open with "Limit reached" — that is the blocking chip's phrase, and sharing it
  //    trains the professor to skim the one state that actually needs them.
  //  - blocked  → SOLID amber, medium weight. This is the one that disables Send,
  //    so it must not read the same as the advisory note above it — a professor who
  //    learns to skim the tinted chip would otherwise skim the blocking one too.
  //    Clock rather than an alert glyph: nothing is broken, it comes back on its own.
  const content = (() => {
    if (!usage) return null

    if (allExhausted) {
      return (
        <span
          title="You've reached today's Athena usage limit — it resets automatically."
          className="inline-flex min-w-0 items-center gap-1 rounded-full bg-warning px-2 py-0.5 text-xs font-medium text-warning-foreground"
        >
          <Clock className="h-3 w-3 shrink-0" />
          <span className="truncate">
            Limit reached · <ResetCountdown resetsAt={usage.resets_at} onElapsed={onUsageReset} />
          </span>
        </span>
      )
    }

    if (switched && noteKey && dismissedKey !== noteKey && activeDef) {
      return (
        <span
          title="Today's limit on Athena's usual model is used up — it switched to a backup model so you can keep working."
          className="inline-flex min-w-0 items-center gap-1 rounded-full bg-warning-muted py-0.5 pl-2 pr-1 text-xs text-warning-muted-foreground"
        >
          <Info className="h-3 w-3 shrink-0" />
          <span className="truncate">Using a backup model</span>
          <button
            type="button"
            onClick={() => setDismissedKey(noteKey)}
            aria-label="Dismiss"
            // p-1.5 (not p-1) so the hit area clears 24x24 — the dock goes full
            // width below md, making this a real touch target.
            className="-my-0.5 shrink-0 rounded-full p-1.5 transition hover:bg-warning-muted-foreground/10"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )
    }

    if (activeUsage?.nearing && !activeUsage.exhausted) {
      return (
        <span
          title={`You're nearing today's Athena usage limit — ${percentRemaining(activeUsage)}% left.`}
          className="truncate text-xs text-muted-foreground"
        >
          Nearing limit · {percentRemaining(activeUsage)}% left
        </span>
      )
    }

    return null
  })()

  // What a screen reader is TOLD, which is deliberately not what is shown.
  //
  //  - It is STATIC. The visible blocked chip carries a countdown that reticks every
  //    30s; if that lived in the live region it would re-announce the whole sentence
  //    every minute for up to 24 hours. The duration is the one part a screen-reader
  //    user least needs read aloud on a loop.
  //  - Nearing announces NOTHING. Interrupting someone mid-compose to say "13% left"
  //    is worse than silence — it's information, not a change they must react to.
  const announcement = allExhausted
    ? "Athena is unavailable until today's usage limit resets."
    : switched && activeDef
      ? 'Now using a backup model. Athena switched automatically; nothing is required of you.'
      : ''

  return (
    <>
      {/*
        Always mounted, even while empty. Mounting role="status" TOGETHER with its
        text is the classic version of this bug that silently never announces — the
        region has to already exist for a change inside it to be picked up. Both
        states it covers (switched, blocked) happen with no focus event to carry
        them, so this is the only channel a screen-reader user has.
        It is also the aria-describedby target for a host's disabled Send button.
      */}
      <div id={ATHENA_USAGE_NOTICE_ID} role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {/*
        The visible chip renders OUTSIDE the live region, and only when there is
        something to show — an always-mounted visible wrapper would leave the host's
        spacing class behind as orphan margin on the common empty case.
        `flex items-center` rather than a bare block: as a flex item in the console's
        composer toolbar the child must be blockified for `truncate` to apply at all
        (overflow:hidden does nothing to an inline box), and it also keeps the text
        centred against the adjacent buttons instead of sitting on its own baseline.
      */}
      {content && <div className={cn('flex min-w-0 items-center', className)}>{content}</div>}
    </>
  )
}
