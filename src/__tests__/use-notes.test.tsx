// Tests for the useLiveNotes hook — the student notetaker's client logic.
//
// The behavior worth guarding isn't the editor; it's the autosave state
// machine: load + deserialize (incl. legacy plain text), debounce, serialized
// saves (so a slow older write can't clobber a newer one), and flushing the
// pending draft when the tab is hidden so the last debounce window isn't lost.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { JSONContent } from 'novel'

const getNotes = vi.fn()
const saveNotes = vi.fn()
vi.mock('@/lib/live-classroom/notes/actions', () => ({
  getNotes: (...args: unknown[]) => getNotes(...args),
  saveNotes: (...args: unknown[]) => saveNotes(...args),
}))

import { useLiveNotes } from '@/lib/live-classroom/notes/use-notes'

const ROOM = '11111111-1111-4111-8111-111111111111'

const doc = (text: string): JSONContent => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

// Let queued microtasks (the awaited server-action promises) settle.
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useLiveNotes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    getNotes.mockReset().mockResolvedValue({ content: '' })
    saveNotes.mockReset().mockResolvedValue({ success: true })
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads and parses existing JSON notes on mount', async () => {
    getNotes.mockResolvedValue({ content: JSON.stringify(doc('from last time')) })
    const { result } = renderHook(() => useLiveNotes(ROOM))

    expect(result.current.loaded).toBe(false)
    await act(async () => { await flush() })

    expect(getNotes).toHaveBeenCalledWith(ROOM)
    expect(result.current.loaded).toBe(true)
    expect(result.current.getInitialContent()).toEqual(doc('from last time'))
  })

  it('wraps a legacy plain-text note as a paragraph doc', async () => {
    getNotes.mockResolvedValue({ content: 'old plain note' })
    const { result } = renderHook(() => useLiveNotes(ROOM))
    await act(async () => { await flush() })

    expect(result.current.getInitialContent()).toEqual(doc('old plain note'))
  })

  it('autosaves serialized JSON once the debounce elapses', async () => {
    const { result } = renderHook(() => useLiveNotes(ROOM))
    await act(async () => { await flush() })

    const d = doc('a thought')
    act(() => { result.current.onChange(d) })
    expect(saveNotes).not.toHaveBeenCalled() // still within the debounce window

    await act(async () => { vi.advanceTimersByTime(800); await flush() })
    expect(saveNotes).toHaveBeenCalledWith(ROOM, JSON.stringify(d))
    expect(result.current.saveState).toBe('saved')
  })

  it('serializes overlapping saves and persists the latest content', async () => {
    let resolveFirst: () => void = () => {}
    saveNotes
      .mockImplementationOnce(() => new Promise<{ success: boolean }>((r) => { resolveFirst = () => r({ success: true }) }))
      .mockResolvedValue({ success: true })

    const { result } = renderHook(() => useLiveNotes(ROOM))
    await act(async () => { await flush() })

    const d1 = doc('v1')
    const d2 = doc('v2')

    // First edit → debounce fires → first save is now in flight (unresolved).
    act(() => { result.current.onChange(d1) })
    await act(async () => { vi.advanceTimersByTime(800); await flush() })
    expect(saveNotes).toHaveBeenCalledTimes(1)
    expect(saveNotes).toHaveBeenLastCalledWith(ROOM, JSON.stringify(d1))

    // Edit again while the first save is still in flight — no second concurrent save.
    act(() => { result.current.onChange(d2) })
    await act(async () => { vi.advanceTimersByTime(800); await flush() })
    expect(saveNotes).toHaveBeenCalledTimes(1)

    // First save resolves → the loop saves the latest draft (v2).
    await act(async () => { resolveFirst(); await flush() })
    expect(saveNotes).toHaveBeenCalledTimes(2)
    expect(saveNotes).toHaveBeenLastCalledWith(ROOM, JSON.stringify(d2))
  })

  it('flushes the pending draft immediately when the tab is hidden', async () => {
    const { result } = renderHook(() => useLiveNotes(ROOM))
    await act(async () => { await flush() })

    const d = doc('half-typed')
    act(() => { result.current.onChange(d) })
    expect(saveNotes).not.toHaveBeenCalled() // debounce not yet elapsed

    await act(async () => { setVisibility('hidden'); await flush() })
    expect(saveNotes).toHaveBeenCalledWith(ROOM, JSON.stringify(d))
  })

  it('does not save when nothing changed from what was loaded', async () => {
    getNotes.mockResolvedValue({ content: JSON.stringify(doc('unchanged')) })
    renderHook(() => useLiveNotes(ROOM))
    await act(async () => { await flush() })

    await act(async () => { setVisibility('hidden'); await flush() })
    expect(saveNotes).not.toHaveBeenCalled()
  })

  it('surfaces an error state when a save fails', async () => {
    saveNotes.mockResolvedValue({ error: 'nope' })
    const { result } = renderHook(() => useLiveNotes(ROOM))
    await act(async () => { await flush() })

    act(() => { result.current.onChange(doc('will fail')) })
    await act(async () => { vi.advanceTimersByTime(800); await flush() })
    expect(result.current.saveState).toBe('error')
  })
})
