/**
 * #768: at 390px the class-lens cluster was wider than the canvas, so a control was clipped and
 * genuinely unclickable.
 *
 * Measured on production before the fix: frame 286px, cluster 325px, pill 246.7px, overhang 50.7px,
 * and **51 dead pixels** on the pill's left edge where `elementFromPoint` returned an unrelated
 * element. Every real student initial sat inside that dead strip; only the "+N" badge was clickable,
 * which inverts what the control is for.
 *
 * Three candidate fixes were ruled out BY MEASUREMENT, and this file pins the reasoning so they are
 * not retried:
 *   - the facepile is already capped at 3 + badge, max 67px, only 20.6% of the cluster
 *   - a scrollable ribbon exposed 16px of scroll and its wheel gesture also panned the canvas
 *   - collapsing to an icon deletes the facepile, which is the thing being clipped
 *
 * The culprit was `.who` ("viewing whole class") at 120.7px with `white-space: nowrap`, 49% of the
 * pill, and redundant in exactly the mode where it overflows because the facepile already says it.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CSS = readFileSync(
  join(process.cwd(), 'src/app/(dashboard)/professor/courses/[sectionId]/roadmap/roadmap-prototype.css'),
  'utf8',
)
const LENS = readFileSync(
  join(process.cwd(), 'src/app/(dashboard)/professor/courses/[sectionId]/roadmap/roadmap-class-lens.tsx'),
  'utf8',
)

/** Everything inside `@media (max-width:760px)` blocks, comments stripped. */
function narrowRules(): string {
  const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...noComments.matchAll(/@media \(max-width:760px\)\s*\{([\s\S]*?)\n\}/g)]
    .map((m) => m[1])
    .join('\n')
}

describe('#768: the whole-class label is dropped at phone width', () => {
  it('hides .who only when a facepile precedes it', () => {
    /* The sibling selector is what separates the two modes without touching the component. Hiding
       `.who` outright would strip the student's NAME in lens-on mode, which is the one piece of
       information that pill exists to show. */
    expect(narrowRules()).toMatch(/\.facepile\s*~\s*\.who\s*\{\s*display:\s*none/)
  })

  it('does not hide .who unconditionally', () => {
    const rules = narrowRules()
    expect(rules).not.toMatch(/\.lensdock\s+\.who\s*\{\s*display:\s*none/)
    expect(rules).not.toMatch(/\.lpill\s+\.who\s*\{\s*display:\s*none/)
  })

  it('relies on the two pill modes still being distinguishable by markup', () => {
    /* If the component ever renders a facepile in BOTH modes, or drops it, the selector above
       silently stops targeting the right one. This is the assumption behind the whole fix. */
    expect(LENS).toContain('className="facepile"')
    expect(LENS).toContain('className="jav"')
  })
})

describe('#768: the lens menu fits inside the frame', () => {
  it('is capped and right-anchored at phone width', () => {
    /* A fixed 290px menu cannot fit a 286px frame at any position, so repositioning alone was never
       enough: it clipped 72.3px off its own left edge and ate the first characters of every name. */
    const rules = narrowRules()
    expect(rules).toMatch(/\.lensmenu\s*\{[^}]*max-width:\s*262px/)
    expect(rules).toMatch(/\.lensmenu\s*\{[^}]*right:\s*0/)
    expect(rules).toMatch(/\.lensmenu\s*\{[^}]*transform:\s*none/)
  })

  it('leaves the desktop menu alone', () => {
    /* 987px of slack at 1440, and zero dead pixels, so the base rule must keep its centred 290px. */
    const base = CSS.replace(/@media[^{]*\{[\s\S]*?\n\}/g, '')
    expect(base).toMatch(/\.lensmenu\s*\{[\s\S]*?width:290px/)
    expect(base).toMatch(/\.lensmenu\s*\{[\s\S]*?transform:translateX\(-50%\)/)
  })
})

/* ── The second round of #768: two mechanisms found by hit-testing, not by looking ──
 *
 * The pill fitting inside the frame was necessary and not sufficient. Both of these were
 * invisible to every width/overflow check, because nothing overflowed — a control was
 * simply covered. Both were measured with `elementFromPoint` on a real 7-student section.
 *
 * They are pinned HERE, against the CSS source, because the browser measurement cannot
 * run in CI: a plausible "tidy-up" of either rule silently restores a dead control.
 */
describe('#768: the toolbar no longer covers the open lens menu', () => {
  it('gives the right cluster a higher z-index than the left one', () => {
    /* Both clusters sat at z-index 20 and the LEFT one comes later in the DOM, so it painted
       on top. The menu opens inside the right cluster, so its own z-index:2 is scoped to that
       cluster's layer and could never lift it above a sibling — raising the menu was not an
       option, only raising its cluster.
       Measured at 390px: 60 of the 63px of the "Whole class" row were not hit-testable, and
       that row is the control that CLEARS the filter. After: zero. */
    const base = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = base.match(/\.rmproto \.ctools\.ctools-r\s*\{([^}]*)\}/)
    expect(rule).not.toBeNull()
    expect(rule![1]).toMatch(/z-index:\s*21/)

    // …and the left cluster must stay below it, or the fix inverts.
    const left = base.match(/\.rmproto \.ctools\s*\{([^}]*)\}/)
    expect(left).not.toBeNull()
    expect(left![1]).toMatch(/z-index:\s*20/)
  })

  it('stays below the overlays that are supposed to cover the toolbar', () => {
    /* 21 must remain under the dossier card, the scrim and the analytics panel.
       These are all inside `.rmproto`, which now forms a stacking context (`isolation:isolate`),
       so this scale is LOCAL to the canvas — which makes the relative order asserted here the
       only thing that orders these layers. App-level overlays sit above the whole canvas and are
       not part of this comparison; see roadmap-canvas-stacking-context.test.ts. */
    const base = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const sel of ['.sdcard', '.ascrim', '.analytics']) {
      const m = base.match(new RegExp(`\\.rmproto \\${sel}\\s*\\{([^}]*)\\}`))
      expect(m, `${sel} rule not found`).not.toBeNull()
      const z = Number(/z-index:\s*(\d+)/.exec(m![1])?.[1])
      expect(z).toBeGreaterThan(21)
    }
  })
})

describe('#768: the action button cannot cover the last student', () => {
  it('scrolls the roster, not the whole menu', () => {
    /* The footer was `position:sticky` INSIDE the scroll box. A sticky element floats over
       whatever is beneath it until it reaches its natural place at the very end, so every
       scroll offset short of the bottom put "Open class analytics" on top of the last row.
       Measured at 390px: 45 of that row's 48px were dead, and a click aimed at the student
       NAVIGATED to analytics — a mis-target that takes you to another page.
       The overflow now lives on .lbody, so the footer is outside the scroll box. */
    const base = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

    const menu = base.match(/\.rmproto \.lensmenu\s*\{([^}]*)\}/)
    expect(menu).not.toBeNull()
    expect(menu![1]).toMatch(/overflow:\s*hidden/)
    expect(menu![1]).toMatch(/display:\s*flex/)
    // The menu itself must NOT be the scroller any more.
    expect(menu![1]).not.toMatch(/overflow:\s*auto/)

    const body = base.match(/\.rmproto \.lensmenu \.lbody\s*\{([^}]*)\}/)
    expect(body, '.lbody scroll box is missing').not.toBeNull()
    expect(body![1]).toMatch(/overflow-y:\s*auto/)
    expect(body![1]).toMatch(/min-height:\s*0/)
  })

  it('no longer positions the footer sticky', () => {
    const base = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const foot = base.match(/\.rmproto \.lensmenu \.lfoot\s*\{([^}]*)\}/)
    expect(foot).not.toBeNull()
    expect(foot![1]).not.toMatch(/position:\s*sticky/)
  })

  it('the component actually renders the scroll box around the rows', () => {
    /* The CSS is inert without it, and this is the half a JSX refactor would drop. The rows
       and the empty state must be INSIDE .lbody; the footer must be outside it. */
    expect(LENS).toContain('className="lbody"')
    const bodyStart = LENS.indexOf('className="lbody"')
    const footStart = LENS.indexOf('className="lfoot"')
    expect(bodyStart).toBeGreaterThan(-1)
    expect(footStart).toBeGreaterThan(bodyStart)
    // the closing </div> of .lbody sits between the last row and the footer
    const between = LENS.slice(bodyStart, footStart)
    expect(between).toContain('className="lempty"')
    expect(between).toContain('</div>')
  })
})

/* The third mechanism on #768, fixed after the first two.
 *
 * In LENS-ON mode at 390px the whole-class "Refresh class" pebble (.sdrb, z-index 59) sat on
 * the same row as the lens cluster (z-index 21) and covered 102px of the pill — measured with
 * elementFromPoint on a 7-student section. The pill is the primary control on this surface.
 *
 * There was nowhere to move it: .sdcard starts at y64 and is 629px tall, so the rows are full.
 * Lowering .sdrb below the pill only swaps which control is dead.
 */
describe('#768: the whole-class refresh pebble is desktop-only', () => {
  it('is hidden at phone width', () => {
    expect(narrowRules()).toMatch(/\.sdrb\s*\{\s*display:\s*none/)
  })

  it('still renders on desktop, where there is room', () => {
    /* 987px of slack at 1440 and zero dead pixels there, so the base rule must keep it. */
    const base = CSS.replace(/@media[^{]*\{[\s\S]*?\n\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(base).toMatch(/\.rmproto \.sdrb\s*\{[\s\S]*?position:absolute/)
    expect(base).not.toMatch(/\.rmproto \.sdrb\s*\{[^}]*display:\s*none/)
  })

  it('is NOT relocated into the one-student dossier card', () => {
    /* Its own comment says it must stay detached because it rewrites EVERY student. A global
       action inside a one-student card reads as applying to that student, and the cost of that
       misread is a 24h cooldown lockout. The button must stay a sibling of .sdcard, not a child. */
    const sdrbAt = LENS.indexOf('className={`sdrb')
    const cardAt = LENS.indexOf('className="sdcard"')
    expect(sdrbAt).toBeGreaterThan(-1)
    expect(cardAt).toBeGreaterThan(-1)
    expect(sdrbAt).toBeLessThan(cardAt)
  })
})
