// Logic test for QuizCountdown.onExpire — the hook the student responders use
// to auto-submit + lock at time-up. It must fire exactly once when the clock
// crosses 0, never while time remains, and immediately if the quiz is already
// past its deadline at mount (e.g. a late joiner inside the close grace window).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { QuizCountdown } from '@/components/live-classroom/shared/QuizCountdown'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('QuizCountdown.onExpire', () => {
  it('does not fire while time remains, fires once when it crosses 0', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-09T00:00:00.000Z'))
    const onExpire = vi.fn()

    render(
      <QuizCountdown
        openedAt="2026-06-09T00:00:00.000Z"
        totalSeconds={3}
        onExpire={onExpire}
      />,
    )
    expect(onExpire).not.toHaveBeenCalled()

    // Jump past the deadline and let the interval tick.
    act(() => {
      vi.setSystemTime(new Date('2026-06-09T00:00:04.000Z'))
      vi.advanceTimersByTime(4000)
    })
    expect(onExpire).toHaveBeenCalledTimes(1)

    // Keep ticking — it must not fire again for the same quiz.
    act(() => {
      vi.setSystemTime(new Date('2026-06-09T00:00:12.000Z'))
      vi.advanceTimersByTime(8000)
    })
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('fires immediately at mount when already past the deadline', () => {
    vi.useFakeTimers()
    // Opened 60s ago with a 30s limit → already expired.
    vi.setSystemTime(new Date('2026-06-09T00:01:00.000Z'))
    const onExpire = vi.fn()

    render(
      <QuizCountdown
        openedAt="2026-06-09T00:00:00.000Z"
        totalSeconds={30}
        onExpire={onExpire}
      />,
    )
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('never fires before opened_at is set (countdown not started)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-09T00:00:00.000Z'))
    const onExpire = vi.fn()

    render(<QuizCountdown openedAt={null} totalSeconds={30} onExpire={onExpire} />)
    act(() => {
      vi.advanceTimersByTime(60000)
    })
    expect(onExpire).not.toHaveBeenCalled()
  })
})
