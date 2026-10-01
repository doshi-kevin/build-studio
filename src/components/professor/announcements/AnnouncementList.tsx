/**
 * AnnouncementList — professor view with create/edit/delete/pin actions.
 *
 * Reading-pane layout: a scannable list on the left, the selected announcement
 * in its own scroll container on the right (lg+), or in place of the list below
 * lg. Rows have a FIXED height and never grow — the previous cards expanded in
 * flow on hover, focus, and click, which shoved every announcement below them
 * down the page.
 *
 * Selection lives in the `?a=<id>` query param, not local state, so browser
 * back closes the pane, refresh and deep links keep the open announcement, and
 * a desktop→mobile resize doesn't lose the reading position.
 *
 * Type: Client Component
 */
'use client'

import { useState, useTransition, useMemo, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Megaphone, Plus, Search, Pin, Pencil, Trash2, Eye, Clock,
  Users, Star, CheckCircle2, MoreHorizontal,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { PageHeader } from '@/components/professor/PageHeader'
import { MaterialViewer } from '@/components/ui/material-viewer'
import { AnnouncementDetail } from './AnnouncementDetail'
import { CreateAnnouncementDialog } from './CreateAnnouncementDialog'
import { DeleteAnnouncementDialog } from './DeleteAnnouncementDialog'
import { toggleAnnouncementPin } from '@/app/(dashboard)/professor/courses/[sectionId]/announcements/actions'
import type { Announcement } from '@/lib/supabase/types'
import type { AnnouncementAttachment, AnnouncementLink } from '@/lib/validations/announcement'
import type { CourseItem } from '@/lib/tiptap/course-mention-extension'

type FilterTab = 'all' | 'published' | 'draft' | 'scheduled'

interface EnrolledStudent {
  id: string
  name: string | null
  email: string
}

interface PostableSection {
  id: string
  label: string
  sublabel?: string
}

interface AnnouncementListProps {
  sectionId: string
  announcements: Announcement[]
  readCounts?: Record<string, number>
  ackCounts?: Record<string, number>
  totalStudents?: number
  enrolledStudents?: EnrolledStudent[]
  courseItems?: CourseItem[]
  otherSections?: PostableSection[]
  groupedIds?: string[]
}

function formatShort(dateStr: string | null): string {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function AnnouncementList({
  sectionId,
  announcements,
  readCounts = {},
  ackCounts = {},
  totalStudents = 0,
  enrolledStudents,
  courseItems,
  otherSections = [],
  groupedIds = [],
}: AnnouncementListProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const isCreateAction = searchParams.get('action') === 'create'
  const paramId = searchParams.get('a')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterTab>('all')
  // Auto-open create dialog when navigated via quick action (?action=create)
  const [createOpen, setCreateOpen] = useState(isCreateAction)

  const basePath = `/professor/courses/${sectionId}/announcements`

  // Clean URL params after auto-opening so browser back doesn't re-trigger
  useEffect(() => {
    if (isCreateAction) {
      router.replace(basePath, { scroll: false })
    }
  }, [isCreateAction, basePath, router])
  const [editAnnouncement, setEditAnnouncement] = useState<Announcement | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Announcement | null>(null)
  const [isPinning, startPinTransition] = useTransition()
  const [viewerFile, setViewerFile] = useState<AnnouncementAttachment | null>(null)
  const [isNavigating, startNavigation] = useTransition()
  // Tri-state: `undefined` = nothing pending (follow the URL), a string = opening
  // that announcement, `null` = closing. `null` has to be distinct from
  // `undefined` or closing the pane would keep rendering it until the URL commits.
  const [pendingId, setPendingId] = useState<string | null | undefined>(undefined)

  // Every announcement is already on the client, so paint the clicked one at
  // once and let the URL catch up. Reading `?a=` alone left the pane showing the
  // PREVIOUS announcement for the whole RSC round-trip — a stale pane that looks
  // like an answer.
  const activeId = isNavigating && pendingId !== undefined ? pendingId : paramId

  const selected = useMemo(
    () => announcements.find((a) => a.id === activeId) ?? null,
    [announcements, activeId],
  )

  const selectAnnouncement = (id: string) => {
    setPendingId(id)
    // Always `push` — never conditionally `replace`. The URL commit trails the
    // click by 1.5–2.4s, so at click time we cannot know whether our own previous
    // push has landed yet, and `replace`-ing before it does overwrites the *bare
    // list* entry — leaving nothing to go Back to. One history entry per
    // announcement opened is the predictable trade; the pane's Close button, not
    // Back, is the primary way out.
    startNavigation(() => router.push(`${basePath}?a=${id}`, { scroll: false }))
  }

  const clearSelection = () => {
    setPendingId(null)
    startNavigation(() => router.replace(basePath, { scroll: false }))
  }

  // Drop a selection that no longer resolves — the announcement was deleted, or
  // the id came from a stale link.
  // Fires once per distinct stale id. Gating on `isNavigating` instead looks
  // equivalent but spins: starting the transition flips the flag true, the effect
  // re-runs, the flag drops back to false, and the effect fires again — forever if
  // the replace never lands. A ref breaks the feedback loop outright.
  const clearedParamRef = useRef<string | null>(null)
  useEffect(() => {
    if (paramId && clearedParamRef.current !== paramId && !announcements.some((a) => a.id === paramId)) {
      clearedParamRef.current = paramId
      router.replace(basePath, { scroll: false })
    }
  }, [paramId, announcements, basePath, router])

  const filtered = useMemo(() => {
    let list = announcements
    if (filter !== 'all') {
      list = list.filter((a) => a.status === filter)
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter((a) => a.title.toLowerCase().includes(q))
    }
    return list
  }, [announcements, filter, search])

  const handlePin = (announcement: Announcement) => {
    // The ⋯ menu closes on click, so `isPinning` has nothing left to disable —
    // without a pending toast the professor gets no feedback at all until the
    // list re-sorts a couple of seconds later.
    const pinning = !announcement.is_pinned
    const toastId = toast.loading(pinning ? 'Pinning…' : 'Unpinning…')
    startPinTransition(async () => {
      const result = await toggleAnnouncementPin(announcement.id, sectionId)
      if (result.error) {
        toast.error(result.error, { id: toastId })
        return
      }
      toast.success(pinning ? 'Pinned to top' : 'Unpinned', { id: toastId })
    })
  }

  const publishedCount = useMemo(
    () => announcements.filter((a) => a.status === 'published').length,
    [announcements],
  )
  const draftCount = useMemo(
    () => announcements.filter((a) => a.status === 'draft').length,
    [announcements],
  )
  const scheduledCount = useMemo(
    () => announcements.filter((a) => a.status === 'scheduled').length,
    [announcements],
  )

  // Onboarding empty state — no announcements at all yet.
  if (announcements.length === 0) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <PageHeader
          title="Announcements"
          description="Post updates and news for your students."
        />
        <EmptyState
          variant="teaching"
          icon={Megaphone}
          title="Post your first announcement"
          description="Share updates, deadlines, and news with your class. Attach files, link course items, and schedule posts to publish later."
        >
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            New announcement
          </Button>
        </EmptyState>
        <CreateAnnouncementDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          sectionId={sectionId}
          enrolledStudents={enrolledStudents}
          courseItems={courseItems}
          otherSections={otherSections}
          basePath="/professor"
        />
      </div>
    )
  }

  const summary = [
    `${announcements.length} announcement${announcements.length !== 1 ? 's' : ''}`,
    `${publishedCount} published`,
    ...(draftCount > 0 ? [`${draftCount} draft${draftCount !== 1 ? 's' : ''}`] : []),
    ...(scheduledCount > 0 ? [`${scheduledCount} scheduled`] : []),
  ].join('  ·  ')

  return (
    // h-full fills the course shell's scrolling <main> so the two panes scroll
    // independently instead of the whole page scrolling the detail out of view.
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Hidden below lg while reading: the page header plus its action button took
          352px — 42% of a 390x844 viewport — above the announcement title. */}
      <div className={cn('shrink-0', selected && 'hidden lg:block')}>
        <PageHeader
          title="Announcements"
          description="Post updates and news for your students."
          actions={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              New announcement
            </Button>
          }
        />
      </div>

      {/* List + reading pane. Below lg only one of the two shows at a time. */}
      <div className="flex min-h-0 flex-1 flex-col gap-6 lg:flex-row">
        <div
          className={cn(
            'min-h-0 w-full flex-col gap-3 lg:max-w-sm lg:shrink-0 xl:max-w-md',
            selected ? 'hidden lg:flex' : 'flex',
          )}
        >
          {/* Search + filters live INSIDE the column they filter, so they size to
              it and disappear with it when the pane takes over below lg. */}
          <div className="shrink-0 space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search announcements..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <ToggleGroup
              type="single"
              value={filter}
              onValueChange={(v) => v && setFilter(v as FilterTab)}
              variant="outline"
              size="sm"
              className="w-full"
            >
              <ToggleGroupItem value="all" aria-label="All announcements">All</ToggleGroupItem>
              <ToggleGroupItem value="published" aria-label="Published announcements">Published</ToggleGroupItem>
              <ToggleGroupItem value="draft" aria-label="Draft announcements">Drafts</ToggleGroupItem>
              <ToggleGroupItem value="scheduled" aria-label="Scheduled announcements">Scheduled</ToggleGroupItem>
            </ToggleGroup>
            <p className="text-xs text-muted-foreground tabular-nums">{summary}</p>
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-10 text-center">
              <p className="text-sm text-muted-foreground">
                {search.trim()
                  ? `No announcements match “${search.trim()}”.`
                  : `No ${filter} announcements.`}
              </p>
              <Button
                variant="link"
                size="sm"
                onClick={() => { setSearch(''); setFilter('all') }}
              >
                Clear filters
              </Button>
            </div>
          ) : (
            // overscroll-contain: hitting the end of this scroller must not
            // chain the gesture to the page and drag the list.
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <AnimatedList className="space-y-2 pr-1">
                {filtered.map((announcement) => {
                  const readCount = readCounts[announcement.id] || 0
                  const isSelected = announcement.id === activeId
                  const isPublished = announcement.status === 'published'
                  // The row's whole body is its text content, and CSS truncation
                  // doesn't shorten it — without this a screen reader reads the
                  // entire announcement for every row.
                  const rowLabel = [
                    announcement.status === 'draft' ? 'Draft' : null,
                    announcement.status === 'scheduled' ? 'Scheduled' : null,
                    announcement.is_important ? 'Important' : null,
                    announcement.is_pinned ? 'Pinned' : null,
                    announcement.title,
                    isPublished ? formatShort(announcement.published_at) : null,
                  ].filter(Boolean).join(', ')

                  return (
                    <AnimatedItem key={announcement.id}>
                      <div
                        className={cn(
                          'group flex items-start gap-1 rounded-xl border bg-card transition duration-200 ease-out motion-reduce:transition-none hover:border-ring/40 hover:shadow-sm',
                          // Status is carried by the border plus a glyph. The old
                          // fills (bg-warning-muted/15 etc.) also sat on this
                          // element alongside bg-card — two competing background
                          // declarations — and composited to four shades within
                          // ~0.005 L of each other on a near-white page, i.e.
                          // mutually indistinguishable. Border-only is what was
                          // actually rendering.
                          isSelected
                            ? 'border-ring bg-accent shadow-sm ring-1 ring-inset ring-ring/30'
                            : announcement.is_important
                              ? 'border-warning/40'
                              : announcement.is_pinned
                                ? 'border-info/40'
                                : 'border-border',
                        )}
                      >
                        {/* One click target for the whole row — opens the reading pane */}
                        <button
                          onClick={() => selectAnnouncement(announcement.id)}
                          aria-current={isSelected ? 'true' : undefined}
                          aria-label={rowLabel}
                          className="min-w-0 flex-1 cursor-pointer rounded-xl px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
                        >
                          <div className="flex items-center gap-2">
                            {announcement.is_important && (
                              <Star className="h-3.5 w-3.5 shrink-0 text-warning-muted-foreground" aria-hidden="true" />
                            )}
                            {announcement.is_pinned && (
                              <Pin className="h-3.5 w-3.5 shrink-0 text-info-muted-foreground" aria-hidden="true" />
                            )}
                            {announcement.requires_acknowledgement && (
                              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                            )}
                            {announcement.visibility === 'mentioned_only' && (
                              <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                            )}
                            {announcement.status === 'draft' && (
                              <Badge variant="secondary" className="shrink-0">Draft</Badge>
                            )}
                            {announcement.status === 'scheduled' && (
                              <Badge variant="secondary" className="shrink-0">
                                <Clock className="h-3 w-3" />
                                {formatShort(announcement.scheduled_at)}
                              </Badge>
                            )}
                            <span className="min-w-0 flex-1 truncate text-sm font-semibold leading-snug text-foreground">
                              {announcement.title}
                            </span>
                            {isPublished && (
                              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                                {formatShort(announcement.published_at)}
                              </span>
                            )}
                          </div>

                          {/* Preview + reach on one fixed line — the gist without opening anything */}
                          <div className="mt-1 flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                              {announcement.content?.trim() || 'No body text'}
                            </span>
                            {isPublished && totalStudents > 0 && (
                              <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
                                <Eye className="h-3 w-3" />
                                {readCount}/{totalStudents}
                              </span>
                            )}
                          </div>
                        </button>

                        {/* Row actions — one tab stop, and reachable on touch (not hover-gated) */}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Actions for ${announcement.title}`}
                              // Full-strength muted (4.7:1). /50 measured ~2:1 and
                              // /70 measured 2.98:1 — both under WCAG 1.4.11's 3:1
                              // floor for a control, and on touch group-hover never
                              // fires so whatever it is at rest is all you get.
                              className="mr-1 mt-1 shrink-0 text-muted-foreground transition-colors motion-reduce:transition-none group-hover:text-foreground"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handlePin(announcement)} disabled={isPinning}>
                              <Pin className="h-4 w-4" />
                              {announcement.is_pinned ? 'Unpin' : 'Pin to top'}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setEditAnnouncement(announcement)}>
                              <Pencil className="h-4 w-4" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setDeleteTarget(announcement)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </AnimatedItem>
                  )
                })}
              </AnimatedList>
            </div>
          )}
        </div>

        {/* Reading pane */}
        <div className={cn('min-h-0 flex-1', selected ? 'block' : 'hidden lg:block')}>
          {selected ? (
            <AnnouncementDetail
              /* Keyed on id AND updated_at so no per-announcement state survives either a
                 selection change or an EDIT (#668). Id alone kept the instance alive
                 across a save, and the body is rendered by Novel's EditorContent, which
                 reads `initialContent` only at mount — so the list row updated with the
                 new text while the detail pane went on showing the pre-edit content, on
                 the same screen. The professor's natural reaction is to edit again. */
              key={`${selected.id}:${selected.updated_at ?? ''}`}
              announcement={selected}
              sectionId={sectionId}
              readCount={readCounts[selected.id] || 0}
              ackCount={ackCounts[selected.id] || 0}
              totalStudents={totalStudents}
              isPinning={isPinning}
              onPin={() => handlePin(selected)}
              onEdit={() => setEditAnnouncement(selected)}
              onDelete={() => setDeleteTarget(selected)}
              onPreviewAttachment={setViewerFile}
              onBack={clearSelection}
            />
          ) : (
            <div className="flex h-full min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/50 p-8 text-center">
              <Megaphone className="h-8 w-8 text-muted-foreground/40" />
              <p className="mt-3 text-sm font-medium text-foreground">No announcement selected</p>
              <p className="mt-1 max-w-xs text-sm text-muted-foreground">
                Pick an announcement to read it here, see who&apos;s opened it, and edit or pin it.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Material Viewer */}
      {viewerFile && (
        <MaterialViewer
          open={!!viewerFile}
          onOpenChange={(open) => { if (!open) setViewerFile(null) }}
          url={viewerFile.fileUrl}
          fileName={viewerFile.fileName}
          fileSize={viewerFile.fileSize}
        />
      )}

      {/* Dialogs */}
      <CreateAnnouncementDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        sectionId={sectionId}
        enrolledStudents={enrolledStudents}
        courseItems={courseItems}
        otherSections={otherSections}
        basePath="/professor"
      />

      <CreateAnnouncementDialog
        open={!!editAnnouncement}
        onOpenChange={(open) => { if (!open) setEditAnnouncement(null) }}
        sectionId={sectionId}
        announcement={editAnnouncement ? {
          ...editAnnouncement,
          // announcements columns are nullable-with-default in the DB; coerce the
          // ones the dialog requires non-null back to their defaults.
          content: editAnnouncement.content ?? '',
          is_pinned: editAnnouncement.is_pinned ?? false,
          status: editAnnouncement.status ?? 'published',
          visibility: editAnnouncement.visibility ?? undefined,
          allow_reactions: editAnnouncement.allow_reactions ?? undefined,
          allow_comments: editAnnouncement.allow_comments ?? undefined,
          attachments: (Array.isArray(editAnnouncement.attachments) ? editAnnouncement.attachments : undefined) as AnnouncementAttachment[] | undefined,
          links: (Array.isArray(editAnnouncement.links) ? editAnnouncement.links : undefined) as AnnouncementLink[] | undefined,
        } : null}
        isGrouped={!!editAnnouncement && groupedIds.includes(editAnnouncement.id)}
        enrolledStudents={enrolledStudents}
        courseItems={courseItems}
        basePath="/professor"
      />

      <DeleteAnnouncementDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        sectionId={sectionId}
        announcement={deleteTarget}
      />
    </div>
  )
}
