/**
 * Format Wolfram LLM-API output into clean studio markdown.
 *
 * The LLM API returns plain text meant for machines: section labels, ASCII math, "image: URL"
 * references, "Wolfram Language code:" lines, and a trailing website link. For the studio we:
 *   - drop the Query echo and the "Wolfram|Alpha website result" section
 *   - strip every wolframalpha.com link and "Wolfram Language code:" line (no vendor references)
 *   - turn "image: URL" references into rendered markdown images
 *   - render self-contained expressions as KaTeX ($…$); leave descriptive lines as plain text
 *     (with their unicode symbols intact, since \commands only render inside math mode)
 *
 * Pure + dependency-free so it can run server-side and be unit-tested.
 */

// Words that mark a line as descriptive prose (leave as text, don't wrap in math).
const PROSE_HINTS = /\b(all|real|numbers?|element|onto|integer|constants?|Taylor|series|at|for|where|surjective|injective|bijective|periodic|even|odd|function|domain|range|undefined|converges?|diverges?)\b/i

/** ^(...) → ^{...} and _(...) → _{...}, allowing one level of nested parentheses. */
function braceGroups(s: string): string {
  return s.replace(/([\^_])\(((?:[^()]|\([^()]*\))*)\)/g, (_m, op: string, inner: string) => `${op}{${inner}}`)
}

/** Best-effort conversion of Wolfram ASCII math to LaTeX for a self-contained expression. */
export function toLatex(expr: string): string {
  let s = expr
  s = s
    .replace(/π/g, '\\pi ')
    .replace(/∞/g, '\\infty ')
    .replace(/(?:→|->)/g, '\\to ')
    .replace(/≈/g, '\\approx ')
    .replace(/∈/g, '\\in ')
    .replace(/·/g, '\\cdot ')
  // Lookarounds (letters only, not \b) so a trailing `_` or `(` — e.g. lim_(…), integral_(…) —
  // still matches, since `_` counts as a word char and would defeat \b.
  s = s.replace(/(?<![A-Za-z])integral(?![A-Za-z])/g, '\\int ')
  s = s.replace(/(?<![A-Za-z])(sin|cos|tan|sec|csc|cot|sinh|cosh|tanh|log|ln|exp|lim|min|max|gcd|lcm|mod)(?![A-Za-z])/g, '\\$1 ')
  s = s.replace(/(?<![A-Za-z])sqrt\(((?:[^()]|\([^()]*\))*)\)/g, '\\sqrt{$1}')
  s = braceGroups(s)
  return s.replace(/\s+/g, ' ').trim()
}

/** Render one body line: an image ref, a math expression, or descriptive text. */
function formatLine(line: string): string | null {
  const img = line.match(/^image:\s*(\S+)/i)
  if (img) return `![Plot](${img[1]})`
  // Strip every vendor reference and bare link.
  if (/wolfram/i.test(line)) return null
  if (/^https?:\/\//i.test(line)) return null
  if (PROSE_HINTS.test(line)) return line
  return `$${toLatex(line)}$`
}

export function formatWolframSolution(raw: string): string {
  const blocks = raw.replace(/\r/g, '').trim().split(/\n\s*\n/)
  const parts: string[] = []

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    if (!lines.length) continue

    let label: string | null = null
    let body = lines
    // A header is a line that starts with a letter and ends with ':' (the value may follow on the
    // same line or below). Skip image/link lines so they're handled as body content.
    const isImageOrLink = /^(image:|https?:)/i.test(lines[0])
    const inlineHeader = isImageOrLink ? null : lines[0].match(/^([A-Za-z][^:\n]*?):\s*(.*)$/)
    if (inlineHeader) {
      label = inlineHeader[1]
      body = [inlineHeader[2], ...lines.slice(1)].filter(Boolean)
    }

    // Drop noise sections entirely.
    if (label && (/^query$/i.test(label) || /wolfram\|?alpha website result/i.test(label))) continue

    const rendered = body.map(formatLine).filter((l): l is string => l !== null)
    if (label) parts.push(`**${label}**`)
    if (rendered.length) parts.push(rendered.join('\n\n'))
  }

  return parts.join('\n\n').trim()
}
