/**
 * Notifications history page ("/notifications") — the bell's "View all" destination.
 * Shows the user's full notification history (read + unread), newest first. Auth is
 * enforced by middleware; the underlying action is recipient-scoped.
 *
 * Type: Server Component
 */

import { listNotificationHistory } from '@/app/(dashboard)/notifications-actions'
import { NotificationHistoryList } from '@/components/notifications/NotificationHistoryList'

export default async function NotificationsPage() {
  const res = await listNotificationHistory()
  const items = res.success && res.data ? res.data.items : []

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Notifications</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything Scholera has notified you about, newest first.
        </p>
      </div>
      <NotificationHistoryList initialItems={items} />
    </div>
  )
}
