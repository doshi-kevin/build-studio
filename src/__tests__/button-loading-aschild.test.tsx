/**
 * Button's `loading` prop and its `asChild` carve-out.
 *
 * The asChild path already broke once app-wide: with `loading` false,
 * `{loading && <Loader2/>}` handed Radix's Slot a two-element array
 * `[false, children]` and every button rendered as a link threw. It was caught
 * only incidentally, by a dialog test that happens to use AlertDialogAction.
 * There are ~35 asChild call sites plus every AlertDialog action and cancel, and
 * the failure mode is a thrown render, so the contract is pinned here directly.
 */

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Button } from '@/components/ui/button'

describe('Button asChild', () => {
  it('renders its single child and does not throw', () => {
    const { container } = render(
      <Button asChild>
        <a href="/x">Go</a>
      </Button>,
    )
    expect(container.querySelectorAll('a')).toHaveLength(1)
    expect(container.querySelector('button')).toBeNull()
  })

  it('adds no spinner under asChild, but makes the control inert', () => {
    // Slot clones exactly one child, so a spinner cannot be injected here.
    // The control must still refuse a second click rather than silently
    // staying live while announcing itself busy.
    const { container } = render(
      <Button asChild loading>
        <a href="/x">Go</a>
      </Button>,
    )
    const anchor = container.querySelector('a')
    expect(container.querySelectorAll('a')).toHaveLength(1)
    expect(container.querySelector('svg')).toBeNull()
    expect(anchor?.getAttribute('aria-disabled')).toBe('true')
    expect(anchor?.className).toContain('pointer-events-none')
  })
})

describe('Button loading', () => {
  it('disables, marks itself busy, and shows a spinner', () => {
    const { container } = render(<Button loading>Save</Button>)
    const button = container.querySelector('button')
    /* `disabled` rather than aria-disabled, deliberately: it is also what stops
       Enter in a text field re-submitting a form that is already in flight. */
    expect(button?.hasAttribute('disabled')).toBe(true)
    expect(button?.getAttribute('aria-busy')).toBe('true')
    expect(button?.className).toContain('pointer-events-none')
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('swallows a second click while loading', () => {
    let clicks = 0
    const { container } = render(
      <Button loading onClick={() => { clicks += 1 }}>Save</Button>,
    )
    container.querySelector('button')?.click()
    expect(clicks).toBe(0)
  })

  it('still honours an explicit disabled', () => {
    const { container } = render(<Button disabled>Save</Button>)
    expect(container.querySelector('button')?.hasAttribute('disabled')).toBe(true)
  })

  it('leaves no residue when not loading', () => {
    // `|| undefined` rather than `false`, so the attributes are absent entirely
    // rather than present-and-false. Easy to lose in a refactor.
    const { container } = render(<Button loading={false}>Save</Button>)
    const button = container.querySelector('button')
    expect(button?.hasAttribute('disabled')).toBe(false)
    expect(button?.hasAttribute('aria-busy')).toBe(false)
    expect(container.querySelector('svg')).toBeNull()
  })
})
