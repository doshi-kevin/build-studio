/**
 * Make model-written math survive remark-math.
 *
 * remark-math only understands `$…$` / `$$…$$`, but nothing constrains which
 * delimiters an LLM reaches for, and two of its habits used to reach the
 * student as raw characters:
 *
 *   - `\(x\)` / `\[x\]` (the LaTeX/MathJax pair) rendered as literal backslashes.
 *   - two plain dollar amounts in one sentence ("$40 … $15") paired up as math
 *     and rendered as `40andthelabkitis15`.
 *
 * So every surface that renders LLM markdown runs its text through
 * `normalizeMathDelimiters` first. Code spans and fenced blocks are left
 * untouched — a snippet that shows LaTeX source must keep showing it.
 */

/** Fenced blocks and inline code spans, which the normalizer must not rewrite. */
const CODE_SEGMENT_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g

/** A LaTeX signal inside a `$…$` span: a command, a script, or a group. Used to
 *  keep `$ \frac{a}{b} $` (padded, but unmistakably math) rendering as math. */
const LATEX_SIGNAL_RE = /[\\^_{}]/

/**
 * Would remark-math's pairing of this `$…$` content be math, or an accident?
 * Pandoc's rule: the content may not start or end with whitespace — which is
 * exactly what tells "$2 f_{max}$" (math) from "$40 and the lab kit is $"
 * (two prices). Padded content still counts when it carries a LaTeX signal.
 */
function looksLikeMath(content: string): boolean {
  if (content.length === 0) return false
  if (!/^\s/.test(content) && !/\s$/.test(content)) return true
  return LATEX_SIGNAL_RE.test(content)
}

/**
 * Escape the `$` of every dollar pair that isn't math, so it renders as a plain
 * dollar sign instead of opening a math span. Walks the text once: a `$` that
 * opens real math is skipped past (its content is never re-examined), and one
 * that doesn't is escaped in place so the scan continues after it.
 */
function escapeNonMathDollars(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    // An already-escaped character (`\$`) is inert — copy both and move on.
    if (ch === '\\' && i + 1 < text.length) {
      out += text.slice(i, i + 2)
      i += 2
      continue
    }
    if (ch !== '$') {
      out += ch
      i += 1
      continue
    }
    if (text.startsWith('$$', i)) {
      // Block math: hand over the whole fence untouched when it closes.
      const close = text.indexOf('$$', i + 2)
      if (close === -1) {
        out += '\\$'
        i += 1
        continue
      }
      out += text.slice(i, close + 2)
      i = close + 2
      continue
    }
    const close = text.indexOf('$', i + 1)
    if (close === -1 || !looksLikeMath(text.slice(i + 1, close))) {
      out += '\\$'
      i += 1
      continue
    }
    out += text.slice(i, close + 1)
    i = close + 1
  }
  return out
}

/** `\(x\)` → `$x$`, `\[x\]` → a display block, and a `$$…$$` written on one
 *  line → the fenced form remark-math renders as display (on one line it comes
 *  out inline, mid-sentence).
 *
 *  Escaped parens mean math and nothing else, so that form converts on sight.
 *  Escaped BRACKETS are also how markdown prose shows a literal `[1]`, so those
 *  convert only when the body carries a math signal. */
function convertLatexDelimiters(text: string): string {
  return text
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => `$${body.trim()}$`)
    .replace(/\\\[([\s\S]+?)\\\]/g, (m, body: string) =>
      /[\\^_{}=<>]/.test(body) ? `\n\n$$\n${body.trim()}\n$$\n\n` : m,
    )
    .replace(/^[ \t]*\$\$[ \t]*(?!\$)([^\n]+?)[ \t]*\$\$[ \t]*$/gm, (_m, body: string) => `$$\n${body}\n$$`)
}

/** Rewrite LLM-written math into the delimiters remark-math understands,
 *  leaving code spans and fenced blocks exactly as they came. */
export function normalizeMathDelimiters(markdown: string): string {
  if (!markdown.includes('$') && !markdown.includes('\\')) return markdown
  return markdown
    .split(CODE_SEGMENT_RE)
    .map((segment, i) =>
      // split() with a capturing group puts the delimiters at odd indices.
      i % 2 === 1 ? segment : convertLatexDelimiters(escapeNonMathDollars(segment)),
    )
    .join('')
}
