// Shared utility for inserting a LaTeX formula from the lecture library
// into a quiz question's Markdown text. Keeps the delimiter convention
// (single `$` for inline, double `$$` for display) in one place so the
// wizard's QuestionEditorCard and the modal QuestionFormDialog can't
// drift apart. The student player renders the result via MarkdownLatex
// (remark-math + rehype-katex), which expects these delimiters.

export interface FormulaInsertResult {
  /** The new full text with the token spliced in. */
  next: string
  /** Caret position to place after the inserted token. */
  caret: number
}

export function buildFormulaToken(latex: string, kind: 'inline' | 'display'): string {
  const delim = kind === 'display' ? '$$' : '$'
  return `${delim}${latex}${delim}`
}

/**
 * Splice `token` into `current` at the textarea's current selection.
 * If the textarea has no selection (unmounted, never focused, cross-origin
 * quirk), we append on a new line so the pick still lands somewhere visible.
 *
 * Pads with a separator when the adjacent character is non-whitespace, so
 * back-to-back picks don't glue into `$$a$$$$b$$` (which remark-math can't
 * disambiguate). Inline tokens get a space; display tokens get a blank line
 * so they render as proper block math.
 */
export function insertAtCaret(
  current: string,
  token: string,
  textarea: HTMLTextAreaElement | null,
): FormulaInsertResult {
  const sep = token.startsWith('$$') ? '\n\n' : ' '

  if (textarea && typeof textarea.selectionStart === 'number') {
    const start = textarea.selectionStart
    const end = textarea.selectionEnd ?? start
    const prev = current.slice(0, start)
    const after = current.slice(end)
    const lead = prev.length > 0 && /\S$/.test(prev) ? sep : ''
    const trail = after.length > 0 && /^\S/.test(after) ? sep : ''
    const next = prev + lead + token + trail + after
    return { next, caret: start + lead.length + token.length }
  }
  const next = current ? `${current}\n${token}` : token
  return { next, caret: next.length }
}

/**
 * Move the textarea's caret without stealing focus. This matters when the
 * picker dialog is open: calling `textarea.focus()` would fight Radix's
 * focus trap and yank scroll. `setSelectionRange` updates
 * `selectionStart`/`selectionEnd` without requiring focus, so a follow-up
 * pick reads the new position and a subsequent formula lands after the
 * previous one rather than overwriting it.
 */
export function advanceCaret(textarea: HTMLTextAreaElement | null, caret: number): void {
  if (!textarea) return
  requestAnimationFrame(() => {
    try {
      textarea.setSelectionRange(caret, caret)
    } catch {
      // Textarea unmounted between rAF schedule and execution — no-op.
    }
  })
}
