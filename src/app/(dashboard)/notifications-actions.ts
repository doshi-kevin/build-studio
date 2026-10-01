/**
 * In-app notification server actions.
 *
 * Reads and mutations against app_notifications. Every action is
 * recipient-scoped: a user can only see / modify rows where
 * recipient_id = auth.uid(). The admin client is used so the actions
 * work even if RLS is somehow misconfigured — we enforce ownership in
 * code as the primary gate.
 */
'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'

// Shape exposed to client components. Mirrors the app_notifications
// columns the UI actually renders.
export interface AppNotification {
  id: string
  recipient_id: string
  actor_id: string | null
  kind: string
  title: string
  body: string | null
  link_url: string | null
  is_read: boolean
  read_at: string | null
  metadata: Record<string, unknown>
  created_at: string
  actor?: {
    id: string
    name: string | null
    email: string
    avatar_url: string | null
  } | null
}

type ActionResult<T = undefined> =
  | { success: true; data?: T }
  | { success?: false; error: string }

async function getAuthUser() {
  const supabase = await createClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

/**
 * List the 50 most recent notifications for the current user, newest
 * first. Includes the actor profile so the bell menu can render an
 * avatar without a second round-trip.
 */
export async function listMyNotifications(): Promise<
  ActionResult<{ notifications: AppNotification[]; unreadCount: number }>
> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { data, error } = await adminDb
      .from('app_notifications')
      .select(
        'id, recipient_id, actor_id, kind, title, body, link_url, is_read, read_at, metadata, created_at, actor:profiles!app_notifications_actor_id_fkey(id, name, email, avatar_url)',
      )
      .eq('recipient_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) {
      logger.error('listMyNotifications', error, { userId: user.id })
      return { error: 'Failed to load notifications' }
    }

    const notifications = (data ?? []) as AppNotification[]
    const unreadCount = notifications.filter((n) => !n.is_read).length

    return { success: true, data: { notifications, unreadCount } }
  } catch (error) {
    logger.error('listMyNotifications', error)
    return { error: 'Something went wrong' }
  }
}

// ── Unified bell (dual-source) ──────────────────────────────────
// The bell shows legacy chat/DM notifications (app_notifications) AND the shared
// event feed (feed_items) merged. Each item carries a `source` so the client routes
// mark-read / dismiss to the right table. IMPORTANT: feed_items rows can be shared
// with the dashboard to-do list. Dismiss/Clear DELETES notices (and finished to-dos);
// a LIVE to-do (is_actionable && !is_done) is only marked read — never deleted — so the
// dashboard to-do list is preserved, while listBell hides READ to-dos so the bell still
// clears. is_actionable/is_done ride along for that.

export interface BellItem {
  source: 'app' | 'feed'
  id: string
  /** Event type for feed items (e.g. 'quiz_published') — drives the type icon.
   *  Null for chat/DM (app_notifications), which show the actor avatar instead. */
  type: string | null
  title: string
  body: string | null
  link_url: string | null
  is_read: boolean
  created_at: string
  /** Course this notification belongs to (e.g. "CS 546"), shown so a student in
   *  multiple courses can tell which one it's from. Null for chat/DM. */
  course_label: string | null
  /** True when the source event was flagged important (e.g. an important announcement),
   *  so the bell highlights it. Stamped into feed_items.metadata at emit time. */
  important: boolean
  /** Feed only. A LIVE to-do (is_actionable && !is_done) is shared with the dashboard
   *  to-do list, so the bell keeps it (marks read) instead of deleting on dismiss.
   *  Always false for chat/DM (app_notifications). */
  is_actionable: boolean
  is_done: boolean
  actor: { id: string; name: string | null; email: string; avatar_url: string | null } | null
}

// Columns each surface reads from the two source tables (shared by the bell + history).
const APP_NOTIF_SELECT =
  'id, title, body, link_url, is_read, created_at, metadata, actor:profiles!app_notifications_actor_id_fkey(id, name, email, avatar_url)'
const FEED_ITEM_SELECT =
  'id, type, title, body, link_url, is_read, created_at, metadata, is_actionable, is_done, actor:profiles!feed_items_actor_id_fkey(id, name, email, avatar_url)'

// Map a raw app_notifications / feed_items row to the unified BellItem shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mapBellRow = (source: 'app' | 'feed') => (r: any): BellItem => ({
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
  actor: Array.isArray(r.actor) ? (r.actor[0] ?? null) : (r.actor ?? null),
})

/** Merge app_notifications (chat/DM) + feed_items (events), newest first, with counts. */
export async function listBell(): Promise<ActionResult<{ items: BellItem[]; unreadCount: number }>> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Two extra COUNT queries rather than counting the display page (#696). The two
       selects below each `.limit(50)`, so any count derived from them caps out — counting
       after the merge-and-slice announced "50 unread" to a screen reader for a student
       with 74, and counting the merged set would merely raise that ceiling to 100. A
       head-only exact count is unbounded and cheap; the mirrored filters are what keep it
       equal to what the bell would show. */
    const [appRes, feedRes, appUnread, feedUnread] = await Promise.all([
      adminDb
        .from('app_notifications')
        .select(APP_NOTIF_SELECT)
        .eq('recipient_id', user.id)
        // Dismissed / cleared-from-the-bell rows are soft-deleted (dismissed_at set): hidden
        // from the bell, but kept for the /notifications history page.
        .is('dismissed_at', null)
        .order('created_at', { ascending: false })
        .limit(50),
      adminDb
        .from('feed_items')
        .select(FEED_ITEM_SELECT)
        .eq('recipient_id', user.id)
        .is('dismissed_at', null)
        // Hide a to-do from the bell once it's been read/dismissed (is_actionable && is_read):
        // the row is kept for the dashboard to-do list, but the bell can be cleared. Notices
        // (is_actionable=false) still show when read — as history — until they're dismissed.
        .or('is_actionable.eq.false,is_read.eq.false')
        .order('created_at', { ascending: false })
        .limit(50),
      // Same predicates as the two selects, plus is_read=false — the unread total.
      adminDb
        .from('app_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_id', user.id)
        .is('dismissed_at', null)
        .eq('is_read', false),
      adminDb
        .from('feed_items')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_id', user.id)
        .is('dismissed_at', null)
        .or('is_actionable.eq.false,is_read.eq.false')
        .eq('is_read', false),
    ])

    if (appRes.error || feedRes.error) {
      logger.error('listBell', appRes.error ?? feedRes.error, { userId: user.id })
      return { error: 'Failed to load notifications' }
    }

    const merged = [
      ...((appRes.data ?? []).map(mapBellRow('app')) as BellItem[]),
      ...((feedRes.data ?? []).map(mapBellRow('feed')) as BellItem[]),
    ].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))

    /* Falls back to counting the page if either count query failed — a wrong-but-close
       number beats announcing zero. */
    const counted = (appUnread?.count ?? null) !== null || (feedUnread?.count ?? null) !== null
    const unreadCount = counted
      ? (appUnread?.count ?? 0) + (feedUnread?.count ?? 0)
      : merged.filter((i) => !i.is_read).length
    const items = merged.slice(0, 50)

    return { success: true, data: { items, unreadCount } }
  } catch (error) {
    logger.error('listBell', error)
    return { error: 'Something went wrong' }
  }
}

/**
 * Full notifications history for the dedicated "/notifications" page — the bell's
 * "View all". Same two-source merge as listBell, but returns the complete history
 * (read AND unread, including already-read to-dos, which the bell hides) up to a higher
 * cap, so a user can look back at everything they've been notified about.
 */
export async function listNotificationHistory(): Promise<
  ActionResult<{ items: BellItem[]; unreadCount: number }>
> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const HISTORY_LIMIT = 100
    const [appRes, feedRes] = await Promise.all([
      adminDb
        .from('app_notifications')
        .select(APP_NOTIF_SELECT)
        .eq('recipient_id', user.id)
        .order('created_at', { ascending: false })
        .limit(HISTORY_LIMIT),
      adminDb
        .from('feed_items')
        .select(FEED_ITEM_SELECT)
        .eq('recipient_id', user.id)
        .order('created_at', { ascending: false })
        .limit(HISTORY_LIMIT),
    ])

    if (appRes.error || feedRes.error) {
      logger.error('listNotificationHistory', appRes.error ?? feedRes.error, { userId: user.id })
      return { error: 'Failed to load notifications' }
    }

    const items = [
      ...((appRes.data ?? []).map(mapBellRow('app')) as BellItem[]),
      ...((feedRes.data ?? []).map(mapBellRow('feed')) as BellItem[]),
    ]
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, HISTORY_LIMIT)

    return { success: true, data: { items, unreadCount: items.filter((i) => !i.is_read).length } }
  } catch (error) {
    logger.error('listNotificationHistory', error)
    return { error: 'Something went wrong' }
  }
}

/**
 * Count unread notifications for the bell badge. Cheaper than pulling
 * the full list when the menu is closed.
 */
export async function countUnreadNotifications(): Promise<
  ActionResult<{ count: number }>
> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { count, error } = await adminDb
      .from('app_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('recipient_id', user.id)
      .eq('is_read', false)

    if (error) {
      logger.error('countUnreadNotifications', error, { userId: user.id })
      return { error: 'Failed to count notifications' }
    }

    return { success: true, data: { count: count ?? 0 } }
  } catch (error) {
    logger.error('countUnreadNotifications', error)
    return { error: 'Something went wrong' }
  }
}

/**
 * Mark a single notification as read. Idempotent — already-read rows
 * are left alone.
 */
export async function markNotificationRead(
  notificationId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { error } = await adminDb
      .from('app_notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('id', notificationId)
      .eq('recipient_id', user.id)
      .eq('is_read', false)

    if (error) {
      logger.error('markNotificationRead', error, { notificationId })
      return { error: 'Failed to update notification' }
    }

    return { success: true }
  } catch (error) {
    logger.error('markNotificationRead', error, { notificationId })
    return { error: 'Something went wrong' }
  }
}

/**
 * Mark every unread notification belonging to the current user as read.
 * Used by the "Mark all as read" button in the bell menu.
 */
export async function markAllNotificationsRead(): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { error } = await adminDb
      .from('app_notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('recipient_id', user.id)
      .eq('is_read', false)

    if (error) {
      logger.error('markAllNotificationsRead', error, { userId: user.id })
      return { error: 'Failed to update notifications' }
    }

    return { success: true }
  } catch (error) {
    logger.error('markAllNotificationsRead', error)
    return { error: 'Something went wrong' }
  }
}

/**
 * Dismiss a notification from the bell (recipient-initiated). Soft delete: sets dismissed_at
 * so the row leaves the bell but is retained for the /notifications history page.
 */
export async function dismissNotification(
  notificationId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { error } = await adminDb
      .from('app_notifications')
      .update({ dismissed_at: new Date().toISOString() })
      .eq('id', notificationId)
      .eq('recipient_id', user.id)

    if (error) {
      logger.error('dismissNotification', error, { notificationId })
      return { error: 'Failed to dismiss notification' }
    }

    return { success: true }
  } catch (error) {
    logger.error('dismissNotification', error, { notificationId })
    return { error: 'Something went wrong' }
  }
}

/**
 * Clear the bell for the current user ("Clear all"). Soft delete: stamps dismissed_at on the
 * caller's still-active notifications so the bell empties while the /notifications history page
 * keeps them. Recipient-scoped — a user can only ever clear their own rows.
 */
export async function clearAllNotifications(): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { error } = await adminDb
      .from('app_notifications')
      .update({ dismissed_at: new Date().toISOString() })
      .eq('recipient_id', user.id)
      .is('dismissed_at', null)

    if (error) {
      logger.error('clearAllNotifications', error, { userId: user.id })
      return { error: 'Failed to clear notifications' }
    }

    return { success: true }
  } catch (error) {
    logger.error('clearAllNotifications', error)
    return { error: 'Something went wrong' }
  }
}
