// Utility functions for student Athena conversation persistence —
// converts between DB rows and Vercel AI SDK UIMessage format.

import type { UIMessage } from 'ai'
import type { AthenaRunEvent } from '@/lib/ai/athena-directive'

/**
 * One file the student attached to a message.
 *
 * The student surface stores a turn as plain text (its `athena_messages.parts`
 * holds one text part), so an attachment is recorded as this compact record
 * under `metadata.attachments` instead of as a file part.
 * The PATH is the durable identifier; `signedUrl` is minted fresh on read
 * (1h TTL) and is never written to the row.
 */
export interface StoredAttachment {
  path: string
  filename: string
  mediaType: string
  signedUrl?: string
}

/** A student turn, as athena-core's persistence layer hands it back. */
export interface DbMessage {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  metadata: Record<string, unknown> & {
    attachments?: StoredAttachment[]
    /** What Athena looked up and set up for this answer — see `messageRun`. */
    run?: AthenaRunEvent[]
  }
  created_at: string
}

/** The attachments recorded on a row, tolerating rows written before they existed. */
export function messageAttachments(msg: DbMessage): StoredAttachment[] {
  const raw = msg.metadata?.attachments
  return Array.isArray(raw) ? raw.filter((a) => a && typeof a.path === 'string') : []
}

/**
 * The run rows recorded on an answer — the lookups Athena performed and the
 * steps any proposal worked through, with their real measured durations.
 *
 * These reach the client twice by two different routes, on purpose. Live, they
 * ride the stream as `[[athena:run:…]]` markers so each row can appear the
 * moment it happens. Afterwards they live here, in `metadata`, so reopening a
 * thread (or reloading, or switching pose) still shows what ran.
 *
 * `metadata`, never `content`: a marker in the answer text would be re-parsed on
 * every read, and the propose directive that rides the same channel would drive
 * the app again each time the student scrolled back through their history.
 * Storing the rows as data means they can be rendered but never re-fired.
 *
 * Tolerant of rows written before this existed — those simply have no cards,
 * which is what the whole feature used to do.
 */
export function messageRun(msg: DbMessage): AthenaRunEvent[] {
  const raw = msg.metadata?.run
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (e): e is AthenaRunEvent =>
      !!e &&
      typeof e.id === 'string' &&
      typeof e.name === 'string' &&
      (e.phase === 'start' || e.phase === 'done'),
  )
}

/** Summary shape passed to the client sidebar. */
export interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

/**
 * Convert a DB message row into a Vercel AI SDK UIMessage.
 *
 * Attachments come back as file parts carrying BOTH a freshly signed URL (what
 * the chip renders and links to) and the durable storage path in
 * providerMetadata — so a follow-up question in a reopened thread re-sends the
 * path and Athena can still read the file. Unsigned attachments (a lapsed or
 * failed signature) still render as a chip; only the link is missing.
 */
export function dbMessageToUIMessage(msg: DbMessage): UIMessage {
  const files = messageAttachments(msg).map((a) => ({
    type: 'file' as const,
    mediaType: a.mediaType,
    filename: a.filename,
    url: a.signedUrl || a.path,
    providerMetadata: { athena: { path: a.path } },
  }))
  // Files first: the composer sends them ahead of the text, and the bubble
  // renders them above it. The text part is dropped only when a file replaces it
  // (a file-only turn) — never leave a message with no parts at all, which
  // convertToModelMessages rejects on the next turn.
  const keepText = !!msg.content || files.length === 0
  return {
    id: msg.id,
    role: msg.role,
    parts: [...files, ...(keepText ? [{ type: 'text' as const, text: msg.content }] : [])],
  }
}

/**
 * Convert a conversation row into a lightweight summary for the picker.
 *
 * Takes the four columns it actually reads rather than a table's Row type, so
 * this stays usable from the client (the row type lives behind `server-only`).
 */
export function dbConversationToSummary(conv: {
  id: string
  title: string
  created_at: string
  updated_at: string
}): ConversationSummary {
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.created_at,
    updatedAt: conv.updated_at,
  }
}

/** Truncate text for use as a conversation title. */
export function truncateTitle(text: string, maxLen = 80): string {
  const cleaned = text.trim().replace(/\s+/g, ' ')
  if (!cleaned) return 'New Chat'
  if (cleaned.length <= maxLen) return cleaned
  return cleaned.slice(0, maxLen) + '…'
}

