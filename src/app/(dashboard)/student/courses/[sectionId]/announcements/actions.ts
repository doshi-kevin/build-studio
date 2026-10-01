/**
 * Student Announcement Server Actions — read tracking, reactions, comments.
 *
 * Verifies enrollment before any mutation.
 * Uses admin client for DB operations (bypasses RLS).
 */
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { reactionSchema, commentSchema } from '@/lib/validations/announcement-interaction'

// ── Helpers ─────────────────────────────────────────────────────

async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

async function verifyEnrollment(sectionId: string, userId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  const { data: enrollment } = await adminDb
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', userId)
    .in('status', ['enrolled', 'completed'])
    .single()

  if (!enrollment) return { enrolled: false as const, adminDb }
  return { enrolled: true as const, adminDb }
}

/**
 * Confirms an announcement belongs to the given section. The actions take an
 * announcementId from the client but only verify enrollment in sectionId, so
 * without this an enrolled student could read/write another section's
 * announcement interactions (incl. commenter name + email).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function announcementInSection(adminDb: any, announcementId: string, sectionId: string): Promise<boolean> {
  const { data } = await adminDb
    .from('announcements')
    .select('id')
    .eq('id', announcementId)
    .eq('section_id', sectionId)
    .maybeSingle()
  return !!data
}

// ── Read Tracking ───────────────────────────────────────────────

export async function markAnnouncementRead(announcementId: string, sectionId: string) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Unauthorized' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    if (!(await announcementInSection(adminDb, announcementId, sectionId))) {
      return { error: 'Announcement not found' }
    }

    // Upsert — ignore conflict if already read
    await adminDb
      .from('announcement_reads')
      .upsert(
        { announcement_id: announcementId, student_id: user.id, read_at: new Date().toISOString() },
        { onConflict: 'announcement_id,student_id', ignoreDuplicates: true }
      )

    // Reading drops the item from the dashboard's unread-important panel and
    // flips its state on the cross-course announcements list.
    revalidatePath('/dashboard')
    revalidatePath('/student/announcements')

    return { success: true }
  } catch (error) {
    logger.error('markAnnouncementRead: Unexpected error', error, { announcementId, sectionId })
    return { error: 'Failed to mark as read' }
  }
}

/**
 * Acknowledge an announcement ("I have read this"). Sets acknowledged_at on the
 * student's read row (and read_at, since acknowledging implies reading). Only
 * meaningful when the announcement requires acknowledgement, but harmless
 * otherwise. Idempotent — re-acknowledging keeps the original timestamp.
 */
export async function acknowledgeAnnouncement(announcementId: string, sectionId: string) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Unauthorized' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    // Confirm the announcement is in this section AND actually requires ack.
    const { data: announcement } = await adminDb
      .from('announcements')
      .select('requires_acknowledgement')
      .eq('id', announcementId)
      .eq('section_id', sectionId)
      .maybeSingle()

    if (!announcement) return { error: 'Announcement not found' }
    if (!announcement.requires_acknowledgement) return { error: 'This announcement does not require acknowledgement' }

    const now = new Date().toISOString()
    // Upsert the read row and stamp acknowledged_at. onConflict updates the
    // existing row (so a prior passive read becomes an acknowledgement).
    const { error } = await adminDb
      .from('announcement_reads')
      .upsert(
        { announcement_id: announcementId, student_id: user.id, read_at: now, acknowledged_at: now },
        { onConflict: 'announcement_id,student_id' },
      )

    if (error) {
      logger.error('acknowledgeAnnouncement: upsert failed', error, { announcementId, sectionId })
      return { error: 'Failed to acknowledge' }
    }

    revalidatePath(`/student/courses/${sectionId}/announcements/${announcementId}`)
    revalidatePath(`/student/courses/${sectionId}/announcements`)
    return { success: true }
  } catch (error) {
    logger.error('acknowledgeAnnouncement: Unexpected error', error, { announcementId, sectionId })
    return { error: 'Failed to acknowledge' }
  }
}

/**
 * Mark every announcement the student can see in this section as read. Powers
 * the "Mark all as read" action that clears the unread nav badge.
 */
export async function markAllAnnouncementsRead(sectionId: string) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Unauthorized' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    // Announcements visible to this student: published, and either public or
    // one they're mentioned in.
    const { data: mentions } = await adminDb
      .from('announcement_mentions')
      .select('announcement_id')
      .eq('student_id', user.id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mentionedIds = ((mentions || []) as any[]).map((m) => m.announcement_id)

    const { data: announcements } = await adminDb
      .from('announcements')
      .select('id, visibility')
      .eq('section_id', sectionId)
      .eq('status', 'published')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const visibleIds = ((announcements || []) as any[])
      .filter((a) => a.visibility === 'all' || mentionedIds.includes(a.id))
      .map((a) => a.id)

    if (visibleIds.length === 0) return { success: true }

    const now = new Date().toISOString()
    /* via_bulk marks these as "cleared from the badge", NOT viewed. The professor's
       read receipts exclude them — one click here used to register this student as
       having viewed announcements they never opened (#667). The student's own unread
       badge still counts every row, which is what this action is for. */
    const rows = visibleIds.map((id: string) => ({
      announcement_id: id,
      student_id: user.id,
      read_at: now,
      via_bulk: true,
    }))

    // Insert reads for any not already read; leave existing rows (and their
    // acknowledged_at) untouched.
    await adminDb
      .from('announcement_reads')
      .upsert(rows, { onConflict: 'announcement_id,student_id', ignoreDuplicates: true })

    revalidatePath(`/student/courses/${sectionId}/announcements`)
    return { success: true }
  } catch (error) {
    logger.error('markAllAnnouncementsRead: Unexpected error', error, { sectionId })
    return { error: 'Failed to mark all as read' }
  }
}

// ── Reactions ───────────────────────────────────────────────────

export async function toggleReaction(announcementId: string, sectionId: string, emoji: string) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Unauthorized' }

    const parsed = reactionSchema.safeParse({ emoji })
    if (!parsed.success) return { error: 'Invalid emoji' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    // Check the announcement is in this section and reactions are allowed.
    const { data: announcement } = await adminDb
      .from('announcements')
      .select('allow_reactions')
      .eq('id', announcementId)
      .eq('section_id', sectionId)
      .single()

    if (!announcement) return { error: 'Announcement not found' }
    if (!announcement.allow_reactions) return { error: 'Reactions are not enabled' }

    // Check if already reacted with this emoji
    const { data: existing } = await adminDb
      .from('announcement_reactions')
      .select('id')
      .eq('announcement_id', announcementId)
      .eq('student_id', user.id)
      .eq('emoji', emoji)
      .single()

    if (existing) {
      // Remove reaction
      await adminDb
        .from('announcement_reactions')
        .delete()
        .eq('id', existing.id)
    } else {
      // Add reaction
      await adminDb
        .from('announcement_reactions')
        .insert({
          announcement_id: announcementId,
          student_id: user.id,
          emoji,
        })
    }

    revalidatePath(`/student/courses/${sectionId}/announcements`)
    return { success: true, toggled: !existing }
  } catch (error) {
    logger.error('toggleReaction: Unexpected error', error, { announcementId, sectionId })
    return { error: 'Failed to toggle reaction' }
  }
}

export async function getAnnouncementReactions(announcementId: string, sectionId: string) {
  try {
    const user = await getAuthUser()
    if (!user) return { data: [] }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { data: [] }

    if (!(await announcementInSection(adminDb, announcementId, sectionId))) {
      return { data: [] }
    }

    const { data: reactions } = await adminDb
      .from('announcement_reactions')
      .select('emoji, student_id')
      .eq('announcement_id', announcementId)

    if (!reactions) return { data: [] }

    // Group by emoji
    const emojiMap: Record<string, { emoji: string; count: number; reacted: boolean }> = {}
    for (const r of reactions) {
      if (!emojiMap[r.emoji]) {
        emojiMap[r.emoji] = { emoji: r.emoji, count: 0, reacted: false }
      }
      emojiMap[r.emoji].count++
      if (r.student_id === user.id) {
        emojiMap[r.emoji].reacted = true
      }
    }

    return { data: Object.values(emojiMap) }
  } catch (error) {
    logger.error('getAnnouncementReactions: Unexpected error', error, { announcementId })
    return { data: [] }
  }
}

// ── Comments ────────────────────────────────────────────────────

export async function createComment(announcementId: string, sectionId: string, content: string) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Unauthorized' }

    const parsed = commentSchema.safeParse({ content })
    if (!parsed.success) return { error: parsed.error.issues[0]?.message || 'Invalid comment' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    // Check the announcement is in this section and comments are allowed.
    const { data: announcement } = await adminDb
      .from('announcements')
      .select('allow_comments')
      .eq('id', announcementId)
      .eq('section_id', sectionId)
      .single()

    if (!announcement) return { error: 'Announcement not found' }
    if (!announcement.allow_comments) return { error: 'Comments are not enabled' }

    const { error } = await adminDb
      .from('announcement_comments')
      .insert({
        announcement_id: announcementId,
        author_id: user.id,
        content: parsed.data.content,
      })

    if (error) {
      logger.error('createComment: Insert failed', error, { announcementId })
      return { error: 'Failed to post comment' }
    }

    revalidatePath(`/student/courses/${sectionId}/announcements/${announcementId}`)
    return { success: true }
  } catch (error) {
    logger.error('createComment: Unexpected error', error, { announcementId, sectionId })
    return { error: 'Failed to post comment' }
  }
}

export async function deleteComment(commentId: string, announcementId: string, sectionId: string) {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Unauthorized' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this course' }

    // Only allow deleting own comments
    const { data: comment } = await adminDb
      .from('announcement_comments')
      .select('author_id')
      .eq('id', commentId)
      .single()

    if (!comment) return { error: 'Comment not found' }
    if (comment.author_id !== user.id) return { error: 'You can only delete your own comments' }

    await adminDb
      .from('announcement_comments')
      .delete()
      .eq('id', commentId)

    revalidatePath(`/student/courses/${sectionId}/announcements/${announcementId}`)
    return { success: true }
  } catch (error) {
    logger.error('deleteComment: Unexpected error', error, { commentId, sectionId })
    return { error: 'Failed to delete comment' }
  }
}

export async function getAnnouncementComments(announcementId: string, sectionId: string) {
  try {
    const user = await getAuthUser()
    if (!user) return { data: [] }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { data: [] }

    if (!(await announcementInSection(adminDb, announcementId, sectionId))) {
      return { data: [] }
    }

    const { data: comments } = await adminDb
      .from('announcement_comments')
      .select('id, content, created_at, author_id, author:profiles(id, name, email)')
      .eq('announcement_id', announcementId)
      .order('created_at', { ascending: true })

    return { data: comments || [] }
  } catch (error) {
    logger.error('getAnnouncementComments: Unexpected error', error, { announcementId })
    return { data: [] }
  }
}
