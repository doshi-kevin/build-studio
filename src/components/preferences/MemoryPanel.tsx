'use client'

/**
 * "What Athena remembers" — one person's view of their own memory. Used by both
 * the student and professor Preferences pages, which hold the same kind of rows
 * and need the same control over them.
 *
 * This exists because the memory layer saves quietly. A confirmation dialog on
 * every capture would be clicked through without being read, so what protects
 * someone is being able to see everything held about them and remove any of it.
 * That makes this a control, not a settings nicety, and it is why the delete
 * really deletes.
 *
 * Expired items are still listed, dimmed and labelled. Athena has already
 * stopped using them, but silently vanishing something a person said would leave
 * them unable to tell "it forgot" from "it never listened".
 */

import { useState, useTransition } from 'react'
import { Brain, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { cn } from '@/lib/utils'

export interface MemoryItem {
  id: string
  text: string
  /** null = applies in every course. */
  courseLabel: string | null
  expiresAt: string | null
}

export function MemoryPanel({
  items,
  forgetAction,
  emptyDescription,
}: {
  items: MemoryItem[]
  forgetAction: (id: string) => Promise<{ success?: boolean; error?: string }>
  /** The empty state has to speak to whoever is reading it. A professor is not
   *  told "how you like things explained" — they are configuring an assistant,
   *  not being taught. */
  emptyDescription?: string
}) {
  // Removed ids drop out immediately rather than waiting for the revalidate, so
  // "forget this" feels like forgetting rather than like a form submission.
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  const [pending, startTransition] = useTransition()

  const visible = items.filter((i) => !removed.has(i.id))

  const forget = (item: MemoryItem) => {
    setRemoved((prev) => new Set(prev).add(item.id))
    startTransition(async () => {
      const result = await forgetAction(item.id)
      if (result.error) {
        // Put it back: showing it as gone when it is still stored would be a lie
        // about what we hold.
        setRemoved((prev) => {
          const next = new Set(prev)
          next.delete(item.id)
          return next
        })
        toast.error(result.error)
      }
    })
  }

  if (visible.length === 0) {
    return (
      <EmptyState
        icon={Brain}
        title="Athena hasn't remembered anything yet"
        description={
          emptyDescription ??
          'Tell Athena how you like things explained, and it will remember for next time. Anything it picks up shows here, and you can remove it.'
        }
      />
    )
  }

  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {visible.map((item) => {
        const expired = !!item.expiresAt && new Date(item.expiresAt) <= new Date()
        return (
          <li key={item.id} className="flex items-start justify-between gap-3 p-3">
            <div className="min-w-0 space-y-1">
              <p className={cn('text-sm text-foreground', expired && 'text-muted-foreground line-through')}>
                {item.text}
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="text-xs font-normal">
                  {item.courseLabel ?? 'Every course'}
                </Badge>
                {expired && (
                  <Badge variant="outline" className="text-xs font-normal text-muted-foreground">
                    No longer used
                  </Badge>
                )}
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={pending}
              onClick={() => forget(item)}
              // The row text is the only thing distinguishing one button from
              // another, so a screen reader needs it in the label.
              aria-label={`Forget: ${item.text}`}
              className="size-9 shrink-0 text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </Button>
          </li>
        )
      })}
    </ul>
  )
}
