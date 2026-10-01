/**
 * Server actions for previewing submitted ZIP archives in-app.
 *
 * Both actions authorize via `authorizeSubmissionFile` first (owner-or-staff + the
 * path must belong to the submission), then read bytes with the admin client and
 * derive a safe view. Nothing is executed; sizes are capped (see `zip.ts`). Returns
 * `{ error }` or a result — never throws.
 */
'use server'

import { ASSIGNMENT_SUBMISSIONS_BUCKET } from '@/lib/supabase/storage'
import { logger } from '@/lib/logger'
import { authorizeSubmissionFile } from './viewer-auth'
import {
  buildSafeTree,
  classifyByName,
  imageMime,
  isUnsafeEntryPath,
  ZIP_LIMITS,
  type ZipFileNode,
} from './zip'
import { readCentralDirectory, readEntryBytes } from './zip-reader'
import { parseNotebook, type ParsedNotebook } from './notebook'

export type ZipListResponse = { error: string } | { files: ZipFileNode[]; omitted: number }

export type ZipEntryResponse =
  | { error: string }
  | { kind: 'text'; content: string; truncated: boolean }
  | { kind: 'image' | 'pdf'; dataBase64: string; mime: string; truncated: boolean }
  | { kind: 'notebook'; notebook: ParsedNotebook }
  | { kind: 'binary' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function downloadSubmissionFile(adminDb: any, path: string): Promise<Buffer | null> {
  const { data, error } = await adminDb.storage.from(ASSIGNMENT_SUBMISSIONS_BUCKET).download(path)
  if (error || !data) return null
  return Buffer.from(await data.arrayBuffer())
}

/** List the files inside a submitted `.zip`, after applying every safety guard. */
export async function listSubmissionZip(
  submissionId: string,
  filePath: string,
): Promise<ZipListResponse> {
  const auth = await authorizeSubmissionFile(submissionId, filePath)
  if ('error' in auth) return { error: auth.error }

  const buffer = await downloadSubmissionFile(auth.adminDb, auth.path)
  if (!buffer) return { error: 'Could not open this archive.' }

  try {
    const entries = await readCentralDirectory(buffer)
    const tree = buildSafeTree(entries)
    if (!tree.ok) return { error: tree.error }
    return { files: tree.files, omitted: tree.omitted }
  } catch {
    logger.warn('listSubmissionZip: archive could not be read', { submissionId })
    return { error: 'This archive could not be read.' }
  }
}

/** Extract and return one entry from a submitted `.zip` for inline preview. */
export async function readSubmissionZipEntry(
  submissionId: string,
  filePath: string,
  entryPath: string,
): Promise<ZipEntryResponse> {
  const auth = await authorizeSubmissionFile(submissionId, filePath)
  if ('error' in auth) return { error: auth.error }

  if (isUnsafeEntryPath(entryPath)) return { error: 'File not found.' }

  const kind = classifyByName(entryPath)
  if (kind === 'binary') return { kind: 'binary' }

  const buffer = await downloadSubmissionFile(auth.adminDb, auth.path)
  if (!buffer) return { error: 'Could not open this archive.' }

  try {
    // Notebooks are read in full (up to the inline cap) so the JSON parses; plain text
    // is truncated at the smaller preview cap.
    const limit =
      kind === 'text' ? ZIP_LIMITS.maxTextPreviewBytes : ZIP_LIMITS.maxInlinePreviewBytes
    const result = await readEntryBytes(buffer, entryPath, limit)
    if (!result) return { error: 'That file is no longer available.' }

    if (kind === 'text') {
      return { kind: 'text', content: result.buffer.toString('utf-8'), truncated: result.truncated }
    }
    if (kind === 'notebook') {
      const notebook = parseNotebook(result.buffer.toString('utf-8'))
      if (!notebook) return { error: 'This notebook could not be read.' }
      return { kind: 'notebook', notebook }
    }
    const mime = kind === 'pdf' ? 'application/pdf' : imageMime(entryPath)
    return { kind, dataBase64: result.buffer.toString('base64'), mime, truncated: result.truncated }
  } catch {
    logger.warn('readSubmissionZipEntry: entry could not be read', { submissionId })
    return { error: 'This file could not be read.' }
  }
}

export type NotebookResponse = { error: string } | { notebook: ParsedNotebook }

/** Parse a submitted `.ipynb` into viewer-ready cells for in-app rendering. */
export async function readSubmissionNotebook(
  submissionId: string,
  filePath: string,
): Promise<NotebookResponse> {
  const auth = await authorizeSubmissionFile(submissionId, filePath)
  if ('error' in auth) return { error: auth.error }

  const buffer = await downloadSubmissionFile(auth.adminDb, auth.path)
  if (!buffer) return { error: 'Could not open this notebook.' }

  const parsed = parseNotebook(buffer.toString('utf-8'))
  if (!parsed) return { error: 'This file is not a readable notebook.' }
  return { notebook: parsed }
}
