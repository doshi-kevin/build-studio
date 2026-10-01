/**
 * #641 — students tapped a reaction, saw a "Sent" tick every time, and the professor
 * received nothing.
 *
 * The DROP itself is now addressed too. This component used to build its own channel with
 * `supabase.channel(ephemeralTopic(roomId))`, on the stated belief that Supabase dedups by
 * topic. It does not: that produced a SECOND channel object which was never subscribed, and
 * sending on an unsubscribed channel is a different path from sending on a joined one. The
 * room's subscribed ephemeral channel now arrives as a prop, so there is no way for this
 * component to send on an unjoined one. (The realtime INSERT policy on the `:ephem` topic
 * does permit an enrolled student to write, so authorization was never the problem.)
 *
 * The other half of the fix, which stands on its own:
 * `RealtimeChannel.send()` RESOLVES with 'ok' | 'timed out' | 'error' — it does not
 * reject — so the old `sendReaction(...).catch(() => {})` was unreachable and the
 * confirmation fired unconditionally.
 *
 * The oracle is what the student is told when delivery fails. Asserting that send was
 * called would pass against the old code, which called it too — and lied afterwards.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const send = vi.fn()
const toastError = vi.fn()

vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
import { StudentReactionBar } from '@/components/student/live-classroom/StudentReactionBar'

const STUDENT = '77777777-7777-4777-8777-777777777777'

/** Stand-in for the room's joined ephemeral channel, which the parent owns. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeChannel = { send: (...a: unknown[]) => send(...a) } as any

/** Tap the first reaction button in the bar. */
function tapFirstReaction() {
  const buttons = screen.getAllByRole('button')
  fireEvent.click(buttons[0])
}

describe('#641 — a reaction that is not delivered must not report "Sent"', () => {
  beforeEach(() => {
    send.mockReset()
    toastError.mockReset()
  })

  it('tells the student when the channel reports an error', async () => {
    send.mockResolvedValue('error')

    render(<StudentReactionBar userId={STUDENT} ephemeralChannel={fakeChannel} />)
    tapFirstReaction()

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(String(toastError.mock.calls[0][0])).toMatch(/didn't reach your professor/i)
  })

  it('tells the student when the send times out', async () => {
    send.mockResolvedValue('timed out')

    render(<StudentReactionBar userId={STUDENT} ephemeralChannel={fakeChannel} />)
    tapFirstReaction()

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
  })

  it('stays quiet when the reaction is delivered', async () => {
    send.mockResolvedValue('ok')

    render(<StudentReactionBar userId={STUDENT} ephemeralChannel={fakeChannel} />)
    tapFirstReaction()

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    // The success path must not nag — the button's own "Sent" beat is the feedback.
    expect(toastError).not.toHaveBeenCalled()
  })

  it('does not swallow a genuine rejection either', async () => {
    send.mockRejectedValue(new Error('socket closed'))

    render(<StudentReactionBar userId={STUDENT} ephemeralChannel={fakeChannel} />)
    tapFirstReaction()

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
  })

  it('stays inert until the room channel has actually joined', async () => {
    send.mockResolvedValue('ok')

    /* Null means the parent's channel has not finished subscribing. Firing into nothing
       here is what the old self-built channel effectively did on every tap. */
    render(<StudentReactionBar userId={STUDENT} ephemeralChannel={null} />)
    tapFirstReaction()

    await waitFor(() => expect(send).not.toHaveBeenCalled())
    expect(toastError).not.toHaveBeenCalled()
  })
})