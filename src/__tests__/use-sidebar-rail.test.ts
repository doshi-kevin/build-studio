// Logic tests for the sidebar open-behavior preference (issue #394). The hook
// owns the mode-gated rail behavior and the same-tab cross-instance sync that
// keeps the header Preferences dialog and the course rail in agreement — both
// have real branches a refactor could silently break, so they're worth pinning.
//
// 'click' is the DEFAULT (pilot feedback: a rail that pops in and out under the
// pointer reads as jitter). 'hover' is therefore the value that must be stored
// explicitly, which is why the persistence tests below write 'hover' — writing
// the default would pass whether or not persistence works at all.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useSidebarOpenMode, useSidebarRail } from '@/lib/hooks/use-sidebar-rail'

const KEY = 'scholera_sidebar_open_mode'
const EXPANDED = 'scholera_sidebar_expanded'

beforeEach(() => {
  localStorage.clear()
})

describe('useSidebarOpenMode — persistence + fallback', () => {
  it('defaults to click when nothing is stored', () => {
    const { result } = renderHook(() => useSidebarOpenMode())
    expect(result.current[0]).toBe('click')
  })

  it('reads a stored "hover" preference after mount', () => {
    localStorage.setItem(KEY, 'hover')
    const { result } = renderHook(() => useSidebarOpenMode())
    expect(result.current[0]).toBe('hover')
  })

  it('falls back to click for a garbage/unknown stored value', () => {
    localStorage.setItem(KEY, 'nonsense')
    const { result } = renderHook(() => useSidebarOpenMode())
    expect(result.current[0]).toBe('click')
  })

  it('setMode persists to localStorage and updates the returned mode', () => {
    const { result } = renderHook(() => useSidebarOpenMode())
    act(() => result.current[1]('hover'))
    expect(result.current[0]).toBe('hover')
    expect(localStorage.getItem(KEY)).toBe('hover')
  })

  it('syncs across two mounted instances in the same tab (custom event)', () => {
    const a = renderHook(() => useSidebarOpenMode())
    const b = renderHook(() => useSidebarOpenMode())
    act(() => a.result.current[1]('hover'))
    expect(a.result.current[0]).toBe('hover')
    expect(b.result.current[0]).toBe('hover') // b must hear a's change
  })
})

describe('useSidebarRail — mode gating', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hover mode: expand() opens and scheduleCollapse() closes after 500ms', () => {
    localStorage.setItem(KEY, 'hover')
    vi.useFakeTimers()
    const { result } = renderHook(() => useSidebarRail())
    expect(result.current.collapsed).toBe(true)

    act(() => result.current.expand())
    expect(result.current.expanded).toBe(true)

    act(() => result.current.scheduleCollapse())
    act(() => { vi.advanceTimersByTime(500) })
    expect(result.current.collapsed).toBe(true)
  })

  it('click mode (the default): expand() and scheduleCollapse() are no-ops; toggle() flips it', () => {
    const { result } = renderHook(() => useSidebarRail())

    act(() => result.current.expand())
    expect(result.current.expanded).toBe(false) // hover-driven open ignored

    act(() => result.current.toggle())
    expect(result.current.expanded).toBe(true) // explicit toggle works

    act(() => result.current.scheduleCollapse())
    expect(result.current.expanded).toBe(true) // hover-driven close ignored
  })

  it('collapses the rail when the mode flips to click while expanded', () => {
    localStorage.setItem(KEY, 'hover')
    const { result } = renderHook(() => useSidebarRail())
    act(() => result.current.expand())
    expect(result.current.expanded).toBe(true)

    act(() => { localStorage.setItem(KEY, 'click'); window.dispatchEvent(new CustomEvent('scholera:sidebar-open-mode')) })
    expect(result.current.collapsed).toBe(true)
  })
})

// Docking + persistence (pilot #26: "when I open the sidebar my screen shall
// fit-to-page"). `docked` is what makes the page reflow instead of being covered,
// so it must be true ONLY in click mode — reflowing on a hover pass would thrash
// the layout on every mouse movement across the rail.
describe('useSidebarRail — docking and persistence', () => {
  it('is not docked while collapsed, and docks once opened in click mode', () => {
    const { result } = renderHook(() => useSidebarRail())
    expect(result.current.docked).toBe(false)

    act(() => result.current.toggle())
    expect(result.current.expanded).toBe(true)
    expect(result.current.docked).toBe(true)
  })

  it('never docks in hover mode, however the rail was opened', () => {
    localStorage.setItem(KEY, 'hover')
    const { result } = renderHook(() => useSidebarRail())

    act(() => result.current.expand())
    expect(result.current.expanded).toBe(true)
    // expanded but NOT docked — hover is a transient peek, so it overlays
    expect(result.current.docked).toBe(false)
  })

  it('persists the open state in click mode so it survives a remount', () => {
    const first = renderHook(() => useSidebarRail())
    act(() => first.result.current.toggle())
    expect(localStorage.getItem(EXPANDED)).toBe('1')

    // a fresh mount (reload / course switch) comes back open
    const second = renderHook(() => useSidebarRail())
    expect(second.result.current.expanded).toBe(true)

    act(() => second.result.current.toggle())
    expect(localStorage.getItem(EXPANDED)).toBe('0')
  })

  it('collapses a DOCKED-open rail when the mode flips to hover', () => {
    /* The direction that was missed. Docking turns off the instant mode leaves
       'click', so an expanded rail keeps its 224px panel but loses the layout
       placeholder holding space for it — it just sits over the content until the
       user happens to hover and leave. */
    const { result } = renderHook(() => useSidebarRail())
    act(() => result.current.toggle())
    expect(result.current.docked).toBe(true)

    act(() => { localStorage.setItem(KEY, 'hover'); window.dispatchEvent(new CustomEvent('scholera:sidebar-open-mode')) })
    expect(result.current.expanded).toBe(false)
    expect(result.current.docked).toBe(false)
  })

  it('suppresses the width transition on the first tick, then enables it', async () => {
    // Otherwise a remembered-open rail animates 56→224 on every load, dragging
    // the page content across with it.
    localStorage.setItem(EXPANDED, '1')
    const { result } = renderHook(() => useSidebarRail())
    expect(result.current.animate).toBe(false)
    expect(result.current.expanded).toBe(true)

    // Poll the flag rather than sleeping a guessed 5ms: the hook flips it from a
    // scheduled callback, and a fixed sleep either races on a loaded machine or
    // wastes time on a fast one.
    await waitFor(() => expect(result.current.animate).toBe(true))
  })

  it('does not restore a persisted open state into hover mode', () => {
    localStorage.setItem(EXPANDED, '1')
    localStorage.setItem(KEY, 'hover')
    const { result } = renderHook(() => useSidebarRail())
    expect(result.current.expanded).toBe(false)
  })
})
