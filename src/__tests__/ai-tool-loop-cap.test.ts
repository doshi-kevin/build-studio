/**
 * Runaway-tool-loop tripwire (pattern: ai-call-site-coverage.test.ts).
 *
 * The invariant: any model call that is given tools MUST also be given a hard step cap.
 * Without one the model decides when to stop, and #651 is what that looks like in
 * practice — the in-builder dock spent an entire exchange calling context tools, up to 109
 * tool chips, never reached `apply_edits`, returned no text at all, and billed every one
 * of those calls against the professor's daily quota. Reproduced 7/7 and confirmed
 * model-independent, so it was the tool set and the prompt, not the provider.
 *
 * This scans for the pairing rather than trusting a review to notice it, because the
 * failure is invisible from the outside: the stream closes normally and the transcript
 * just looks empty.
 *
 * A call with NO tools cannot loop — one request, one response — so those are ignored.
 *
 * If this fails on a new file: add `stopWhen: stepCountIs(N)` (AI SDK v5) or `maxSteps: N`
 * beside the `tools:` option. Do not allowlist your way past it. And a cap alone is not
 * the whole job — see the sibling assertion below about telling the user when it trips.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const SRC = join(__dirname, '..')

/** Model calls that can run a tool loop. */
const LOOPING_CALLS = /\b(streamText|generateText)\s*\(/
/** Either the AI SDK v5 form or the older maxSteps form counts as a cap. */
const HAS_CAP = /stopWhen\s*:|stepCountIs\s*\(|maxSteps\s*:/
/**
 * A tools option being passed to the call, in either form.
 *
 * The shorthand matters: both Athena routes write `tools,` not `tools: tools`, so a
 * pattern requiring the colon reported them as tool-free and the cap assertion passed
 * over the exact two files it exists to police. Caught by the sibling assertion below,
 * which is why that one is here.
 */
const PASSES_TOOLS = /(^|[\s,{])tools\s*[,:}\n]/m

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

describe('AI tool loops must be capped (#651)', () => {
  it('every model call that passes tools also passes a step cap', () => {
    const offenders: string[] = []

    for (const file of walk(SRC)) {
      const src = readFileSync(file, 'utf8')
      if (!LOOPING_CALLS.test(src)) continue
      if (!PASSES_TOOLS.test(src)) continue // no tools, no loop
      if (HAS_CAP.test(src)) continue
      offenders.push(relative(SRC, file))
    }

    expect(offenders).toEqual([])
  })

  it('the surfaces that run tool loops are the ones we think they are', () => {
    /* A guard on the guard. If a fifth Athena surface appears, this list is what makes
       someone decide deliberately whether it needs the stalled-turn notice too, rather
       than shipping another surface that dead-ends in silence. */
    const withLoops = walk(SRC)
      .filter((f) => {
        const src = readFileSync(f, 'utf8')
        return LOOPING_CALLS.test(src) && PASSES_TOOLS.test(src)
      })
      .map((f) => relative(SRC, f).replace(/\\/g, '/'))
      .sort()

    expect(withLoops).toEqual([
      'app/api/assignment-assistant/route.ts', // in-builder dock: assignments, quizzes, studios
      'app/api/professor-assistant/route.ts', // professor console
      'lib/ai/athena-core/turn.ts', // student tutor, via app/api/chat/route.ts
      // Studio builder: one step per call, no execute; the harness drives the loop with its
      // own turn budget and ends every run with a fixed-copy outcome, so it never stalls silently.
      'lib/studio/builder/model.ts',
    ])
  })
})
