// Recent important announcements shown on the student dashboard.
// Lists unread, important announcements across enrolled courses; each row links
// to the full announcement (which marks it read, so it drops off next load).
// Always renders the panel so the "View all" entry point stays visible.

import Link from 'next/link'
import { Megaphone, ArrowRight, Check, CircleAlert } from 'lucide-react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)

function formatShortDate(dateStr: string | null): string {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

interface RecentAnnouncementsProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  announcements: any[]
  /** Total unread announcements (incl. non-important) — shown as a hint. */
  unreadCount: number
  /**
   * When the fetch failed, show a distinct error state instead of the empty state —
   * a failed load must not masquerade as a reassuring "no important announcements".
   */
  loadError?: boolean
}

export function RecentAnnouncements({ announcements, unreadCount, loadError = false }: RecentAnnouncementsProps) {
  return (
    <section className="flex flex-col h-full min-h-0 rounded-2xl border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        <Megaphone className="h-4 w-4 text-muted-foreground shrink-0" />
        <h2 className="text-base font-semibold tracking-tight text-foreground truncate min-w-0">Important Announcements</h2>
        <Link
          href="/student/announcements"
          className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          {/* unreadCount counts ALL unread announcements, not just important ones —
              sitting it right under the "Important Announcements" heading as its
              own badge read as if it described the (possibly empty) list below.
              Folding it into "View all" keeps the number but ties it to the link
              that actually goes to the full, unfiltered list. */}
          View all{unreadCount > 0 ? ` (${unreadCount} unread)` : ''}
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {/* Body — unread important announcements */}
      {loadError ? (
        <div className="flex-1 flex items-center justify-center gap-2 px-4 py-6 text-sm text-muted-foreground">
          <CircleAlert className="h-4 w-4 text-destructive-muted-foreground shrink-0" />
          Couldn&apos;t load announcements. Refresh to try again.
        </div>
      ) : announcements.length === 0 ? (
        <div className="flex-1 flex items-center justify-center gap-2 px-4 py-6 text-sm text-muted-foreground">
          <Check className="h-4 w-4 text-success" />
          No important announcements
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-border">
          {announcements.map((announcement) => {
            const section = resolveJoin(announcement.section)
            const course = resolveJoin(section?.course)
            return (
              <Link
                key={announcement.id}
                href={`/student/courses/${announcement.section_id}/announcements/${announcement.id}`}
                className="group flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                <div className="min-w-0 flex-1">
                  {course?.code && (
                    <p className="text-[10px] font-mono text-muted-foreground mb-0.5">{course.code}</p>
                  )}
                  <p className="text-sm font-medium truncate">{announcement.title}</p>
                </div>
                <span className="text-[11px] text-muted-foreground shrink-0">
                  {formatShortDate(announcement.published_at)}
                </span>
              </Link>
            )
          })}
        </div>
      )}
    </section>
  )
}
