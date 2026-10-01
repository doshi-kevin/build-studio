// The office-deck branch of MaterialBody, which now renders a PPTX as ONE scrolling
// PDF (/api/extraction/pdf) instead of the slide-by-slide PNG pager it replaced.
//
// The HEAD probe is the only reason a failure stays honest: an iframe's `onLoad` fires
// even when the response is a 415 with a text body, so WITHOUT the probe a deck whose
// converter is down renders the route's raw error prose inside our chrome and reports
// itself as loaded. That is invisible to a typecheck and invisible to a happy-path e2e
// run (the converter is usually up), which is exactly why it is pinned here.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MaterialBody } from '@/components/ui/material-viewer'

const ITEM = 'item-1'

const mockFetch = vi.fn()

const deckProps = {
  url: 'https://storage.test/signed/week3.pptx',
  fileName: 'week3.pptx',
  mimeCategory: 'document' as const,
  itemId: ITEM,
  pageCount: 12,
}

const frame = () => document.querySelector('iframe')

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  mockFetch.mockReset()
  vi.unstubAllGlobals()
})

describe('MaterialBody — office deck', () => {
  it('probes /api/extraction/pdf with HEAD and frames that same URL', async () => {
    mockFetch.mockResolvedValue({ ok: true })
    render(<MaterialBody {...deckProps} />)

    await waitFor(() => expect(frame()).toBeTruthy())
    const src = frame()!.getAttribute('src')!
    // The deck must go to the whole-document route, not the per-page PNG route the
    // pager used — /api/extraction/page without a `page` param is a 400.
    expect(src.startsWith(`/api/extraction/pdf?item=${ITEM}`)).toBe(true)

    const [probedUrl, init] = mockFetch.mock.calls[0]
    expect(init).toMatchObject({ method: 'HEAD' })
    // Same URL both times, so the frame's GET is served from the route's own
    // `private, max-age=300` response rather than converting twice.
    expect(probedUrl).toBe(src)
  })

  it('renders a plain dead end instead of a frame when the probe fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 415 })
    render(<MaterialBody {...deckProps} />)

    expect(await screen.findByText(/can't be previewed right now/i)).toBeTruthy()
    // The load-bearing half: no iframe at all, so the 415 body can never paint.
    expect(frame()).toBeNull()
  })

  it('renders the dead end when the probe itself rejects', async () => {
    mockFetch.mockRejectedValue(new Error('offline'))
    render(<MaterialBody {...deckProps} />)

    expect(await screen.findByText(/can't be previewed right now/i)).toBeTruthy()
    expect(frame()).toBeNull()
  })

  it('shows a preparing state, naming the file, while the probe is in flight', async () => {
    let release: (v: { ok: boolean }) => void = () => {}
    mockFetch.mockReturnValue(new Promise((res) => { release = res }))
    render(<MaterialBody {...deckProps} />)

    // Neither a frame nor a dead end yet — a cold conversion can take seconds and a
    // blank pane reads as "this item has no file".
    expect(screen.getByText(/preparing week3\.pptx/i)).toBeTruthy()
    expect(frame()).toBeNull()

    release({ ok: true })
    await waitFor(() => expect(frame()).toBeTruthy())
  })

  it('carries a rail page jump into the frame as a #page hash', async () => {
    mockFetch.mockResolvedValue({ ok: true })
    render(<MaterialBody {...deckProps} targetPage={7} />)

    await waitFor(() => expect(frame()).toBeTruthy())
    expect(frame()!.getAttribute('src')).toContain('#page=7')
  })

  it('moves the deck on a later rail jump without re-probing', async () => {
    // Remounting the DECK on a jump (keying it on the page) re-runs the availability
    // probe and blanks the whole pane back to a spinner every time — where a PDF just
    // moves. Only the inner frame may remount.
    //
    // NOT covered here, and not coverable: a real browser ignores a hash-only src
    // change on an already-loaded iframe, which is why PdfFrame keys on the page.
    // jsdom updates the src attribute either way and has no PDF viewer to navigate,
    // so removing that key passes this file — that half lives in the visual
    // walkthrough (e2e/visual/), not in vitest.
    mockFetch.mockResolvedValue({ ok: true })
    const { rerender } = render(<MaterialBody {...deckProps} targetPage={3} />)
    await waitFor(() => expect(frame()!.getAttribute('src')).toContain('#page=3'))

    rerender(<MaterialBody {...deckProps} targetPage={9} />)
    await waitFor(() => expect(frame()!.getAttribute('src')).toContain('#page=9'))
    expect(screen.queryByText(/preparing/i)).toBeNull()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('drops the embedded PDF toolbar in chromeless mode', async () => {
    mockFetch.mockResolvedValue({ ok: true })
    render(<MaterialBody {...deckProps} chromeless />)

    await waitFor(() => expect(frame()).toBeTruthy())
    expect(frame()!.getAttribute('src')).toContain('toolbar=0')
  })

  it('never probes for a real PDF — it frames the signed URL directly', async () => {
    render(<MaterialBody url="https://storage.test/signed/lecture.pdf" fileName="lecture.pdf" mimeCategory="pdf" />)

    await waitFor(() => expect(frame()).toBeTruthy())
    expect(frame()!.getAttribute('src')).toContain('https://storage.test/signed/lecture.pdf')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  // A deck whose extraction hasn't produced a page count must still preview.
  //
  // slideMode used to require `pageCount > 0`, left over from the slide-by-slide PNG
  // pager that needed the count up front. DocumentDeck does not take pageCount at all,
  // so the gate guarded nothing and only mis-fired: the deck fell through to the
  // "cannot be previewed in the browser" panel while /api/extraction/pdf returned a
  // perfectly good PDF for that same item. Availability is the probe's call, not the
  // gate's — these two pin that, because a stray `&& pageCount` restores the bug
  // silently and every other test in this file passes pageCount: 12.
  const noCountProps = { ...deckProps, pageCount: undefined }

  it('frames a deck that has no pageCount yet', async () => {
    mockFetch.mockResolvedValue({ ok: true })
    render(<MaterialBody {...noCountProps} />)

    await waitFor(() => expect(frame()).toBeTruthy())
    expect(frame()!.getAttribute('src')!.startsWith(`/api/extraction/pdf?item=${ITEM}`)).toBe(true)
    expect(screen.queryByText(/cannot be previewed in the browser/i)).toBeNull()
  })

  it('still defers to the probe when a deck has no pageCount and is unavailable', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 415 })
    render(<MaterialBody {...noCountProps} />)

    // The probe's honest dead end, NOT the "cannot be previewed" panel — the two read
    // the same to a skim and mean different things: one is "not right now", the other
    // is "this file type never can".
    expect(await screen.findByText(/can't be previewed right now/i)).toBeTruthy()
    expect(screen.queryByText(/cannot be previewed in the browser/i)).toBeNull()
    expect(frame()).toBeNull()
  })
})
