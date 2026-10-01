/**
 * RouteProgress — the three timings that make it useful rather than annoying.
 *
 * These are the parts that cannot be checked by clicking around, because the
 * whole point of two of them is that nothing appears on screen. A bar that
 * flashes on every fast click is worse than no bar at all, and a bar left
 * creeping forever after a dead navigation is worse still.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'

let pathname = '/dashboard'
let search = ''

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(search),
}))

import { RouteProgress } from '@/components/dashboard/RouteProgress'

/** Click a real in-document anchor, the way the capture listener expects. */
function clickInternalLink(href: string) {
  const a = document.createElement('a')
  a.setAttribute('href', href)
  /* Swallow the default on the anchor itself. The component listens in the
     CAPTURE phase, so it has already seen an unprevented event by the time
     this target-phase listener runs — this only stops jsdom from trying to
     actually follow the link and logging "navigation to another Document". */
  a.addEventListener('click', (e) => e.preventDefault())
  document.body.appendChild(a)
  act(() => {
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  a.remove()
}

describe('RouteProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    pathname = '/dashboard'
    search = ''
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows nothing at all when the navigation beats the 100ms delay', () => {
    const { container, rerender } = render(<RouteProgress />)

    clickInternalLink('/professor/courses')
    act(() => {
      vi.advanceTimersByTime(60) // still inside the delay
    })
    expect(container.firstChild).toBeNull()

    // Route commits at 60ms — the common prefetched case.
    pathname = '/professor/courses'
    act(() => {
      rerender(<RouteProgress />)
    })

    // Let well past the delay elapse; the bar must never have been armed.
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(container.firstChild).toBeNull()
  })

  it('appears once a navigation is slower than the delay', () => {
    const { container } = render(<RouteProgress />)

    clickInternalLink('/professor/courses/abc/grades')
    act(() => {
      vi.advanceTimersByTime(150)
    })

    expect(container.firstChild).not.toBeNull()
  })

  it('gives up on a navigation that never commits, instead of creeping forever', () => {
    const { container } = render(<RouteProgress />)

    clickInternalLink('/professor/courses/abc/grades')
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(container.firstChild).not.toBeNull()

    // Route never changes. The ceiling has to clear it on its own.
    act(() => {
      vi.advanceTimersByTime(8000 + 320 + 180 + 50)
    })
    expect(container.firstChild).toBeNull()
  })

  it('holds the bar for the floor once it has appeared, then clears it', () => {
    // The most common successful navigation, and the one the other tests miss:
    // the bar IS on screen when the route commits. It must not vanish the
    // instant it arrives, or a 350ms navigation reads as a blink.
    const { container, rerender } = render(<RouteProgress />)

    clickInternalLink('/professor/courses/abc/grades')
    act(() => {
      vi.advanceTimersByTime(150) // past the delay, so it is visible
    })
    expect(container.firstChild).not.toBeNull()

    pathname = '/professor/courses/abc/grades'
    act(() => {
      rerender(<RouteProgress />)
      vi.advanceTimersByTime(20) // flush the rAF that runs the teardown
    })
    // Committed, but still held: 150ms of the 320ms floor has elapsed.
    expect(container.firstChild).not.toBeNull()

    act(() => {
      vi.advanceTimersByTime(320 + 180)
    })
    expect(container.firstChild).toBeNull()
  })

  it('keeps one bar running when a second navigation interrupts the first', () => {
    // Clicking again mid-navigation used to strand the bar: the phase never
    // transitioned, so it stayed at scaleX(0) and no timer was left to clear it.
    const { container, rerender } = render(<RouteProgress />)

    clickInternalLink('/professor/courses')
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(container.firstChild).not.toBeNull()

    clickInternalLink('/professor/calendar') // interrupt
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(container.firstChild).not.toBeNull() // still shown, not reset

    pathname = '/professor/calendar'
    act(() => {
      rerender(<RouteProgress />)
      vi.advanceTimersByTime(20)
    })
    act(() => {
      vi.advanceTimersByTime(320 + 180)
    })
    expect(container.firstChild).toBeNull() // and it does finish
  })

  it('ignores a link to the page you are already on', () => {
    const { container } = render(<RouteProgress />)

    // jsdom's location is "/", so this is a same-page link.
    clickInternalLink('/')
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(container.firstChild).toBeNull()
  })

  it('ignores modified clicks, which open a tab rather than navigating', () => {
    const { container } = render(<RouteProgress />)

    const a = document.createElement('a')
    a.setAttribute('href', '/professor/courses')
    document.body.appendChild(a)
    act(() => {
      a.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }),
      )
    })
    a.remove()

    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(container.firstChild).toBeNull()
  })
})
