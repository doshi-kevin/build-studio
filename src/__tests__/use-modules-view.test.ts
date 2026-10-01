// The Modules layout preference. Silent-failure behaviour, like
// use-module-expansion: nothing throws if the default flips to tiles or the
// restore stops working — every student just gets a page they didn't choose.
//
// The default is the load-bearing assertion. `list` is what every existing
// student sees today, so a regression to `tile` would silently re-lay-out the
// page for a whole institution.
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useModulesView, parseModulesView } from '@/lib/hooks/use-modules-view'

const KEY = 'scholera_modules_view'

beforeEach(() => {
  localStorage.clear()
})

describe('useModulesView', () => {
  it('defaults to the list — the layout students already have', () => {
    const { result } = renderHook(() => useModulesView())
    expect(result.current.view).toBe('list')
  })

  it('restores a remembered tile preference', () => {
    localStorage.setItem(KEY, 'tile')
    const { result } = renderHook(() => useModulesView())
    expect(result.current.view).toBe('tile')
  })

  it('persists the choice so it survives a remount', () => {
    const { result, unmount } = renderHook(() => useModulesView())
    act(() => result.current.setView('tile'))
    expect(result.current.view).toBe('tile')
    unmount()

    const second = renderHook(() => useModulesView())
    expect(second.result.current.view).toBe('tile')
  })

  /* localStorage, NOT sessionStorage, and not keyed by section: the preference is
     meant to follow the reader across courses and across weeks — unlike which
     sections they have open, which is this-tab working state. */
  it('remembers the preference for every course, not per course', () => {
    const { result } = renderHook(() => useModulesView())
    act(() => result.current.setView('tile'))
    expect(localStorage.getItem(KEY)).toBe('tile')
    expect(sessionStorage.getItem(KEY)).toBeNull()
  })
})

describe('parseModulesView — anything unrecognised is the list', () => {
  it.each([
    ['nothing stored', null],
    ['an empty string', ''],
    ['a value from some older build', 'grid'],
    ['junk', '{"view":"tile"}'],
  ])('falls back to list for %s', (_label, raw) => {
    expect(parseModulesView(raw)).toBe('list')
  })

  it('accepts the two real values', () => {
    expect(parseModulesView('list')).toBe('list')
    expect(parseModulesView('tile')).toBe('tile')
  })
})
