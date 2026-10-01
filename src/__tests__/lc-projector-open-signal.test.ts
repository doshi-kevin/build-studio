/**
 * #647 — guards a spec incompatibility that a browser pass caught in my first
 * attempt at this fix, and that no amount of reading the code would reveal.
 *
 * `window.open()` returns null WHENEVER `noopener` is in the feature string, whether
 * or not the window opened — the spec forbids retaining a reference. So the return
 * value cannot double as a "did it open?" signal. Using it as one made the success
 * branch unreachable and fired the "your browser blocked the projector window" toast
 * on every SUCCESSFUL launch: a false alarm, every professor, every class start —
 * strictly worse than the silent failure it replaced.
 *
 * Verified in a real browser:
 *   window.open('about:blank','_blank','popup,noopener')  -> null  (tab opens anyway)
 *   window.open('about:blank','_blank','popup')           -> WindowProxy
 *
 * This is a source-level assertion on purpose. The invariant is that two lines must
 * not coexist — a `noopener` feature and a truthiness check on the result — which is
 * a property of the call site, not of any value a unit test can observe. jsdom's
 * window.open is a stub and would happily return an object for either form, so a
 * behavioural test here would pass against the broken version.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const DASHBOARD = join(
  process.cwd(),
  'src/components/professor/live-classroom/ClassroomDashboard.tsx',
)

describe('#647 — the projector open-success signal must be usable', () => {
  const src = readFileSync(DASHBOARD, 'utf8')

  /* The projector's window.open CALL, matched via its assignment so that prose
     mentioning window.open() — including the explanatory comment at the call site —
     cannot satisfy or break these assertions. */
  const call = src.match(/const win = window\.open\(([^)]*)\)/)
  const features = call?.[1] ?? ''

  it('opens the projector with a window.open call whose result is captured', () => {
    expect(call).not.toBeNull()
  })

  it('does not pass noopener, which would force a null return', () => {
    expect(features).not.toContain('noopener')
  })

  it('still requests the standalone popup window shape', () => {
    expect(features).toContain('popup')
  })

  it('branches on the returned handle, so a real block is detected', () => {
    expect(src).toMatch(/const win = window\.open\(/)
    expect(src).toMatch(/if \(win\)/)
  })

  it('severs the back-reference by hand, preserving what noopener gave us', () => {
    expect(src).toMatch(/win\.opener = null/)
  })
})
