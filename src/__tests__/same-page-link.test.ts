// applySamePageLink decides whether a roadmap link is a NAVIGATION or a state
// change. Getting it wrong is visible either way: treat a same-page link as a
// navigation and the S19 canvas note opens a second copy of the roadmap the
// student is already reading (its renderer uses target="_blank"); treat a
// cross-page link as state and the link silently does nothing.
//
// The other half worth pinning is the MERGE. The roadmap keeps its open node
// card in `?node=`, and the card's history bookkeeping pops its own entry when
// the param disappears — so a write that replaced the query instead of merging
// it would trigger a history.back() that undoes the very param it just wrote.

import { describe, it, expect, beforeEach } from 'vitest'
import { applySamePageLink } from '@/lib/roadmap/same-page-link'

const ROADMAP = '/student/courses/sec-1/roadmap'

const at = (url: string) => window.history.replaceState(null, '', url)
const search = () => new URLSearchParams(window.location.search)

describe('applySamePageLink', () => {
  beforeEach(() => at(ROADMAP))

  it('handles a link back to this page in place, without navigating', () => {
    expect(applySamePageLink(`${ROADMAP}?athena-topic=Attention`)).toBe(true)
    expect(window.location.pathname).toBe(ROADMAP)
    expect(search().get('athena-topic')).toBe('Attention')
  })

  it('merges onto the query already showing rather than replacing it', () => {
    at(`${ROADMAP}?node=module_item:i-1`)

    expect(applySamePageLink(`${ROADMAP}?athena-topic=Word%20alignment`)).toBe(true)
    // Both survive: dropping ?node= would read as "the card closed" to the canvas,
    // which pops the history entry that card owns.
    expect(search().get('node')).toBe('module_item:i-1')
    expect(search().get('athena-topic')).toBe('Word alignment')
  })

  it('leaves a link to another page to the browser', () => {
    const before = window.location.href

    expect(applySamePageLink('/student/courses/sec-1/modules?athena-topic=Attention')).toBe(false)
    expect(window.location.href).toBe(before) // nothing written
  })

  it('refuses an off-origin href instead of writing it into this page', () => {
    const before = window.location.href

    expect(applySamePageLink('https://evil.example.com/student/courses/sec-1/roadmap')).toBe(false)
    expect(applySamePageLink('//evil.example.com/student/courses/sec-1/roadmap')).toBe(false)
    expect(window.location.href).toBe(before)
  })

  it('survives an unparseable href', () => {
    // A malformed href must not throw out of a click handler — the click just
    // falls through to the browser's own (harmless) handling.
    expect(applySamePageLink('http://[')).toBe(false)
  })

  it('replaces the current history entry rather than pushing a new one', () => {
    // Every other assertion here passes just as happily under pushState, but a
    // pushed entry is a Back press that visibly does nothing — AthenaShell strips
    // `?athena-topic=` the moment it reads it, so Back returns to a URL identical
    // to the one showing. It also hands the open node card a history entry the
    // card does not own, which its own bookkeeping then tries to pop.
    at(`${ROADMAP}?node=module_item:i-1`)
    const depth = window.history.length

    expect(applySamePageLink(`${ROADMAP}?athena-topic=Attention`)).toBe(true)

    expect(window.history.length).toBe(depth)
  })

  it('overwrites a param it already set, so a second skill wins', () => {
    at(`${ROADMAP}?athena-topic=Attention`)

    expect(applySamePageLink(`${ROADMAP}?athena-topic=Tokenization`)).toBe(true)
    expect(search().getAll('athena-topic')).toEqual(['Tokenization'])
  })
})
