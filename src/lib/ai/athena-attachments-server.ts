/**
 * Athena attachment plumbing — SERVER ONLY.
 *
 * The half of the attachment pipeline that needs the service-role client or Node
 * Buffer: signing stored paths for display, "materializing" a stored file into
 * the form Gemini needs at request time, and the IDOR guard that binds a path
 * arriving from the untrusted client back to the caller. The browser never
 * touches the bucket; all access flows through authed server code.
 *
 * Shared by both Athena surfaces — the professor console
 * (`/api/professor-assistant`) and the student dock (`/api/chat`).
 *
 * Do NOT import into a client tree — pulls in the admin client + Node Buffer.
 * The pure rules (validation, limits, path layout) live in `athena-attachments.ts`.
 */

import type { UIMessage } from 'ai'
import type { createAdminClient } from '@/lib/supabase/admin'
import {
  ATHENA_ATTACHMENTS_BUCKET,
  ATHENA_SIGNED_URL_TTL_SECONDS,
  CONTENT_TYPE,
  TEXT_EXT,
  extOf,
} from './athena-attachments'

type AdminClient = ReturnType<typeof createAdminClient>

/** Batch-mint short-lived signed URLs for stored paths (display on reload). */
export async function signAthenaAttachments(
  db: AdminClient,
  paths: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = [...new Set(paths)].filter(Boolean)
  if (unique.length === 0) return out
  const { data, error } = await db.storage
    .from(ATHENA_ATTACHMENTS_BUCKET)
    .createSignedUrls(unique, ATHENA_SIGNED_URL_TTL_SECONDS)
  if (error || !data) return out
  for (const entry of data) {
    if (entry.path && entry.signedUrl) out.set(entry.path, entry.signedUrl)
  }
  return out
}

/**
 * Turn a stored attachment into what Gemini needs at request time. We download
 * the bytes with the admin client (rather than relying on a signed URL being
 * fetchable — the Google provider has empty supportedUrls and would otherwise
 * fetch it itself) and return either an inline file part (base64 data URL) or,
 * for text files, the decoded string to inline as a cheaper text part.
 */
export type MaterializedPart =
  | { type: 'file'; mediaType: string; dataUrl: string }
  | { type: 'text'; text: string }
  | null

/**
 * Ceiling on how much of a .txt/.md/.csv we paste into the prompt.
 *
 * A text attachment is inlined as characters, not handed to the provider as a
 * file, so its whole body lands in the request. The per-file upload ceiling is
 * 20MB, and this repo reckons ~4 chars per token, so one accepted 20MB .txt is
 * roughly 5M tokens against a 1M context: the turn fails outright, and it fails
 * again on every later turn because attachments are re-inlined. 100k characters
 * is about 25k tokens, so even a full set of them stays inside the window.
 *
 * Binary attachments (PDF, images) need no equivalent: they ride as file parts
 * the provider pages itself, and the per-file size limit already bounds them.
 */
const MAX_INLINED_TEXT_CHARS = 100_000

export async function materializeForModel(db: AdminClient, path: string): Promise<MaterializedPart> {
  const { data, error } = await db.storage.from(ATHENA_ATTACHMENTS_BUCKET).download(path)
  if (error || !data) return null
  // Determine text vs binary from the STORED path's extension (server-controlled
  // — we wrote it), never a client-supplied mediaType, which could be spoofed.
  const ext = extOf(path)
  if (TEXT_EXT.has(ext)) {
    const text = await data.text()
    if (text.length <= MAX_INLINED_TEXT_CHARS) return { type: 'text', text }
    // Say it was cut, so the model reports a partial read instead of answering
    // confidently from a file it only saw the front of.
    return {
      type: 'text',
      text: `${text.slice(0, MAX_INLINED_TEXT_CHARS)}\n\n[Truncated here: only the first ${MAX_INLINED_TEXT_CHARS.toLocaleString()} characters of this file were loaded.]`,
    }
  }
  const mediaType = CONTENT_TYPE[ext] ?? 'application/octet-stream'
  const buf = Buffer.from(await data.arrayBuffer())
  return { type: 'file', mediaType, dataUrl: `data:${mediaType};base64,${buf.toString('base64')}` }
}

// ── File parts on the wire ──────────────────────────────────────────
// Attachments travel as file parts. The DURABLE identifier is the storage path;
// the client carries a fresh signed `url` for display + the path in
// providerMetadata.athena.path. Routes (1) persist the path (not the signed
// URL), and (2) at model time download the bytes via the admin client and inline
// them — never trusting the client URL.

export type FilePartLike = {
  type?: unknown
  url?: unknown
  mediaType?: unknown
  filename?: unknown
  providerMetadata?: { athena?: { path?: unknown } }
}

export function asFilePart(p: unknown): FilePartLike | null {
  return p && (p as FilePartLike).type === 'file' ? (p as FilePartLike) : null
}

export function athenaPathOf(p: FilePartLike): string | undefined {
  const meta = p.providerMetadata?.athena?.path
  if (typeof meta === 'string' && meta) return meta
  // Fallback: a bare storage path (no scheme, not a data URL) IS the path.
  if (typeof p.url === 'string' && !/^[a-z]+:\/\//i.test(p.url) && !p.url.startsWith('data:')) return p.url
  return undefined
}

/** The display name a file part claims, defaulted. Never used for a storage
 *  decision — only for what the student/professor and the model see. */
export function filePartName(p: FilePartLike): string {
  return typeof p.filename === 'string' && p.filename ? p.filename : 'file'
}

/**
 * IDOR guard. The storage path round-trips through the untrusted client on every
 * turn, and we download it with the RLS-bypassing admin client — so a forged
 * path pointing at another tenant's file would otherwise be readable. Bind every
 * path to the caller's verified prefix (see `athenaAttachmentPrefix`); anything
 * else is treated as no attachment (never downloaded, never persisted).
 *
 * A bare `startsWith` is NOT enough: `{prefix}/../../other-bucket/x` starts with
 * the prefix yet resolves outside it once `..`/`//` are followed. Because
 * `athenaAttachmentPath` only ever mints `{prefix}{uuid}.{ext}`, we require the
 * remainder after the prefix to be exactly one such filename — a single segment,
 * no slash, no `..` — so a traversal fails the check even though it matched the
 * prefix.
 */
const SCOPED_FILENAME = /^[0-9a-f-]{36}\.[a-z0-9]{1,5}$/

export function pathInScope(path: string | undefined, allowedPrefix: string): path is string {
  if (!path || !path.startsWith(allowedPrefix)) return false
  return SCOPED_FILENAME.test(path.slice(allowedPrefix.length))
}

/**
 * Rewrite a message's file parts for PERSISTENCE: keep the durable storage path,
 * drop anything outside the caller's verified prefix.
 *
 * This must run before a turn is written. A stored path is a durable capability —
 * every later read re-mints a signed URL for it with the RLS-bypassing admin
 * client — so a forged path persisted once is readable forever after. Guarding
 * only on the model-facing copy of the history is not enough; that copy is
 * thrown away, the stored one is not.
 *
 * `allowedPrefix: null` means this surface accepts no attachments at all, so
 * every file part is dropped.
 *
 * Lives here rather than in a route because it was previously a local copy in
 * one route, and the route that did not have the copy is exactly the one that
 * shipped the hole.
 */
export function filePartsToPaths(message: UIMessage, allowedPrefix: string | null): UIMessage {
  const parts = message.parts.flatMap((p) => {
    const fp = asFilePart(p)
    if (!fp) return [p]
    if (allowedPrefix === null) return []
    const path = athenaPathOf(fp)
    if (!pathInScope(path, allowedPrefix)) return []
    return [
      { type: 'file', mediaType: fp.mediaType, filename: fp.filename, url: path } as UIMessage['parts'][number],
    ]
  })
  return { ...message, parts: parts as UIMessage['parts'] }
}

/**
 * For the model: replace each in-scope file part with inline bytes (data URL)
 * or, for text files, a text part. Out-of-scope paths are never downloaded.
 *
 * `maxFiles` bounds how many attachments are inlined, keeping the most RECENT
 * (the ones the current question is most likely about) and standing the rest
 * down to a one-line note. An attachment is re-sent on every subsequent turn of
 * a thread, so without a cap a few large files quietly become a permanent tax on
 * every message that follows them. Omit it for no cap.
 */
export async function materializeFileParts(
  db: AdminClient,
  messages: UIMessage[],
  allowedPrefix: string,
  maxFiles?: number,
): Promise<UIMessage[]> {
  // Which file parts survive the cap — counted backwards from the newest turn,
  // so it's the oldest attachments that get stood down.
  const kept = new Set<unknown>()
  if (maxFiles !== undefined) {
    let budget = maxFiles
    for (let i = messages.length - 1; i >= 0 && budget > 0; i--) {
      for (let j = messages[i].parts.length - 1; j >= 0 && budget > 0; j--) {
        const p = messages[i].parts[j]
        if (!asFilePart(p)) continue
        kept.add(p)
        budget--
      }
    }
  }

  return Promise.all(
    messages.map(async (m) => {
      const parts = await Promise.all(
        m.parts.map(async (p) => {
          const fp = asFilePart(p)
          if (!fp) return p
          const path = athenaPathOf(fp)
          const name = filePartName(fp)
          if (!pathInScope(path, allowedPrefix)) {
            return { type: 'text', text: `[Attachment "${name}" is unavailable.]` }
          }
          if (maxFiles !== undefined && !kept.has(p)) {
            // Role-neutral on purpose: every professor authoring and grading
            // surface reaches this line too, and telling Athena to "ask the
            // student" there put a wrong instruction in front of the model.
            return {
              type: 'text',
              text: `[Attachment "${name}" was sent earlier in this conversation and is no longer loaded. Ask for it to be attached again if you need it.]`,
            }
          }
          const mat = await materializeForModel(db, path)
          if (!mat) return { type: 'text', text: `[Attachment "${name}" could not be loaded.]` }
          if (mat.type === 'text') return { type: 'text', text: `Attached file "${name}":\n\n${mat.text}` }
          return { type: 'file', mediaType: mat.mediaType, filename: fp.filename, url: mat.dataUrl }
        }),
      )
      return { ...m, parts: parts as UIMessage['parts'] }
    }),
  )
}
