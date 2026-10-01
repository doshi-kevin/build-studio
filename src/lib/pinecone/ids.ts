// Deterministic vector-id grammar: {module_item_id}#p{zero-padded page}.
// Deterministic ids make ingestion idempotent (upsert overwrites in place)
// and the prefix is the per-material delete key. Zero-padding matters:
// without it prefix "item#p1" also matches "item#p10".

const PAGE_PAD = 4
const MAX_PAGE = 9999

export function buildPageVectorId(moduleItemId: string, pageNumber: number): string {
  if (!moduleItemId || moduleItemId.includes('#')) {
    throw new Error(`buildPageVectorId: invalid moduleItemId "${moduleItemId}"`)
  }
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > MAX_PAGE) {
    throw new Error(`buildPageVectorId: invalid pageNumber ${pageNumber}`)
  }
  return `${moduleItemId}#p${String(pageNumber).padStart(PAGE_PAD, '0')}`
}

/** Prefix matching every page vector of one material — the delete/list key. */
export function materialVectorPrefix(moduleItemId: string): string {
  if (!moduleItemId || moduleItemId.includes('#')) {
    throw new Error(`materialVectorPrefix: invalid moduleItemId "${moduleItemId}"`)
  }
  return `${moduleItemId}#p`
}

// Transcript vectors: {room_id}#t_{deck_id}#s{zero-padded slide}. The room and
// the deck are both prefixes, so erasure works at either grain: the deck prefix
// serves removeDeck (the one path that erases lc_transcriptions rows today),
// the room prefix serves any future whole-room deletion. Slide numbers are
// 0-based, matching lc_transcriptions.page_number.

const assertUnfenced = (label: string, value: string): void => {
  if (!value || value.includes('#')) {
    throw new Error(`${label}: invalid id "${value}"`)
  }
}

export function buildTranscriptVectorId(roomId: string, deckId: string, pageNumber: number): string {
  assertUnfenced('buildTranscriptVectorId roomId', roomId)
  assertUnfenced('buildTranscriptVectorId deckId', deckId)
  if (!Number.isInteger(pageNumber) || pageNumber < 0 || pageNumber > MAX_PAGE) {
    throw new Error(`buildTranscriptVectorId: invalid pageNumber ${pageNumber}`)
  }
  return `${roomId}#t_${deckId}#s${String(pageNumber).padStart(PAGE_PAD, '0')}`
}

/** Prefix matching a room's transcript vectors — pass `deckId` to narrow to one
 *  deck (the removeDeck erasure grain). */
export function transcriptVectorPrefix(roomId: string, deckId?: string): string {
  assertUnfenced('transcriptVectorPrefix roomId', roomId)
  if (deckId === undefined) return `${roomId}#t_`
  assertUnfenced('transcriptVectorPrefix deckId', deckId)
  return `${roomId}#t_${deckId}#s`
}

// ── Rubric reference vector ids ─────────────────────────────────────────────
// Grammar: {assignmentId}#q{zero-padded questionIndex}#c{zero-padded criterionIndex}.
// Deterministic — idempotent upsert + prefix-list-delete per assignment.

const CRITERION_PAD = 3
const MAX_CRITERION = 199

export function buildRubricReferenceVectorId(
  assignmentId: string,
  questionIndex: number,
  criterionIndex: number,
): string {
  if (!assignmentId || assignmentId.includes('#')) {
    throw new Error(`buildRubricReferenceVectorId: invalid assignmentId "${assignmentId}"`)
  }
  if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex > MAX_CRITERION) {
    throw new Error(`buildRubricReferenceVectorId: invalid questionIndex ${questionIndex}`)
  }
  if (!Number.isInteger(criterionIndex) || criterionIndex < 0 || criterionIndex > MAX_CRITERION) {
    throw new Error(`buildRubricReferenceVectorId: invalid criterionIndex ${criterionIndex}`)
  }
  return `${assignmentId}#q${String(questionIndex).padStart(CRITERION_PAD, '0')}#c${String(criterionIndex).padStart(CRITERION_PAD, '0')}`
}

/** Prefix matching every rubric reference vector of one assignment — the delete/list key. */
export function rubricReferenceVectorPrefix(assignmentId: string): string {
  if (!assignmentId || assignmentId.includes('#')) {
    throw new Error(`rubricReferenceVectorPrefix: invalid assignmentId "${assignmentId}"`)
  }
  return `${assignmentId}#q`
}
