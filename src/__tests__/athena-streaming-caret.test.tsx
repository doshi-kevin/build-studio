/**
 * Athena's streaming caret — does the COMPONENT render it?
 *
 * Runtime QA sampled 4491 frames of a real streaming answer and never saw the
 * caret. That leaves two possibilities: the component never renders it, or the
 * chat status never reaches 'streaming' so the prop is never true. Those need
 * completely different fixes, and a browser cannot tell them apart.
 *
 * This test isolates the component half. If it passes, the switch is correct and
 * any remaining gap is upstream in the status wiring.
 *
 * What it deliberately cannot cover: where the caret LANDS. jsdom does no
 * layout. The first implementation rendered a sibling <span>, which put the
 * caret on its own line under the paragraph and stole the container's
 * last-child margin rule — both invisible to a test like this, and both the
 * reason it is now a ::after in globals.css.
 */

import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

import { ChatMessage } from '@/components/student/athena/ChatMessage'

const base = {
  role: 'assistant',
  documents: [],
  onOpenPreview: () => {},
}

/**
 * The caret is a ::after on the prose container's last block, switched on by
 * one class. jsdom applies no stylesheets, so the class IS the contract worth
 * asserting — and asserting it rather than a span's Tailwind classes means a
 * cosmetic restyle cannot fail this test.
 */
function caretOf(container: HTMLElement) {
  return container.querySelector('.athena-streaming')
}

describe('Athena streaming caret', () => {
  it('renders while the answer is still streaming', () => {
    const { container } = render(
      <ChatMessage {...base} content="Partial answer so f" streaming />,
    )
    expect(caretOf(container)).not.toBeNull()
  })

  it('is absent once the turn has settled', () => {
    const { container } = render(
      <ChatMessage {...base} content="A complete answer." streaming={false} />,
    )
    expect(caretOf(container)).toBeNull()
  })

  it('never renders on a student turn, streaming or not', () => {
    const { container } = render(
      <ChatMessage {...base} role="user" content="my question" streaming />,
    )
    expect(caretOf(container)).toBeNull()
  })
})
