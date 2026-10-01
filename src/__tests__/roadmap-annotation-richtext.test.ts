// Tests for setRichText — the annotation layer's note renderer.
//
// Two reasons this is worth pinning down:
//  1. It is the ONLY place annotation copy becomes DOM. Triage text is
//     system-authored today but interpolates titles/skills already, so the
//     "markers become elements, everything else is a text node" rule is a
//     stored-XSS gate, not a formatting nicety.
//  2. `href` is caller-supplied and lands on an <a>. safeAppPath is the gate
//     that keeps a rendered note from becoming a navigation primitive
//     (javascript:, protocol-relative, off-site).
//
// The regex carries four capture groups across three markers; adding a marker
// renumbers them, and a mis-numbered group renders empty text with no error.

import { describe, it, expect, afterEach } from 'vitest'
import { setRichText, AN_TONE } from '@/app/(dashboard)/professor/courses/[sectionId]/roadmap/roadmap-annotations'

const render = (text: string, href?: string) => {
  const el = document.createElement('div')
  setRichText(el, text, href)
  return el
}

describe('setRichText — markers', () => {
  it('<b> bolds its segment and leaves the surrounding copy as text', () => {
    const el = render("you're <b>62%</b> through what's been taught")
    expect(el.querySelector('b')?.textContent).toBe('62%')
    expect(el.textContent).toBe("you're 62% through what's been taught")
  })

  it('<c:TONE> paints its segment in that tone, from the enum and never from the text', () => {
    // The mastery-trend note ("41% → 78%") is the only consumer; its two numbers
    // are coloured by band. A capture-group slip here renders empty numbers.
    const el = render('<c:alert>41%</c> → <c:ok>78%</c>')
    const [lo, hi] = [...el.querySelectorAll('b')]
    expect(lo.textContent).toBe('41%')
    expect(hi.textContent).toBe('78%')
    expect(lo.style.getPropertyValue('--t')).toBe(AN_TONE.alert)
    expect(hi.style.getPropertyValue('--t')).toBe(AN_TONE.ok)
    expect(el.textContent).toBe('41% → 78%')
  })

  it('an unknown tone is not a marker — it stays literal text, no element', () => {
    const el = render('<c:evil>x</c>')
    expect(el.querySelector('b')).toBeNull()
    expect(el.textContent).toBe('<c:evil>x</c>')
  })

  it('renders S19 end to end: bold skill + trailing link in one note', () => {
    const el = render(
      '<b>Word alignment</b> is your weakest here — <a>study it with the AI Tutor</a>',
      '/student/courses/s1/ai-tutor?topic=Word%20alignment',
    )
    expect(el.querySelector('b')?.textContent).toBe('Word alignment')
    const a = el.querySelector('a')!
    expect(a.getAttribute('href')).toBe('/student/courses/s1/ai-tutor?topic=Word%20alignment')
    expect(a.textContent).toContain('study it with the AI Tutor')
    // Order preserved: bold first, link last.
    expect(el.textContent!.indexOf('Word alignment')).toBeLessThan(el.textContent!.indexOf('study it'))
  })

  it('never emits raw markup — a note carrying HTML renders as characters', () => {
    const el = render('<img src=x onerror=alert(1)> and <script>alert(2)</script>')
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('script')).toBeNull()
    expect(el.textContent).toBe('<img src=x onerror=alert(1)> and <script>alert(2)</script>')
  })
})

describe('setRichText — the href gate', () => {
  it('accepts a same-origin app path and hardens the link', () => {
    const a = render('<a>go</a>', '/student/courses/s1/ai-tutor').querySelector('a')!
    expect(a.getAttribute('href')).toBe('/student/courses/s1/ai-tutor')
    expect(a.target).toBe('_blank')
    expect(a.rel).toBe('noopener noreferrer')
  })

  it.each([
    ['javascript:alert(1)', 'script URL'],
    ['JavaScript:alert(1)', 'script URL, mixed case'],
    ['//evil.com/x', 'protocol-relative — same-looking, different origin'],
    // The URL parser folds `\` into `/` for special schemes, so these resolve
    // off-origin just like `//evil.com` while *looking* like an app path. A
    // startsWith('/') && !startsWith('//') gate lets them straight through.
    ['/\\evil.com', 'backslash protocol-relative'],
    ['/\\/evil.com', 'backslash + slash protocol-relative'],
    ['https://evil.com', 'absolute off-site URL'],
    ['data:text/html,<script>alert(1)</script>', 'data URL'],
    ['mailto:x@y.z', 'non-http scheme'],
    ['student/courses/s1', 'relative path — resolves against whatever page renders it'],
    ['', 'empty'],
  ])('rejects %s (%s) — the words render, but not as a link', (href) => {
    const el = render('read <a>the tutor page</a> now', href)
    expect(el.querySelector('a')).toBeNull()
    expect(el.textContent).toBe('read the tutor page now')
  })

  it('drops the link when no href is supplied at all (AI Tutor feature off)', () => {
    const el = render('<a>study it with the AI Tutor</a>')
    expect(el.querySelector('a')).toBeNull()
    expect(el.textContent).toBe('study it with the AI Tutor')
  })

  it('a click on the link does not reach the canvas underneath', () => {
    // The canvas pans on pointer events; a link that bubbles would drag the map
    // out from under the click.
    const el = render('<a>go</a>', '/x')
    let bubbled = false
    el.addEventListener('click', () => { bubbled = true })
    el.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(bubbled).toBe(false)
  })
})

// S19's "study it with Athena" points at the roadmap the reader is ALREADY on —
// it only flips `?athena-topic=`, which AthenaShell consumes to open the dock. So
// it is a state change, and the two link affordances this renderer adds by
// default are both wrong for it: target="_blank" opened a second copy of the
// roadmap the student was looking at, and the ↗ promised exactly that.
//
// Nothing above reaches this branch. Every href in this file is cross-page only
// because jsdom's default pathname is `/`, so the existing `target === '_blank'`
// assertion passes either way — invert the samePage test and the suite stays
// green while the note goes back to duplicating the page.
describe('setRichText — a link back to the page already showing', () => {
  const ROADMAP = '/student/courses/s1/roadmap'
  const at = (url: string) => window.history.replaceState(null, '', url)

  // The other describes render at jsdom's default location; don't strand them here.
  afterEach(() => at('/'))

  it('renders it in place — no new tab, and no ↗ claiming one', () => {
    at(ROADMAP)
    const a = render(
      '<a>study it with Athena</a>',
      `${ROADMAP}?athena-topic=Word%20alignment`,
    ).querySelector('a')!

    expect(a.target).toBe('')
    expect(a.rel).toBe('')
    // The arrow is the "leaves this page" affordance, and screen readers speak
    // it — on a same-page link it is a lie in both channels.
    expect(a.textContent).toBe('study it with Athena')
  })

  it('clicking it flips the param instead of navigating, keeping the open card', () => {
    at(`${ROADMAP}?node=module_item:i-1`)
    const a = render('<a>study it with Athena</a>', `${ROADMAP}?athena-topic=Attention`).querySelector('a')!

    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    a.dispatchEvent(click)

    // Prevented → the browser never navigates and the page is never refetched.
    expect(click.defaultPrevented).toBe(true)
    const q = new URLSearchParams(window.location.search)
    expect(q.get('athena-topic')).toBe('Attention')
    // ?node= belongs to the open node card, which pops its own history entry when
    // the param vanishes — a write that replaced the query would undo itself.
    expect(q.get('node')).toBe('module_item:i-1')
  })

  it('still hardens and marks a link that genuinely leaves the page', () => {
    // Asserted from the SAME known location as the same-page case above:
    // otherwise "no _blank" there could equally mean the branch inverted.
    at(ROADMAP)
    const a = render('<a>go</a>', '/student/courses/s1/modules').querySelector('a')!

    expect(a.target).toBe('_blank')
    expect(a.rel).toBe('noopener noreferrer')
    expect(a.textContent).toBe('go ↗')
  })
})
