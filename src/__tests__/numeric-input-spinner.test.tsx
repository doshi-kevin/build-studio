// NumericInput's `spinner` mode — the Max Attempts field (issue #43).
// The bug users reported was the field REFILLING itself: clear it and it snapped
// back to 1, so "no limit" was unreachable through the UI. Blur on an empty field
// must commit '' (which the form maps to null = no limit), and the field must carry
// no upper bound now that the 1..10 ceiling is gone.

import * as React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NumericInput } from '@/components/ui/numeric-input'
import { MAX_ATTEMPTS_CEILING } from '@/lib/validations/quiz'

// Mirrors QuizInfoStep's wiring exactly: the form holds `number | null` and an empty
// string means null. NumericInput re-syncs its display from `value` on blur, so a
// harness that ignores onChange can't tell "committed empty" from "snapped back" —
// the round trip through parent state is the thing worth asserting.
function MaxAttemptsField({ initial }: { initial: number | null }) {
  const [value, setValue] = React.useState<number | null>(initial)
  return (
    <>
      <NumericInput
        spinner
        min={1}
        max={MAX_ATTEMPTS_CEILING}
        placeholder="No limit"
        value={value ?? ''}
        onChange={(v) => setValue(v ? parseInt(v) : null)}
      />
      <output>{value === null ? 'No limit' : String(value)}</output>
    </>
  )
}

describe('Max Attempts field (spinner + nullable form value)', () => {
  it('clearing the field commits null, so the quiz gets no attempt limit', () => {
    render(<MaxAttemptsField initial={3} />)
    const input = screen.getByRole('spinbutton') as HTMLInputElement

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    // The old behaviour refilled to 1 here, which made "no limit" unreachable (#43).
    expect(screen.getByRole('status')).toHaveTextContent('No limit')
    expect(input.value).toBe('')
  })

  it('accepts a value past the old ceiling of 10 and holds it', () => {
    render(<MaxAttemptsField initial={null} />)
    const input = screen.getByRole('spinbutton') as HTMLInputElement

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.blur(input)

    expect(screen.getByRole('status')).toHaveTextContent('99')
    expect(input.value).toBe('99')
  })

  it('clamps a value past the sanity ceiling instead of failing the save', () => {
    // The client ceiling matches the server's, so 5000 becomes 1000 here rather than
    // reaching Quiz Studio's raw "Please fix: Too big…" toast — which is the symptom
    // #43 was filed over, just at a different number.
    render(<MaxAttemptsField initial={null} />)
    const input = screen.getByRole('spinbutton') as HTMLInputElement

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '5000' } })
    fireEvent.blur(input)

    expect(screen.getByRole('status')).toHaveTextContent(String(MAX_ATTEMPTS_CEILING))
  })

  it('still floors an out-of-range entry at one attempt', () => {
    render(<MaxAttemptsField initial={3} />)
    const input = screen.getByRole('spinbutton') as HTMLInputElement

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)

    expect(screen.getByRole('status')).toHaveTextContent('1')
  })
})

describe('NumericInput spinner mode', () => {
  it('renders a number field with min but no max', () => {
    render(<NumericInput spinner min={1} value={null} onChange={vi.fn()} />)
    const input = screen.getByRole('spinbutton') as HTMLInputElement
    expect(input.type).toBe('number')
    expect(input.getAttribute('min')).toBe('1')
    expect(input.getAttribute('max')).toBeNull()
  })

  it('commits empty on blur instead of refilling to min', () => {
    const onChange = vi.fn()
    render(<NumericInput spinner min={1} value={3} onChange={onChange} />)
    const input = screen.getByRole('spinbutton') as HTMLInputElement

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    expect(onChange).toHaveBeenLastCalledWith('')
  })

  it('keeps a value past the old ceiling of 10', () => {
    const onChange = vi.fn()
    render(<NumericInput spinner min={1} value={null} onChange={onChange} />)
    const input = screen.getByRole('spinbutton') as HTMLInputElement

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.blur(input)

    expect(onChange).toHaveBeenLastCalledWith('99')
  })

  it('still clamps below min on blur', () => {
    const onChange = vi.fn()
    render(<NumericInput spinner min={1} value={null} onChange={onChange} />)
    const input = screen.getByRole('spinbutton') as HTMLInputElement

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)

    expect(onChange).toHaveBeenLastCalledWith('1')
  })

  it('renders a null value as an empty field, so the "No limit" placeholder shows', () => {
    render(<NumericInput spinner min={1} placeholder="No limit" value={null} onChange={vi.fn()} />)
    const input = screen.getByPlaceholderText('No limit') as HTMLInputElement
    expect(input.value).toBe('')
  })
})
