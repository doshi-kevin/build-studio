/**
 * Answer-key text: parsed ONCE when the professor uploads the key, stored in the
 * staff-only assignment_answer_keys table, and read straight from there at grading
 * time — no re-download, no re-parse per grading session.
 *
 * The stored row is keyed by assignment_id. Uploading (or replacing) the key mints a
 * new timestamped path and overwrites source_path + text in one upsert, so the cache
 * can never point at a stale path. The row is also the source of truth for "is there a
 * key" (source_path NOT NULL) — this moved OFF the student-readable
 * settings.answerKeySource so the key's existence + filename no longer leak to students
 * (BLOCKER #1). A rubric_ai-only row (hand-authored reference answers, no key PDF) has a
 * NULL source_path, so loadAnswerKeyText returns null for it.
 *
 * SERVER-ONLY: reads Storage + the admin client.
 */
import 'server-only'

import { logger } from '@/lib/logger'
import { parseDocument, getTextForLLM } from '@/lib/document-parser'
import { COURSE_MATERIALS_BUCKET } from '@/lib/supabase/storage'
import { parseRubricAi, type RubricAi } from '@/lib/validations/assignment'
import type { createAdminClient } from '@/lib/supabase/admin'

type AdminClient = ReturnType<typeof createAdminClient>

/** Cap on answer-key text stored + appended to the grading prompt (chars). */
export const ANSWER_KEY_MAX_CHARS = 30_000

/** Parse a freshly-uploaded answer-key PDF buffer to capped plain text. */
export async function parseAnswerKeyBuffer(buffer: Buffer): Promise<string> {
  const parsed = await parseDocument(buffer)
  return getTextForLLM(parsed.pages, parsed.metadata).slice(0, ANSWER_KEY_MAX_CHARS)
}

/**
 * Store parsed answer-key text for an assignment (called at upload). Upserts on
 * assignment_id, so a re-uploaded key overwrites the previous text. Best-effort:
 * a failure here is logged, not thrown — grading still back-fills on demand.
 */
export async function storeAnswerKeyText(
  adminDb: AdminClient,
  row: {
    assignmentId: string
    institutionId: string
    sectionId: string
    sourcePath: string
    sourceName: string
    text: string
  },
): Promise<{ error: string | null }> {
  const { error } = await adminDb.from('assignment_answer_keys').upsert(
    {
      assignment_id: row.assignmentId,
      institution_id: row.institutionId,
      section_id: row.sectionId,
      source_path: row.sourcePath,
      source_name: row.sourceName,
      text: row.text,
      char_count: row.text.length,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'assignment_id' },
  )
  if (error) {
    logger.warn('storeAnswerKeyText: upsert failed, grading will parse on demand', {
      source: 'answer-key.storeAnswerKeyText',
      assignmentId: row.assignmentId,
      error: error.message,
    })
  }
  /* Returns the failure instead of only logging it (#627). The log line's own claim —
     "grading will parse on demand" — only holds if the ROW exists to be re-read. When the
     upsert itself fails there is no row, so nothing back-fills, and the caller used to
     report a clean success while the professor's answer key had gone nowhere. Mirrors
     storeRubricAi below, which already returned its error. */
  return { error: error?.message ?? null }
}

/**
 * Store the answer-key AI fields (split off the student-readable rubric) for an assignment.
 * Upserts on assignment_id and writes ONLY the rubric_ai columns, so it never clobbers the
 * parsed key text / source cached by storeAnswerKeyText (and vice-versa). `approved` is the
 * committed answer key the grader merges; `draft` is the autosaved (not-yet-approved) draft's
 * AI fields, kept isolated so a mid-edit draft never changes what the grader sees. Pass
 * clearDraft to wipe the draft blob on approval. Best-effort: a failure is returned so the
 * caller can degrade AI grading without losing the rubric save.
 */
export async function storeRubricAi(
  adminDb: AdminClient,
  row: {
    assignmentId: string
    institutionId: string
    sectionId: string
    approved?: RubricAi
    draft?: RubricAi
    clearDraft?: boolean
  },
): Promise<{ error: string | null }> {
  const { error } = await adminDb.from('assignment_answer_keys').upsert(
    {
      assignment_id: row.assignmentId,
      institution_id: row.institutionId,
      section_id: row.sectionId,
      ...(row.approved !== undefined ? { rubric_ai: row.approved } : {}),
      ...(row.draft !== undefined ? { rubric_ai_draft: row.draft } : {}),
      ...(row.clearDraft ? { rubric_ai_draft: { criteria: {}, questions: {} } } : {}),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'assignment_id' },
  )
  if (error) {
    logger.warn('storeRubricAi: upsert failed', {
      source: 'answer-key.storeRubricAi',
      assignmentId: row.assignmentId,
      error: error.message,
    })
  }
  return { error: error?.message ?? null }
}

/**
 * Load the answer-key AI blobs (approved + draft) for an assignment from the staff-only table.
 * Staff editors + the grader graft these back onto the public rubric via mergeRubricAi.
 * Returns empty blobs (merge no-op) when there is no row or the read fails.
 */
export async function loadRubricAi(
  adminDb: AdminClient,
  assignmentId: string,
): Promise<{ approved: RubricAi; draft: RubricAi }> {
  const { data, error } = await adminDb
    .from('assignment_answer_keys')
    .select('rubric_ai, rubric_ai_draft')
    .eq('assignment_id', assignmentId)
    .maybeSingle()
  if (error) {
    logger.warn('loadRubricAi: read failed, grading/editing on public rubric only', {
      source: 'answer-key.loadRubricAi',
      assignmentId,
      error: error.message,
    })
    return { approved: { criteria: {}, questions: {} }, draft: { criteria: {}, questions: {} } }
  }
  return { approved: parseRubricAi(data?.rubric_ai), draft: parseRubricAi(data?.rubric_ai_draft) }
}

// Per-process memo so repeated single-student suggests in one server process skip
// the DB round-trip. Keyed by assignmentId:path so a replaced key invalidates it.
// Positive entries never expire (a key's parsed text is stable). Negative entries (a
// failed download/parse) get a short TTL so a transient Storage blip doesn't disable the
// answer key for the rest of the process lifetime — E10.
const NEG_CACHE_TTL_MS = 60_000
const memo = new Map<string, { text: string; expiresAt: number }>()

/**
 * Read the uploaded answer-key PDF pointer (path + name) for an assignment. This used
 * to live in the student-readable settings.answerKeySource, which leaked the key's
 * existence + filename to any student PostgREST read; the source of truth is now the
 * staff-only assignment_answer_keys row (BLOCKER #1). Returns null when no key PDF is
 * attached (source_path NULL — the row may still hold hand-authored rubric_ai).
 */
export async function loadAnswerKeySource(
  adminDb: AdminClient,
  assignmentId: string,
): Promise<{ path: string; name: string } | null> {
  const { data, error } = await adminDb
    .from('assignment_answer_keys')
    .select('source_path, source_name')
    .eq('assignment_id', assignmentId)
    .maybeSingle()
  if (error) {
    logger.warn('loadAnswerKeySource: read failed', {
      source: 'answer-key.loadAnswerKeySource',
      assignmentId,
      error: error.message,
    })
    return null
  }
  if (!data?.source_path) return null
  return { path: data.source_path, name: data.source_name ?? data.source_path.split('/').pop() ?? 'Answer key' }
}

/**
 * Load the full answer-key text for an assignment (Report 10: the key in context
 * is worth ~3 accuracy points). Reads the cached text off the staff-only row; when a
 * key PDF is attached but its text isn't cached yet, back-fills once (download, parse,
 * store) so the next session is a plain read. Returns null when no key PDF is attached
 * or parsing fails — grading then proceeds on rubric references alone.
 */
export async function loadAnswerKeyText(
  adminDb: AdminClient,
  assignment: { id: string; institutionId: string; sectionId: string },
): Promise<string | null> {
  // The row is the source of truth: source_path + cached text (both NULL when no key PDF).
  const { data: stored } = await adminDb
    .from('assignment_answer_keys')
    .select('source_path, source_name, text')
    .eq('assignment_id', assignment.id)
    .eq('institution_id', assignment.institutionId) // defence-in-depth tenant scope (#16)
    .maybeSingle()
  if (!stored?.source_path) return null // no key PDF attached (rubric_ai-only rows have no source)
  const path = stored.source_path

  const memoKey = `${assignment.id}:${path}`
  const memoed = memo.get(memoKey)
  if (memoed && Date.now() < memoed.expiresAt) return memoed.text || null

  if (stored.text) {
    memo.set(memoKey, { text: stored.text, expiresAt: Infinity })
    return stored.text
  }

  // Back-fill: parse from storage once and store for next time (covers keys uploaded
  // before the text cache existed, and any upload where the pre-parse failed).
  try {
    const { data: blob, error } = await adminDb.storage.from(COURSE_MATERIALS_BUCKET).download(path)
    if (error || !blob) throw new Error(error?.message ?? 'download failed')
    const text = await parseAnswerKeyBuffer(Buffer.from(await blob.arrayBuffer()))
    await storeAnswerKeyText(adminDb, {
      assignmentId: assignment.id,
      institutionId: assignment.institutionId,
      sectionId: assignment.sectionId,
      sourcePath: path,
      sourceName: stored.source_name ?? path.split('/').pop() ?? 'Answer key',
      text,
    })
    memo.set(memoKey, { text, expiresAt: Infinity })
    return text || null
  } catch (err) {
    logger.warn('loadAnswerKeyText: failed, grading on rubric references only', {
      source: 'answer-key.loadAnswerKeyText',
      path,
      err: String(err),
    })
    memo.set(memoKey, { text: '', expiresAt: Date.now() + NEG_CACHE_TTL_MS }) // TTL'd negative cache
    return null
  }
}
