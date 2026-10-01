/**
 * Announcements Server Actions — CRUD for section announcements.
 *
 * Writes are allowed for the section's professor and for active TAs; graders
 * and everyone else are blocked. Access is checked via verifySectionAccess()
 * on every action so TAs can post announcements through the same UI tree as
 * the professor without needing a duplicated /staff route.
 *
 * Includes auto-publish for scheduled announcements, mention sync,
 * and read-count aggregation.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import { extractLinkedItems } from '@/lib/tiptap-utils'
import { emitEvent } from '@/lib/events/emit'
import { resolveAnnouncementAudience } from '@/lib/events/audience'
import { ROLE_DENIED_MESSAGE, canWriteAsStaff, verifySectionAccess } from '@/lib/auth/section-access'
import { rewriteAnnouncement } from '@/lib/ai/llm-client'
import { checkAiFeatureBySection } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'
import { autoPublishScheduledAnnouncements } from '@/lib/notifications/announcement-auto-publish'
import {
  createAnnouncementSchema,
  updateAnnouncementSchema,
  type CreateAnnouncementInput,
  type UpdateAnnouncementInput,
} from '@/lib/validations/announcement'

// ── Helpers ──────────────────────────────────────────────────────

async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

function sectionPath(sectionId: string) {
  return `/professor/courses/${sectionId}`
}

/**
 * Sync mention records: delete old, insert new.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function syncMentions(adminDb: any, announcementId: string, studentIds: string[]) {
  // Delete existing mentions
  await adminDb
    .from('announcement_mentions')
    .delete()
    .eq('announcement_id', announcementId)

  // Insert new mentions
  if (studentIds.length > 0) {
    const rows = studentIds.map((sid) => ({
      announcement_id: announcementId,
      student_id: sid,
    }))
    await adminDb.from('announcement_mentions').insert(rows)
  }
}

// ── Actions ──────────────────────────────────────────────────────

export async function getAnnouncements(sectionId: string) {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated', data: [] }

  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok) return { error: 'You do not have access to this section', data: [] }
  const adminDb = access.adminDb

  // Auto-publish any scheduled announcements that are past due, and notify the class.
  await autoPublishScheduledAnnouncements(adminDb, sectionId)

  /* Embeds the mention rows so the edit form can SEED its student picker (#666).
     Without them the picker opened empty on a targeted announcement: the professor
     either couldn't save (the "select at least one student" guard blocked it) or
     re-picked from scratch, silently changing who it was aimed at. An edit form must
     open showing current state. */
  const { data, error } = await adminDb
    .from('announcements')
    .select('*, announcement_mentions(student_id)')
    .eq('section_id', sectionId)
    .order('is_pinned', { ascending: false, nullsFirst: false })
    .order('published_at', { ascending: false })

  if (error) {
    logger.error('getAnnouncements: Fetch failed', error, { sectionId })
    return { error: 'Failed to load announcements', data: [] }
  }

  // Flatten to a plain id list — the form wants ids, not join rows.
  const rows = (data || []).map((a: Record<string, unknown>) => ({
    ...a,
    mentioned_student_ids: ((a.announcement_mentions as Array<{ student_id: string }> | null) ?? []).map(
      (m) => m.student_id,
    ),
  }))

  return { data: rows }
}

export async function createAnnouncement(
  sectionId: string,
  input: CreateAnnouncementInput,
): Promise<{ success?: boolean; error?: string; id?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = createAnnouncementSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) return { error: ROLE_DENIED_MESSAGE }
    const adminDb = access.adminDb

    const d = parsed.data

    // Multi-section posting is incompatible with per-student targeting (the
    // student picker is inherently scoped to one section's roster).
    const additionalSectionIds = (d.additional_section_ids ?? []).filter(
      (id) => id !== sectionId,
    )
    if (additionalSectionIds.length > 0 && d.visibility === 'mentioned_only') {
      return { error: 'Cannot post to multiple sections with "Selected students only" audience' }
    }

    // Determine published_at and scheduled_at based on status
    let published_at: string | null = null
    let scheduled_at: string | null = null

    if (d.status === 'published') {
      published_at = new Date().toISOString()
    } else if (d.status === 'scheduled') {
      if (!d.scheduled_at) {
        return { error: 'Scheduled time is required for scheduled announcements' }
      }
      scheduled_at = d.scheduled_at
    }

    // Shared row payload (identical content for every section this posts to).
    const rowBase = {
      author_id: user.id,
      title: d.title,
      content: d.content || '',
      rich_content: d.rich_content || null,
      is_pinned: d.is_pinned ?? false,
      is_important: d.is_important ?? false,
      requires_acknowledgement: d.requires_acknowledgement ?? false,
      status: d.status ?? 'published',
      scheduled_at,
      visibility: d.visibility ?? 'all',
      allow_reactions: d.allow_reactions ?? false,
      allow_comments: d.allow_comments ?? false,
      attachments: d.attachments ?? [],
      links: d.links ?? [],
      published_at,
      linked_items: d.rich_content ? extractLinkedItems(d.rich_content) : [],
    }

    // Insert the origin row (in the section the professor is posting from).
    const { data: inserted, error: insertError } = await adminDb
      .from('announcements')
      .insert({ ...rowBase, section_id: sectionId })
      .select('id')
      .single()

    if (insertError || !inserted) {
      logger.error('createAnnouncement: Insert failed', insertError, { sectionId })
      return { error: 'Failed to create announcement' }
    }

    // Sync mentions if provided
    if (d.mentioned_student_ids && d.mentioned_student_ids.length > 0) {
      await syncMentions(adminDb, inserted.id, d.mentioned_student_ids)
    }

    logEvent({
      userId: user.id,
      eventType: 'announcement.created',
      eventCategory: 'professor',
      metadata: { sectionId, title: d.title, status: d.status, additionalSections: additionalSectionIds.length },
      sectionId,
    })

    // Notify enrolled students when the announcement is live (not for drafts or
    // scheduled ones — those notify when they actually publish). Idempotent per
    // (recipient, type, announcement id), so an edit-republish won't re-notify.
    if (d.status === 'published') {
      /* Audience from the announcement's OWN targeting, not the roster (#665). Without
         this a post aimed at one student notified all of them — the body stayed private
         but the title did not, and the link 404s for everyone else. */
      await emitEvent({
        type: 'announcement_posted',
        sectionId,
        actorId: user.id,
        audience: await resolveAnnouncementAudience(adminDb, inserted.id, sectionId, d.visibility),
        entity: { type: 'announcement', id: inserted.id },
        title: `New announcement: ${d.title}`,
        linkUrl: `/student/courses/${sectionId}/announcements/${inserted.id}`,
        metadata: d.is_important ? { important: true } : undefined,
      })
    }

    // Multi-section: create a linked child copy in each additional section the
    // professor also teaches. Access is verified PER section (never trust the
    // client list) — a section the caller can't write to is silently skipped.
    // Children point at the origin row via parent_announcement_id so a later
    // edit can sync content across the whole group. Comments/reactions/reads are
    // never shared — each copy is its own announcement_id.
    for (const targetSectionId of additionalSectionIds) {
      const targetAccess = await verifySectionAccess(targetSectionId, user.id)
      if (!targetAccess.ok || !canWriteAsStaff(targetAccess.role)) continue

      const { data: child, error: childError } = await targetAccess.adminDb
        .from('announcements')
        .insert({ ...rowBase, section_id: targetSectionId, parent_announcement_id: inserted.id })
        .select('id')
        .single()

      if (childError || !child) {
        logger.error('createAnnouncement: multi-section child insert failed', childError, { targetSectionId })
        continue
      }

      logEvent({
        userId: user.id,
        eventType: 'announcement.created',
        eventCategory: 'professor',
        metadata: { sectionId: targetSectionId, title: d.title, status: d.status, viaMultiSection: true },
        sectionId: targetSectionId,
      })

      if (d.status === 'published') {
        /* No targeting lookup here on purpose: multi-section posting rejects
           'mentioned_only' upfront (see the guard above), so a child copy is always
           audience 'all'. If that restriction is ever lifted, this needs the same
           resolveAnnouncementAudience call as the create path (#665). */
        await emitEvent({
          type: 'announcement_posted',
          sectionId: targetSectionId,
          actorId: user.id,
          entity: { type: 'announcement', id: child.id },
          title: `New announcement: ${d.title}`,
          linkUrl: `/student/courses/${targetSectionId}/announcements/${child.id}`,
          metadata: d.is_important ? { important: true } : undefined,
        })
      }

      revalidatePath(sectionPath(targetSectionId))
    }

    revalidatePath(sectionPath(sectionId))
    return { success: true, id: inserted.id }
  } catch (error) {
    logger.error('createAnnouncement: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function updateAnnouncement(
  id: string,
  sectionId: string,
  input: UpdateAnnouncementInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = updateAnnouncementSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) return { error: ROLE_DENIED_MESSAGE }
    const adminDb = access.adminDb

    const d = parsed.data
    const syncScope = d.sync_scope ?? 'this'
    const updateData: Record<string, unknown> = {
      ...d,
      updated_at: new Date().toISOString(),
      linked_items: d.rich_content ? extractLinkedItems(d.rich_content) : undefined,
    }

    // Remove client-only fields (not columns on announcements)
    delete updateData.mentioned_student_ids
    delete updateData.additional_section_ids
    delete updateData.sync_scope

    // Handle scheduling logic
    if (d.status === 'published') {
      updateData.published_at = new Date().toISOString()
      updateData.scheduled_at = null
    } else if (d.status === 'scheduled') {
      if (!d.scheduled_at) {
        return { error: 'Scheduled time is required' }
      }
      updateData.scheduled_at = d.scheduled_at
      updateData.published_at = null
    } else if (d.status === 'draft') {
      updateData.published_at = null
      updateData.scheduled_at = null
    }

    const { data: updated, error: updateError } = await adminDb
      .from('announcements')
      .update(updateData)
      .eq('id', id)
      .eq('section_id', sectionId)
      .select('title, parent_announcement_id')
      .maybeSingle()

    if (updateError) {
      logger.error('updateAnnouncement: Update failed', updateError, { id, sectionId })
      return { error: 'Failed to update announcement' }
    }

    // Multi-section edit sync: when the professor chose "apply to all sections",
    // propagate only the CONTENT fields to the other copies in the group. Never
    // touch each copy's own status/scheduling, comments, reactions or reads.
    if (syncScope === 'all' && updated) {
      const groupRootId = updated.parent_announcement_id ?? id
      // All copies in the group: the root plus every child pointing at it.
      const { data: groupRows } = await adminDb
        .from('announcements')
        .select('id, section_id')
        .or(`id.eq.${groupRootId},parent_announcement_id.eq.${groupRootId}`)

      const contentSync = {
        title: updateData.title,
        content: updateData.content,
        rich_content: updateData.rich_content,
        linked_items: updateData.linked_items,
        attachments: updateData.attachments,
        links: updateData.links,
        is_important: updateData.is_important,
        requires_acknowledgement: updateData.requires_acknowledgement,
        allow_reactions: updateData.allow_reactions,
        allow_comments: updateData.allow_comments,
        updated_at: new Date().toISOString(),
      }
      // Drop keys the edit didn't set so we don't overwrite with undefined.
      const cleanSync = Object.fromEntries(
        Object.entries(contentSync).filter(([, v]) => v !== undefined),
      )

      for (const row of (groupRows ?? []) as Array<{ id: string; section_id: string }>) {
        if (row.id === id) continue // already updated above
        const rowAccess = await verifySectionAccess(row.section_id, user.id)
        if (!rowAccess.ok || !canWriteAsStaff(rowAccess.role)) continue
        await rowAccess.adminDb.from('announcements').update(cleanSync).eq('id', row.id)
        revalidatePath(sectionPath(row.section_id))
      }
    }

    // Sync mentions if provided
    if (d.mentioned_student_ids) {
      await syncMentions(adminDb, id, d.mentioned_student_ids)
    }

    logEvent({
      userId: user.id,
      eventType: 'announcement.updated',
      eventCategory: 'professor',
      metadata: { sectionId, announcementId: id },
      sectionId,
    })

    // Draft/scheduled -> published via an edit notifies enrolled students. Idempotent
    // per announcement, so editing an already-published one does not re-notify.
    if (d.status === 'published' && updated?.title) {
      /* Reads targeting from the stored row, not from `d`: an edit that publishes a
         draft need not restate mentioned_student_ids, so the payload is not a reliable
         source for who should be notified (#665). */
      await emitEvent({
        type: 'announcement_posted',
        sectionId,
        actorId: user.id,
        audience: await resolveAnnouncementAudience(adminDb, id, sectionId, updated.visibility),
        entity: { type: 'announcement', id },
        title: `New announcement: ${updated.title}`,
        linkUrl: `/student/courses/${sectionId}/announcements/${id}`,
        metadata: d.is_important ? { important: true } : undefined,
      })
    }

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('updateAnnouncement: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function deleteAnnouncement(
  id: string,
  sectionId: string,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) return { error: ROLE_DENIED_MESSAGE }
    const adminDb = access.adminDb

    const { error: deleteError } = await adminDb
      .from('announcements')
      .delete()
      .eq('id', id)
      .eq('section_id', sectionId)

    if (deleteError) {
      logger.error('deleteAnnouncement: Delete failed', deleteError, { id, sectionId })
      return { error: 'Failed to delete announcement' }
    }

    logEvent({
      userId: user.id,
      eventType: 'announcement.deleted',
      eventCategory: 'professor',
      metadata: { sectionId, announcementId: id },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('deleteAnnouncement: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function toggleAnnouncementPin(
  id: string,
  sectionId: string,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) return { error: ROLE_DENIED_MESSAGE }
    const adminDb = access.adminDb

    // Fetch current pin state
    const { data: announcement, error: fetchError } = await adminDb
      .from('announcements')
      .select('is_pinned')
      .eq('id', id)
      .eq('section_id', sectionId)
      .single()

    if (fetchError || !announcement) {
      return { error: 'Announcement not found' }
    }

    const { error: updateError } = await adminDb
      .from('announcements')
      .update({ is_pinned: !announcement.is_pinned, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (updateError) {
      logger.error('toggleAnnouncementPin: Update failed', updateError, { id, sectionId })
      return { error: 'Failed to toggle pin' }
    }

    logEvent({
      userId: user.id,
      eventType: announcement.is_pinned ? 'announcement.unpinned' : 'announcement.pinned',
      eventCategory: 'professor',
      metadata: { sectionId, announcementId: id },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('toggleAnnouncementPin: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Get read counts per announcement for the professor dashboard.
 */
/**
 * Comments on one announcement, for section staff.
 *
 * The student action gates on verifyEnrollment, so a professor — who is not enrolled in
 * their own section — always got back an empty list. The result was a discussion surface
 * the author could not see: an announcement carrying real student comments showed none at
 * all on the professor's reading pane (#669 part 2).
 *
 * Read-only on purpose. Surfacing the thread was the approved change; whether staff can
 * delete a student's comment is a separate moderation decision, so nothing here writes.
 */
export async function getAnnouncementCommentsForStaff(announcementId: string, sectionId: string) {
  try {
    const user = await getAuthUser()
    if (!user) return { data: [] }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { data: [] }
    const adminDb = access.adminDb

    /* Scope the comment read to an announcement PROVEN to be in this section, so an id
       from another section (or another tenant) cannot be read through a section the caller
       does happen to own. */
    const { data: owned } = await adminDb
      .from('announcements')
      .select('id')
      .eq('id', announcementId)
      .eq('section_id', sectionId)
      .maybeSingle()
    if (!owned) return { data: [] }

    const { data: comments, error } = await adminDb
      .from('announcement_comments')
      .select('id, content, created_at, author_id, author:profiles(id, name, email)')
      .eq('announcement_id', announcementId)
      .order('created_at', { ascending: true })
    if (error) {
      logger.error('getAnnouncementCommentsForStaff: read failed', error, { announcementId })
      return { data: [] }
    }

    return { data: comments || [] }
  } catch (error) {
    logger.error('getAnnouncementCommentsForStaff: Unexpected error', error, { announcementId })
    return { data: [] }
  }
}

export async function getAnnouncementReadCounts(sectionId: string) {
  try {
    const user = await getAuthUser()
    if (!user) return { data: {} }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { data: {} }
    const adminDb = access.adminDb

    // Get total enrolled students
    const { count: totalStudents } = await adminDb
      .from('enrollments')
      .select('id', { count: 'exact', head: true })
      .eq('section_id', sectionId)
      .eq('status', 'active')

    // Get read + acknowledgement rows grouped by announcement
    /* Only genuine opens count as views. "Mark all as read" writes via_bulk rows to
       clear the student's nav badge, and counting those told the professor a notice had
       been read when nobody looked at it (#667). Acknowledgements are unaffected —
       those require an explicit action either way. */
    const { data: reads } = await adminDb
      .from('announcement_reads')
      .select('announcement_id, acknowledged_at')
      .eq('via_bulk', false)
      .in('announcement_id', (
        await adminDb
          .from('announcements')
          .select('id')
          .eq('section_id', sectionId)
      ).data?.map((a: { id: string }) => a.id) || [])

    // Count reads (all rows) and acknowledgements (rows with a timestamp) per announcement
    const readMap: Record<string, number> = {}
    const ackMap: Record<string, number> = {}
    if (reads) {
      for (const r of reads as Array<{ announcement_id: string; acknowledged_at: string | null }>) {
        readMap[r.announcement_id] = (readMap[r.announcement_id] || 0) + 1
        if (r.acknowledged_at) ackMap[r.announcement_id] = (ackMap[r.announcement_id] || 0) + 1
      }
    }

    return { data: readMap, ackData: ackMap, totalStudents: totalStudents || 0 }
  } catch (error) {
    logger.error('getAnnouncementReadCounts: Unexpected error', error, { sectionId })
    return { data: {}, ackData: {}, totalStudents: 0 }
  }
}

/**
 * "Rewrite with Athena" — polish the professor's announcement draft via the AI
 * model. Read-only (no DB write), so no logEvent/revalidate; cost is tracked in
 * the AI usage ledger. Section write-access is required so this can't be used as
 * a free generation endpoint by non-staff.
 */
export async function rewriteAnnouncementContent(
  sectionId: string,
  input: { content: string },
): Promise<{ text?: string; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) return { error: ROLE_DENIED_MESSAGE }

    const content = typeof input?.content === 'string' ? input.content.trim() : ''
    if (!content) return { error: 'Add a few words and Athena will polish them for you.' }

    // Institution/platform AI kill switch.
    const aiVerdict = await checkAiFeatureBySection(access.adminDb, sectionId, 'athena-professor')
    if (!aiVerdict.allowed) return { error: aiRefusalMessage(aiVerdict.lockedBy) }

    const { text, error } = await rewriteAnnouncement(content, { sectionId, userId: user.id })
    if (error || !text) return { error: error || 'Could not rewrite. Please try again.' }
    return { text }
  } catch (error) {
    logger.error('rewriteAnnouncementContent: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}
