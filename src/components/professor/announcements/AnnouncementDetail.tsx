/**
 * AnnouncementDetail — the reading pane for one announcement.
 *
 * Rendered beside the list on lg+ and in place of the list below lg. This is
 * the professor's only full read surface (there is no professor detail route),
 * which is why the list rows no longer expand in place: growing a card pushed
 * every sibling below it down the page.
 *
 * Owns no state seeded from props — the parent still keys it by announcement id
 * so any state added later can't survive a selection change.
 *
 * Type: Client Component
 */
'use client'

import {
  ArrowLeft, Paperclip, ExternalLink, Eye, Download, Clock, Users,
  Star, CheckCircle2, Pin, Pencil, Trash2, X, MessageSquare,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { getAnnouncementCommentsForStaff } from '@/app/(dashboard)/professor/courses/[sectionId]/announcements/actions'
import { isRichContentEmpty } from '@/lib/announcements/rich-content'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RichContentRenderer } from '@/components/shared/announcements/RichContentRenderer'
import { formatFileSize } from '@/lib/supabase/storage'
import type { Announcement } from '@/lib/supabase/types'
import type { AnnouncementAttachment, AnnouncementLink } from '@/lib/validations/announcement'
import type { JSONContent } from 'novel'

interface AnnouncementDetailProps {
  announcement: Announcement
  sectionId: string
  readCount: number
  ackCount: number
  totalStudents: number
  isPinning: boolean
  onPin: () => void
  onEdit: () => void
  onDelete: () => void
  onPreviewAttachment: (attachment: AnnouncementAttachment) => void
  onBack: () => void
}

// Rows written before linkSchema enforced a scheme can still hold `javascript:…`,
// and signAnnouncementAttachments falls back to the persisted fileUrl when no
// path resolves — so guard at the sink too, not just at the schema.
// Same shape as StudentNotebookView.tsx:28.
const isHttpUrl = (u: string) => /^https?:\/\//i.test(u)

function formatFullDate(dateStr: string | null): string {
  if (!dateStr) return 'Not published'
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

export function AnnouncementDetail({
  announcement,
  sectionId,
  readCount,
  ackCount,
  totalStudents,
  isPinning,
  onPin,
  onEdit,
  onDelete,
  onPreviewAttachment,
  onBack,
}: AnnouncementDetailProps) {
  const attachments = (Array.isArray(announcement.attachments) ? announcement.attachments : []) as AnnouncementAttachment[]
  const links = (Array.isArray(announcement.links) ? announcement.links : []) as AnnouncementLink[]
  const richContent = announcement.rich_content as JSONContent | null
  const isPublished = announcement.status === 'published'
  // Counts only mean something once it's published to a non-empty roster.
  const showCounts = isPublished && totalStudents > 0
  const hasReach = showCounts || !!announcement.requires_acknowledgement

  return (
    <section
      aria-label="Announcement details"
      className="flex h-full min-h-0 flex-col rounded-2xl border border-border bg-card"
    >
      {/* Header — sticks while the body scrolls */}
      <div className="shrink-0 border-b border-border p-4 sm:p-6">
        {/* Back to the list — the list is hidden at this breakpoint */}
        <Button variant="ghost" size="sm" onClick={onBack} className="mb-3 -ml-2 lg:hidden">
          <ArrowLeft className="h-4 w-4" />
          All announcements
        </Button>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {announcement.is_important && (
                <Badge variant="outline" className="border-warning/30 bg-warning-muted text-warning-muted-foreground">
                  <Star className="h-3 w-3 shrink-0" />
                  Important
                </Badge>
              )}
              {announcement.is_pinned && (
                <Badge variant="outline" className="border-info/30 bg-info-muted text-info-muted-foreground">
                  <Pin className="h-3 w-3 shrink-0" />
                  Pinned
                </Badge>
              )}
              {announcement.status === 'draft' && <Badge variant="secondary">Draft</Badge>}
              {announcement.status === 'scheduled' && (
                <Badge variant="secondary">
                  <Clock className="h-3 w-3 shrink-0" />
                  {announcement.scheduled_at ? formatFullDate(announcement.scheduled_at) : 'Scheduled'}
                </Badge>
              )}
              {announcement.visibility === 'mentioned_only' && (
                <Badge variant="outline">
                  <Users className="h-3 w-3 shrink-0" />
                  Selected students
                </Badge>
              )}
            </div>

            <h2 className="text-lg font-semibold leading-snug text-foreground">
              {announcement.title}
            </h2>

            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              {announcement.published_at
                ? formatFullDate(announcement.published_at)
                : announcement.status === 'scheduled' ? 'Not yet published' : 'Not published'}
            </p>
          </div>

          {/* Primary actions — always visible here, no hover required */}
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={onPin}
              disabled={isPinning}
              aria-label={announcement.is_pinned ? 'Unpin announcement' : 'Pin announcement to top'}
              className={cn(announcement.is_pinned && 'bg-info-muted text-info-muted-foreground')}
            >
              <Pin className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={onEdit} aria-label="Edit announcement">
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onDelete}
              aria-label="Delete announcement"
              className="ml-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
            {/* Explicit way out on desktop, where the mobile "All announcements"
                button is hidden — otherwise browser Back is the only exit. */}
            <Button
              variant="ghost"
              size="icon"
              onClick={onBack}
              aria-label="Close announcement"
              // ml-2 so Delete has clearance on BOTH sides, not just from Edit.
              className="ml-2 hidden lg:inline-flex"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Body — the only scroll container, so the list never moves.
          overscroll-contain stops a gesture that runs past the end of this pane
          from chaining to the page and dragging the list with it. */}
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-4 sm:p-6">
        {!isRichContentEmpty(richContent) ? (
          <div className="max-w-prose text-sm text-foreground">
            <RichContentRenderer content={richContent} sectionId={sectionId} basePath="/professor" />
          </div>
        ) : announcement.content ? (
          <p className="max-w-prose whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {announcement.content}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">This announcement has no body text.</p>
        )}

        {attachments.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Attachments
            </h3>
            <div className="flex flex-wrap gap-2">
              {attachments.map((att, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-1.5 text-xs"
                >
                  <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="max-w-[160px] truncate font-medium">{att.fileName}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">{formatFileSize(att.fileSize)}</span>
                  <div className="ml-1 flex items-center gap-0.5 border-l border-border pl-2">
                    <button
                      onClick={() => onPreviewAttachment(att)}
                      className="cursor-pointer rounded-full p-1 text-muted-foreground transition-colors motion-reduce:transition-none hover:bg-muted hover:text-foreground"
                      aria-label={`Preview ${att.fileName}`}
                    >
                      <Eye className="h-3 w-3" />
                    </button>
                    {isHttpUrl(att.fileUrl) && (
                      <a
                        href={att.fileUrl}
                        download={att.fileName}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-full p-1 text-muted-foreground transition-colors motion-reduce:transition-none hover:bg-muted hover:text-foreground"
                        aria-label={`Download ${att.fileName}`}
                      >
                        <Download className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {links.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Links
            </h3>
            <div className="flex flex-wrap gap-2">
              {links.filter((link) => isHttpUrl(link.url)).map((link, i) => (
                <a
                  key={i}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 rounded-xl border border-border bg-muted/40 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:border-primary/30 hover:bg-accent"
                >
                  <ExternalLink className="h-3 w-3 shrink-0" />
                  <span className="max-w-[200px] truncate">
                    {link.label || link.url.replace(/^https?:\/\//, '').split('/')[0]}
                  </span>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* The author could not see their own discussion (#669 part 2): the student action
            gates on enrollment, and a professor is not enrolled in their own section, so
            every read came back empty. Read-only — surfacing the thread was the approved
            change; letting staff delete a student's comment is a separate decision. */}
        {announcement.allow_comments && (
          <StaffCommentThread announcementId={announcement.id} sectionId={sectionId} />
        )}

      </div>

      {/* Reach — "did they read it?" is the question this screen exists to answer,
          so it's pinned as a real footer outside the scrolling body rather than
          sitting below a long announcement. Gated: every child is conditional, and
          an unconditional wrapper rendered an orphan hairline plus 40px of empty
          padding on a draft with acknowledgement, reactions and comments all off. */}
      {hasReach && (
        <div className="shrink-0 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-4 py-3 sm:px-6">
          {showCounts && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
              <Eye className="h-3.5 w-3.5" />
              {readCount} of {totalStudents} read
            </span>
          )}
          {announcement.requires_acknowledgement && (
            showCounts ? (
              <span className="flex items-center gap-1.5 text-xs text-primary tabular-nums">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {ackCount} of {totalStudents} acknowledged
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Needs acknowledgement
              </span>
            )
          )}
        </div>
      )}
    </section>
  )
}

/** Comments on an announcement, as section staff see them: present, and read-only. */
function StaffCommentThread({ announcementId, sectionId }: { announcementId: string; sectionId: string }) {
  const [comments, setComments] = useState<StaffComment[] | null>(null)

  useEffect(() => {
    let cancelled = false
    getAnnouncementCommentsForStaff(announcementId, sectionId).then((res) => {
      if (!cancelled) setComments((res.data ?? []) as StaffComment[])
    })
    return () => {
      cancelled = true
    }
  }, [announcementId, sectionId])

  if (comments === null) {
    return <p className="mt-6 text-xs text-muted-foreground">Loading comments…</p>
  }

  return (
    <div className="mt-6 border-t border-border pt-4">
      <h3 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <MessageSquare className="h-3.5 w-3.5" />
        {comments.length === 0
          ? 'Comments'
          : `${comments.length} comment${comments.length === 1 ? '' : 's'}`}
      </h3>
      {comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet.</p>
      ) : (
        <ul className="space-y-3">
          {comments.map((c) => (
            <li key={c.id} className="rounded-xl bg-muted/40 px-3 py-2">
              <p className="text-xs font-medium text-foreground">
                {c.author?.name || c.author?.email || 'Student'}
              </p>
              <p className="mt-0.5 text-sm text-foreground whitespace-pre-wrap break-words">{c.content}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface StaffComment {
  id: string
  content: string
  created_at: string
  author_id: string
  author: { id: string; name: string | null; email: string } | null
}
