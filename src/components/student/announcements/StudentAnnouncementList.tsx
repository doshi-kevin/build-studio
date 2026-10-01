'use client'

// Read-only announcement feed for students.
// Rows have a FIXED height and are a single link to the full announcement page,
// where reactions, comments, and acknowledgement actually work. Rows used to
// expand in place on hover/focus/click — which pushed every announcement below
// them down the page — and the expanded body only *teased* reactions and
// comments with static labels that did nothing.

import { useState, useMemo, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Megaphone, Search, Pin, Star, CheckCircle2, CheckCheck, ChevronRight,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { PageHeader } from '@/components/professor/PageHeader'
import { markAllAnnouncementsRead } from '@/app/(dashboard)/student/courses/[sectionId]/announcements/actions'
import type { Announcement } from '@/lib/supabase/types'

interface StudentAnnouncementListProps {
  announcements: Announcement[]
  readAnnouncementIds?: string[]
  sectionId: string
}

function isNew(publishedAt: string | null): boolean {
  if (!publishedAt) return false
  return Date.now() - new Date(publishedAt).getTime() < 48 * 60 * 60 * 1000
}

function formatShort(dateStr: string | null): string {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
  })
}

export function StudentAnnouncementList({
  announcements,
  readAnnouncementIds = [],
  sectionId,
}: StudentAnnouncementListProps) {
  const [search, setSearch] = useState('')
  const [isMarking, startMarking] = useTransition()
  const router = useRouter()

  const readSet = useMemo(() => new Set(readAnnouncementIds), [readAnnouncementIds])
  const unreadCount = useMemo(
    () => announcements.filter((a) => !readSet.has(a.id)).length,
    [announcements, readSet],
  )

  const handleMarkAllRead = () => {
    startMarking(async () => {
      const result = await markAllAnnouncementsRead(sectionId)
      if (result.error) {
        toast.error(result.error)
        return
      }
      toast.success('All announcements marked as read')
      router.refresh()
    })
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return announcements
    const q = search.toLowerCase()
    return announcements.filter((a) => a.title.toLowerCase().includes(q))
  }, [announcements, search])

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <PageHeader
        title="Announcements"
        description="Stay up to date with course news and updates."
        actions={
          announcements.length > 0 ? (
            <div className="flex items-center gap-3">
              {unreadCount > 0 && (
                <Button variant="outline" size="sm" onClick={handleMarkAllRead} disabled={isMarking}>
                  <CheckCheck className="h-4 w-4" />
                  {isMarking ? 'Marking…' : 'Mark all as read'}
                </Button>
              )}
              <span className="text-xs text-muted-foreground tabular-nums">
                {unreadCount > 0 ? `${unreadCount} unread · ` : ''}{announcements.length} {announcements.length === 1 ? 'post' : 'posts'}
              </span>
            </div>
          ) : undefined
        }
      />

      {/* Search */}
      {announcements.length > 0 && (
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search announcements…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      )}

      {/* Feed */}
      {filtered.length === 0 ? (
        announcements.length === 0 ? (
          <EmptyState
            variant="teaching"
            icon={Megaphone}
            title="No announcements yet"
            description="Your instructor hasn't posted any announcements for this course."
          />
        ) : (
          <p className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
            No announcements match your search.
          </p>
        )
      ) : (
        <AnimatedList className="space-y-2">
          {filtered.map((announcement) => {
            const isUnread = !readSet.has(announcement.id)
            // The preview holds the full body and CSS truncation doesn't shorten
            // it, so without an explicit label a screen reader reads the whole
            // announcement for every row.
            const rowLabel = [
              isUnread ? 'Unread' : null,
              announcement.is_important ? 'Important' : null,
              announcement.is_pinned ? 'Pinned' : null,
              announcement.requires_acknowledgement ? 'Needs acknowledgement' : null,
              announcement.title,
              formatShort(announcement.published_at),
            ].filter(Boolean).join(', ')

            return (
              <AnimatedItem key={announcement.id}>
                {/* The whole row is one link — no expand, so nothing else moves */}
                <Link
                  href={`/student/courses/${sectionId}/announcements/${announcement.id}`}
                  aria-label={rowLabel}
                  className={cn(
                    'group flex items-start gap-3 rounded-xl border bg-card px-4 py-3 transition duration-200 ease-out motion-reduce:transition-none hover:border-ring/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40',
                    // Border + glyph carry status. The old fills sat on this element
                    // next to bg-card — two competing background declarations — and
                    // composited to near-identical shades of the page background.
                    announcement.is_important
                      ? 'border-warning/40'
                      : announcement.is_pinned
                        ? 'border-info/40'
                        : 'border-border',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {isUnread && (
                        <span className="h-2 w-2 shrink-0 rounded-full bg-info" aria-hidden="true" />
                      )}
                      {announcement.is_important && (
                        <Star className="h-3.5 w-3.5 shrink-0 text-warning-muted-foreground" aria-hidden="true" />
                      )}
                      {announcement.is_pinned && (
                        <Pin className="h-3.5 w-3.5 shrink-0 text-info-muted-foreground" aria-hidden="true" />
                      )}
                      {announcement.requires_acknowledgement && (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                      )}
                      {isNew(announcement.published_at) && (
                        <Badge variant="secondary" className="shrink-0">New</Badge>
                      )}
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate text-sm leading-snug text-foreground',
                          isUnread ? 'font-semibold' : 'font-medium',
                        )}
                      >
                        {announcement.title}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {formatShort(announcement.published_at)}
                      </span>
                    </div>

                    {/* One-line preview — the gist without opening anything */}
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {announcement.content?.trim() || 'No body text'}
                    </p>
                  </div>

                  <ChevronRight
                    className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground"
                    aria-hidden="true"
                  />
                </Link>
              </AnimatedItem>
            )
          })}
        </AnimatedList>
      )}
    </div>
  )
}
