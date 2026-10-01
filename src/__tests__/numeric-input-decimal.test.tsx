// NumericInput's `decimal` mode. Default is integer-only (it strips the dot),
// which silently broke the Target SE field (0.3 → "03" → 3 → clamped to 2).
// These lock the decimal path: the dot survives typing and commits on blur.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NumericInput } from '@/components/ui/numeric-input'

describe('NumericInput decimal mode', () => {
  it('integer mode strips the decimal point (unchanged default)', () => {
    render(<NumericInput value="" onChange={vi.fn()} onLiveChange={undefined} />)
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '0.3' } })
    expect(input.value).toBe('03') // dot stripped in integer mode
  })

  it('decimal mode keeps the decimal point and commits the float on blur', () => {
    const onChange = vi.fn()
    render(<NumericInput decimal min={0.1} max={2} value="" onChange={onChange} />)
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '0.3' } })
    expect(input.value).toBe('0.3')
    fireEvent.blur(input)
    expect(onChange).toHaveBeenLastCalledWith('0.3')
  })

  it('decimal mode keeps only the first dot', () => {
    render(<NumericInput decimal value="" onChange={vi.fn()} />)
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '0.3.5' } })
    expect(input.value).toBe('0.35')
  })

  it('decimal mode clamps to max on blur', () => {
    const onChange = vi.fn()
    render(<NumericInput decimal min={0.1} max={2} value="" onChange={onChange} />)
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '9.9' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenLastCalledWith('2')
  })
})
