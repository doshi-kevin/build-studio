// Tests for LocalDateTime — the client-only formatter that fixes the
// classroom timezone bug (server components were emitting UTC strings).

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LocalDateTime } from '@/components/shared/LocalDateTime'

const ISO = '2026-04-28T23:59:14-04:00'

describe('LocalDateTime', () => {
  it('emits a <time> element with the dateTime attribute', () => {
    const { container } = render(<LocalDateTime iso={ISO} />)
    const time = container.querySelector('time')
    expect(time).not.toBeNull()
    expect(time!.getAttribute('datetime')).toBe(ISO)
  })

  it('renders a localized datetime string after hydration', () => {
    render(<LocalDateTime iso={ISO} mode="datetime" />)
    const time = document.querySelector('time')!
    // Whatever locale jsdom is in, the string should contain a digit-bearing
    // representation of the date — i.e. it ran through toLocaleString and
    // didn't stay empty.
    expect(time.textContent ?? '').toMatch(/\d/)
  })

  it('renders only the date portion in date mode', () => {
    render(<LocalDateTime iso={ISO} mode="date" />)
    const text = document.querySelector('time')!.textContent ?? ''
    // Date-only formatting must not contain colons (which would only
    // appear in a time portion). Keeps the assertion locale-agnostic.
    expect(text).not.toContain(':')
    expect(text).toMatch(/\d/)
  })

  it('renders only the time portion in time mode', () => {
    render(<LocalDateTime iso={ISO} mode="time" />)
    const text = document.querySelector('time')!.textContent ?? ''
    expect(text).toMatch(/\d/)
  })

  it('prepends the prefix to the rendered text', () => {
    render(<LocalDateTime iso={ISO} mode="time" prefix="Ended" />)
    const text = document.querySelector('time')!.textContent ?? ''
    expect(text.startsWith('Ended ')).toBe(true)
  })

  it('renders the fallback when the iso string is invalid', () => {
    render(<LocalDateTime iso="not-a-date" fallback="—" />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})
