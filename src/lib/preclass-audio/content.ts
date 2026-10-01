// Assembles the source content for a Pre-Class Primer and derives a stable
// content hash. The lecture "so far" comes from the module_item (title,
// description, instructor note, extracted deck text) plus its parent module and
// the PREVIOUS lecture item (for the "bridge to last class" beat).
//
// Split in two:
//   • assemblePrimerContent(...)  — PURE: raw fields → { userContent, sourceHash,
//     hasMaterial }. Unit-tested (hash determinism, cap, material gate).
//   • buildPrimerSource(adminDb, moduleItemId) — does the DB reads, orders the
//     syllabus to find the previous lecture, then calls the pure function.
//
// The hash is sha256 over the exact bytes fed to the model, so it changes iff
// the primer's inputs change → drives lazy regeneration (see generate.ts).

import 'server-only'

import { createHash } from 'crypto'
import { PRECLASS_PRIMER_MAX_CONTEXT_CHARS } from '@/lib/ai/config'

/** Raw fields describing a lecture and the one before it. */
export interface PrimerRawInputs {
  moduleTitle: string
  moduleDescription: string
  lectureTitle: string
  lectureDescription: string
  instructorNote: string
  /** Extracted deck/notes text for this lecture (already page-formatted). */
  lectureText: string
  /** The prior lecture in syllabus order, for the bridge. Null if this is the first. */
  previousLectureTitle: string | null
  previousLectureDescription: string | null
}

export interface AssembledPrimerContent {
  /** The labelled prompt body sent to the script generator. */
  userContent: string
  /** sha256 of userContent — the freshness key. */
  sourceHash: string
  /** False when there's nothing substantive to prime from (avoid hallucination). */
  hasMaterial: boolean
}

function clean(s: string | null | undefined): string {
  return (s ?? '').trim()
}

/**
 * PURE. Build the model prompt body + freshness hash from raw lecture fields.
 * The lecture text is capped to the primer context budget (truncated at the
 * cap; a primer only needs the gist). hasMaterial gates the LLM call: with no
 * description, note, or extracted text, the model would invent a lecture.
 */
export function assemblePrimerContent(raw: PrimerRawInputs): AssembledPrimerContent {
  const lectureText = clean(raw.lectureText).slice(0, PRECLASS_PRIMER_MAX_CONTEXT_CHARS)

  const hasMaterial =
    lectureText.length > 0 ||
    clean(raw.lectureDescription).length > 0 ||
    clean(raw.instructorNote).length > 0 ||
    clean(raw.moduleDescription).length > 0

  const sections: string[] = [
    `=== Course module ===\nTitle: ${clean(raw.moduleTitle) || '(untitled)'}`,
  ]
  if (clean(raw.moduleDescription)) sections.push(`Module overview: ${clean(raw.moduleDescription)}`)

  sections.push(`\n=== Upcoming lecture ===\nTitle: ${clean(raw.lectureTitle) || '(untitled)'}`)
  if (clean(raw.lectureDescription)) sections.push(`Description: ${clean(raw.lectureDescription)}`)
  if (clean(raw.instructorNote)) sections.push(`Instructor note: ${clean(raw.instructorNote)}`)
  if (lectureText) sections.push(`\nLecture material:\n${lectureText}`)

  if (clean(raw.previousLectureTitle)) {
    sections.push(`\n=== Previous lecture (for the bridge) ===\nTitle: ${clean(raw.previousLectureTitle)}`)
    if (clean(raw.previousLectureDescription)) {
      sections.push(`Description: ${clean(raw.previousLectureDescription)}`)
    }
  }

  const userContent = sections.join('\n')
  const sourceHash = createHash('sha256').update(userContent).digest('hex')

  return { userContent, sourceHash, hasMaterial }
}

// ── DB-backed assembly ───────────────────────────────────────────

export interface PrimerSource extends AssembledPrimerContent {
  sectionId: string
  institutionId: string
  lectureTitle: string
}

interface ExtractionPageLike {
  pageNumber: number
  text: string
}
interface ModuleItemContent {
  extraction?: { pages?: ExtractionPageLike[] } | null
}
interface ModuleItemRow {
  id: string
  title: string
  description: string
  instructor_note: string
  item_type: string
  is_visible: boolean
  module_id: string
  position: number
  content: ModuleItemContent | null
}

/**
 * Page-format the extracted deck/notes text of a module item, if any. Reads
 * only pageNumber + text (not the full extraction type) so it stays decoupled
 * from the extraction schema — same approach as buildLectureContext.
 */
function extractionTextOf(content: ModuleItemRow['content']): string {
  const pages = content?.extraction?.pages
  if (!pages?.length) return ''
  return pages
    .filter((p) => p.text?.trim())
    .map((p) => `Page ${p.pageNumber}:\n${p.text.trim()}`)
    .join('\n\n')
}

/**
 * Read the lecture item, its module, and the previous lecture item (syllabus
 * order = module.position, then item.position), then assemble the primer source.
 * Returns null if the item doesn't exist or isn't a visible lecture.
 */
export async function buildPrimerSource(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  moduleItemId: string,
): Promise<PrimerSource | null> {
  const { data: item } = await adminDb
    .from('module_items')
    .select('id, title, description, instructor_note, item_type, is_visible, module_id, position, content')
    .eq('id', moduleItemId)
    .maybeSingle()
  if (!item || item.item_type !== 'lecture' || !item.is_visible) return null
  const lecture = item as ModuleItemRow

  const { data: mod } = await adminDb
    .from('modules')
    .select('id, title, description, section_id, position')
    .eq('id', lecture.module_id)
    .maybeSingle()
  if (!mod) return null

  const { data: section } = await adminDb
    .from('course_sections')
    .select('id, institution_id')
    .eq('id', mod.section_id)
    .maybeSingle()
  if (!section) return null

  const prev = await findPreviousLecture(adminDb, mod.section_id, mod.position, lecture.position)

  const assembled = assemblePrimerContent({
    moduleTitle: mod.title,
    moduleDescription: mod.description,
    lectureTitle: lecture.title,
    lectureDescription: lecture.description,
    instructorNote: lecture.instructor_note,
    lectureText: extractionTextOf(lecture.content),
    previousLectureTitle: prev?.title ?? null,
    previousLectureDescription: prev?.description ?? null,
  })

  return {
    ...assembled,
    sectionId: mod.section_id,
    institutionId: section.institution_id,
    lectureTitle: lecture.title,
  }
}

/**
 * The visible lecture item immediately before this one in syllabus order.
 * Loads the section's visible lecture items with their module positions,
 * sorts by (module.position, item.position), and returns the predecessor.
 */
async function findPreviousLecture(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  sectionId: string,
  currentModulePosition: number,
  currentItemPosition: number,
): Promise<{ title: string; description: string } | null> {
  const { data: modules } = await adminDb
    .from('modules')
    .select('id, position')
    .eq('section_id', sectionId)
  const modPos = new Map<string, number>(
    ((modules ?? []) as Array<{ id: string; position: number }>).map((m) => [m.id, m.position]),
  )
  const moduleIds = [...modPos.keys()]
  if (moduleIds.length === 0) return null

  const { data: items } = await adminDb
    .from('module_items')
    .select('title, description, module_id, position')
    .in('module_id', moduleIds)
    .eq('item_type', 'lecture')
    .eq('is_visible', true)

  const lectures = ((items ?? []) as Array<{ title: string; description: string; module_id: string; position: number }>)
    .map((it) => ({ ...it, modPos: modPos.get(it.module_id) ?? 0 }))
    .sort((a, b) => (a.modPos - b.modPos) || (a.position - b.position))

  // The predecessor is the last lecture that sorts strictly before the current one.
  let prev: { title: string; description: string } | null = null
  for (const it of lectures) {
    const isBefore =
      it.modPos < currentModulePosition ||
      (it.modPos === currentModulePosition && it.position < currentItemPosition)
    if (isBefore) prev = { title: it.title, description: it.description }
    else break
  }
  return prev
}
