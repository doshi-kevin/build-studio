// The pre-fill handoff carries drafted prose out of band so it never lands in
// a URL, browser history, or an access log (§14.4). The properties worth
// pinning are the ones that stop a draft turning up somewhere it shouldn't.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAthenaPrefill, writeAthenaPrefill } from '@/lib/hooks/use-athena-prefill'

const HERE = '/student/courses/sec-1/live-classroom/room-3'

describe('the pre-fill handoff', () => {
  beforeEach(() => {
    sessionStorage.clear()
    // jsdom's default location; the handoff is scoped to the path she drove to.
    window.history.replaceState({}, '', HERE)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hands the draft to the surface it was written for, once', () => {
    writeAthenaPrefill('lc_question', 'Could you go over attention again?', HERE)
    const { result, rerender } = renderHook(() => useAthenaPrefill('lc_question'))

    expect(result.current).toBe('Could you go over attention again?')
    // Taking it deletes it, so it can't reappear on a later visit.
    expect(sessionStorage.getItem('athena-prefill')).toBeNull()
    rerender()
    expect(result.current).toBe('Could you go over attention again?')
  })

  it('leaves a draft meant for another surface alone', () => {
    writeAthenaPrefill('booking_note', 'a note for the professor', HERE)
    const { result } = renderHook(() => useAthenaPrefill('lc_question'))

    expect(result.current).toBeNull()
    // Still there for the surface it belongs to.
    expect(sessionStorage.getItem('athena-prefill')).toContain('booking_note')
  })

  it('reaches a surface that was already mounted — asking during class is the normal case', () => {
    const { result } = renderHook(() => useAthenaPrefill('lc_question'))
    expect(result.current).toBeNull()

    act(() => writeAthenaPrefill('lc_question', 'drafted mid-session', HERE))
    expect(result.current).toBe('drafted mid-session')
  })

  it('costs a pre-fill and never the page when the entry is corrupt', () => {
    sessionStorage.setItem('athena-prefill', '{not json')
    const { result } = renderHook(() => useAthenaPrefill('lc_question'))
    expect(result.current).toBeNull()
  })

  it('will not hand a draft to a page it was not written for', () => {
    // A booking note drafted for /student/office-hours must not turn up in some
    // other form the student happens to open.
    writeAthenaPrefill('booking_note', 'about your weak topics', '/student/office-hours')
    const { result } = renderHook(() => useAthenaPrefill('booking_note'))
    expect(result.current).toBeNull()
  })

  it('expires — a proposal the student walked away from is not waiting for them later', () => {
    writeAthenaPrefill('booking_note', 'about your weak topics', HERE)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 121_000)

    const { result } = renderHook(() => useAthenaPrefill('booking_note'))
    expect(result.current).toBeNull()
    // And it's cleared, so it can't ambush a form on a later mount either.
    expect(sessionStorage.getItem('athena-prefill')).toBeNull()
  })

  it('uses sessionStorage, so a drive in one tab cannot pre-fill another', () => {
    writeAthenaPrefill('lc_question', 'tab-local', HERE)
    expect(localStorage.getItem('athena-prefill')).toBeNull()
    expect(sessionStorage.getItem('athena-prefill')).toContain('tab-local')
  })
})
