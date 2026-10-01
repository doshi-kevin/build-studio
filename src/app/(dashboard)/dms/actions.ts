// Direct Message server actions — open/create a 1:1 channel between
// two users, list the caller's DMs, post a message. Writes go through
// the admin client after we verify both sides: (1) the caller is
// authenticated, (2) the other user exists. DMs are global so any two
// authenticated users can start a thread — no course/team gating here.
'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { purgeChatAttachment } from '@/lib/supabase/chat-storage-server'
import { logEvent } from '@/lib/supabase/event-logger'
import {
  sendDmMessageSchema,
  type SendDmMessageInput,
} from '@/lib/validations/direct-messages'

type ActionResult<T = unknown> = { success?: boolean; error?: string; data?: T }

export interface DmChannelSummary {
  id: string
  user_a_id: string
  user_b_id: string
  last_message_at: string | null
  created_at: string
  other_user: {
    id: string
    name: string | null
    email: string
    avatar_url: string | null
  }
  last_message: {
    content: string
    attachment_name: string | null
    author_id: string
    created_at: string
  } | null
}

async function getAuthUser() {
  const supabase = await createClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

// Sort a pair of UUIDs so we always match the (user_a_id, user_b_id)
// ordered convention used by the unique index.
function sortPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

/**
 * Find or create the DM channel between the caller and `otherUserId`.
 * The participants table is sorted so the unique constraint matches
 * any caller/target pair regardless of who opens the thread first.
 */
/**
 * Do these two users share a live context that makes a DM legitimate? (#679)
 *
 * The product rule is that only people who share a course or a project team can message
 * each other, and the read paths already enforce it — listSectionPeople checks enrollment,
 * listTeamPeople checks membership. Only the WRITE didn't, so anyone replaying the action
 * with a crafted target id could open a channel with any user in the institution,
 * including staff and admins. Proven in the report against an admin account.
 *
 * "Shares a course" is symmetric across both roles, so all four pairings count: two
 * enrolled students, a student and the professor who teaches them, or two staff of the
 * same section. Statuses mirror the read paths ('enrolled' | 'completed'), so a finished
 * course still lets a student message the professor who graded them.
 */
async function shareDmContext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  userId: string,
  otherUserId: string,
): Promise<boolean> {
  const STATUSES = ['enrolled', 'completed']

  const sectionsOf = async (id: string): Promise<Set<string>> => {
    const [{ data: enrolled }, { data: teaching }, { data: staffing }] = await Promise.all([
      adminDb.from('enrollments').select('section_id').eq('student_id', id).in('status', STATUSES),
      adminDb.from('course_sections').select('id').eq('professor_id', id),
      adminDb.from('section_staff').select('section_id').eq('staff_id', id).eq('status', 'active'),
    ])
    const out = new Set<string>()
    for (const r of (enrolled ?? []) as Array<{ section_id: string }>) out.add(r.section_id)
    for (const r of (teaching ?? []) as Array<{ id: string }>) out.add(r.id)
    for (const r of (staffing ?? []) as Array<{ section_id: string }>) out.add(r.section_id)
    return out
  }

  const [mine, theirs] = await Promise.all([sectionsOf(userId), sectionsOf(otherUserId)])
  for (const s of mine) if (theirs.has(s)) return true

  // Project teams — the second half of the rule.
  const teamsOf = async (id: string): Promise<Set<string>> => {
    const { data } = await adminDb.from('project_members').select('team_id').eq('user_id', id)
    return new Set(((data ?? []) as Array<{ team_id: string }>).map((r) => r.team_id))
  }
  const [myTeams, theirTeams] = await Promise.all([teamsOf(userId), teamsOf(otherUserId)])
  for (const t of myTeams) if (theirTeams.has(t)) return true

  return false
}

export async function openOrCreateDm(
  otherUserId: string,
): Promise<ActionResult<{ channelId: string }>> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    if (!otherUserId) return { error: 'Missing user id' }
    if (otherUserId === user.id) return { error: 'Cannot DM yourself' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    // Make sure the target is a real profile — cheap guard against
    // crafted UUIDs from the client.
    const { data: target } = await adminDb
      .from('profiles')
      .select('id')
      .eq('id', otherUserId)
      .maybeSingle()
    /* Deliberately the SAME refusal as a nonexistent profile: distinguishing them would
       confirm whether an arbitrary user id belongs to a real account, which is a
       membership oracle over the whole institution. */
    if (!target) return { error: 'User not found' }

    if (!(await shareDmContext(adminDb, user.id, otherUserId))) {
      return { error: 'User not found' }
    }

    const [userA, userB] = sortPair(user.id, otherUserId)

    const { data: existing } = await adminDb
      .from('dm_channels')
      .select('id')
      .eq('user_a_id', userA)
      .eq('user_b_id', userB)
      .maybeSingle()

    if (existing?.id) {
      return { success: true, data: { channelId: existing.id } }
    }

    const { data: created, error } = await adminDb
      .from('dm_channels')
      .insert({ user_a_id: userA, user_b_id: userB })
      .select('id')
      .single()

    if (error || !created) {
      logger.error('openOrCreateDm', error, { userA, userB })
      return { error: 'Failed to open DM' }
    }
    return { success: true, data: { channelId: created.id } }
  } catch (error) {
    logger.error('openOrCreateDm', error, { otherUserId })
    return { error: 'Something went wrong' }
  }
}

/**
 * Recent DM threads for the caller with the counterparty profile and
 * last-message preview for the sidebar.
 */
export async function listMyDms(): Promise<ActionResult<DmChannelSummary[]>> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { data: channels, error } = await adminDb
      .from('dm_channels')
      .select(
        `
        id,
        user_a_id,
        user_b_id,
        last_message_at,
        created_at,
        user_a:profiles!dm_channels_user_a_id_fkey(id, name, email, avatar_url),
        user_b:profiles!dm_channels_user_b_id_fkey(id, name, email, avatar_url)
      `,
      )
      .or(`user_a_id.eq.${user.id},user_b_id.eq.${user.id}`)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(100)

    if (error || !channels) {
      logger.error('listMyDms fetch', error, { userId: user.id })
      return { error: 'Failed to list DMs' }
    }

    if (channels.length === 0) {
      return { success: true, data: [] }
    }

    // Batch-fetch the newest message per channel. Cheap enough for 100
    // threads — if this grows, swap for a materialized column.
    const channelIds = channels.map((c: { id: string }) => c.id)
    const { data: recentMessages } = await adminDb
      .from('dm_messages')
      .select('channel_id, content, attachment_name, author_id, created_at')
      .in('channel_id', channelIds)
      .order('created_at', { ascending: false })

    const lastByChannel = new Map<string, DmChannelSummary['last_message']>()
    if (recentMessages) {
      for (const m of recentMessages as Array<{
        channel_id: string
        content: string
        attachment_name: string | null
        author_id: string
        created_at: string
      }>) {
        if (!lastByChannel.has(m.channel_id)) {
          lastByChannel.set(m.channel_id, {
            content: m.content,
            attachment_name: m.attachment_name,
            author_id: m.author_id,
            created_at: m.created_at,
          })
        }
      }
    }

    const rows: DmChannelSummary[] = channels.map(
      (c: {
        id: string
        user_a_id: string
        user_b_id: string
        last_message_at: string | null
        created_at: string
        user_a: { id: string; name: string | null; email: string; avatar_url: string | null } | Array<{ id: string; name: string | null; email: string; avatar_url: string | null }>
        user_b: { id: string; name: string | null; email: string; avatar_url: string | null } | Array<{ id: string; name: string | null; email: string; avatar_url: string | null }>
      }) => {
        const userA = Array.isArray(c.user_a) ? c.user_a[0] : c.user_a
        const userB = Array.isArray(c.user_b) ? c.user_b[0] : c.user_b
        const other = c.user_a_id === user.id ? userB : userA
        return {
          id: c.id,
          user_a_id: c.user_a_id,
          user_b_id: c.user_b_id,
          last_message_at: c.last_message_at,
          created_at: c.created_at,
          other_user: other,
          last_message: lastByChannel.get(c.id) ?? null,
        }
      },
    )

    return { success: true, data: rows }
  } catch (error) {
    logger.error('listMyDms', error)
    return { error: 'Something went wrong' }
  }
}

/**
 * Send a message into a DM thread. Validates the caller is a
 * participant of the channel before writing.
 */
export async function sendDmMessage(
  channelId: string,
  input: SendDmMessageInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = sendDmMessageSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { data: channel } = await adminDb
      .from('dm_channels')
      .select('id, user_a_id, user_b_id')
      .eq('id', channelId)
      .maybeSingle()

    if (!channel) return { error: 'DM not found' }
    if (channel.user_a_id !== user.id && channel.user_b_id !== user.id) {
      return { error: 'Not a participant in this DM' }
    }

    const { data: message, error } = await adminDb
      .from('dm_messages')
      .insert({
        channel_id: channelId,
        author_id: user.id,
        content: parsed.data.content || '',
        attachment_url: parsed.data.attachment_url || null,
        attachment_path: parsed.data.attachment_path || null,
        attachment_name: parsed.data.attachment_name || null,
        attachment_size: parsed.data.attachment_size || null,
        attachment_type: parsed.data.attachment_type || null,
      })
      .select('id')
      .single()

    if (error) {
      logger.error('sendDmMessage', error, { channelId })
      return { error: 'Failed to send message' }
    }

    // Best-effort notification to the counterparty. Swallow failures
    // so a notification outage never blocks the primary send.
    const recipient =
      channel.user_a_id === user.id ? channel.user_b_id : channel.user_a_id
    adminDb
      .from('app_notifications')
      .insert({
        recipient_id: recipient,
        /* Who sent it (#693). Without actor_id the notification rendered a generic
           avatar, so a student was told they had a message but not who from. */
        actor_id: user.id,
        kind: 'dm',
        title: 'New direct message',
        /* Points at a RESOLVER, not at a discussions URL (#693). A DM is global, but the
           pane only renders inside a section-scoped page, so the destination depends on
           which course the two still share, what role the RECIPIENT holds there, and
           whether discussions is switched on. All three can change after this row is
           written, so computing a URL here would bake in a link that goes stale — and
           it would cost several joins on the hot path of every message send for a link
           most recipients never click. `/dms` resolves it at click time instead. */
        link_url: `/dms?c=${channelId}`,
        body: parsed.data.content?.slice(0, 140) || parsed.data.attachment_name || 'Attachment',
        metadata: {
          channel_id: channelId,
          author_id: user.id,
          message_id: message.id,
        },
      })
      .then((res: { error: { message: string } | null }) => {
        if (res.error) {
          logger.warn('sendDmMessage notification insert failed', {
            message: res.error.message,
            channelId,
          })
        }
      })

    logEvent({
      userId: user.id,
      eventType: 'dm_message_sent',
      metadata: { channel_id: channelId },
    })

    return { success: true, data: message }
  } catch (error) {
    logger.error('sendDmMessage', error, { channelId })
    return { error: 'Something went wrong' }
  }
}

/**
 * Soft-delete a DM message. Only the original author can retract their
 * own message; bystanders still see a tombstone in place of the row so
 * surrounding thread ordering is preserved.
 */
export async function deleteDmMessage(
  messageId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    if (!messageId) return { error: 'Missing message id' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { data: message } = await adminDb
      .from('dm_messages')
      .select('id, author_id, channel_id, deleted_at, attachment_path')
      .eq('id', messageId)
      .maybeSingle()

    if (!message) return { error: 'Message not found' }
    if (message.author_id !== user.id) {
      return { error: 'You can only delete your own messages' }
    }
    if (message.deleted_at) return { success: true }

    const { error } = await adminDb
      .from('dm_messages')
      .update({ deleted_at: new Date().toISOString(), deleted_by_id: user.id })
      .eq('id', messageId)

    if (error) {
      logger.error('deleteDmMessage', error, { messageId })
      return { error: 'Failed to delete message' }
    }

    /* The row is redacted by the DB trigger; the FILE is not, because Postgres cannot reach
       object storage (#678). `message` is the pre-delete copy — the trigger has already nulled
       the column by now. Best-effort: a failure must not fail the delete. */
    await purgeChatAttachment(adminDb, message.attachment_path)

    // Best-effort: clear the recipient's notification so the bell + unread
    // count drop in realtime via the existing DELETE subscription. A failure
    // here must not roll back the soft-delete — log a warning and move on.
    try {
      const { error: notifErr } = await adminDb
        .from('app_notifications')
        .delete()
        .eq('kind', 'dm')
        .filter('metadata->>message_id', 'eq', messageId)
      if (notifErr) {
        logger.warn('deleteDmMessage: notification cleanup failed', {
          messageId,
          error: notifErr.message,
        })
      }
    } catch (notifException) {
      logger.warn('deleteDmMessage: notification cleanup exception', {
        messageId,
        error:
          notifException instanceof Error
            ? notifException.message
            : String(notifException),
      })
    }

    logEvent({
      userId: user.id,
      eventType: 'dm_message_deleted',
      metadata: { message_id: messageId, channel_id: message.channel_id },
    })

    return { success: true }
  } catch (error) {
    logger.error('deleteDmMessage', error, { messageId })
    return { error: 'Something went wrong' }
  }
}

// ── People pickers ──────────────────────────────────────────────

export interface PersonOption {
  id: string
  name: string | null
  email: string
  avatar_url: string | null
  role?: string | null
  unread_count?: number
  last_dm_at?: string | null
}

export interface DmUnreadEntry {
  other_user_id: string
  unread_count: number
  last_message_at: string | null
}

/**
 * Upsert the read cursor for a DM channel — called when the viewer
 * opens or is actively viewing a DM thread.
 */
export async function markDmRead(
  channelId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { error } = await adminDb
      .from('dm_read_cursors')
      .upsert(
        { channel_id: channelId, user_id: user.id, last_read_at: new Date().toISOString() },
        { onConflict: 'channel_id,user_id' },
      )

    if (error) {
      logger.error('markDmRead', error, { channelId })
      return { error: 'Failed to update read cursor' }
    }
    return { success: true }
  } catch (error) {
    logger.error('markDmRead', error, { channelId })
    return { error: 'Something went wrong' }
  }
}

/**
 * Returns unread counts + last-message timestamps for every DM channel
 * the caller participates in. The parent merges this into the people
 * list so PeoplePanel can show badges and sort by recency.
 */
export async function getDmUnreadCounts(): Promise<ActionResult<DmUnreadEntry[]>> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { data, error } = await adminDb.rpc('get_dm_unread_counts', {
      p_user_id: user.id,
    })

    if (error) {
      logger.warn('getDmUnreadCounts rpc failed, falling back', { message: error.message })
      return await getDmUnreadCountsFallback(adminDb, user.id)
    }

    return { success: true, data: data as DmUnreadEntry[] }
  } catch (error) {
    logger.error('getDmUnreadCounts', error)
    return { error: 'Something went wrong' }
  }
}

async function getDmUnreadCountsFallback(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  userId: string,
): Promise<ActionResult<DmUnreadEntry[]>> {
  const { data: channels } = await adminDb
    .from('dm_channels')
    .select('id, user_a_id, user_b_id, last_message_at')
    .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)

  if (!channels || channels.length === 0) {
    return { success: true, data: [] }
  }

  const channelIds = channels.map((c: { id: string }) => c.id)

  const { data: cursors } = await adminDb
    .from('dm_read_cursors')
    .select('channel_id, last_read_at')
    .eq('user_id', userId)
    .in('channel_id', channelIds)

  const cursorMap = new Map<string, string>()
  if (cursors) {
    for (const c of cursors as Array<{ channel_id: string; last_read_at: string }>) {
      cursorMap.set(c.channel_id, c.last_read_at)
    }
  }

  const entries: DmUnreadEntry[] = []

  for (const ch of channels as Array<{ id: string; user_a_id: string; user_b_id: string; last_message_at: string | null }>) {
    const otherUserId = ch.user_a_id === userId ? ch.user_b_id : ch.user_a_id
    const cursor = cursorMap.get(ch.id)

    let query = adminDb
      .from('dm_messages')
      .select('id', { count: 'exact', head: true })
      .eq('channel_id', ch.id)
      .neq('author_id', userId)
      .is('deleted_at', null)

    if (cursor) {
      query = query.gt('created_at', cursor)
    }

    const { count } = await query

    entries.push({
      other_user_id: otherUserId,
      unread_count: count || 0,
      last_message_at: ch.last_message_at,
    })
  }

  return { success: true, data: entries }
}

/**
 * List enrolled students + professor + active TAs/graders for a section —
 * used by the course discussions "People" panel. Caller must be enrolled OR
 * be the section's professor.
 */
export async function listSectionPeople(
  sectionId: string,
): Promise<ActionResult<PersonOption[]>> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { data: section } = await adminDb
      .from('course_sections')
      .select('id, professor_id')
      .eq('id', sectionId)
      .maybeSingle()
    if (!section) return { error: 'Section not found' }

    const isProfessor = section.professor_id === user.id
    if (!isProfessor) {
      const { data: enrollment } = await adminDb
        .from('enrollments')
        .select('id')
        .eq('section_id', sectionId)
        .eq('student_id', user.id)
        .in('status', ['enrolled', 'completed'])
        .maybeSingle()
      if (!enrollment) return { error: 'Not enrolled in this section' }
    }

    const { data: enrollments } = await adminDb
      .from('enrollments')
      .select(
        `
        student_id,
        profile:profiles!enrollments_student_id_fkey(id, name, email, avatar_url)
      `,
      )
      .eq('section_id', sectionId)
      .in('status', ['enrolled', 'completed'])

    const { data: professor } = await adminDb
      .from('profiles')
      .select('id, name, email, avatar_url')
      .eq('id', section.professor_id)
      .maybeSingle()

    /* Active TAs/graders are course personnel too — without them here the
     * professor has no way to DM their own assistants, and the staff page's
     * "Message" link has nothing to resolve. */
    const { data: staff } = await adminDb
      .from('section_staff')
      .select(
        `
        role,
        profile:profiles!section_staff_staff_id_fkey(id, name, email, avatar_url)
      `,
      )
      .eq('section_id', sectionId)
      .eq('status', 'active')
      .gt('ends_at', new Date().toISOString())

    const people: PersonOption[] = []
    if (professor && professor.id !== user.id) {
      people.push({ ...professor, role: 'professor' })
    }

    if (staff) {
      for (const row of staff as Array<{
        role: string | null
        profile:
          | { id: string; name: string | null; email: string; avatar_url: string | null }
          | Array<{ id: string; name: string | null; email: string; avatar_url: string | null }>
          | null
      }>) {
        const p = Array.isArray(row.profile) ? row.profile[0] : row.profile
        if (p && p.id !== user.id) {
          people.push({ ...p, role: row.role })
        }
      }
    }

    if (enrollments) {
      /* A student promoted to course_assistant keeps their enrollment row, so
       * they can appear in both lists for the same section. Staff wins — one
       * row per person, or PeoplePanel renders duplicate React keys. */
      const alreadyListed = new Set(people.map((p) => p.id))
      for (const row of enrollments as Array<{
        student_id: string
        profile:
          | { id: string; name: string | null; email: string; avatar_url: string | null }
          | Array<{ id: string; name: string | null; email: string; avatar_url: string | null }>
          | null
      }>) {
        const p = Array.isArray(row.profile) ? row.profile[0] : row.profile
        if (p && p.id !== user.id && !alreadyListed.has(p.id)) {
          alreadyListed.add(p.id)
          people.push({ ...p, role: 'student' })
        }
      }
    }

    people.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email))
    return { success: true, data: people }
  } catch (error) {
    logger.error('listSectionPeople', error, { sectionId })
    return { error: 'Something went wrong' }
  }
}

/**
 * List team members for a project team — used by the team workspace
 * "People" panel. Caller must be a team member.
 */
export async function listTeamPeople(
  teamId: string,
): Promise<ActionResult<PersonOption[]>> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { data: membership } = await adminDb
      .from('project_members')
      .select('id')
      .eq('team_id', teamId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (!membership) return { error: 'Not a team member' }

    const { data: members } = await adminDb
      .from('project_members')
      .select(
        `
        user_id,
        role,
        profile:profiles!project_members_user_id_fkey(id, name, email, avatar_url)
      `,
      )
      .eq('team_id', teamId)

    const people: PersonOption[] = []
    if (members) {
      for (const row of members as Array<{
        user_id: string
        role: string | null
        profile:
          | { id: string; name: string | null; email: string; avatar_url: string | null }
          | Array<{ id: string; name: string | null; email: string; avatar_url: string | null }>
          | null
      }>) {
        const p = Array.isArray(row.profile) ? row.profile[0] : row.profile
        if (p && p.id !== user.id) {
          people.push({ ...p, role: row.role })
        }
      }
    }

    people.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email))
    return { success: true, data: people }
  } catch (error) {
    logger.error('listTeamPeople', error, { teamId })
    return { error: 'Something went wrong' }
  }
}
