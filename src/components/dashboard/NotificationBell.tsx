/**
 * NotificationBell — header bell menu + realtime, reading TWO sources merged:
 *   - app_notifications (legacy chat @mentions / DMs)
 *   - feed_items (the shared event feed: assignments, grades, announcements, …)
 *
 * Each item carries a `source` so mutations route to the right table. Dismiss/Clear
 * REMOVES items: chat/DM and feed notices are deleted; a live to-do (actionable and
 * not yet done) is shared with the dashboard to-do list, so it is only marked read —
 * never deleted — and stays in the bell until it's completed.
 *
 * Type: Client Component
 */
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { motion, AnimatePresence } from 'framer-motion'
import { SPRING, EXIT } from '@/lib/motion'
import { toast } from 'sonner'
import {
  Bell,
  CheckCheck,
  ChevronRight,
  Loader2,
  Star,
  Trash2,
  X,
  Inbox,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useRealtimeSubscription } from '@/lib/supabase/realtime'
import {
  clearAllNotifications,
  dismissNotification,
  listBell,
  markAllNotificationsRead,
  markNotificationRead,
  type BellItem,
} from '@/app/(dashboard)/notifications-actions'
import {
  dismissFeedItem,
  dismissFeedNotices,
  markAllFeedRead,
  markFeedRead,
} from '@/lib/events/feed-actions'
import { iconForType } from '@/components/notifications/notification-icons'

interface NotificationBellProps {
  userId: string
}

type Source = 'app' | 'feed'
const keyOf = (i: { source: Source; id: string }) => `${i.source}:${i.id}`

// A live to-do (an actionable feed item not yet done) is shared with the dashboard
// to-do list, so the bell must NOT delete it — dismissing one only marks it read.
const isLiveTodo = (i: BellItem) => i.source === 'feed' && i.is_actionable && !i.is_done

export function NotificationBell({ userId }: NotificationBellProps) {
  const router = useRouter()
  const [items, setItems] = useState<BellItem[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [markingAll, setMarkingAll] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const loadedRef = useRef(false)
  const routerRef = useRef(router)
  useEffect(() => {
    routerRef.current = router
  }, [router])
  // Keyed by `${source}:${id}` so an item is never toasted twice.
  const seenRef = useRef<Set<string>>(new Set())

  const markReadRouted = (item: BellItem) =>
    item.source === 'app' ? markNotificationRead(item.id) : markFeedRead(item.id)

  const markItemReadLocal = useCallback((k: string) => {
    setItems((prev) => {
      const next = prev.map((m) => (keyOf(m) === k ? { ...m, is_read: true } : m))
      setUnreadCount(next.filter((m) => !m.is_read).length)
      return next
    })
  }, [])

  // Highlighted arrival toast, reused by realtime + catch-up refetch.
  const showToast = useCallback(
    (item: BellItem) => {
      const ToastIcon = item.source === 'feed' ? iconForType(item.type) : Bell
      const important = item.source === 'feed' && item.important
      toast.custom(
        (t) => (
          <div
            className={`flex w-80 items-start gap-3 rounded-xl border border-border border-l-4 bg-popover p-3.5 shadow-lg ${
              important ? 'border-l-warning' : 'border-l-primary'
            }`}
          >
            <span
              className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                important
                  ? 'bg-warning-muted text-warning-muted-foreground'
                  : 'bg-primary/10 text-primary'
              }`}
            >
              <ToastIcon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              {important ? (
                <p className="mb-0.5 flex items-center gap-1.5">
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/40 bg-warning-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning-muted-foreground">
                    <Star className="h-2.5 w-2.5" />
                    Important
                  </span>
                  {item.course_label && (
                    <span className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {item.course_label}
                    </span>
                  )}
                </p>
              ) : (
                item.course_label && (
                  <p className="mb-0.5 truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {item.course_label}
                  </p>
                )
              )}
              <p className="text-sm font-semibold leading-snug text-foreground">{item.title}</p>
              {item.body && (
                <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
                  {item.body}
                </p>
              )}
              {item.link_url && (
                <button
                  type="button"
                  onClick={() => {
                    markItemReadLocal(keyOf(item))
                    void markReadRouted(item)
                    if (item.link_url) routerRef.current.push(item.link_url)
                    toast.dismiss(t)
                  }}
                  className="mt-1.5 text-xs font-medium text-primary hover:underline"
                >
                  View
                </button>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => toast.dismiss(t)}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ),
        { duration: 6000 },
      )
    },
    [markItemReadLocal],
  )

  // Load / reload the merged bell. Initial load only seeds seen; a catch-up refetch
  // toasts newly-arrived recent unread items so a missed realtime event still surfaces.
  const loadBell = useCallback(
    async (opts?: { toastNew?: boolean }) => {
      const res = await listBell()
      if (res.success && res.data) {
        const list = res.data.items
        if (opts?.toastNew) {
          const cutoff = Date.now() - 5 * 60 * 1000
          for (const it of [...list].reverse()) {
            if (
              !seenRef.current.has(keyOf(it)) &&
              !it.is_read &&
              new Date(it.created_at).getTime() >= cutoff
            ) {
              showToast(it)
            }
          }
        }
        for (const it of list) seenRef.current.add(keyOf(it))
        setItems(list)
        setUnreadCount(res.data.unreadCount)
      }
      setLoading(false)
    },
    [showToast],
  )

  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadBell()
  }, [loadBell])

  // Catch-up safety net (focus / visibility / gentle interval while visible).
  useEffect(() => {
    const refetch = () => {
      if (document.visibilityState === 'visible') void loadBell({ toastNew: true })
    }
    document.addEventListener('visibilitychange', refetch)
    window.addEventListener('focus', refetch)
    const interval = setInterval(refetch, 30_000)
    return () => {
      document.removeEventListener('visibilitychange', refetch)
      window.removeEventListener('focus', refetch)
      clearInterval(interval)
    }
  }, [loadBell])

  // Shared realtime handler for both tables (realtime rows carry no actor join —
  // the catch-up refetch fills that in).
  const applyRealtime = useCallback(
    (
      source: Source,
      payload: { eventType: 'INSERT' | 'UPDATE' | 'DELETE'; new?: unknown; old?: unknown },
    ) => {
      if (payload.eventType === 'DELETE') {
        const k = `${source}:${(payload.old as { id: string }).id}`
        setItems((prev) => {
          const next = prev.filter((m) => keyOf(m) !== k)
          setUnreadCount(next.filter((m) => !m.is_read).length)
          return next
        })
        return
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = payload.new as any
      // A soft-deleted (dismissed / cleared) row is no longer a bell item — drop it, same as a
      // hard DELETE would. Keeps other tabs in sync without waiting for the catch-up refetch.
      if (r?.dismissed_at) {
        const k = `${source}:${r.id}`
        setItems((prev) => {
          const next = prev.filter((m) => keyOf(m) !== k)
          setUnreadCount(next.filter((m) => !m.is_read).length)
          return next
        })
        return
      }
      const item: BellItem = {
        source,
        id: r.id,
        type: (r.type as string | undefined) ?? null,
        title: r.title,
        body: r.body ?? null,
        link_url: r.link_url ?? null,
        is_read: r.is_read,
        created_at: r.created_at,
        course_label: (r.metadata?.course_label as string | undefined) ?? null,
        important: (r.metadata?.important as boolean | undefined) ?? false,
        is_actionable: (r.is_actionable as boolean | undefined) ?? false,
        is_done: (r.is_done as boolean | undefined) ?? false,
        actor: null,
      }
      const k = keyOf(item)
      // A read to-do is hidden from the bell (listBell filters it the same way): its row
      // lives on for the dashboard to-do list, but it must not sit in the bell. Drop it on
      // any realtime event so a single dismiss/mark-read clears it for good.
      const isHiddenTodo = item.source === 'feed' && item.is_actionable && item.is_read
      if (payload.eventType === 'INSERT') {
        if (isHiddenTodo) return
        setItems((prev) => {
          if (prev.some((m) => keyOf(m) === k)) return prev
          return [item, ...prev].slice(0, 50)
        })
        if (!item.is_read) setUnreadCount((c) => c + 1)
        if (!seenRef.current.has(k)) {
          seenRef.current.add(k)
          showToast(item)
        }
      } else {
        // UPDATE — a to-do just marked read leaves the bell; otherwise update in place
        // (preserving the existing actor, since realtime rows carry no join).
        setItems((prev) => {
          const next = isHiddenTodo
            ? prev.filter((m) => keyOf(m) !== k)
            : prev.map((m) => (keyOf(m) === k ? { ...m, ...item, actor: m.actor ?? item.actor } : m))
          setUnreadCount(next.filter((m) => !m.is_read).length)
          return next
        })
      }
    },
    [showToast],
  )

  useRealtimeSubscription(
    { table: 'app_notifications', filter: `recipient_id=eq.${userId}` },
    useCallback(
      (p: { eventType: 'INSERT' | 'UPDATE' | 'DELETE'; new?: unknown; old?: unknown }) =>
        applyRealtime('app', p),
      [applyRealtime],
    ),
  )
  useRealtimeSubscription(
    { table: 'feed_items', filter: `recipient_id=eq.${userId}` },
    useCallback(
      (p: { eventType: 'INSERT' | 'UPDATE' | 'DELETE'; new?: unknown; old?: unknown }) =>
        applyRealtime('feed', p),
      [applyRealtime],
    ),
  )

  const handleClick = useCallback(
    (item: BellItem) => {
      if (!item.is_read) {
        markItemReadLocal(keyOf(item))
        void markReadRouted(item)
      }
      if (item.link_url) {
        setMenuOpen(false)
        router.push(item.link_url)
      }
    },
    [markItemReadLocal, router],
  )

  // "View all" opens the full notifications history page; close the menu so the dropdown
  // doesn't linger over the new page.
  const handleViewAll = useCallback(() => {
    setMenuOpen(false)
    router.push('/notifications')
  }, [router])

  const handleMarkAll = useCallback(async () => {
    if (markingAll || unreadCount === 0) return
    setMarkingAll(true)
    setItems((prev) => prev.map((m) => ({ ...m, is_read: true })))
    setUnreadCount(0)
    // Await + reconcile: a silently-failed mark-all used to snap the badge back up on the
    // next refetch with no explanation.
    const results = await Promise.all([markAllNotificationsRead(), markAllFeedRead()])
    if (results.some((r) => !r.success)) {
      toast.error("Couldn't mark all as read — please try again.")
      await loadBell()
    }
    setMarkingAll(false)
  }, [markingAll, unreadCount, loadBell])

  // Dismiss always clears the item from the bell. A live to-do is only marked read — its
  // row is kept for the dashboard to-do list, and listBell hides read to-dos so it won't
  // come back to the bell. Chat/DM and notices are deleted outright. On failure we reconcile
  // to the true server state instead of leaving a falsely-removed row in the list.
  const handleDismiss = useCallback(
    async (item: BellItem) => {
      const k = keyOf(item)
      setItems((prev) => {
        const next = prev.filter((m) => keyOf(m) !== k)
        setUnreadCount(next.filter((m) => !m.is_read).length)
        return next
      })
      const res = isLiveTodo(item)
        ? await markFeedRead(item.id)
        : item.source === 'app'
          ? await dismissNotification(item.id)
          : await dismissFeedItem(item.id)
      if (!res.success) {
        toast.error("Couldn't dismiss that notification — please try again.")
        await loadBell()
      }
    },
    [loadBell],
  )

  // Clear all empties the bell across BOTH sources. Chat/DM + feed notices are dismissed;
  // live to-dos are marked read (kept for the dashboard to-do list, hidden from the bell by
  // listBell). We AWAIT all three and reconcile on failure. Previously these were fired and
  // forgotten: if the feed-notice dismiss didn't land, NOTICES (e.g. "module posted", which
  // are is_actionable=false and only leave the bell when dismissed_at is set) silently
  // reappeared on the next refetch — while to-dos vanished via mark-all-read — and had to be
  // cleared by hand. Surfacing the error and refetching the true state fixes that.
  const handleClearAll = useCallback(async () => {
    setItems([])
    setUnreadCount(0)
    const results = await Promise.all([
      clearAllNotifications(),
      dismissFeedNotices(),
      markAllFeedRead(),
    ])
    if (results.some((r) => !r.success)) {
      toast.error("Couldn't clear all notifications — please try again.")
      await loadBell()
    }
  }, [loadBell])

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold flex items-center justify-center"
              aria-label={`${unreadCount} unread`}
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96 max-h-[480px] p-0 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <DropdownMenuLabel className="p-0 text-sm font-semibold">
            Notifications
            {unreadCount > 0 && (
              <span className="ml-2 text-[11px] font-medium text-muted-foreground">
                {unreadCount} new
              </span>
            )}
          </DropdownMenuLabel>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={handleMarkAll}
              disabled={markingAll}
              className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              <CheckCheck className="h-3 w-3" />
              Mark all read
            </button>
          )}
        </div>
        <DropdownMenuSeparator className="m-0" />
        <div className="max-h-[400px] overflow-y-auto">
          {loading ? (
            <div className="py-10 flex justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : items.length === 0 ? (
            <div className="py-10 text-center">
              <Inbox className="h-5 w-5 mx-auto text-muted-foreground mb-2" />
              <p className="text-xs text-muted-foreground">You&apos;re all caught up.</p>
            </div>
          ) : (
            <ul>
              {/* A notification is the definition of something arriving that the
                  reader did not ask for, so it earns an entrance. `initial={false}`
                  is what keeps that honest: the items already in the list when the
                  panel opens do NOT animate, only ones that genuinely arrive after. */}
              <AnimatePresence initial={false}>
              {items.map((n) => {
                const actorName = n.actor?.name || n.actor?.email || 'Someone'
                const initials = actorName.slice(0, 2).toUpperCase()
                const TypeIcon = iconForType(n.type)
                return (
                  <motion.li
                    key={keyOf(n)}
                    layout
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4, transition: EXIT }}
                    transition={SPRING}
                    className="relative group"
                  >
                    <button
                      type="button"
                      onClick={() => handleClick(n)}
                      className={`w-full text-left pl-3 pr-9 py-2.5 flex gap-2.5 border-b last:border-b-0 transition-colors ${
                        n.important
                          ? 'bg-warning-muted/15 hover:bg-warning-muted/25'
                          : !n.is_read
                            ? 'bg-muted/30 hover:bg-muted/50'
                            : 'hover:bg-muted/30'
                      }`}
                    >
                      {n.source === 'feed' ? (
                        <span
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
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
                          className="h-8 w-8 rounded-full object-cover shrink-0"
                        />
                      ) : (
                        <span className="h-8 w-8 rounded-full bg-muted-foreground/10 text-muted-foreground flex items-center justify-center text-[10px] font-semibold shrink-0">
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
                            <p className="truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                              {n.course_label}
                            </p>
                          )
                        )}
                        <p className="text-sm font-medium leading-snug truncate">{n.title}</p>
                        {n.body && (
                          <p className="text-xs text-muted-foreground leading-snug mt-0.5 line-clamp-2">
                            {n.body}
                          </p>
                        )}
                        <p className="text-[10px] text-muted-foreground mt-1">
                          {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                        </p>
                      </div>
                      {!n.is_read && (
                        <span
                          className="mt-1.5 h-2 w-2 rounded-full bg-primary shrink-0"
                          aria-label="Unread"
                        />
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label="Dismiss notification"
                      title="Dismiss"
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleDismiss(n)
                      }}
                      className="absolute top-2 right-1.5 h-6 w-6 rounded-md flex items-center justify-center text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-muted hover:text-foreground transition-opacity"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </motion.li>
                )
              })}
              </AnimatePresence>
            </ul>
          )}
        </div>
        {!loading && (
          <>
            <DropdownMenuSeparator className="m-0" />
            <div className="px-3 py-2 flex items-center justify-between">
              <button
                type="button"
                onClick={handleViewAll}
                className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                View all notifications
                <ChevronRight className="h-3 w-3" />
              </button>
              {items.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearAll}
                  className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-destructive transition-colors"
                >
                  <Trash2 className="h-3 w-3" />
                  Clear all
                </button>
              )}
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
