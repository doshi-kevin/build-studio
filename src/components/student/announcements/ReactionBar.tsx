/**
 * ReactionBar — emoji reaction buttons for announcements.
 *
 * Shows preset emoji buttons with count badges. Highlighted if the
 * current student has reacted. Uses optimistic updates with useTransition.
 *
 * Type: Client Component
 */
'use client'

import { useState, useEffect, useTransition } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  toggleReaction,
  getAnnouncementReactions,
} from '@/app/(dashboard)/student/courses/[sectionId]/announcements/actions'

const PRESET_EMOJIS = [
  { emoji: '👍', label: 'Thumbs up' },
  { emoji: '❤️', label: 'Heart' },
  { emoji: '👏', label: 'Clap' },
  { emoji: '💡', label: 'Lightbulb' },
  { emoji: '🔥', label: 'Fire' },
]

interface ReactionBarProps {
  announcementId: string
  sectionId: string
}

interface ReactionState {
  emoji: string
  count: number
  reacted: boolean
}

export function ReactionBar({ announcementId, sectionId }: ReactionBarProps) {
  const [reactions, setReactions] = useState<ReactionState[]>([])
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    getAnnouncementReactions(announcementId, sectionId).then((result) => {
      if (result.data) setReactions(result.data)
    })
  }, [announcementId, sectionId])

  const handleToggle = (emoji: string) => {
    // Optimistic update
    setReactions((prev) => {
      const existing = prev.find((r) => r.emoji === emoji)
      if (existing) {
        if (existing.reacted) {
          // Remove reaction
          const newCount = existing.count - 1
          if (newCount <= 0) return prev.filter((r) => r.emoji !== emoji)
          return prev.map((r) =>
            r.emoji === emoji ? { ...r, count: newCount, reacted: false } : r
          )
        } else {
          // Add reaction
          return prev.map((r) =>
            r.emoji === emoji ? { ...r, count: r.count + 1, reacted: true } : r
          )
        }
      } else {
        return [...prev, { emoji, count: 1, reacted: true }]
      }
    })

    startTransition(async () => {
      const result = await toggleReaction(announcementId, sectionId, emoji)
      if (result.error) {
        /* SAY so, don't just revert (#669). The optimistic count used to snap back with
           no toast — indistinguishable from a misclick — while the comment path on the
           same screen does report its error. Most common cause is the announcement being
           deleted while open, which no amount of retrying will fix. */
        toast.error(result.error)
        // Revert on error — refetch
        const fresh = await getAnnouncementReactions(announcementId, sectionId)
        if (fresh.data) setReactions(fresh.data)
      }
    })
  }

  // Build display: show preset emojis (with count if > 0) + any custom emojis from reactions
  const reactionMap = new Map(reactions.map((r) => [r.emoji, r]))

  return (
    <div className="flex flex-wrap gap-1.5">
      {PRESET_EMOJIS.map(({ emoji, label }) => {
        const reaction = reactionMap.get(emoji)
        const count = reaction?.count || 0
        const reacted = reaction?.reacted || false

        return (
          <button
            key={emoji}
            onClick={() => handleToggle(emoji)}
            disabled={isPending}
            title={label}
            className={cn(
              'inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-sm transition-colors',
              reacted
                ? 'bg-primary/10 border-primary/30 text-primary'
                : 'bg-muted/30 border-transparent text-muted-foreground hover:bg-muted/60 hover:border-muted-foreground/20'
            )}
          >
            <span>{emoji}</span>
            {count > 0 && <span className="text-xs font-medium">{count}</span>}
          </button>
        )
      })}
    </div>
  )
}
