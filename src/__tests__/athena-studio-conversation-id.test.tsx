/**
 * The conversation id the Studio dock hands its panel — the piece of the persisted-chat
 * work with no visible symptom when it breaks.
 *
 * Every turn is now written to athena_conversations keyed by the id `useChat` was given
 * (see /api/assignment-assistant). The panel is remounted by a React `key` whenever the
 * scope changes, and it used to mint a fresh `crypto.randomUUID()` on every one of those
 * mounts. The transcript itself already survived a remount (the dock caches it per
 * panelKey), so nothing on screen would look wrong — but the second half of the SAME
 * visible conversation would be filed under a second row in the database. Reopening the
 * history then shows one thread split in two, each holding part of the exchange, and no
 * error is raised anywhere.
 *
 * So the three properties worth pinning are all about identity across a remount:
 *   1. leaving a scope and coming back reuses that scope's id;
 *   2. a different assignment gets a different id (the scoping this feature exists for);
 *   3. "New chat" deliberately mints a new one — and only for the scope it was pressed in.
 *
 * Harness copied from athena-panel-fill-chip.test.tsx: real provider, real panel, only the
 * chat SDK stubbed.
 */
import { useEffect } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  AssignmentAthenaProvider,
  useAthenaDock,
  useAthenaSurface,
} from '@/components/professor/assignments/athena/AssignmentAthenaDock'

/** The id the currently-mounted panel is chatting under. */
const chat = vi.hoisted(() => ({ current: '' }))

vi.mock('@ai-sdk/react', async () => {
  const React = await import('react')
  return {
    useChat: (args: { id: string }) => {
      chat.current = args.id
      const [messages, setMessages] = React.useState<unknown[]>([])
      return {
        messages,
        setMessages,
        sendMessage: vi.fn(),
        addToolResult: vi.fn(),
        status: 'ready',
        error: undefined,
        stop: vi.fn(),
      }
    },
  }
})
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))
vi.mock('@/components/professor/assignments/athena/actions', () => ({
  // Unmocked these reach real server actions → cookies(), which throws in jsdom.
  getPanelAthenaUsage: async () => ({ status: { models: [], resets_at: null } }),
  saveAssignmentDesign: vi.fn(),
  applyFrontierRubric: vi.fn(),
  listStudioConversations: async () => ({ data: [] }),
  loadStudioConversation: async () => ({ messages: [], mode: 'standard' }),
  setStudioConversationArchivedAction: async () => ({ success: true }),
}))
vi.mock('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions', () => ({
  uploadAssignmentAttachment: vi.fn(),
}))

Element.prototype.scrollIntoView = vi.fn()

/** A host screen registering itself as Athena's surface for one assignment. */
function Host({ assignmentId }: { assignmentId: string }) {
  const { setOpen } = useAthenaDock()
  useEffect(() => {
    setOpen(true)
  }, [setOpen])
  useAthenaSurface({
    active: true,
    surface: 'authoring',
    kind: 'files',
    assignmentId,
    getScreen: () => ({}),
    onFill: () => ({ summary: 'ok' }),
  })
  return null
}

const dock = (assignmentId: string) => (
  <AssignmentAthenaProvider sectionId="sec-1">
    <Host assignmentId={assignmentId} />
  </AssignmentAthenaProvider>
)

beforeEach(() => {
  vi.clearAllMocks()
  chat.current = ''
})

describe('Studio dock — the conversation id survives a remount of the same scope', () => {
  it('gives the same id back when the professor navigates away and returns', () => {
    const { rerender } = render(dock('a1'))
    const first = chat.current
    expect(first).toBeTruthy()

    rerender(dock('a2'))
    expect(chat.current).not.toBe(first)

    rerender(dock('a1'))
    // A fresh id here would file the rest of this visible conversation under a
    // SECOND athena_conversations row — the transcript still looks whole on
    // screen, so nothing catches it until the history list shows the split.
    expect(chat.current).toBe(first)
  })

  it('keeps a different assignment on its own id, which is the whole point of the scoping', () => {
    const { rerender } = render(dock('a1'))
    const first = chat.current

    rerender(dock('a2'))
    const second = chat.current

    expect(second).not.toBe(first)
    rerender(dock('a2'))
    expect(chat.current).toBe(second)
  })

  it('mints a new id on "New chat", and leaves the other scope\'s thread alone', () => {
    const { rerender } = render(dock('a1'))
    const firstOnA1 = chat.current

    rerender(dock('a2'))
    const onA2 = chat.current

    rerender(dock('a1'))
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    const secondOnA1 = chat.current

    // New chat means a genuinely new thread, not a reset of the current one.
    expect(secondOnA1).not.toBe(firstOnA1)

    // ...and it is scoped: the other assignment's in-progress conversation is
    // still exactly where it was left.
    rerender(dock('a2'))
    expect(chat.current).toBe(onA2)
  })
})
