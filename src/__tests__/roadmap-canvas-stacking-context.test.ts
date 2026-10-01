/**
 * The roadmap canvas declares its own z-index scale, and that scale runs far above the app's
 * overlay layer: .ascrim 60, .analytics (the tracked-skills drawer) 61, .dhaze 93, .dcard 95, and
 * .react-flow__node:hover 1000 — against z-50 on every Radix overlay in ui/dialog.tsx + ui/sheet.tsx.
 *
 * `.rmproto` is `position:relative` with `z-index:auto`, which forms NO stacking context, so those
 * numbers competed directly in the ROOT stacking context against the overlay layer. A dialog opened
 * from inside the canvas therefore painted UNDER the canvas chrome that opened it: the concept
 * detail panel reached from a skill's coverage badges sat 66% under the tracked-skills drawer at
 * 1440px, 76% at 390px.
 *
 * Pinned against the CSS source because jsdom does no layout and computes no stacking order, so no
 * unit test can observe the occlusion itself, and there is no roadmap e2e spec to catch it either.
 * What IS checkable is the relationship that makes the fix load-bearing.
 *
 * The invariant below is deliberately an OR, not a check for the one line that currently satisfies
 * it: scoping the scale and renumbering the scale under the overlay layer are both valid fixes, and
 * both keep this green. That is why it is not a restatement of the implementation. It goes red only
 * for the actual broken state — unscoped layers that outrank app overlays.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROADMAP_CSS = 'src/app/(dashboard)/professor/courses/[sectionId]/roadmap/roadmap-prototype.css'
const OVERLAY_SOURCES = ['src/components/ui/dialog.tsx', 'src/components/ui/sheet.tsx']

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const CSS = read(ROADMAP_CSS).replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * Every `.rmproto` BASE rule, unioned — not its descendant rules (`.rmproto .foo`). The stylesheet
 * splits the element's declarations across five blocks (layout at the top, custom-property blocks
 * further down), and all five cascade onto the same element, so the stacking context is formed if
 * ANY of them forms it. Anchored to the line start so `.rmproto .child` never matches.
 */
function baseRule(): string {
  const blocks = [...CSS.matchAll(/^\.rmproto\s*\{([^{}]*)\}/gm)].map((m) => m[1])
  expect(blocks.length, '.rmproto base rule not found — did the canvas class get renamed?')
    .toBeGreaterThan(0)
  return blocks.join('\n')
}

/** The app's overlay layer, read from the Radix primitives rather than hardcoded. */
function appOverlayLayer(): number {
  const zs = OVERLAY_SOURCES.flatMap((p) => [...read(p).matchAll(/\bz-(\d+)\b/g)].map((m) => Number(m[1])))
  expect(zs.length, `no z-N utility found in ${OVERLAY_SOURCES.join(', ')}`).toBeGreaterThan(0)
  return Math.max(...zs)
}

describe('the roadmap canvas cannot paint over app dialogs', () => {
  it('either scopes its z-index scale or keeps it below the app overlay layer', () => {
    const rule = baseRule()
    /* Either mechanism forms a stacking context on a positioned element. The current choice is
       `isolation` so the canvas keeps z-index:auto and its paint order against its siblings; this
       asserts the OUTCOME, so that choice stays free to change. */
    const scoped = /isolation:\s*isolate/.test(rule) || /z-index:\s*-?\d+/.test(rule)

    const overlay = appOverlayLayer()
    const layers = [...CSS.matchAll(/z-index:\s*(-?\d+)/g)].map((m) => Number(m[1]))
    const outranking = [...new Set(layers.filter((z) => z > overlay))].sort((a, b) => a - b)

    expect(
      scoped || outranking.length === 0,
      `.rmproto forms no stacking context, yet declares ${outranking.length} layer(s) above the ` +
        `app overlay layer (z-${overlay}): ${outranking.join(', ')}. Dialogs opened from inside ` +
        `the canvas will paint behind the canvas chrome that opened them.`,
    ).toBe(true)
  })

  it('stays positioned, or the absolute layers inside it detach from the canvas', () => {
    /* `isolation:isolate` scopes the scale on its own, but the canvas ALSO has to remain the
       containing block for the many `position:absolute` layers inside it. */
    expect(baseRule()).toMatch(/position:\s*relative/)
  })
})
