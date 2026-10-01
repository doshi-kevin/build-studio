// Collapsed-by-default is the whole point of the Modules redesign — a semester of
// sections expanded at once is the scroll it exists to remove — and the persisted
// set is what stops a server revalidation (publish, reorder, delete) from snapping
// everything shut mid-task. Both are silent-failure behaviours: nothing throws if
// the default flips to all-open or the restore stops working, the page just gets
// worse. Same shape as use-sidebar-rail.test.ts.
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useModuleExpansion } from '@/lib/hooks/use-module-expansion'

const KEY = 'scholera_modules_expanded:sec-1'
const IDS = ['m1', 'm2', 'm3']

const stored = () => JSON.parse(sessionStorage.getItem(KEY) ?? 'null')

beforeEach(() => {
  sessionStorage.clear()
})

describe('useModuleExpansion — first visit', () => {
  it('opens only the first section when nothing is stored', () => {
    const { result } = renderHook(() => useModuleExpansion('sec-1', IDS))
    expect([...result.current.expanded]).toEqual(['m1'])
  })

  it('opens nothing when the course has no modules', () => {
    const { result } = renderHook(() => useModuleExpansion('sec-1', []))
    expect(result.current.expanded.size).toBe(0)
  })
})

describe('useModuleExpansion — restoring the reader’s state', () => {
  it('restores the persisted set instead of the first-open default', () => {
    sessionStorage.setItem(KEY, JSON.stringify(['m2', 'm3']))
    const { result } = renderHook(() => useModuleExpansion('sec-1', IDS))
    expect([...result.current.expanded].sort()).toEqual(['m2', 'm3'])
  })

  it('honours a persisted all-collapsed state rather than re-opening the first section', () => {
    // An empty stored array is a real choice ("I closed everything"), not "nothing stored".
    sessionStorage.setItem(KEY, JSON.stringify([]))
    const { result } = renderHook(() => useModuleExpansion('sec-1', IDS))
    expect(result.current.expanded.size).toBe(0)
  })

  it('drops persisted ids for modules that no longer exist', () => {
    sessionStorage.setItem(KEY, JSON.stringify(['m2', 'deleted-module']))
    const { result } = renderHook(() => useModuleExpansion('sec-1', IDS))
    expect([...result.current.expanded]).toEqual(['m2'])
  })

  it('falls back to the default when the stored value is garbage', () => {
    sessionStorage.setItem(KEY, 'not json')
    const { result } = renderHook(() => useModuleExpansion('sec-1', IDS))
    expect([...result.current.expanded]).toEqual(['m1'])
  })

  it('is scoped per course section', () => {
    sessionStorage.setItem(KEY, JSON.stringify(['m3']))
    const { result } = renderHook(() => useModuleExpansion('sec-2', IDS))
    expect([...result.current.expanded]).toEqual(['m1']) // sec-2 has its own key
  })
})

describe('useModuleExpansion — toggle and expand', () => {
  it('toggle opens a section and persists the new set', () => {
    const { result } = renderHook(() => useModuleExpansion('sec-1', IDS))
    act(() => result.current.toggle('m2'))
    expect([...result.current.expanded].sort()).toEqual(['m1', 'm2'])
    expect(stored().sort()).toEqual(['m1', 'm2'])
  })

  it('toggle closes an open section, persisting the empty set', () => {
    const { result } = renderHook(() => useModuleExpansion('sec-1', IDS))
    act(() => result.current.toggle('m1'))
    expect(result.current.expanded.size).toBe(0)
    expect(stored()).toEqual([]) // must survive a remount as all-collapsed
  })

  it('expand opens a section without closing the others (?item= deep links)', () => {
    const { result } = renderHook(() => useModuleExpansion('sec-1', IDS))
    act(() => result.current.expand('m3'))
    expect([...result.current.expanded].sort()).toEqual(['m1', 'm3'])
  })

  it('expand on an already-open section is a no-op', () => {
    const { result } = renderHook(() => useModuleExpansion('sec-1', IDS))
    const before = result.current.expanded
    act(() => result.current.expand('m1'))
    expect(result.current.expanded).toBe(before) // no re-render, no write
    expect(sessionStorage.getItem(KEY)).toBeNull()
  })
})

/* The student tile view has one detail panel, so it needs "open exactly this one"
   — but it shares this state with the list so switching layouts keeps the
   reader's place. That sharing is the point: a separate open-tile state would let
   the two views disagree. */
describe('useModuleExpansion — setOnly (single-open tile view)', () => {
  it('closes everything else', () => {
    const { result } = renderHook(() => useModuleExpansion('sec-1', IDS))
    act(() => result.current.expand('m2')) // m1 + m2 open, as the list allows
    act(() => result.current.setOnly('m3'))
    expect([...result.current.expanded]).toEqual(['m3'])
  })

  it('persists, so switching to the list keeps that section open', () => {
    const { result } = renderHook(() => useModuleExpansion('sec-1', IDS))
    act(() => result.current.setOnly('m2'))
    expect(stored()).toEqual(['m2'])
  })

  it('closes everything when passed null (Collapse)', () => {
    const { result } = renderHook(() => useModuleExpansion('sec-1', IDS))
    act(() => result.current.setOnly(null))
    expect(result.current.expanded.size).toBe(0)
    expect(stored()).toEqual([])
  })
})

/* The tile grid starts fully collapsed, so it has to tell the first-visit default
   (first section open) apart from a state the reader chose — including a chosen
   all-closed, which looks identical in `expanded` but isn't. */
describe('useModuleExpansion — usingDefault', () => {
  it('is true on a first visit, when the open section is only the default', () => {
    const { result } = renderHook(() => useModuleExpansion('sec-1', IDS))
    expect(result.current.usingDefault).toBe(true)
    expect([...result.current.expanded]).toEqual(['m1']) // …the default itself
  })

  it('is false once the reader has opened something', () => {
    const { result } = renderHook(() => useModuleExpansion('sec-1', IDS))
    act(() => result.current.toggle('m2'))
    expect(result.current.usingDefault).toBe(false)
  })

  it('is false for a restored state, including a deliberate all-closed', () => {
    sessionStorage.setItem(KEY, JSON.stringify([]))
    const { result } = renderHook(() => useModuleExpansion('sec-1', IDS))
    expect(result.current.usingDefault).toBe(false)
  })

  it('is true when the stored value is garbage — that is no choice at all', () => {
    sessionStorage.setItem(KEY, 'not json')
    const { result } = renderHook(() => useModuleExpansion('sec-1', IDS))
    expect(result.current.usingDefault).toBe(true)
  })
})
