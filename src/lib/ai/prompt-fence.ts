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
