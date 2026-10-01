'use client'

/**
 * Evidence highlighting for the grading panel (evidence-first review).
 *
 * The AI grader quotes verbatim evidence per rubric criterion (substring-verified
 * server-side against the ingested submission). This module locates those quotes in the
 * TYPED written response and renders them as criterion-tagged highlights. Evidence that
 * came from an uploaded file (PDF etc.) won't locate here — callers degrade to a quote
 * chip with a "from the submitted files" hint. Matching never guesses: no range beats a
 * wrong range, because a mis-anchored highlight would misattribute student work.
 *
 * Rendering is pure string-splitting into React text nodes — the submission and the
 * evidence are both student-authored, so nothing here may pass through
 * dangerouslySetInnerHTML or any HTML parsing.
 */

export interface EvidenceRange {
  key: string
  start: number
  end: number
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Locate one evidence quote in the response text. Three passes, strictest first:
 *  1. exact substring
 *  2. case-insensitive substring (length-preserving, so indexes stay valid)
 *  3. whitespace-tolerant: tokens joined by \s+ (PDF extraction and textarea text
 *     disagree about newlines/spacing far more often than about words)
 * Returns null when none match — the caller shows the quote without a highlight.
 */
export function findEvidenceRange(
  text: string,
  evidence: string,
): { start: number; end: number } | null {
  const needle = evidence.trim()
  if (!needle || !text) return null

  const exact = text.indexOf(needle)
  if (exact !== -1) return { start: exact, end: exact + needle.length }

  // The lowercase fast path is only index-safe when toLowerCase preserves length — a few
  // Unicode characters (e.g. "İ") expand, which would shift the highlight. Those rare
  // cases fall through to the regex pass, which matches case-insensitively on the
  // ORIGINAL string so its indexes are always valid.
  const lowerText = text.toLowerCase()
  const lowerNeedle = needle.toLowerCase()
  if (lowerText.length === text.length && lowerNeedle.length === needle.length) {
    const insensitive = lowerText.indexOf(lowerNeedle)
    if (insensitive !== -1) return { start: insensitive, end: insensitive + needle.length }
  }

  const tokens = needle.split(/\s+/).filter(Boolean).map(escapeRegExp)
  if (tokens.length === 0) return null
  try {
    const match = new RegExp(tokens.join('\\s+'), 'i').exec(text)
    if (match) return { start: match.index, end: match.index + match[0].length }
  } catch {
    // Pathological evidence (regex too large) — degrade to no highlight.
  }
  return null
}

/**
 * Locate every criterion's evidence, drop overlaps (first by document order wins —
 * two criteria citing the same sentence would otherwise produce nested marks).
 */
export function computeEvidenceRanges(
  text: string,
  criteria: { key: string; evidence: string }[],
): EvidenceRange[] {
  const found: EvidenceRange[] = []
  for (const c of criteria) {
    if (!c.evidence?.trim()) continue
    const range = findEvidenceRange(text, c.evidence)
    if (range) found.push({ key: c.key, ...range })
  }
  found.sort((a, b) => a.start - b.start || a.end - b.end)
  const result: EvidenceRange[] = []
  let lastEnd = -1
  for (const r of found) {
    if (r.start < lastEnd) continue
    result.push(r)
    lastEnd = r.end
  }
  return result
}

/** DOM id for a criterion's highlight, shared with the rubric panel's scroll-to. */
export function evidenceMarkId(key: string): string {
  return `evidence-${key.replace(':', '-')}`
}

/**
 * The written response with evidence highlights. Text nodes only — student-authored
 * content (including any HTML/script the student typed) renders inert as text.
 */
export function EvidenceHighlightedText({
  text,
  ranges,
  activeKey,
}: {
  text: string
  ranges: EvidenceRange[]
  activeKey: string | null
}) {
  if (ranges.length === 0) {
    return <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{text}</p>
  }
  const segments: React.ReactNode[] = []
  let cursor = 0
  for (const r of ranges) {
    if (r.start > cursor) segments.push(text.slice(cursor, r.start))
    const active = r.key === activeKey
    segments.push(
      <mark
        key={`${r.key}-${r.start}`}
        id={evidenceMarkId(r.key)}
        className={
          active
            ? 'bg-primary/30 text-foreground ring-1 ring-primary'
            : 'bg-primary/10 text-foreground'
        }
      >
        {text.slice(r.start, r.end)}
      </mark>,
    )
    cursor = r.end
  }
  if (cursor < text.length) segments.push(text.slice(cursor))
  return <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{segments}</p>
}
