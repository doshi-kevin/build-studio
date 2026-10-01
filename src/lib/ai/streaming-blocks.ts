/**
 * Streaming-safe markdown block balancing.
 *
 * A streamed answer arrives a token at a time, so a block delimiter is open for
 * many frames before its closer lands. Until then the markdown parser sees an
 * unterminated block and renders it as LITERAL TEXT — the student watches
 * "$$P(A \mid B" or "```python\ndef f(" crawl across the screen as raw markup,
 * then snap into place. Closing the open delimiter for display purposes only
 * means the block renders as a block from its first character, growing in place.
 *
 * Generalised over every block delimiter we emit rather than maths alone, but the
 * two kinds need OPPOSITE treatment:
 *   ```   fenced code   → CLOSE it. A partial code block renders fine: it's plain
 *                         text in a <pre>, so it grows line by line.
 *   $$    display maths → DROP it. Closing a half-written formula hands KaTeX
 *   \[ \]                invalid LaTeX, and KaTeX renders a parse failure as raw
 *                         source in red — so "closing" it trades a grey markup
 *                         flash for a red error flash, which is worse. Withholding
 *                         the formula until its closer arrives (~150ms) shows
 *                         nothing instead of something wrong.
 *
 * Deliberately NOT handled:
 *   - inline `$…$`: a lone "$" is far more often currency than maths, and
 *     remark-math only opens an inline node when the "$" is followed by a
 *     non-space, so a trailing "costs $5" never opens one. Guessing here would
 *     corrupt ordinary prose.
 *   - inline single backtick: cheap to mis-detect in prose, and a one-token flash
 *     of `foo` is not worth the risk.
 *   - tables/lists: GFM already renders these incrementally row by row.
 *
 * APPLY ONLY WHILE STREAMING. Pure, but NOT safe to apply unconditionally: it is
 * idempotent on BALANCED text only, and withholding is lossy by design. Prose that
 * legitimately contains an odd number of `$$` (a currency example, "$$" used as a
 * separator, a truncated generation) would have everything after the last opener
 * silently deleted — measured at 74 of 93 characters on a one-line probe. A
 * finished message must render exactly what it says, so the caller gates this on
 * the message actually being in flight.
 */

/** The delimiters we can close, and what closes them. */
const OPENERS = [
  // `close`: what to append to finish the block. null = withhold the partial block
  // instead, because a partially-closed one renders WORSE than nothing.
  { open: '```', close: '\n```' },
  { open: '$$', close: null },
  { open: '\\[', close: null, closeMatch: '\\]' },
] as const

export function balanceStreamingBlocks(text: string): string {
  if (!text) return text

  let i = 0
  // Only one block is treated as open at a time. These delimiters don't nest in
  // practice (maths inside a fence is literal, and a fence inside maths isn't a
  // thing), and a single-slot model can't get the unwinding order wrong.
  let openIdx: number | null = null
  // Where the currently-open delimiter starts, so a withheld block can be cut off
  // cleanly rather than closed.
  let openStart = 0

  while (i < text.length) {
    if (openIdx === null) {
      const hit = OPENERS.findIndex((d) => text.startsWith(d.open, i))
      if (hit !== -1) {
        openIdx = hit
        openStart = i
        i += OPENERS[hit].open.length
        continue
      }
      i += 1
      continue
    }

    const d = OPENERS[openIdx]
    // `\[` closes with `\]`; the others close with the same token they opened with.
    const closer = 'closeMatch' in d ? d.closeMatch : d.open
    if (text.startsWith(closer, i)) {
      openIdx = null
      i += closer.length
      continue
    }
    i += 1
  }

  if (openIdx === null) return text
  const { close } = OPENERS[openIdx]
  // trimEnd so withholding doesn't leave the trailing blank line the opener sat on
  return close === null ? text.slice(0, openStart).trimEnd() : text + close
}
