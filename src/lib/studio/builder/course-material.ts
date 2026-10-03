/**
 * Course material for the builder (Step 9, docs/reference/studio-agent-harness.md, "Course
 * material"). Pure: the database decides which units exist and what each one's disclosure
 * class is (studio_course_units); this file turns rows into what the model may see.
 *
 *   - the search words, with time words removed (time goes through `focus`);
 *   - which modules a focus means ("this week", "next week", "week 6");
 *   - a plain source label per excerpt, never an id;
 *   - byte caps on every excerpt, every search and the whole prompt block;
 *   - roster names redacted from excerpts and labels.
 *
 * What it never does: decide eligibility, read the database, or keep text. A run keeps
 * search keys only (work.material); every turn re-reads them.
 */
import { unlockLabel } from '@/lib/modules/unlock'
import { redactRosterNames } from '@/lib/validations/memory'
import {
  STUDIO_BUILDER_TOOL_RESULT_MAX_BYTES,
  STUDIO_COURSE_BLOCK_MAX_BYTES,
  STUDIO_COURSE_EXCERPT_MAX_BYTES,
  STUDIO_COURSE_LABEL_MAX_CHARS,
  STUDIO_COURSE_QUERY_MAX_BYTES,
  STUDIO_COURSE_RESULTS_MAX,
} from '../limits'
import { utf8Bytes } from './paths'

export const MATERIAL_FOCI = ['this_week', 'next_week'] as const
/** this_week, next_week, or week:N for an explicit week number. */
export const FOCUS_PATTERN = /^(this_week|next_week|week:([1-9]|[1-4][0-9]|5[0-2]))$/
export type MaterialFocus = (typeof MATERIAL_FOCI)[number] | `week:${number}`

/** One search as a run keeps it: words, focus and the unit keys it returned. */
export interface MaterialSearch {
  query: string
  focus: MaterialFocus | null
  keys: string[]
}

/** What a run keeps about course material, in its working copy. Keys only. */
export interface WorkMaterial {
  searches: MaterialSearch[]
  /** Keys of scheduled units this run showed the model: the project's provenance at commit. */
  sources: string[]
  /** Search calls that reached the database, successful or not: the per-run cap counts these. */
  attempts: number
  /** A search failed: the rest of the run doesn't search again. */
  unavailable: boolean
}

export const emptyMaterial = (): WorkMaterial => ({ searches: [], sources: [], attempts: 0, unavailable: false })

/** One provenance entry: a unit key and the section it was built from. Never text. */
export interface MaterialSourceEntry {
  k: string
  s: string
}

export type Disclosure = 'released' | 'scheduled'

/** One unit row as the search and re-read functions return it. */
export interface CourseUnitRow {
  unitKey: string
  sourceKind: 'item' | 'module' | 'syllabus' | 'assignment'
  moduleTitle: string | null
  weekNumber: number | null
  itemType: string | null
  page: number | null
  title: string | null
  heading: string | null
  disclosure: Disclosure
  opensAt: string | null
  excerpt: string
}

/** An excerpt ready for the prompt: label and text redacted, capped and clean. */
export interface ShownExcerpt {
  key: string
  label: string
  disclosure: Disclosure
  opensAt: string | null
  text: string
}

export interface FocusModule {
  id: string
  title?: string
  weekNumber: number | null
  unlockDate: string | null
  isPublished: boolean
}

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

// Words about time or the course's structure, which `focus` carries instead. Left in the
// query they'd match every "Week N" title.
const TIME_WORDS = /\b(this|next|last|coming|current|upcoming|week'?s?|weeks|lectures?'?s?|class(es)?|today|tomorrow|yesterday|module'?s?)\b/gi

/** The search words without time words. Empty when nothing is left to search for. */
export function cleanQuery(raw: string): string {
  return raw.replace(TIME_WORDS, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * The modules a focus means. Never a guess: when the course's dates can't answer, no
 * module is in focus and ranking is by relevance alone.
 *
 *   week:N     modules with that week number
 *   this_week  published modules opening within 7 days either side of now
 *   next_week  published modules opening 7 to 14 days from now
 *
 * When no module of the course has an opening date, this_week and next_week fall back to
 * counting weeks from the section's start date against week numbers, only when both exist.
 */
export function resolveFocus(focus: MaterialFocus | null, modules: readonly FocusModule[], startDate: string | null, now: number): string[] {
  if (!focus) return []
  const explicit = /^week:(\d+)$/.exec(focus)
  if (explicit) {
    const week = Number(explicit[1])
    return modules.filter((m) => m.weekNumber === week).map((m) => m.id)
  }
  const dated = modules.filter((m) => m.isPublished && m.unlockDate && !Number.isNaN(Date.parse(m.unlockDate)))
  if (modules.some((m) => m.unlockDate)) {
    return dated
      .filter((m) => {
        const delta = Date.parse(m.unlockDate!) - now
        return focus === 'this_week' ? Math.abs(delta) <= WEEK_MS : delta > WEEK_MS && delta <= 2 * WEEK_MS
      })
      .map((m) => m.id)
  }
  const start = startDate ? Date.parse(startDate) : Number.NaN
  if (Number.isNaN(start) || now < start) return []
  const current = Math.floor((now - start) / WEEK_MS) + 1
  const week = focus === 'this_week' ? current : current + 1
  return modules.filter((m) => m.weekNumber === week).map((m) => m.id)
}

/**
 * Search words from the focused modules' own titles ("Week 6: Cellular respiration" gives
 * "Cellular respiration"), for a focused search whose words found nothing. Published modules
 * only, so no title the course hasn't released reaches the prompt. Empty when none is left.
 */
export function focusQuery(modules: readonly FocusModule[], focusIds: readonly string[], roster: readonly string[] = []): string {
  const words = modules
    .filter((m) => m.isPublished && m.title && focusIds.includes(m.id))
    .map((m) => cleanQuery(redactRosterNames(cleanText(m.title!), roster).replace(/[0-9]+|[:\-–—|]/g, ' ')))
    .filter(Boolean)
    .join(' ')
  return capBytes(words, STUDIO_COURSE_QUERY_MAX_BYTES).replace(/…$/, '').trim()
}

const ITEM_TYPE_WORDS: Record<string, string> = { lecture: 'lecture', reference: 'reading', note: 'note', link: 'link' }

// Characters that take no space (format: zero-width, soft hyphen, bidirectional, tag
// characters; private use; variation selectors) are deleted, so a word they sit inside stays
// one word. Control characters become spaces. Then whitespace is collapsed.
const INVISIBLE = /[\p{Cf}\p{Co}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu
const CONTROL = /\p{Cc}/gu

/** Text with unsafe characters removed and whitespace collapsed. */
export function cleanText(text: string): string {
  return text.replace(INVISIBLE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
}

/** At most `max` UTF-8 bytes, cut between whole characters (never inside a surrogate pair), with a marker. */
export function capBytes(text: string, max: number): string {
  if (utf8Bytes(text) <= max) return text
  const chars = Array.from(text)
  let bytes = 0
  let end = 0
  while (end < chars.length && bytes + utf8Bytes(chars[end]) <= max - 3) bytes += utf8Bytes(chars[end++])
  return `${chars.slice(0, end).join('')}…`
}

/** "Week 6: Attention (lecture), page 12". Built from fixed fields, redacted and capped. */
export function labelFor(row: CourseUnitRow, roster: readonly string[]): string {
  const week = row.weekNumber ? `Week ${row.weekNumber}: ` : ''
  let base: string
  switch (row.sourceKind) {
    case 'item':
      base = `${row.title || row.moduleTitle || 'Untitled'} (${ITEM_TYPE_WORDS[row.itemType ?? ''] ?? 'material'})${row.page ? `, page ${row.page}` : ''}`
      break
    case 'module':
      base = `${row.title || 'Untitled'} (module)`
      break
    case 'assignment':
      base = `${row.title || 'Untitled'} (assignment)`
      break
    case 'syllabus':
      // The syllabus title already says "Week N".
      return finishLabel(`Syllabus: ${row.title || 'week'}`, roster)
  }
  // A title that already starts with its week ("Week 6: Respiration") isn't prefixed twice.
  const titled = row.weekNumber !== null && new RegExp(`^week\\s*${row.weekNumber}\\b`, 'i').test(base)
  return finishLabel(titled ? base : `${week}${base}`, roster)
}

// Cleaned before redaction, so a name split by an invisible character is still found.
function finishLabel(label: string, roster: readonly string[]): string {
  return redactRosterNames(cleanText(label.replace(/[<>]/g, ' ')), roster).slice(0, STUDIO_COURSE_LABEL_MAX_CHARS).trim()
}

/** What a student can see of this unit, in words. */
export function disclosureNote(e: { disclosure: Disclosure; opensAt: string | null }): string {
  if (e.disclosure === 'released') return 'visible to students'
  const opens = e.opensAt ? unlockLabel(e.opensAt) : null
  return opens ? `not visible to students yet, ${opens.replace(/^Opens/, 'opens')}` : 'not visible to students yet'
}

/** One row, ready for the prompt. */
export function toShown(row: CourseUnitRow, roster: readonly string[]): ShownExcerpt {
  return {
    key: row.unitKey,
    label: labelFor(row, roster),
    disclosure: row.disclosure,
    opensAt: row.opensAt,
    text: capBytes(redactRosterNames(cleanText(row.excerpt ?? ''), roster), STUDIO_COURSE_EXCERPT_MAX_BYTES),
  }
}

/** One excerpt as the prompt shows it. */
export function excerptEntry(e: ShownExcerpt, n: number): string {
  return `[${n}] ${e.label} (${disclosureNote(e)})\n${e.text || '(no text on this page)'}`
}

/**
 * A search's result: rows in rank order, added until the next would pass the per-search
 * byte cap or the result count. Returns what to show and the keys to keep.
 */
export function capSearch(rows: readonly CourseUnitRow[], roster: readonly string[]): { shown: ShownExcerpt[]; keys: string[]; scheduled: string[] } {
  const shown: ShownExcerpt[] = []
  let bytes = 0
  for (const row of rows) {
    if (shown.length >= STUDIO_COURSE_RESULTS_MAX) break
    const e = toShown(row, roster)
    const size = utf8Bytes(excerptEntry(e, shown.length + 1))
    if (bytes + size > STUDIO_BUILDER_TOOL_RESULT_MAX_BYTES) break
    shown.push(e)
    bytes += size
  }
  return { shown, keys: shown.map((e) => e.key), scheduled: shown.filter((e) => e.disclosure === 'scheduled').map((e) => e.key) }
}

/** A search with the excerpts its keys re-read to this turn, in the search's own order. */
export interface RenderedSearch {
  query: string
  focus: MaterialFocus | null
  shown: ShownExcerpt[]
}

/**
 * The searches the prompt carries, under the block cap: the oldest whole search goes
 * first, then the lowest-ranked results of the oldest search left.
 */
export function fitSearches(searches: readonly RenderedSearch[], maxBytes = STUDIO_COURSE_BLOCK_MAX_BYTES): { searches: RenderedSearch[]; dropped: number } {
  const size = (list: readonly RenderedSearch[]) =>
    list.reduce((n, s) => n + s.shown.reduce((m, e, i) => m + utf8Bytes(excerptEntry(e, i + 1)) + 1, 0) + utf8Bytes(s.query) + 64, 0)
  let kept = searches.map((s) => ({ ...s, shown: [...s.shown] }))
  let dropped = 0
  while (kept.length > 1 && size(kept) > maxBytes) {
    kept = kept.slice(1)
    dropped += 1
  }
  while (kept.length === 1 && kept[0].shown.length > 0 && size(kept) > maxBytes) kept[0].shown.pop()
  return { searches: kept, dropped }
}

/** Keys added to a run's provenance, deduplicated, newest last. */
export function withSources(existing: readonly string[], added: readonly string[], max: number): string[] {
  const all = [...existing.filter((k) => !added.includes(k)), ...added]
  return all.slice(Math.max(0, all.length - max))
}

/** A project's provenance plus this run's scheduled sources, stamped with the run's section. */
export function provenanceEntries(project: readonly MaterialSourceEntry[], runSources: readonly string[], sectionId: string | null): MaterialSourceEntry[] {
  const out = [...project]
  if (sectionId) for (const k of runSources) if (!out.some((e) => e.k === k && e.s === sectionId)) out.push({ k, s: sectionId })
  return out
}

/** Bytes of one excerpt, for tests and the trim. */
export const shownBytes = (e: ShownExcerpt) => utf8Bytes(excerptEntry(e, 1))
