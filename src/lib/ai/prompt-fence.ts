/**
 * Fence an untrusted display string before it enters a model prompt.
 *
 * Pure and dependency-free on purpose: the callers are a chat route, two insight
 * generators and a context loader, and none of them should pull an LLM client in
 * just to sanitize a name.
 *
 * The values this guards are all human- or AI-authored free text that reaches a
 * prompt as DATA: student and professor names, and topic names — which the
 * extraction pipeline writes from whatever is inside an uploaded course file.
 * Stripping newlines and angle brackets keeps an instruction smuggled into one of
 * them from reading as prompt structure, and the length clamp keeps a pathological
 * value from crowding out the real context.
 */
export function fence(value: string, max: number): string {
  return value.replace(/[\r\n<>]+/g, ' ').slice(0, max).trim()
}

/** Where a fenced block's text came from. Every one of them is data, never instruction. */
export type FenceProvenance = 'model-authored' | 'plugin-code' | 'check-output' | 'course-data' | 'earlier-request' | 'professor-answer'

/**
 * Fence a multi-line untrusted block, such as plugin source or check output, before it
 * enters a prompt. `fence()` can't do this: it flattens newlines and angle brackets,
 * which destroys TSX.
 *
 * The tag carries a nonce chosen fresh for each prompt, so text inside the block can't
 * close it: any copy of the closing tag is removed first. NUL and control characters
 * other than tab and newline are stripped, and the block is clamped by bytes with a
 * visible marker. Attribute values are reduced to a safe character set.
 */
export function fenceBlock(
  nonce: string,
  kind: string,
  provenance: FenceProvenance,
  text: string,
  maxBytes: number,
  attrs: Record<string, string | number> = {},
): string {
  if (!/^[a-z0-9]{6,16}$/.test(nonce)) throw new Error('fenceBlock: nonce must be 6 to 16 lowercase letters or digits')
  const tag = `data_${nonce}`
  const safeAttr = (v: string | number) => String(v).replace(/[^A-Za-z0-9 ._/:-]/g, '').slice(0, 80)
  const attributes = [`kind="${safeAttr(kind)}"`, `provenance="${provenance}"`, ...Object.entries(attrs).map(([k, v]) => `${safeAttr(k)}="${safeAttr(v)}"`)]
  let body = text
    .replace(/\r\n?/g, '\n')
    // Strip NUL and controls except tab and newline.
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
  // Until none is left: removing one copy can join the text around it into another.
  while (body.includes(`<${tag}`) || body.includes(`</${tag}`)) body = body.split(`</${tag}`).join('').split(`<${tag}`).join('')
  const encoder = new TextEncoder()
  if (encoder.encode(body).length > maxBytes) {
    // Clamp on a character boundary, then mark it.
    let cut = body.slice(0, maxBytes)
    while (encoder.encode(cut).length > maxBytes) cut = cut.slice(0, -1)
    body = `${cut}\n[truncated]`
  }
  return `<${tag} ${attributes.join(' ')}>\n${body}\n</${tag}>`
}
