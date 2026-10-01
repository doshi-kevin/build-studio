/**
 * The ask line → chat hand-off. This is the only genuinely new logic in the floating
 * trigger, and every case here is one that silently loses, duplicates, or MISDIRECTS a
 * professor's request — failure modes you cannot see in a screenshot.
 *
 *  1. Enter with text opens the dock AND sends that text as the turn, exactly once.
 *  2. Enter on an empty field still opens the dock and sends nothing — the old button's
 *     behavior, preserved.
 *  3. A prompt typed while Athena is mid-answer DEFERS instead of vanishing. The panel's
 *     own `send` no-ops while a turn is in flight, so consuming during a stream would
 *     swallow it with no error and no message. It must land once the stream settles.
 *  4. …but a deferred prompt must DIE with the surface it was written for. The security
 *     review caught this: the parked prompt was the one piece of provider state that
 *     outlived the panel's keyed remount, so an instruction meant for one assignment
 *     could execute against the next one opened — where fill tools apply automatically
 *     and some cannot be undone.
 *  5. ⌘K focuses the field / closes the dock, and closing restores focus to the field.
 *
 * Each test here was checked against a mutation of the source it guards — if breaking
 * the code doesn't turn the test red, the test isn't earning its place. An earlier
 * "doesn't resend on re-render" case was deleted for failing exactly that check.
 *
 * Only the chat SDK is stubbed (shared sendMessage spy + switchable status). The dock
 * provider, the panel, the ask line and the prompt plumbing are all real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AssignmentAthenaProvider, useAthenaSurface } from '@/components/professor/assignments/athena/AssignmentAthenaDock'
import { AthenaAskLine } from '@/components/professor/assignments/athena/AthenaAskLine'

const { chat } = vi.hoisted(() => ({
  chat: {
    sendMessage: vi.fn(),
    /** Status the panel mounts with; flip it mid-test via setStatus. */
    initialStatus: 'ready' as string,
    setStatus: (() => {}) as (s: string) => void,
  },
}))

// The panel calls router.refresh() after a panel-owned fill persists (so the host's
// server-rendered rubric pane picks up the write). jsdom mounts no app router — stub it.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))
vi.mock('@ai-sdk/react', async () => {
  const React = await import('react')
  return {
    useChat: () => {
      const [status, setStatus] = React.useState(chat.initialStatus)
      // Hand the setter out so a test can settle a "streaming" chat.
      chat.setStatus = setStatus
      return {
        messages: [],
        setMessages: vi.fn(),
        sendMessage: chat.sendMessage,
        addToolResult: vi.fn(),
        status,
        error: undefined,
        stop: vi.fn(),
      }
    },
  }
})
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))
vi.mock('@/components/professor/assignments/athena/actions', () => ({
  // The panel reads its rate-limit pool on open. Unmocked, this reaches the real
  // server action → createClient() → cookies(), which throws in jsdom. An empty
  // models list means allExhausted is false, so Send stays enabled.
  getPanelAthenaUsage: async () => ({ status: { models: [], resets_at: null } }),
  saveAssignmentDesign: vi.fn(),
  applyFrontierRubric: vi.fn(),
}))
vi.mock('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions', () => ({
  uploadAssignmentAttachment: vi.fn(),
}))

Element.prototype.scrollIntoView = vi.fn()

/** A host screen that registers a surface and mounts the floating ask line. */
function Host({ assignmentId = 'q1' }: { assignmentId?: string }) {
  useAthenaSurface({
    active: true,
    surface: 'authoring',
    kind: 'quiz',
    assignmentId,
    getScreen: () => ({}),
    onFill: () => ({ summary: 'ok', applied: true }),
  })
  return <AthenaAskLine />
}

const renderAskLine = () =>
  render(
    <AssignmentAthenaProvider sectionId="sec-1">
      <Host />
    </AssignmentAthenaProvider>,
  )

/** The dock's <aside> carries aria-hidden, so it reports whether Athena is open. */
const dockIsOpen = () => document.querySelector('[data-athena-dock]')?.getAttribute('aria-hidden') === 'false'
const askInput = () => screen.getByLabelText('Ask Athena')

beforeEach(() => {
  vi.clearAllMocks()
  chat.initialStatus = 'ready'
})

describe('Athena ask line', () => {
  it('opens the dock and sends the typed prompt exactly once', async () => {
    renderAskLine()
    expect(dockIsOpen()).toBe(false)

    fireEvent.change(askInput(), { target: { value: 'add a criterion for citations worth 10 points' } })
    fireEvent.keyDown(askInput(), { key: 'Enter' })

    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1))
    expect(chat.sendMessage).toHaveBeenCalledWith(
      { text: 'add a criterion for citations worth 10 points' },
      expect.objectContaining({ body: expect.objectContaining({ screen: {} }) }),
    )
    expect(dockIsOpen()).toBe(true)
    // The field is cleared, so the prompt can't be resubmitted by a stray Enter.
    expect((askInput() as HTMLInputElement).value).toBe('')
  })

  it('opens the dock without sending when Enter is pressed on an empty field', async () => {
    renderAskLine()
    fireEvent.keyDown(askInput(), { key: 'Enter' })

    await waitFor(() => expect(dockIsOpen()).toBe(true))
    expect(chat.sendMessage).not.toHaveBeenCalled()
  })

  it('defers a prompt typed while Athena is mid-answer, then delivers it once she settles', async () => {
    chat.initialStatus = 'streaming'
    renderAskLine()

    // Busy is announced through the provider's live region. It must NOT be appended to
    // the field's accessible name: that is never announced, and it breaks voice control.
    expect(screen.getByRole('status')).toHaveTextContent('Athena is working')
    expect(askInput()).toHaveAttribute('aria-label', 'Ask Athena')

    fireEvent.change(askInput(), { target: { value: 'make question 3 harder' } })
    fireEvent.keyDown(askInput(), { key: 'Enter' })

    // Swallowing it here is the bug this guards: the panel's send() no-ops while busy.
    await waitFor(() => expect(dockIsOpen()).toBe(true))
    expect(chat.sendMessage).not.toHaveBeenCalled()

    act(() => chat.setStatus('ready'))

    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1))
    expect(chat.sendMessage).toHaveBeenCalledWith(
      { text: 'make question 3 harder' },
      expect.objectContaining({ body: expect.anything() }),
    )
  })

  it('drops a deferred prompt when the professor moves to a different assignment', async () => {
    // Caught by the security review: the parked prompt was the one piece of provider
    // state that outlived the panel's keyed remount. A prompt written for assignment q1
    // — deferred because Athena was still answering — would fire into q2's conversation
    // against q2's screen, where fill tools apply automatically and some can't be undone.
    chat.initialStatus = 'streaming'
    const { rerender } = render(
      <AssignmentAthenaProvider sectionId="sec-1">
        <Host assignmentId="q1" />
      </AssignmentAthenaProvider>,
    )

    fireEvent.change(askInput(), { target: { value: 'delete every question after 3' } })
    fireEvent.keyDown(askInput(), { key: 'Enter' })
    await waitFor(() => expect(dockIsOpen()).toBe(true))
    expect(chat.sendMessage).not.toHaveBeenCalled() // parked, as designed

    // Switch surface: new panelKey → fresh panel, fresh chat, fresh exactly-once ref.
    rerender(
      <AssignmentAthenaProvider sectionId="sec-1">
        <Host assignmentId="q2" />
      </AssignmentAthenaProvider>,
    )
    act(() => chat.setStatus('ready'))

    // The new conversation must never receive q1's instruction.
    await waitFor(() => expect(dockIsOpen()).toBe(true))
    expect(chat.sendMessage).not.toHaveBeenCalled()
  })

  it('opens the dock on a bare click of the bot icon, with no text required', async () => {
    renderAskLine()
    fireEvent.click(screen.getByRole('button', { name: 'Open Athena' }))

    await waitFor(() => expect(dockIsOpen()).toBe(true))
    expect(chat.sendMessage).not.toHaveBeenCalled()
  })

  it('focuses the field on Cmd+K and closes an open dock with it', async () => {
    renderAskLine()
    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    expect(document.activeElement).toBe(askInput())

    // Open it, then ⌘K again should close rather than refocus.
    fireEvent.keyDown(askInput(), { key: 'Enter' })
    await waitFor(() => expect(dockIsOpen()).toBe(true))
    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    await waitFor(() => expect(dockIsOpen()).toBe(false))

    // The ask line inherited `data-athena-trigger` from the deleted button; the dock
    // restores focus to it when the panel goes inert, or focus falls to <body> (WCAG 2.4.3).
    await waitFor(() => expect(document.activeElement).toBe(askInput()))
  })
})
