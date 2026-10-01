/**
 * Announcement Detail Page — full-view of a single announcement for students.
 *
 * Shows rich content, attachments, links. Fires read tracking on mount.
 * Conditionally shows ReactionBar and CommentSection based on
 * announcement settings (allow_reactions / allow_comments).
 *
 * Type: Server Component
 * Route: /student/courses/[sectionId]/announcements/[announcementId]
 */

import { notFound } from 'next/navigation'
import { isRichContentEmpty } from '@/lib/announcements/rich-content'
import Link from 'next/link'
import { ArrowLeft, Pin, Paperclip, ExternalLink, Download, Star } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { Badge } from '@/components/ui/badge'
import { RichContentRenderer } from '@/components/shared/announcements/RichContentRenderer'
import { ReadTracker } from '@/components/student/announcements/ReadTracker'
import { ReactionBar } from '@/components/student/announcements/ReactionBar'
import { CommentSection } from '@/components/student/announcements/CommentSection'
import { AcknowledgeCard } from '@/components/student/announcements/AcknowledgeCard'
import { formatFileSize } from '@/lib/supabase/storage'
import { signAnnouncementAttachments } from '@/lib/supabase/signed-urls'
import type { AnnouncementAttachment, AnnouncementLink } from '@/lib/validations/announcement'
import type { JSONContent } from 'novel'

interface AnnouncementDetailPageProps {
  params: Promise<{ sectionId: string; announcementId: string }>
}

// Announcement links and attachment URLs are author-supplied and land straight in
// an `<a href>` shown to every enrolled student, so a `javascript:…` value would
// execute in the reader's session. linkSchema now rejects those on write; this
// guards rows written before it did. Same shape as StudentNotebookView.tsx:28.
const isHttpUrl = (u: string) => /^https?:\/\//i.test(u)

export default async function AnnouncementDetailPage({ params }: AnnouncementDetailPageProps) {
  const { sectionId, announcementId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  // Verify enrollment
  const { data: enrollment } = await adminDb
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', user.id)
    .in('status', ['enrolled', 'completed'])
    .single()

  if (!enrollment) notFound()

  // Fetch announcement
  const { data: announcement } = await adminDb
    .from('announcements')
    .select('*')
    .eq('id', announcementId)
    .eq('section_id', sectionId)
    .eq('status', 'published')
    .single()

  if (!announcement) notFound()

  // Check visibility — if mentioned_only, verify student is mentioned
  if (announcement.visibility === 'mentioned_only') {
    const { data: mention } = await adminDb
      .from('announcement_mentions')
      .select('id')
      .eq('announcement_id', announcementId)
      .eq('student_id', user.id)
      .single()

    if (!mention) notFound()
  }

  // Current acknowledgement state (for required-acknowledgement announcements)
  let acknowledgedAt: string | null = null
  if (announcement.requires_acknowledgement) {
    const { data: readRow } = await adminDb
      .from('announcement_reads')
      .select('acknowledged_at')
      .eq('announcement_id', announcementId)
      .eq('student_id', user.id)
      .maybeSingle()
    acknowledgedAt = readRow?.acknowledged_at ?? null
  }

  // Re-sign attachment URLs from filePath (private bucket; persisted URLs expire).
  const [signedAnnouncement] = await signAnnouncementAttachments([announcement])
  const attachments = (Array.isArray(signedAnnouncement.attachments) ? signedAnnouncement.attachments : []) as AnnouncementAttachment[]
  const links = (Array.isArray(announcement.links) ? announcement.links : []) as AnnouncementLink[]
  const richContent = announcement.rich_content as JSONContent | null

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      {/* Read tracker — fires on mount */}
      <ReadTracker announcementId={announcementId} sectionId={sectionId} />

      {/* Back link */}
      <Link
        href={`/student/courses/${sectionId}/announcements`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Announcements
      </Link>

      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2.5 flex-wrap">
          {announcement.is_pinned && (
            <Badge variant="outline" className="bg-info-muted text-info-muted-foreground border-info/30">
              <Pin className="h-3 w-3" />
              Pinned
            </Badge>
          )}
          {announcement.is_important && (
            <Badge variant="outline" className="bg-warning-muted text-warning-muted-foreground border-warning/40">
              <Star className="h-3 w-3" />
              Important
            </Badge>
          )}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight leading-snug text-foreground">{announcement.title}</h1>
        <p className="text-sm text-muted-foreground">
          {announcement.published_at
            ? new Date(announcement.published_at).toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })
            : 'Not published'}
        </p>
      </div>

      {/* Content */}
      <div className="rounded-2xl border border-border bg-card p-6">
        {!isRichContentEmpty(richContent) ? (
          <RichContentRenderer content={richContent} sectionId={sectionId} />
        ) : announcement.content ? (
          <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">{announcement.content}</p>
        ) : (
          <p className="text-sm text-muted-foreground italic">No content.</p>
        )}
      </div>

      {/* Attachments */}
      {attachments.length > 0 && (
        <div className="space-y-2.5">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Attachments</h3>
          <div className="flex flex-wrap gap-2">
            {attachments.map((att, i) => (
              <div
                key={i}
                className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border bg-muted/30 text-xs"
              >
                <Paperclip className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="font-medium truncate max-w-[180px]">{att.fileName}</span>
                <span className="text-muted-foreground shrink-0 tabular-nums">{formatFileSize(att.fileSize)}</span>
                <div className="flex items-center gap-0.5 ml-1 border-l border-border pl-2">
                  {isHttpUrl(att.fileUrl) && (
                    <a
                      href={att.fileUrl}
                      download={att.fileName}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                      title="Download"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Links */}
      {links.length > 0 && (
        <div className="space-y-2.5">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Links</h3>
          <div className="flex flex-wrap gap-2">
            {links.filter((link) => isHttpUrl(link.url)).map((link, i) => (
              <a
                key={i}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border bg-muted/30 text-xs font-medium text-primary hover:bg-accent hover:border-primary/30 transition-colors"
              >
                <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate max-w-[260px]">
                  {link.label || link.url.replace(/^https?:\/\//, '').split('/')[0]}
                </span>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Acknowledgement — required-ack announcements only */}
      {announcement.requires_acknowledgement && (
        <AcknowledgeCard
          announcementId={announcementId}
          sectionId={sectionId}
          acknowledgedAt={acknowledgedAt}
        />
      )}

      {/* Reactions */}
      {announcement.allow_reactions && (
        <div className="border-t border-border/40 pt-4">
          <ReactionBar announcementId={announcementId} sectionId={sectionId} />
        </div>
      )}

      {/* Comments */}
      {announcement.allow_comments && (
        <div className="border-t border-border/40 pt-4">
          <CommentSection
            announcementId={announcementId}
            sectionId={sectionId}
            currentUserId={user.id}
          />
        </div>
      )}
    </div>
  )
}
