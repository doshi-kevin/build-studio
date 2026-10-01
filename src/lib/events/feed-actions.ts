/**
 * Shared feed read/mark server actions — used by BOTH surfaces.
 *
 * The notification bell reads notices (and marks read/dismissed); the dashboard reads
 * actionable to-dos (and shows "done", which is normally driven by completion events,
 * but markDone is here for explicit cases). Every action is recipient-scoped: a user
 * only ever sees/mutates rows where recipient_id = their own id (enforced in code via
 * the admin client, backed by the SELECT-only RLS policy).
 */
'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import type { FeedItem } from '@/lib/events/types'

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

const FEED_SELECT =
  'id, recipient_id, actor_id, institution_id, section_id, type, title, body, link_url, entity_type, entity_id, is_read, read_at, is_actionable, is_done, done_at, due_at, metadata, created_at, actor:profiles!feed_items_actor_id_fkey(id, name, email, avatar_url)'

export interface ListFeedOptions {
  /** Only actionable to-dos (dashboard). */
  actionableOnly?: boolean
  /** Only unread (bell). */
  unreadOnly?: boolean
  /** Only not-yet-done to-dos (open tasks). */
  undoneOnly?: boolean
  limit?: number
}

/**
 * List the current user's feed, newest first, with counts. One query serves both the
 * bell (notices) and the dashboard (to-dos) — filter with the options.
 */
export async function listFeed(
  opts: ListFeedOptions = {},
): Promise<ActionResult<{ items: FeedItem[]; unreadCount: number; openTodoCount: number }>> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    let query = adminDb
      .from('feed_items')
      .select(FEED_SELECT)
      .eq('recipient_id', user.id)
      .order('created_at', { ascending: false })
      .limit(opts.limit ?? 50)

    if (opts.actionableOnly) query = query.eq('is_actionable', true)
    if (opts.unreadOnly) query = query.eq('is_read', false)
    if (opts.undoneOnly) query = query.eq('is_done', false)

    const { data, error } = await query
    if (error) {
      logger.error('listFeed', error, { userId: user.id })
      return { error: 'Failed to load feed' }
    }

    const items = (data ?? []) as FeedItem[]
    return {
      success: true,
      data: {
        items,
        unreadCount: items.filter((i) => !i.is_read).length,
        openTodoCount: items.filter((i) => i.is_actionable && !i.is_done).length,
      },
    }
  } catch (error) {
    logger.error('listFeed', error)
    return { error: 'Something went wrong' }
  }
}

/** Mark one item read (bell). Recipient-scoped. */
export async function markFeedRead(itemId: string): Promise<ActionResult> {
  return updateOwn(itemId, { is_read: true, read_at: new Date().toISOString() }, 'markFeedRead')
}

/** Mark every unread item read (bell "mark all read"). */
export async function markAllFeedRead(): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { error } = await adminDb
      .from('feed_items')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('recipient_id', user.id)
      .eq('is_read', false)
    if (error) {
      logger.error('markAllFeedRead', error, { userId: user.id })
      return { error: 'Failed to update feed' }
    }
    return { success: true }
  } catch (error) {
    logger.error('markAllFeedRead', error)
    return { error: 'Something went wrong' }
  }
}

/** Mark one to-do done (explicit completion; normally driven by completion events). */
export async function markFeedDone(itemId: string): Promise<ActionResult> {
  return updateOwn(itemId, { is_done: true, done_at: new Date().toISOString() }, 'markFeedDone')
}

/**
 * Dismiss one item from the bell. Soft delete: sets dismissed_at so the item leaves the bell
 * but is retained for the /notifications history page. Recipient-scoped. The `.or(...)` keeps
 * the live-to-do guarantee at the DB layer: a LIVE to-do (is_actionable && !is_done) is shared
 * with the dashboard to-do list, so a direct call naming one updates 0 rows (the client marks
 * it read instead). Notices and finished to-dos are dismissed as normal.
 */
export async function dismissFeedItem(itemId: string): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { error } = await adminDb
      .from('feed_items')
      .update({ dismissed_at: new Date().toISOString() })
      .eq('id', itemId)
      .eq('recipient_id', user.id)
      .or('is_actionable.eq.false,is_done.eq.true')
    if (error) {
      logger.error('dismissFeedItem', error, { itemId })
      return { error: 'Failed to dismiss item' }
    }
    return { success: true }
  } catch (error) {
    logger.error('dismissFeedItem', error, { itemId })
    return { error: 'Something went wrong' }
  }
}

/**
 * Clear the bell's feed items EXCEPT live to-dos (bell "Clear all"). Soft delete: stamps
 * dismissed_at on the caller's notices and finished to-dos so they leave the bell but stay in
 * the /notifications history; a LIVE to-do (is_actionable && !is_done) is kept for the
 * dashboard to-do list (marked read separately via markAllFeedRead). Recipient-scoped.
 */
export async function dismissFeedNotices(): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { error } = await adminDb
      .from('feed_items')
      .update({ dismissed_at: new Date().toISOString() })
      .eq('recipient_id', user.id)
      .is('dismissed_at', null)
      .or('is_actionable.eq.false,is_done.eq.true')
    if (error) {
      logger.error('dismissFeedNotices', error, { userId: user.id })
      return { error: 'Failed to clear notifications' }
    }
    return { success: true }
  } catch (error) {
    logger.error('dismissFeedNotices', error)
    return { error: 'Something went wrong' }
  }
}

// Shared recipient-scoped single-row update.
async function updateOwn(
  itemId: string,
  patch: Record<string, unknown>,
  label: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { error } = await adminDb
      .from('feed_items')
      .update(patch)
      .eq('id', itemId)
      .eq('recipient_id', user.id)
    if (error) {
      logger.error(label, error, { itemId })
      return { error: 'Failed to update item' }
    }
    return { success: true }
  } catch (error) {
    logger.error(label, error, { itemId })
    return { error: 'Something went wrong' }
  }
}
