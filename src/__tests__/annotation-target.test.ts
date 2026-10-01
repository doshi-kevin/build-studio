// How an annotation finds its card. This resolver decides where every note, flag
// and ring on the roadmap is drawn AND which module band the triage engine thinks
// it belongs to — it used to be two copies of these rules, one per caller, free to
// disagree. The cases below are the ones that were actually wrong.

import { describe, it, expect } from 'vitest'
import { parseTarget, resolveTarget, type TargetGroup } from '@/lib/roadmap/annotation-target'

interface Row {
  group: TargetGroup
  title: string
  key?: string
}
const get = {
  group: (e: Row) => e.group,
  title: (e: Row) => e.title,
  key: (e: Row) => e.key,
}
const res = (title: string, key?: string): Row => ({ group: 'res', title, key })
const sess = (title: string): Row => ({ group: 'sess', title })
const mod = (title: string): Row => ({ group: 'mod', title })

describe('resolveTarget — by title', () => {
  it('prefers an exact title over a longer one that merely contains it', () => {
    /* THE bug. A course with both papers resolved "Attention" to "Attention Is All
       You Need", because the shorter title is a substring of the longer and the
       longer card came first. Every generated signal carries the card's full title,
       so exact-first sends each to its own card. */
    const rows = [res('Attention Is All You Need'), res('Attention')]

    expect(resolveTarget(rows, 'Attention', get)).toBe(rows[1])
    expect(resolveTarget(rows, 'Attention Is All You Need', get)).toBe(rows[0])
  })

  it('still matches a fragment, for notes a professor wrote by hand', () => {
    // Hand-authored annotations deliberately write part of a title; dropping
    // substring matching to fix the above would have silently unhooked them all.
    const rows = [res('Lecture 3: Attention')]
    expect(resolveTarget(rows, 'Lecture 3', get)).toBe(rows[0])
  })

  it('finds nothing rather than guessing when no title matches', () => {
    expect(resolveTarget([res('Backprop')], 'Transformers', get)).toBeUndefined()
  })
})

describe('resolveTarget — group precedence', () => {
  it('answers with the resource, not the session that shares its title', () => {
    // Sessions routinely carry their lecture doc's exact title.
    const rows = [sess('Lecture 1'), res('Lecture 1')]
    expect(resolveTarget(rows, 'Lecture 1', get)).toBe(rows[1])
  })

  it("`session:` reaches past the resource to the session's own tile", () => {
    const rows = [res('Lecture 1'), sess('Lecture 1')]
    expect(resolveTarget(rows, 'session:Lecture 1', get)).toBe(rows[1])
  })

  it('`module:` keeps a class-aggregate note off a card named after the module', () => {
    // "3 of 12 stuck here" belongs on the band, never on a reading whose title
    // happens to contain the module name.
    const rows = [res('Week 2 recap'), mod('Week 2')]
    expect(resolveTarget(rows, 'module:Week 2', get)).toBe(rows[1])
  })
})

describe('resolveTarget — by item id', () => {
  const rows = [res('Attention', 'module_item:aaa'), res('Attention', 'module_item:bbb')]

  it('separates two cards that share a title, which no title target can', () => {
    expect(resolveTarget(rows, 'item:bbb', get)).toBe(rows[1])
    expect(resolveTarget(rows, 'item:aaa', get)).toBe(rows[0])
  })

  it('never falls back to a title when the id is absent — a wrong card is worse', () => {
    expect(resolveTarget(rows, 'item:missing', get)).toBeUndefined()
  })

  it('splits the key on its FIRST colon, as the node-key convention does', () => {
    const odd = [res('X', 'module_item:id:with:colons')]
    expect(resolveTarget(odd, 'item:id:with:colons', get)).toBe(odd[0])
  })

  it('matches nothing when the caller exposes no keys at all', () => {
    // The triage locator passes keys; a caller that doesn't must not silently
    // match by something else.
    expect(resolveTarget([res('Attention')], 'item:aaa', { group: get.group, title: get.title }))
      .toBeUndefined()
  })
})

describe('parseTarget', () => {
  it('reads each prefix, and treats a bare string as a title', () => {
    expect(parseTarget('item:abc')).toMatchObject({ itemId: 'abc', order: ['res'] })
    expect(parseTarget('session:Lab')).toMatchObject({ query: 'Lab', order: ['sess'] })
    expect(parseTarget('module:Week 1')).toMatchObject({ query: 'Week 1', order: ['mod'] })
    expect(parseTarget('Week 1')).toMatchObject({ query: 'Week 1', order: ['res', 'sess', 'mod'] })
  })
})
