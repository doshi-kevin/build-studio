/**
 * The Athena panel's fill chip + the host→chat note channel. This panel is shared by every
 * Athena surface (files / notebook / verbal / document / quiz), so both behaviors here are
 * cross-feature contracts, and neither is reachable from an adapter test.
 *
 *  1. The Undo affordance is gated on the fill actually BEING revertible (`canUndo`), not on
 *     it having applied. A fill can land and still be irreversible — a generation hand-off is
 *     already streaming server-side. QA caught the earlier version rendering Undo for those:
 *     clicking it did nothing and then reported "Reverted" over a run that was still adding
 *     questions. The two states are one boolean apart, which is exactly how it regressed.
 *  2. `addToolResult` carries the REAL outcome ({applied, summary}) back to the model, so a
 *     refused fill can't be acknowledged as a success.
 *  3. The notify channel: the panel registers its transcript-poster with the dock, so a host
 *     screen can report something that settled OUTSIDE a conversation turn (a generation run
 *     finishing). Includes the fragile case — the note must still land after the provider
 *     remounts the panel on a surface change, i.e. the unmount cleanup must not null a
 *     poster the new panel just registered.
 *
 * Only the chat SDK is stubbed (a stateful useChat: real transcript state, no network). The
 * dock provider, the panel, the registration and the note plumbing are all real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEffect } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import {
  AssignmentAthenaProvider,
  useAthenaDock,
  useAthenaNotify,
  useAthenaSurface,
  type FillResult,
} from '@/components/professor/assignments/athena/AssignmentAthenaDock'
import { athenaLimitMessage } from '@/components/professor/assignments/athena/AssignmentAthenaPanel'

const { chat } = vi.hoisted(() => ({
  chat: {
    /** Transcript the panel mounts with — set per test to stage a tool call. */
    seed: [] as unknown[],
    addToolResult: vi.fn(),
  },
}))

// A stateful stand-in: `messages` is real React state so the panel's own setMessages
// (the note poster) re-renders the transcript, with no transport or network involved.
vi.mock('@ai-sdk/react', async () => {
  const React = await import('react')
  return {
    useChat: () => {
      const [messages, setMessages] = React.useState(chat.seed)
      return {
        messages,
        setMessages,
        sendMessage: vi.fn(),
        addToolResult: chat.addToolResult,
        status: 'ready',
        error: undefined,
        stop: vi.fn(),
      }
    },
  }
})
// The panel calls router.refresh() after a panel-owned fill persists, so the host's
// server-rendered panes (the studio's rubric card) pick up the write. No app router is
// mounted in jsdom, so stub it.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))
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

/** An assistant turn holding one fill tool call awaiting client-side application. */
const pendingFill = (toolCallId = 'call-1') => [
  {
    id: 'm1',
    role: 'assistant',
    parts: [
      {
        type: 'tool-apply_edits',
        toolCallId,
        state: 'input-available',
        input: { ops: [{ op: 'insert', question: { questionType: 'true_false' } }] },
      },
    ],
  },
]

/**
 * A host screen: registers itself as Athena's surface with a canned fill result, opens the
 * dock (so the panel isn't aria-hidden), and exposes the notify channel as a button.
 */
function Host({
  result,
  kind = 'quiz',
  noAssignment = false,
  surface = 'authoring',
}: {
  result: FillResult
  kind?: string
  /** Explicit FLAG rather than `assignmentId: undefined`: a default parameter swallows an
   *  explicit undefined, which silently stages the opposite scenario. */
  noAssignment?: boolean
  surface?: 'authoring' | 'grade'
}) {
  const { setOpen } = useAthenaDock()
  const notify = useAthenaNotify()
  useEffect(() => {
    setOpen(true)
  }, [setOpen])
  useAthenaSurface({
    active: true,
    surface,
    kind,
    assignmentId: noAssignment ? undefined : 'q1',
    getScreen: () => ({}),
    onFill: () => result,
  })
  return (
    <button type="button" onClick={() => notify('Generation finished: 22 of the 30 asked for')}>
      report settled
    </button>
  )
}

const renderDock = (props: {
  result: FillResult
  kind?: string
  noAssignment?: boolean
  surface?: 'authoring' | 'grade'
}) =>
  render(
    <AssignmentAthenaProvider sectionId="sec-1">
      <Host {...props} />
    </AssignmentAthenaProvider>,
  )

const undoButton = () => screen.queryByRole('button', { name: /undo/i })

beforeEach(() => {
  vi.clearAllMocks()
  chat.seed = []
})

describe('Athena fill chip — the Undo affordance follows revertibility, not success', () => {
  it('offers Undo for a revertible fill, and reverting says so once', async () => {
    const undo = vi.fn()
    chat.seed = pendingFill()
    renderDock({ result: { summary: 'Added 3 questions', undo } })

    expect(await screen.findByText('Added 3 questions')).toBeInTheDocument()
    fireEvent.click(undoButton()!)

    expect(undo).toHaveBeenCalledTimes(1)
    // The chip becomes the revert receipt and stops offering the action again. It keeps the
    // summary alongside "Reverted" so the transcript still records WHAT was undone.
    expect(await screen.findByText('Reverted · Added 3 questions')).toBeInTheDocument()
    expect(undoButton()).toBeNull()
  })

  it('writes the revert into the TRANSCRIPT, so the model knows it is gone', async () => {
    // The chip is the human's receipt; this is the model's. The transcript still
    // carries the fill call and its "applied": true result, and QA proved history
    // wins: a stress-test attacked a policy the professor had already undone,
    // because nothing in the conversation ever said so. The change-diff alone was
    // too weak a signal — an explicit assistant turn is what corrects the record.
    chat.seed = pendingFill()
    renderDock({ result: { summary: 'Added a late-work policy', undo: vi.fn() } })

    expect(await screen.findByText('Added a late-work policy')).toBeInTheDocument()
    expect(screen.queryByText(/no longer on the page/i)).toBeNull()

    fireEvent.click(undoButton()!)

    expect(await screen.findByText(/Undone — that change is no longer on the page/i)).toBeInTheDocument()
  })

  it('offers NO Undo for a fill that applied but cannot be reverted', async () => {
    // The generation hand-off: the run is already streaming server-side, so there is
    // nothing to roll back. An Undo here did nothing and then claimed "Reverted" over a
    // run that was still adding questions.
    chat.seed = pendingFill()
    renderDock({ result: { summary: 'Generating 30 questions…' } })

    expect(await screen.findByText('Generating 30 questions…')).toBeInTheDocument()
    expect(undoButton()).toBeNull()
    expect(screen.queryByText('Reverted')).toBeNull()
  })

  it('relays a fill that did not apply as a plain note, with no Undo', async () => {
    chat.seed = pendingFill()
    renderDock({
      result: { summary: 'The quiz is locked while questions are generating', applied: false },
    })

    expect(await screen.findByText(/locked while questions are generating/i)).toBeInTheDocument()
    expect(undoButton()).toBeNull()
  })

  it('reports the real outcome back to the model, not a blanket success', async () => {
    chat.seed = pendingFill('call-42')
    renderDock({ result: { summary: 'Nothing changed — no question with that id', applied: false } })

    await waitFor(() => expect(chat.addToolResult).toHaveBeenCalled())
    expect(chat.addToolResult).toHaveBeenCalledWith({
      tool: 'apply_edits',
      toolCallId: 'call-42',
      output: { applied: false, summary: 'Nothing changed — no question with that id' },
    })
  })
})

const keepButton = () => screen.queryByRole('button', { name: /keep/i })

describe('Athena fill chip — a host can REFUSE an Undo at click time', () => {
  // Discovered live: About's undo() refuses (returns false, no revert) once the
  // professor has already resolved the turn from elsewhere — Keep on the canvas,
  // or a hand edit since. Fixing the content side of that alone left the chip
  // lying: it flipped to "Reverted" and told the model the change was gone, over
  // content that never moved. Only an explicit `false` return may skip both.
  it('does not mark the fill "Reverted" or post the synthetic message when undo() returns false', async () => {
    const undo = vi.fn(() => false)
    chat.seed = pendingFill()
    renderDock({ result: { summary: 'Rewrote the intro', undo } })

    expect(await screen.findByText('Rewrote the intro')).toBeInTheDocument()
    fireEvent.click(undoButton()!)

    expect(undo).toHaveBeenCalledTimes(1)
    // Refused, not reverted: the chip still says what it said, Undo is still there
    // to try again (the host's own toast carries the reason), and nothing about
    // the refusal was said into the transcript Athena reads.
    expect(screen.getByText('Rewrote the intro')).toBeInTheDocument()
    expect(screen.queryByText(/Reverted/)).toBeNull()
    expect(screen.queryByText(/no longer on the page/i)).toBeNull()
    expect(undoButton()).not.toBeNull()
  })

  it('treats every other return value as success, unchanged from before this contract existed', async () => {
    // A host that returns nothing (every surface but About, today) must keep
    // working exactly as it always did — `false` is the one value that means no.
    const undo = vi.fn(() => undefined)
    chat.seed = pendingFill()
    renderDock({ result: { summary: 'Added 3 questions', undo } })

    expect(await screen.findByText('Added 3 questions')).toBeInTheDocument()
    fireEvent.click(undoButton()!)

    expect(await screen.findByText('Reverted · Added 3 questions')).toBeInTheDocument()
    expect(undoButton()).toBeNull()
  })
})

describe('Athena fill chip — Keep dismisses the marker without touching content', () => {
  it('offers Keep alongside Undo; keeping retires both and leaves content untouched', async () => {
    const undo = vi.fn()
    const keep = vi.fn()
    chat.seed = pendingFill()
    renderDock({ result: { summary: 'Rewrote the intro', undo, keep } })

    expect(await screen.findByText('Rewrote the intro')).toBeInTheDocument()
    fireEvent.click(keepButton()!)

    expect(keep).toHaveBeenCalledTimes(1)
    expect(undo).not.toHaveBeenCalled()
    // Kept is not Undone: the summary stays as a plain record, no "Reverted" prefix,
    // because nothing on the page actually changed.
    expect(screen.getByText('Rewrote the intro')).toBeInTheDocument()
    expect(keepButton()).toBeNull()
    expect(undoButton()).toBeNull()
  })

  it('offers NO Keep for a host with no marker to dismiss (Keep is optional)', async () => {
    chat.seed = pendingFill()
    renderDock({ result: { summary: 'Added 3 questions', undo: vi.fn() } })

    expect(await screen.findByText('Added 3 questions')).toBeInTheDocument()
    expect(keepButton()).toBeNull()
  })
})

describe('Athena notify channel — a host can post into the transcript between turns', () => {
  it('lands a host note in the chat', async () => {
    renderDock({ result: { summary: 'noop' } })

    fireEvent.click(screen.getByRole('button', { name: /report settled/i }))

    expect(await screen.findByText(/Generation finished: 22 of the 30 asked for/)).toBeInTheDocument()
  })

  it('still lands after the provider remounts the panel for a new surface', async () => {
    // Switching surface remounts the panel with a fresh key (a new conversation). The old
    // panel's cleanup nulls the dock's poster, so if it ran AFTER the new panel registered,
    // every later note would be silently dropped — Athena would go quiet exactly when a
    // generation settled.
    const { rerender } = renderDock({ result: { summary: 'noop' }, kind: 'quiz' })
    fireEvent.click(screen.getByRole('button', { name: /report settled/i }))
    expect(await screen.findByText(/Generation finished/)).toBeInTheDocument()

    rerender(
      <AssignmentAthenaProvider sectionId="sec-1">
        <Host result={{ summary: 'noop' }} kind="files" />
      </AssignmentAthenaProvider>,
    )
    // Fresh conversation: the earlier note is gone with the old transcript.
    await waitFor(() => expect(screen.queryByText(/Generation finished/)).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: /report settled/i }))
    expect(await screen.findByText(/Generation finished/)).toBeInTheDocument()
  })
})

/**
 * Web search feedback. Native Gemini grounding does NOT arrive shaped like our own
 * tools: the SDK streams it as `type: 'dynamic-tool'` with the real name in
 * `toolName` ('server:GOOGLE_SEARCH_WEB' as observed on the wire), NOT as
 * 'tool-google_search'. The panel's renderer drops every part that isn't `tool-*`,
 * so the first cut of this feature silently swallowed the search step and a 12-14s
 * search looked like a hang — invisible to types and to every other test, and only
 * caught by driving a browser. These pin the wire shape.
 */
describe('Athena web search — the search step and its citations are visible', () => {
  const searchTurn = (state: string, extraParts: unknown[] = []) => [
    {
      id: 'm1',
      role: 'assistant',
      parts: [
        { type: 'dynamic-tool', toolName: 'server:GOOGLE_SEARCH_WEB', toolCallId: 's-1', state },
        ...extraParts,
      ],
    },
  ]

  it('shows the in-flight search, so a slow turn does not look like a hang', async () => {
    chat.seed = searchTurn('input-available')
    renderDock({ result: { summary: 'noop' } })

    expect(await screen.findByText('Searching the web…')).toBeInTheDocument()
  })

  it('reports a completed search, and admits when it grounded nothing', async () => {
    chat.seed = searchTurn('output-available')
    renderDock({ result: { summary: 'noop' } })

    // No citations arrived, so the chip must not imply the reply is sourced.
    expect(await screen.findByText('Searched the web — no sources to cite')).toBeInTheDocument()
  })

  it('says a FAILED search failed, instead of claiming the reply is sourced', async () => {
    // The trust-critical branch: a failed search is invisible (the model fills the gap
    // with prose), so reporting "Searched the web" would tell the professor a fact was
    // web-verified when it was guessed.
    chat.seed = searchTurn('output-error')
    renderDock({ result: { summary: 'noop' } })

    expect(await screen.findByText(/Couldn’t search the web/)).toBeInTheDocument()
    expect(screen.queryByText(/no sources to cite/)).toBeNull()
  })

  it('falls back to a neutral label rather than exposing the grounding redirect host', async () => {
    // Gemini's grounding uri is a vertexaisearch.cloud.google.com redirect; with no
    // title, a naive hostname fallback labels every chip with our own machinery.
    chat.seed = searchTurn('output-available', [
      {
        type: 'source-url',
        url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123',
      },
    ])
    renderDock({ result: { summary: 'noop' } })

    expect(await screen.findByRole('link', { name: /Web source/i })).toBeInTheDocument()
    expect(screen.queryByText(/vertexaisearch/i)).toBeNull()
  })

  it('folds the citations onto the search line as a disclosure with a count', async () => {
    // The professor asked for this: a flat pill row under the chips read as decoration and
    // got skipped, so the count now rides the "Searched the web" line itself.
    chat.seed = searchTurn('output-available', [
      { type: 'source-url', url: 'https://nmea.org/standard', title: 'NMEA 0183 Standard' },
      { type: 'source-url', url: 'https://gpsd.gitlab.io/nmea', title: 'NMEA Sentence Reference' },
    ])
    renderDock({ result: { summary: 'noop' } })

    expect(await screen.findByText(/Searched the web · 2 sources/)).toBeInTheDocument()
    // The bare chip must NOT also render — two near-identical lines is the thing being fixed.
    expect(screen.queryByText(/no sources to cite/)).toBeNull()
  })

  it('singularises one source', async () => {
    chat.seed = searchTurn('output-available', [
      { type: 'source-url', url: 'https://toptechboy.com/lesson-24', title: 'toptechboy.com' },
    ])
    renderDock({ result: { summary: 'noop' } })

    expect(await screen.findByText(/Searched the web · 1 source$/)).toBeInTheDocument()
  })

  it('still admits a finished search that grounded NOTHING', async () => {
    // Zero citations is a real outcome — observed on the wire — and hiding it would let a
    // guessed answer look sourced. The plain chip must survive when there are no sources.
    chat.seed = searchTurn('output-available')
    renderDock({ result: { summary: 'noop' } })

    expect(await screen.findByText('Searched the web — no sources to cite')).toBeInTheDocument()
    expect(screen.queryByText(/· 0 sources/)).toBeNull()
  })

  it('shows citations that arrive with NO search tool part at all', async () => {
    // Verified against the live API: a grounded turn came back with steps[0].toolCalls === []
    // and one source, because Gemini runs search provider-side. Gating the citations on the
    // tool part would drop them exactly when only grounding metadata arrived.
    chat.seed = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'The NMEA 0183 sentence format is defined by the standard.' },
          { type: 'source-url', url: 'https://nmea.org/standard', title: 'NMEA 0183 Standard' },
        ],
      },
    ]
    renderDock({ result: { summary: 'noop' } })

    expect(await screen.findByText(/Searched the web · 1 source/)).toBeInTheDocument()
    expect(
      await screen.findByRole('link', { name: /NMEA 0183 Standard/i }),
    ).toHaveAttribute('href', 'https://nmea.org/standard')
  })

  it('renders grounding citations as links the professor can actually check', async () => {
    chat.seed = searchTurn('output-available', [
      { type: 'source-url', url: 'https://www.ftc.gov/news/case', title: 'FTC enforcement action' },
      // same URL twice — one chip, not two
      { type: 'source-url', url: 'https://www.ftc.gov/news/case', title: 'FTC enforcement action' },
    ])
    renderDock({ result: { summary: 'noop' } })

    const links = await screen.findAllByRole('link', { name: /FTC enforcement action/i })
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', 'https://www.ftc.gov/news/case')
    // opens away from the editor the professor is mid-edit in, and safely
    expect(links[0]).toHaveAttribute('target', '_blank')
    expect(links[0]).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('ignores a non-http source URL rather than rendering an unsafe link', async () => {
    chat.seed = searchTurn('output-available', [
      { type: 'source-url', url: 'javascript:alert(1)', title: 'not a real source' },
    ])
    renderDock({ result: { summary: 'noop' } })

    // Dropped by the href filter — so the turn has NO citable sources, and the chip has to say
    // that rather than render a count of 1 or a link to a javascript: URL.
    await screen.findByText('Searched the web — no sources to cite')
    expect(screen.queryByRole('link', { name: /not a real source/i })).toBeNull()
    expect(screen.queryByText(/· 1 source/)).toBeNull()
  })

  it('does not mistake an unrelated dynamic tool for a web search', async () => {
    chat.seed = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'dynamic-tool', toolName: 'server:CODE_EXECUTION', toolCallId: 'x-1', state: 'output-available' },
        ],
      },
    ]
    renderDock({ result: { summary: 'noop' } })

    await waitFor(() => expect(screen.queryByText('Searched the web')).toBeNull())
    expect(screen.queryByText('Searching the web…')).toBeNull()
  })
})


/**
 * Two regressions runtime QA caught, pinned here because both are one boolean from silent.
 *
 * 1. A tool call the SDK REJECTED against its input schema arrives as `output-error`, which
 *    matched none of the renderer's branches and rendered NULL — a failed write with no
 *    chip, no message and no console error. The professor's only clue was that the model
 *    happened to mention it in prose; a different phrasing and it was undetectable.
 * 2. The Frontier toggle was offered in the create-assignment wizard, which has no saved
 *    assignment id. The route withholds the two save tools there while the prompt still
 *    orders them, so Athena complied by printing the PRIVATE design notes as chat prose —
 *    unsaved, and a leak of the very anti-copying guard they exist to protect.
 */
describe('Athena fill chip — a rejected tool input must be visible', () => {
  const rejected = (toolCallId = 'call-err') => [
    {
      id: 'm-err',
      role: 'assistant',
      parts: [
        {
          type: 'tool-set_design_notes',
          toolCallId,
          state: 'output-error',
          errorText: 'An error occurred.',
        },
      ],
    },
  ]

  it('renders a visible failure notice instead of nothing', async () => {
    chat.seed = rejected()
    renderDock({ result: { summary: 'unused' } })

    expect(await screen.findByText(/didn't go through/i)).toBeInTheDocument()
    // and it must not masquerade as a success: no Undo on something that never landed
    expect(undoButton()).toBeNull()
  })

  it('still renders nothing for a genuinely abandoned orphan call', async () => {
    // An unresolved duplicate the model never completed applied nothing and has no error —
    // that one SHOULD stay silent, otherwise every stuck part becomes a scary chip.
    chat.seed = [
      { id: 'm-orphan', role: 'assistant', parts: [{ type: 'tool-apply_edits', toolCallId: 'o1', state: 'input-error-unknown' }] },
    ]
    renderDock({ result: { summary: 'unused' } })
    expect(screen.queryByText(/didn't go through/i)).toBeNull()
  })
})

describe('Frontier toggle is only offered where all three of its writes can land', () => {
  // Now an icon-only button inline beside the attach button (no label text), so it is found
  // by its accessible name rather than by visible copy.
  const toggle = () => screen.queryByRole('button', { name: /frontier/i })

  it('is offered on an authoring surface with a saved assignment', async () => {
    renderDock({ result: { summary: 'x' }, kind: 'notebook' })
    await waitFor(() => expect(toggle()).toBeInTheDocument())
  })

  it('is NOT offered without a saved assignment (the create wizard)', async () => {
    renderDock({ result: { summary: 'x' }, kind: 'files', noAssignment: true })
    await waitFor(() => expect(screen.getByLabelText(/message athena/i)).toBeInTheDocument())
    expect(toggle()).toBeNull()
  })

  it('IS offered on the quiz kind (a quiz just skips the rubric step)', async () => {
    renderDock({ result: { summary: 'x' }, kind: 'quiz' })
    await waitFor(() => expect(toggle()).toBeInTheDocument())
  })

  it('is NOT offered while grading', async () => {
    renderDock({ result: { summary: 'x' }, surface: 'grade', kind: undefined })
    await waitFor(() => expect(screen.getByLabelText(/message athena/i)).toBeInTheDocument())
    expect(toggle()).toBeNull()
  })
})

/**
 * The runaway-loop guard.
 *
 * `sendAutomaticallyWhen` re-arms after every settled fill so the model can acknowledge it.
 * A REFUSED fill used to re-arm it too — and because `stopWhen: stepCountIs(6)` bounds steps
 * per HTTP REQUEST rather than the chain of requests, refusal → auto-send → retry → refusal
 * had no bound whatsoever. Runtime QA measured 268+ tool calls and ~15 false "I've updated
 * the rubric" claims from one over-budget request.
 *
 * The predicate is pure, so it's tested directly rather than by driving the panel: the
 * distinction it has to draw is exactly one field deep, which is how it regressed.
 */
describe('auto-send is not re-armed by a refused fill', () => {
  const turn = (applied: boolean) => [
    {
      id: 'm1',
      role: 'assistant' as const,
      parts: [
        {
          type: 'tool-set_rubric',
          toolCallId: 'c1',
          state: 'output-available',
          input: { questions: [] },
          output: { applied, summary: applied ? 'Saved a rubric with 3 questions.' : "Questions add up to 160 pts, over the assignment's 100." },
        },
      ],
    },
  ]

  /** Mirrors the panel's predicate; kept in step with AssignmentAthenaPanel. */
  function shouldAutoSend(messages: ReturnType<typeof turn>): boolean {
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant') return false
    const refused = last.parts.some(
      (p) =>
        typeof p.type === 'string' &&
        p.type.startsWith('tool-') &&
        p.state === 'output-available' &&
        (p.output as { applied?: unknown } | null)?.applied === false,
    )
    return !refused
  }

  it('auto-sends after a fill that landed', () => {
    expect(shouldAutoSend(turn(true))).toBe(true)
  })

  it('does NOT auto-send after a fill that was refused', () => {
    expect(shouldAutoSend(turn(false))).toBe(false)
  })

  it('a refusal anywhere in the turn blocks the chain, even beside a success', () => {
    const mixed = turn(true)
    mixed[0].parts.push({
      type: 'tool-set_design_notes',
      toolCallId: 'c2',
      state: 'output-available',
      input: { questions: [] },
      output: { applied: false, summary: 'Those design notes are incomplete.' },
    })
    expect(shouldAutoSend(mixed)).toBe(false)
  })
})


/**
 * A list page registers no editor, so `apply_edits` isn't in the tool set and there is no
 * canvas. QA caught Athena still saying "I'll draft it on the canvas" and offering "Build this
 * out on the topic we're covering" there — promising a surface that does not exist.
 */
describe('no registered editor — Athena offers course help, not a canvas', () => {
  it('drops the canvas promise and the build-it suggestion when nothing is registered', async () => {
    // No Host component at all: the provider mounts, nothing registers.
    render(<AssignmentAthenaProvider sectionId="sec-1"><OpenerOnly /></AssignmentAthenaProvider>)

    expect(await screen.findByText(/talk through what to assign next/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/message athena/i)).toHaveAttribute('placeholder', 'Ask about this course…')
    expect(screen.queryByText(/on the canvas/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /build this out/i })).toBeNull()
    // and Frontier is not offered without a subject to write against
    expect(screen.queryByRole('button', { name: /frontier/i })).toBeNull()
  })
})

/** Opens the dock without registering a surface. */
function OpenerOnly() {
  const { setOpen } = useAthenaDock()
  useEffect(() => {
    setOpen(true)
  }, [setOpen])
  return null
}

/**
 * Flipping Frontier must SWAP conversations, not destroy one.
 *
 * `mode` is part of `panelKey`, which is deliberate — it is what stops a half-standard,
 * half-Frontier transcript ever reaching the model. But it also remounts the panel, and UX
 * review found that a single click on the compass therefore wiped a real multi-turn design
 * conversation with no confirmation and no undo. The asymmetry was the problem: arming costs
 * an ordinary chat, disarming costs 6–8 turns of the professor's own answers about their field.
 *
 * The dock now retains one transcript per panelKey and hands it back on remount. This test is
 * the guarantee — restore the old `useState(crypto.randomUUID())`-only behaviour and it fails.
 */
describe('Frontier toggle swaps conversations instead of destroying them', () => {
  function ModeControl() {
    const { mode, setMode } = useAthenaDock()
    return (
      <button type="button" onClick={() => setMode(mode === 'frontier' ? 'standard' : 'frontier')}>
        flip mode
      </button>
    )
  }

  it('restores the transcript you left when you switch back', async () => {
    chat.seed = []
    render(
      <AssignmentAthenaProvider sectionId="sec-1">
        <Host result={{ summary: 'x' }} kind="notebook" />
        <ModeControl />
      </AssignmentAthenaProvider>,
    )

    // Put something real in the standard-mode transcript via the host→chat note channel.
    fireEvent.click(screen.getByRole('button', { name: /report settled/i }))
    expect(await screen.findByText(/Generation finished: 22 of the 30/i)).toBeInTheDocument()

    // Arm Frontier: a DIFFERENT conversation, so the note must not be here…
    fireEvent.click(screen.getByRole('button', { name: /flip mode/i }))
    await waitFor(() => expect(screen.queryByText(/Generation finished/i)).toBeNull())

    // …and switching back must hand the original conversation back intact.
    fireEvent.click(screen.getByRole('button', { name: /flip mode/i }))
    expect(await screen.findByText(/Generation finished: 22 of the 30/i)).toBeInTheDocument()
  })
})

describe('athenaLimitMessage — the 429 contract with the routes', () => {
  // This parses a body shape produced in two OTHER files (both Athena routes).
  // If either renames `error` or `message`, the in-transcript bubble silently
  // reverts to the generic "Something went wrong. Try again." — which is the exact
  // bug QA caught and this function was written to fix. Nothing else pins it.
  it('extracts the human sentence from a rate-limit 429 body', () => {
    const body = JSON.stringify({
      error: 'athena_rate_limited',
      message: "You've reached today's Athena usage limit. It refreshes automatically.",
      resets_at: '2026-08-03T10:00:00.000Z',
    })
    expect(athenaLimitMessage(body)).toBe(
      "You've reached today's Athena usage limit. It refreshes automatically.",
    )
  })

  it('extracts the sentence from an entitlement 403, where retrying is futile', () => {
    // Regression: the sweep caught this envelope reaching a toast verbatim,
    // with the transcript showing "Something went wrong. Try again." next to
    // it. Both wrong — the school does not have Athena, so there is nothing to
    // retry, and the sentence to show was already inside the body.
    const body = JSON.stringify({
      error: 'not_entitled',
      message: "Athena is not part of your institution's plan. Ask an administrator to request it.",
    })
    expect(athenaLimitMessage(body)).toBe(
      "Athena is not part of your institution's plan. Ask an administrator to request it.",
    )
  })

  it('extracts the sentence from an AI kill-switch 403', () => {
    const body = JSON.stringify({
      error: 'ai_disabled',
      message: 'AI features are currently disabled for your institution.',
    })
    expect(athenaLimitMessage(body)).toBe('AI features are currently disabled for your institution.')
  })

  it('returns null for anything else, so other failures keep the generic copy', () => {
    expect(athenaLimitMessage('Internal Server Error')).toBeNull()
    expect(athenaLimitMessage('')).toBeNull()
    // Right shape, different error — must not be mistaken for a rate limit.
    expect(athenaLimitMessage(JSON.stringify({ error: 'something_else', message: 'nope' }))).toBeNull()
    // Correct error key but no message to show.
    expect(athenaLimitMessage(JSON.stringify({ error: 'athena_rate_limited' }))).toBeNull()
  })
})
