// Fill-in-the-blank inline blanks — the single source of truth for how a blank
// is embedded in a question's text, parsed, rendered, and (critically) stripped
// of its answers before the text is ever sent to a student.
//
// Wire format (canonical, professor/AI-authored, stored in questionText):
//     {{blank:<id>:<answer1>|<answer2>|…}}
//   - <id>      stable per-blank id ([A-Za-z0-9_-]+) so reorder/delete never
//               mis-maps answers (the Quizizz property).
//   - answers   pipe-separated accepted answers. Answers may NOT contain the
//               characters { } |  — the authoring layer sanitizes them out, so
//               the `}}` terminator and `|` separator are always unambiguous.
//
// Wire format (STRIPPED, what a student ever receives):
//     {{blank:<id>}}
//   The answer payload is removed. `stripBlankAnswers()` is the anti-leak gate;
//   every student-facing path MUST run the question text through it.
//
// The delimiter `{{blank:…}}` is chosen so it can't collide with prose, Markdown,
// or LaTeX in practice, and the renderer parses these tokens out BEFORE Markdown/
// KaTeX runs — so even `{{` sequences inside math never reach a student as answers.

/** A blank as parsed from question text. */
export interface ParsedBlank {
  id: string
  acceptedAnswers: string[]
}

/** One piece of a question's text: literal prose or a blank placeholder. */
export type BlankSegment =
  | { type: 'text'; value: string }
  | { type: 'blank'; id: string; index: number; acceptedAnswers: string[] }

// Canonical/stripped token. Group 1 = id; group 2 = answer payload (absent when
// stripped). `[^{}|]` per answer char keeps the terminator + separator clean.
const BLANK_TOKEN = /\{\{blank:([A-Za-z0-9_-]+)(?::([^{}]*))?\}\}/g

/** Chars that would break the token if they appeared inside an answer. */
export function sanitizeBlankAnswer(answer: string): string {
  return answer.replace(/[{}|]/g, '').trim()
}

/** Build a canonical token from an id + accepted answers. */
export function serializeBlankToken(id: string, acceptedAnswers: string[]): string {
  const cleaned = acceptedAnswers.map(sanitizeBlankAnswer).filter(Boolean)
  return cleaned.length ? `{{blank:${id}:${cleaned.join('|')}}}` : `{{blank:${id}}}`
}

/** True if the text uses the inline-blank format at all (vs. legacy plain text). */
export function hasInlineBlanks(text: string): boolean {
  BLANK_TOKEN.lastIndex = 0
  return BLANK_TOKEN.test(text ?? '')
}

/**
 * Remove every answer payload from the text, leaving positional-only tokens
 * (`{{blank:id}}`). THIS IS THE ANTI-LEAK GATE — run it on any question text
 * before it reaches a student. Idempotent: already-stripped text is unchanged.
 */
export function stripBlankAnswers(text: string): string {
  if (!text) return text
  return text.replace(BLANK_TOKEN, (_m, id) => `{{blank:${id}}}`)
}

/**
 * Split text into ordered segments for rendering. Works on both canonical and
 * stripped text (stripped simply yields blanks with `acceptedAnswers: []`).
 */
export function segmentFillInBlankText(text: string): BlankSegment[] {
  const segments: BlankSegment[] = []
  if (!text) return segments
  BLANK_TOKEN.lastIndex = 0
  let last = 0
  let index = 0
  let m: RegExpExecArray | null
  while ((m = BLANK_TOKEN.exec(text)) !== null) {
    if (m.index > last) segments.push({ type: 'text', value: text.slice(last, m.index) })
    const answers = (m[2] ?? '').split('|').map((a) => a.trim()).filter(Boolean)
    segments.push({ type: 'blank', id: m[1], index, acceptedAnswers: answers })
    index += 1
    last = m.index + m[0].length
  }
  if (last < text.length) segments.push({ type: 'text', value: text.slice(last) })
  return segments
}

/**
 * The blanks defined by the text, in order, de-duplicated by id (first wins).
 * Used to derive `content.blanks[]` on save so grading / analytics keep reading
 * the same shape they always have.
 */
export function parseBlanks(text: string): ParsedBlank[] {
  const out: ParsedBlank[] = []
  const seen = new Set<string>()
  for (const seg of segmentFillInBlankText(text)) {
    if (seg.type === 'blank' && !seen.has(seg.id)) {
      seen.add(seg.id)
      out.push({ id: seg.id, acceptedAnswers: seg.acceptedAnswers })
    }
  }
  return out
}

/** Ordered, de-duplicated blank ids — the submission keys a student fills in. */
export function blankIds(text: string): string[] {
  return parseBlanks(text).map((b) => b.id)
}

/**
 * Human-readable text for summaries / list rows / previews: every blank token
 * (canonical or stripped) collapses to a plain "_____" marker — no ids, no
 * answers — so the UI reads like it did before, never showing raw tokens.
 */
export function blankPlaceholderText(text: string, placeholder = '_____'): string {
  return (text ?? '').replace(BLANK_TOKEN, placeholder)
}

/** Number of distinct blanks defined inline. */
export function inlineBlankCount(text: string): number {
  return parseBlanks(text).length
}

let idCounter = 0
/**
 * A short, collision-safe blank id for a newly-inserted chip. Only needs to be
 * unique within one question's text; the random suffix avoids clashing with ids
 * already saved in the text after a reload resets the counter.
 */
export function newBlankId(): string {
  idCounter += 1
  const rand = Math.floor(Math.random() * 1e6).toString(36)
  return `b${rand}${idCounter}`
}
