// Cross-course announcements list for the /student/announcements page.
// Groups every visible announcement by course (most-recently-active course
// first) and shows read/unread state. Each row links to the full announcement.

import Link from 'next/link'
import { Megaphone, Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/professor/PageHeader'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)

function formatShortDate(dateStr: string | null): string {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

interface AllStudentAnnouncementsProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  announcements: any[]
}

interface Group {
  sectionId: string
  code: string
  title: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  items: any[]
}

export function AllStudentAnnouncements({ announcements }: AllStudentAnnouncementsProps) {
  // Group by section, preserving newest-first order (first-seen section wins).
  const groups: Group[] = []
  const byId = new Map<string, Group>()
  for (const a of announcements) {
    const section = resolveJoin(a.section)
    const course = resolveJoin(section?.course)
    const sectionId = a.section_id
    let group = byId.get(sectionId)
    if (!group) {
      group = {
        sectionId,
        code: course?.code ?? '',
        title: course?.title ?? 'Course',
        items: [],
      }
      byId.set(sectionId, group)
      groups.push(group)
    }
    group.items.push(a)
  }

  const unreadCount = announcements.filter((a) => !a.is_read).length

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <PageHeader
        title="Announcements"
        description="News and updates across all your courses."
        actions={
          announcements.length > 0 ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {unreadCount > 0 ? `${unreadCount} unread · ` : ''}
              {announcements.length} {announcements.length === 1 ? 'post' : 'posts'}
            </span>
          ) : undefined
        }
      />

      {groups.length === 0 ? (
        <EmptyState
          variant="teaching"
          icon={Megaphone}
          title="No announcements yet"
          description="Announcements from your courses will show up here."
        />
      ) : (
        groups.map((group) => (
          <section key={group.sectionId} className="space-y-2">
            <h2 className="flex items-baseline gap-2 text-sm font-semibold tracking-tight text-foreground">
              <span className="font-mono">{group.code}</span>
              <span className="font-normal text-muted-foreground truncate">{group.title}</span>
            </h2>

            <div className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
              {group.items.map((a) => (
                <Link
                  key={a.id}
                  href={`/student/courses/${a.section_id}/announcements/${a.id}`}
                  className="group flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors"
                >
                  <span
                    className={cn('h-1.5 w-1.5 rounded-full shrink-0', a.is_read ? 'bg-border' : 'bg-primary')}
                  />
                  <div className="min-w-0 flex-1 flex items-center gap-2">
                    <p className={cn('text-sm truncate', a.is_read ? 'text-muted-foreground' : 'font-medium')}>
                      {a.title}
                    </p>
                    {a.is_important && (
                      <Star className="h-3 w-3 shrink-0 text-warning-muted-foreground" aria-label="Important" />
                    )}
                  </div>
                  <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">
                    {formatShortDate(a.published_at)}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}
