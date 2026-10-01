/**
 * #619 — a points edit confirmed with Enter silently reverted if another action followed
 * quickly.
 *
 * NumericInput committed onChange ONLY on blur. Enter did nothing, so the value lived in local
 * state until some later blur happened to fire — and if the next action unmounted the field
 * first (closing the points popover), the edit was discarded with no error. Points decide how
 * a question is scored, so the professor ships a quiz that grades differently from what they
 * configured.
 *
 * The oracle is that onChange FIRES on Enter. Asserting the displayed value would pass against
 * the bug, because the local display was always correct — it was the commit that never
 * happened.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NumericInput } from '@/components/ui/numeric-input'

describe('NumericInput — commit semantics', () => {
  it('commits on Enter, without waiting for a blur', () => {
    const onChange = vi.fn()
    render(<NumericInput value={1} min={1} max={100} onChange={onChange} />)

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '5' } })
    expect(onChange).not.toHaveBeenCalled() // still mid-edit

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('5')
  })

  it('still commits on blur — the existing path must keep working', () => {
    const onChange = vi.fn()
    render(<NumericInput value={1} min={1} max={100} onChange={onChange} />)

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '7' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith('7')
  })

  it('clamps to max on Enter, exactly as blur does', () => {
    const onChange = vi.fn()
    render(<NumericInput value={1} min={1} max={100} onChange={onChange} />)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '250' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('100')
  })

  it('clamps up to min on Enter', () => {
    const onChange = vi.fn()
    render(<NumericInput value={5} min={1} max={100} onChange={onChange} />)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '0' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('1')
  })

  it('does not commit on other keys — typing must stay free', () => {
    const onChange = vi.fn()
    render(<NumericInput value={1} onChange={onChange} />)

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '42' } })
    fireEvent.keyDown(input, { key: 'a' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onChange).not.toHaveBeenCalled()
  })

  /* This test used to assert ONLY that the caller's callback fired — and it passed while the
     component was broken, because `{...props}` spread after onKeyDown and REPLACED our handler
     outright. The caller's callback ran instead of ours, not in addition to it, so "it fired"
     proved nothing. Caught in review (three rounds; I missed it three times).

     The oracle has to be BOTH on the same Enter: the caller's handler runs AND onChange fires,
     which is only true if our handler survived the spread and called through. */
  it('runs BOTH our commit and a caller-supplied onKeyDown on the same Enter', () => {
    const onKeyDown = vi.fn()
    const onChange = vi.fn()
    render(<NumericInput value={1} min={1} max={100} onChange={onChange} onKeyDown={onKeyDown} />)

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '9' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onKeyDown).toHaveBeenCalled()   // caller still notified
    expect(onChange).toHaveBeenCalledWith('9') // ...and the value actually committed
  })

  it('still commits on blur when the caller also passes onBlur', () => {
    // onBlur carries commit-on-blur, so the same spread bug would have silently disabled it.
    const onBlur = vi.fn()
    const onChange = vi.fn()
    render(<NumericInput value={1} min={1} max={100} onChange={onChange} onBlur={onBlur} />)

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '4' } })
    fireEvent.blur(input)

    expect(onBlur).toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith('4')
  })
})

/**
 * With an IME active (Japanese, Chinese, Korean…) Enter CONFIRMS the candidate being composed;
 * it does not mean "I'm done with this field". Committing on that keystroke would swallow it
 * and cut the composition short, so composition Enter must pass through untouched.
 *
 * Raised by a code review of the commit-on-Enter change above — the fix is cheap, and getting
 * it wrong silently breaks input for anyone typing with an IME.
 */
describe('NumericInput — IME composition', () => {
  it('does not commit while an IME composition is in flight', () => {
    const onChange = vi.fn()
    render(<NumericInput value={1} min={1} max={100} onChange={onChange} />)

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '5' } })
    // React exposes this as e.nativeEvent.isComposing
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })

    expect(onChange).not.toHaveBeenCalled()
  })

  it('commits on the Enter that follows, once composition has ended', () => {
    const onChange = vi.fn()
    render(<NumericInput value={1} min={1} max={100} onChange={onChange} />)

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '5' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith('5')
  })
})
