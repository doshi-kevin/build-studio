// Pre-class interaction prep — lets a professor queue polls and quizzes as
// drafts while the deck renders. Each one is created via the shared
// NewInteractionComposer (status 'draft'); the prof launches it live later
// from the in-class composer. The queued list is loaded from the server so it
// survives a mid-setup reload, and each item can be removed before class.

'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { BarChart3, FileQuestion, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { NewInteractionComposer } from '@/components/live-classroom/shared/NewInteractionComposer'
import {
  listPreparedInteractions,
  deleteInteraction,
  type PreparedInteraction,
} from '@/lib/live-classroom/interactions/actions'
import { SPRING_SNAPPY } from '@/lib/motion'

interface PreClassInteractionPrepProps {
  roomId: string
}

/** A poll/quiz payload reduced to what the queued list needs to display. */
function describe(item: PreparedInteraction): { title: string; meta: string } {
  const payload = item.payload
  if (item.kind === 'poll') {
    const choices = Array.isArray(payload.choices) ? payload.choices.length : 0
    return {
      title: (payload.question as string) || 'Untitled poll',
      meta: `Poll · ${choices} choices`,
    }
  }
  const questions = Array.isArray(payload.questions) ? payload.questions : []
  const first = (questions[0] ?? {}) as { choices?: unknown[] }
  const choices = Array.isArray(first.choices) ? first.choices.length : 0
  const seconds = typeof payload.timeLimitSeconds === 'number' ? payload.timeLimitSeconds : 60
  return {
    title: (payload.title as string) || 'Untitled quiz',
    meta: `Quiz · ${choices} choices · ${seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`}`,
  }
}

export function PreClassInteractionPrep({ roomId }: PreClassInteractionPrepProps) {
  const [prepared, setPrepared] = useState<PreparedInteraction[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const result = await listPreparedInteractions({ roomId })
    if (!result.error && result.interactions) setPrepared(result.interactions)
    setLoading(false)
  }, [roomId])

  // Load any drafts already queued for this room (recovers after a reload).
  // Guarded so a mid-flight unmount doesn't set state on a dead component.
  useEffect(() => {
    let active = true
    ;(async () => {
      const result = await listPreparedInteractions({ roomId })
      if (!active) return
      if (!result.error && result.interactions) setPrepared(result.interactions)
      setLoading(false)
    })()
    return () => {
      active = false
    }
  }, [roomId])

  const handleDelete = useCallback(
    async (id: string) => {
      if (deletingId) return
      setDeletingId(id)
      const result = await deleteInteraction({ interactionId: id })
      if (result.error) {
        toast.error(result.error)
        // The draft may have changed under us (e.g. launched elsewhere) —
        // resync so the list reflects the truth.
        await refresh()
      } else {
        setPrepared((prev) => prev.filter((i) => i.id !== id))
      }
      setDeletingId(null)
    },
    [deletingId, refresh],
  )

  return (
    <TooltipProvider delayDuration={250}>
      <div>
        <h3 className="text-sm font-semibold">Prep polls &amp; quizzes</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Queue them now, or add more once class starts — launch each with one tap. Optional.
        </p>

        <div className="mt-4">
          <NewInteractionComposer
            roomId={roomId}
            successMessage="Added to your class plan"
            onCreated={refresh}
          />
        </div>

        {/* Queued list */}
        {!loading && prepared.length > 0 && (
          <div className="mt-4 space-y-2">
            <p className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
              Queued ({prepared.length})
            </p>
            <AnimatePresence initial={false}>
              {prepared.map((item) => {
                const { title, meta } = describe(item)
                const Icon = item.kind === 'poll' ? BarChart3 : FileQuestion
                return (
                  <motion.div
                    key={item.id}
                    layout
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={SPRING_SNAPPY}
                    className="flex items-center gap-3 rounded-2xl border border-border bg-background p-3"
                  >
                    <div className="rounded-xl bg-muted/40 border border-border p-2">
                      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{title}</p>
                      <p className="text-xs text-muted-foreground">{meta}</p>
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => handleDelete(item.id)}
                          disabled={deletingId === item.id}
                          aria-label={`Remove ${title}`}
                          className="shrink-0 h-9 w-9 rounded-xl flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 transition-colors disabled:opacity-50"
                        >
                          {deletingId === item.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">Remove</TooltipContent>
                    </Tooltip>
                  </motion.div>
                )
              })}
            </AnimatePresence>
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}
