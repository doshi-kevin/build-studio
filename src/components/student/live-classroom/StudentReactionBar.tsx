// Student pacing reactions (#36). Four buttons that emit an ephemeral
// `reaction` on the room's :ephem channel — no server hop, no persistence.
// After a tap, a colored fill drains left-to-empty over REACTION_VISIBLE_MS —
// the exact window the professor's badge counts it for — so the student can see
// how long their signal is live. A per-kind cooldown prevents spamming.

'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { Check } from 'lucide-react'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import type { ReactionKind } from '@/lib/live-classroom/broadcast/types'
import { sendReaction } from '@/lib/live-classroom/reactions/send-reaction'
import { REACTION_KINDS } from '@/lib/live-classroom/reactions/reaction-kinds'
import { REACTION_VISIBLE_MS } from '@/lib/live-classroom/reactions/constants'

const COOLDOWN_MS = 3000
/** How long the "Sent" confirmation stays before settling into the cooldown. */
const SENT_FLASH_MS = 800

interface Props {
  userId: string
  /**
   * The room's SUBSCRIBED ephemeral channel, owned by StudentClassroomView.
   *
   * This component used to build its own with `supabase.channel(ephemeralTopic(roomId))`,
   * on the stated belief that "Supabase dedups by topic". It does not: that produced a
   * SECOND channel object which was never subscribed, and sending on an unsubscribed
   * channel is a different path from sending on a joined one. Students got a "Sent" tick
   * and the professor's badge never moved (#641). The realtime INSERT policy on the
   * `:ephem` topic does permit an enrolled student to write, so authorization was never
   * the problem — the channel was.
   *
   * Null until the room's channel finishes joining; the buttons stay inert until then
   * rather than firing into nothing.
   */
  ephemeralChannel: RealtimeChannel | null
}

export function StudentReactionBar({ userId, ephemeralChannel }: Props) {
  const [cooling, setCooling] = useState<Record<string, boolean>>({})
  // Brief positive "Sent" beat — fire-and-forget has no server ack, so confirm
  // receipt to the student rather than only dimming the button.
  const [justSent, setJustSent] = useState<Record<string, boolean>>({})
  // Per-kind nonce (0 = inactive). Set to a fresh value on each tap so the
  // drain overlay re-mounts and restarts; cleared when the drain finishes.
  const [windowKey, setWindowKey] = useState<Record<string, number>>({})

  const react = (kind: ReactionKind) => {
    if (!ephemeralChannel || cooling[kind]) return
    /* send() RESOLVES with 'ok' | 'timed out' | 'error' — it does not reject — so the
       old `.catch(() => {})` could never fire and the "Sent" tick below was shown
       whatever happened. Students reported reacting and being confirmed while the
       professor received nothing (#641); an undeliverable reaction must not look
       delivered. Failure is surfaced instead of swallowed, which also makes the
       remaining delivery question observable rather than invisible. */
    void sendReaction(ephemeralChannel, { kind, userId }).then(
      (status) => {
        if (status === 'ok') return
        logger.warn('StudentReactionBar.react: reaction not delivered', { kind, status })
        toast.error("That reaction didn't reach your professor — check your connection.")
      },
      (err: unknown) => {
        logger.warn('StudentReactionBar.react: reaction send threw', { kind, err: String(err) })
        toast.error("That reaction didn't reach your professor — check your connection.")
      },
    )
    setCooling((prev) => ({ ...prev, [kind]: true }))
    setJustSent((prev) => ({ ...prev, [kind]: true }))
    setWindowKey((prev) => ({ ...prev, [kind]: (prev[kind] ?? 0) + 1 }))
    setTimeout(() => {
      setJustSent((prev) => ({ ...prev, [kind]: false }))
    }, SENT_FLASH_MS)
    setTimeout(() => {
      setCooling((prev) => ({ ...prev, [kind]: false }))
    }, COOLDOWN_MS)
  }

  return (
    <div className="rounded-2xl border border-border bg-muted/20 px-3 py-3">
      <p className="text-xs uppercase tracking-widest font-semibold text-muted-foreground mb-2.5 px-0.5">
        Let your professor know
      </p>
      <div className="grid grid-cols-2 gap-2">
        {REACTION_KINDS.map(({ kind, label, Icon }) => {
          const isCooling = cooling[kind]
          const sent = justSent[kind]
          const draining = windowKey[kind]
          return (
            <button
              key={kind}
              type="button"
              onClick={() => react(kind)}
              disabled={isCooling}
              className={`relative overflow-hidden flex items-center justify-center gap-2 rounded-full border px-3 py-2.5 text-xs font-medium transition duration-200 ease-out ${
                sent
                  ? 'border-success/50 bg-success-muted text-success-muted-foreground'
                  : isCooling
                    ? 'border-border bg-background opacity-50'
                    : 'border-border bg-background hover:border-foreground/40 hover:bg-muted/40'
              }`}
            >
              {/* "Visible to prof" drain — fills the button then recedes left
                  over the same window the prof counts the reaction for. */}
              {draining ? (
                <motion.span
                  key={draining}
                  aria-hidden
                  initial={{ scaleX: 1 }}
                  animate={{ scaleX: 0 }}
                  transition={{ duration: REACTION_VISIBLE_MS / 1000, ease: 'linear' }}
                  onAnimationComplete={() =>
                    setWindowKey((prev) => ({ ...prev, [kind]: 0 }))
                  }
                  className="pointer-events-none absolute inset-0 origin-left bg-success/20"
                />
              ) : null}
              <span className="relative z-10 flex items-center gap-2 min-w-0">
                {sent ? (
                  <Check className="h-4 w-4 shrink-0" strokeWidth={2.5} aria-hidden />
                ) : (
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="truncate">{sent ? 'Sent' : label}</span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
