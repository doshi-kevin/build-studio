/**
 * NotificationHistoryList — the full "/notifications" page list (the bell's "View all"
 * destination). Shows the complete history, read and unread, newest first. Clicking a row
 * marks it read and navigates to the item; "Mark all read" clears unread in bulk.
 *
 * Mirrors the header bell's visual language (type icon for events, actor avatar for
 * chat/DM) but as a full-page scrollable list rather than a compact dropdown.
 *
 * Type: Client Component
 */
'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { CheckCheck, Star, Inbox } from 'lucide-react'
import { iconForType } from '@/components/notifications/notification-icons'
import {
  markAllNotificationsRead,
  markNotificationRead,
  type BellItem,
} from '@/app/(dashboard)/notifications-actions'
import { markAllFeedRead, markFeedRead } from '@/lib/events/feed-actions'

const keyOf = (i: BellItem) => `${i.source}:${i.id}`

export function NotificationHistoryList({ initialItems }: { initialItems: BellItem[] }) {
  const router = useRouter()
  const [items, setItems] = useState<BellItem[]>(initialItems)
  const unreadCount = items.filter((i) => !i.is_read).length

  const markReadRouted = (item: BellItem) =>
    item.source === 'app' ? markNotificationRead(item.id) : markFeedRead(item.id)

  const handleClick = useCallback(
    (item: BellItem) => {
      if (!item.is_read) {
        setItems((prev) =>
          prev.map((m) => (keyOf(m) === keyOf(item) ? { ...m, is_read: true } : m)),
        )
        void markReadRouted(item)
      }
      if (item.link_url) router.push(item.link_url)
    },
    [router],
  )

  const handleMarkAll = useCallback(async () => {
    if (unreadCount === 0) return
    setItems((prev) => prev.map((m) => ({ ...m, is_read: true })))
    await Promise.all([markAllNotificationsRead(), markAllFeedRead()])
  }, [unreadCount])

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card py-16 text-center">
        <Inbox className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">No notifications yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          When something happens in your courses, it&apos;ll show up here.
        </p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <p className="text-xs font-medium text-muted-foreground">
          {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'}
        </p>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={handleMarkAll}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <CheckCheck className="h-3.5 w-3.5" />
            Mark all read
          </button>
        )}
      </div>
      <ul>
        {items.map((n) => {
          const actorName = n.actor?.name || n.actor?.email || 'Someone'
          const initials = actorName.slice(0, 2).toUpperCase()
          const TypeIcon = iconForType(n.type)
          return (
            <li key={keyOf(n)}>
              <button
                type="button"
                onClick={() => handleClick(n)}
                className={`flex w-full gap-3 border-b border-border px-5 py-3.5 text-left transition-colors last:border-b-0 ${
                  n.important
                    ? 'bg-warning-muted/15 hover:bg-warning-muted/25'
                    : !n.is_read
                      ? 'bg-muted/30 hover:bg-muted/50'
                      : 'hover:bg-muted/30'
                }`}
              >
                {n.source === 'feed' ? (
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                      n.important
                        ? 'bg-warning-muted text-warning-muted-foreground'
                        : 'bg-primary/10 text-primary'
                    }`}
                  >
                    <TypeIcon className="h-4 w-4" />
                  </span>
                ) : n.actor?.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={n.actor.avatar_url}
                    alt={actorName}
                    className="h-9 w-9 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted-foreground/10 text-[11px] font-semibold text-muted-foreground">
                    {initials}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  {n.important ? (
                    <p className="mb-0.5 flex items-center gap-1.5">
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/40 bg-warning-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning-muted-foreground">
                        <Star className="h-2.5 w-2.5" />
                        Important
                      </span>
                      {n.course_label && (
                        <span className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {n.course_label}
                        </span>
                      )}
                    </p>
                  ) : (
                    n.course_label && (
                      <p className="mb-0.5 truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {n.course_label}
                      </p>
                    )
                  )}
                  <p className="text-sm font-medium leading-snug text-foreground">{n.title}</p>
                  {n.body && (
                    <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
                      {n.body}
                    </p>
                  )}
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                  </p>
                </div>
                {!n.is_read && (
                  <span
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary"
                    aria-label="Unread"
                  />
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
