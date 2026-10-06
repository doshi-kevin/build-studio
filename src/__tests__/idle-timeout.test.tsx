// Idle sign-out (src/lib/auth/idle-timeout.ts + src/components/shared/IdleTimeout.tsx).
//
// The pure functions decide; the component feeds them time from a cookie every
// tab shares and acts on the answer. The component tests drive the real
// component with fake timers and a cookie, because each rule they pin down (the
// warning not closing on mouse movement, a fresh login not inheriting an old
// stamp, an offline sign-out not quietly leaving the session alive) is about the
// wiring, not the math.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js'
import {
  IDLE_TIMEOUT_MS,
  IDLE_WARNING_MS,
  LAST_ACTIVE_COOKIE,
  idleState,
  parseSignedOut,
  sessionFromAccessToken,
  sessionSignedInAt,
} from '@/lib/auth/idle-timeout'

const getUser = vi.fn()
const getSession = vi.fn()
const localSignOut = vi.fn()
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getUser, getSession, signOut: localSignOut } }),
}))
const recordSignOut = vi.fn()
const signOut = vi.fn()
vi.mock('@/app/(dashboard)/dashboard/actions', () => ({
  recordSignOut: (...a: unknown[]) => recordSignOut(...a),
  signOut: (...a: unknown[]) => signOut(...a),
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import { IdleTimeout } from '@/components/shared/IdleTimeout'

const MIN = 60 * 1000
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0)

describe('idleState', () => {
  const at = (idleMs: number, extra: Partial<Parameters<typeof idleState>[0]> = {}) =>
    idleState({ now: T0, lastActiveAt: T0 - idleMs, countFrom: 0, exempt: false, ...extra })

  it('is active until the warning window opens, then warns, then expires at exactly 60 minutes', () => {
    expect(at(IDLE_TIMEOUT_MS - IDLE_WARNING_MS - 1).state).toBe('active')
    expect(at(IDLE_TIMEOUT_MS - IDLE_WARNING_MS).state).toBe('warning')
    expect(at(IDLE_TIMEOUT_MS - 1).state).toBe('warning')
    expect(at(IDLE_TIMEOUT_MS).state).toBe('expired')
  })

  it('never counts from before the session signed in, so an old stamp cannot sign a fresh login out', () => {
    expect(at(3 * IDLE_TIMEOUT_MS, { countFrom: T0 - MIN }).state).toBe('active')
  })

  it('still times out when the cookie holds no stamp', () => {
    expect(idleState({ now: T0, lastActiveAt: 0, countFrom: T0 - IDLE_TIMEOUT_MS, exempt: false }).state).toBe('expired')
  })

  it('ignores a stamp far in the future instead of renewing it every tick', () => {
    const r = idleState({ now: T0, lastActiveAt: T0 + 12 * IDLE_TIMEOUT_MS, countFrom: T0 - IDLE_TIMEOUT_MS, exempt: false })
    expect(r.state).toBe('expired')
    // A few seconds of skew between tabs is still fine.
    expect(at(-30 * 1000).state).toBe('active')
  })

  it('never expires an exempt page', () => {
    expect(at(10 * IDLE_TIMEOUT_MS, { exempt: true }).state).toBe('active')
  })
})

describe('cookie and token parsing', () => {
  it('sessionSignedInAt takes the newest amr timestamp, in ms, and null without one', () => {
    expect(sessionSignedInAt([{ method: 'password', timestamp: 100 }, { method: 'totp', timestamp: 250 }])).toBe(250_000)
    expect(sessionSignedInAt(['password'])).toBeNull()
    expect(sessionSignedInAt(undefined)).toBeNull()
  })

  it('parseSignedOut reads only known markers', () => {
    expect(parseSignedOut('idle.abc-123')).toEqual({ marker: 'idle', sessionId: 'abc-123' })
    expect(parseSignedOut('signed_out.')).toEqual({ marker: 'signed_out', sessionId: '' })
    expect(parseSignedOut('1790886473000')).toBeNull()
    expect(parseSignedOut('constructor.x')).toBeNull()
    expect(parseSignedOut(null)).toBeNull()
  })

  it('sessionFromAccessToken decodes the payload and rejects garbage', () => {
    expect(sessionFromAccessToken(token('u1', 's1', T0))).toEqual({ userId: 'u1', sessionId: 's1', signedInAt: T0 })
    expect(sessionFromAccessToken('not-a-jwt')).toBeNull()
  })
})

function token(sub: string, sessionId: string, signedInAt: number): string {
  const payload = btoa(JSON.stringify({ sub, session_id: sessionId, amr: [{ method: 'password', timestamp: signedInAt / 1000 }] }))
  return `h.${payload.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.s`
}

function setCookie(value: string) {
  document.cookie = `${LAST_ACTIVE_COOKIE}=${value}; path=/`
}
function cookieValue(): string | undefined {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${LAST_ACTIVE_COOKIE}=`))
    ?.slice(LAST_ACTIVE_COOKIE.length + 1)
}

/** Session s1 for user u1, signed in at `signedInAt` (default: just now); last_sign_in_at as given. */
function signedIn({
  user = 'u1',
  session = 's1',
  signedInAt = T0,
  lastSignInAt,
}: { user?: string; session?: string; signedInAt?: number; lastSignInAt?: number } = {}) {
  lastSignInAt ??= signedInAt
  getUser.mockResolvedValue({
    data: { user: { id: user, last_sign_in_at: new Date(lastSignInAt).toISOString() } },
    error: null,
  })
  getSession.mockResolvedValue({ data: { session: { access_token: token(user, session, signedInAt) } } })
}

const assign = vi.fn()
const originalLocation = window.location

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  getUser.mockReset()
  getSession.mockReset()
  localSignOut.mockReset().mockResolvedValue({ error: null })
  recordSignOut.mockReset().mockResolvedValue({ success: true })
  signOut.mockReset()
  assign.mockReset()
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, protocol: 'http:', assign },
  })
  document.cookie = `${LAST_ACTIVE_COOKIE}=; path=/; max-age=0`
})

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
})

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function mountAndSettle(silent = false) {
  render(<IdleTimeout silent={silent} />)
  // Let the first session check resolve, then run one tick.
  await advance(1000)
}

// Each test here runs up to two simulated hours of one-second ticks through
// React. That is milliseconds on an idle machine and several seconds on a busy
// one, so the default 5s timeout would flake (and one timeout cascades into the
// tests after it). Same budget as asset-crop.test.ts.
describe('<IdleTimeout />', { timeout: 30_000 }, () => {
  it('stays quiet for a user who is merely between clicks', async () => {
    signedIn()
    await mountAndSettle()
    await advance(30 * MIN)
    expect(screen.queryByText('Are you still there?')).toBeNull()
  })

  it('warns in the last two minutes with Stay focused, and signs only this browser out at 60', async () => {
    signedIn()
    await mountAndSettle()
    await advance(IDLE_TIMEOUT_MS - 90 * 1000)
    expect(screen.getByText('Are you still there?')).toBeTruthy()
    // A reflexive Enter from a returning user must keep them signed in.
    expect(document.activeElement?.textContent).toBe('Stay signed in')

    await advance(90 * 1000)
    expect(recordSignOut).toHaveBeenCalledWith('idle')
    expect(localSignOut).toHaveBeenCalledWith({ scope: 'local' })
    // Names the session, for the other tabs to follow.
    expect(cookieValue()).toBe('idle.s1')
    expect(assign).toHaveBeenCalledWith('/login?error=idle')
  })

  it('keeps the warning open when the mouse moves, and closes it on Stay', async () => {
    signedIn()
    await mountAndSettle()
    fireEvent.pointerDown(window) // one real interaction, so the cookie holds a stamp
    const stamp = cookieValue()
    await advance(IDLE_TIMEOUT_MS - 90 * 1000)

    // Reaching for the button is not "staying".
    fireEvent.pointerMove(window)
    await advance(2000)
    expect(screen.getByText('Are you still there?')).toBeTruthy()
    expect(cookieValue()).toBe(stamp)

    fireEvent.click(screen.getByRole('button', { name: 'Stay signed in' }))
    await advance(2000)
    expect(screen.queryByText('Are you still there?')).toBeNull()
    expect(Number(cookieValue())).toBeGreaterThan(Number(stamp))
    expect(recordSignOut).not.toHaveBeenCalled()
  })

  it('does not time out while an exempt surface is on the page, and keeps other tabs alive', async () => {
    signedIn()
    const quiz = document.createElement('div')
    quiz.setAttribute('data-idle-exempt', '')
    document.body.appendChild(quiz)
    try {
      await mountAndSettle()
      await advance(IDLE_TIMEOUT_MS * 2)
      expect(recordSignOut).not.toHaveBeenCalled()
      expect(Number(cookieValue())).toBeGreaterThan(Date.now() - 20 * 1000)
    } finally {
      quiz.remove()
    }
  })

  it('counts a playing video as activity', async () => {
    signedIn()
    const video = document.createElement('video')
    Object.defineProperty(video, 'paused', { value: false })
    document.body.appendChild(video)
    try {
      await mountAndSettle()
      await advance(IDLE_TIMEOUT_MS * 2)
      expect(recordSignOut).not.toHaveBeenCalled()
    } finally {
      video.remove()
    }
  })

  it('silent (projector) shows no dialog but still signs out', async () => {
    signedIn()
    await mountAndSettle(true)
    await advance(IDLE_TIMEOUT_MS - 60 * 1000)
    expect(screen.queryByText('Are you still there?')).toBeNull()
    await advance(60 * 1000)
    expect(assign).toHaveBeenCalledWith('/login?error=idle')
  })

  it('follows another tab that signed this session out, without logging it again', async () => {
    signedIn()
    await mountAndSettle()
    setCookie('idle.s1')
    await advance(1000)
    // Covered at once, but the shared cookies stay until the other tab's audit
    // request (which needs the session) has had its time.
    expect(screen.getByRole('alert').textContent).toContain('Signing you out')
    await advance(6000)
    expect(localSignOut).not.toHaveBeenCalled()
    await advance(3000)
    expect(localSignOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(assign).toHaveBeenCalledWith('/login?error=idle')
    expect(recordSignOut).not.toHaveBeenCalled()
  })

  it('does not let activity overwrite a sign-out the other tabs have yet to see', async () => {
    signedIn()
    await mountAndSettle()
    setCookie('signed_out.s1')
    fireEvent.pointerDown(window)
    expect(cookieValue()).toBe('signed_out.s1')
  })

  it("replaces an earlier session's sign-out marker on a fresh login", async () => {
    signedIn()
    setCookie('idle.an-older-session')
    await mountAndSettle()
    expect(assign).not.toHaveBeenCalled()
    expect(cookieValue()).toMatch(/^\d+$/)
  })

  it('finishes a sign-out that never completed when the page loads again', async () => {
    // The device was offline when this session timed out; it reloads after reconnecting.
    // The same path runs when another tab's check wrote the marker moments ago,
    // so it waits out that tab's audit request before clearing the cookies.
    signedIn()
    setCookie('idle.s1')
    await mountAndSettle()
    expect(screen.getByRole('alert').textContent).toContain('Signing you out')
    expect(localSignOut).not.toHaveBeenCalled()
    await advance(9000)
    expect(localSignOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(assign).toHaveBeenCalledWith('/login?error=idle')
  })

  it('covers the page and retries when the sign-out cannot reach Supabase', async () => {
    signedIn()
    await mountAndSettle()
    localSignOut.mockResolvedValue({ error: new AuthRetryableFetchError('Failed to fetch', 0) })
    await advance(IDLE_TIMEOUT_MS)
    expect(screen.getByRole('alert').textContent).toContain("couldn't reach Scholera")
    expect(assign).not.toHaveBeenCalled()

    localSignOut.mockResolvedValue({ error: null })
    await advance(10 * 1000)
    expect(assign).toHaveBeenCalledWith('/login?error=idle')
  })

  it('covers the page before asking Supabase, so a stalled call never leaves it visible', async () => {
    signedIn()
    await mountAndSettle()
    localSignOut.mockReturnValue(new Promise(() => {})) // offline: never settles
    await advance(IDLE_TIMEOUT_MS)
    expect(screen.getByRole('alert').textContent).toContain('Signing you out')
    expect(screen.queryByText('Are you still there?')).toBeNull()
  })

  it('treats a sign-out error as done when no session is left (a tab signing out at the same moment)', async () => {
    signedIn()
    await mountAndSettle()
    localSignOut.mockImplementation(async () => {
      getSession.mockResolvedValue({ data: { session: null } })
      return { error: new Error('Refresh result discarded: session state changed mid-flight') }
    })
    await advance(IDLE_TIMEOUT_MS)
    expect(assign).toHaveBeenCalledWith('/login?error=idle')
    expect(screen.queryByText("couldn't reach Scholera", { exact: false })).toBeNull()
  })



  it('does not let a reload buy an absent user another hour', async () => {
    // Signed in and last active 59 minutes ago; the tab reloads by itself now.
    signedIn({ signedInAt: T0 - 59 * MIN })
    setCookie(String(T0 - 59 * MIN))
    await mountAndSettle()
    expect(screen.getByText('Are you still there?')).toBeTruthy()
    await advance(MIN)
    expect(assign).toHaveBeenCalledWith('/login?error=idle')
  })

  it('records activity even while Supabase cannot be reached', async () => {
    signedIn()
    getUser.mockResolvedValue({ data: { user: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) })
    getSession.mockResolvedValue({ data: { session: null } })
    await mountAndSettle()
    for (let i = 0; i < 4; i++) {
      await advance(20 * MIN)
      fireEvent.pointerDown(window)
    }
    expect(recordSignOut).not.toHaveBeenCalled()
    expect(screen.queryByText('Are you still there?')).toBeNull()
  })

  it('never leaves the page readable while the audit call hangs', async () => {
    signedIn()
    await mountAndSettle()
    recordSignOut.mockReturnValue(new Promise(() => {}))
    await advance(IDLE_TIMEOUT_MS)
    expect(screen.getByRole('alert').textContent).toContain('Signing you out')
    await advance(9000)
    expect(localSignOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('neither audits nor ends a session that a new sign-in already replaced', async () => {
    signedIn()
    await mountAndSettle()
    await advance(IDLE_TIMEOUT_MS - 30 * 1000)
    // Someone signed in again in another tab (s2) moments before this tab expires,
    // after its last session check.
    getSession.mockResolvedValue({ data: { session: { access_token: token('u1', 's2', Date.now()) } } })
    await advance(30 * 1000)
    expect(recordSignOut).not.toHaveBeenCalled()
    expect(localSignOut).not.toHaveBeenCalled()
    expect(assign).toHaveBeenCalledWith('/login')
  })

  it('a session replaced while the audit was in flight is left alone', async () => {
    signedIn()
    await mountAndSettle()
    recordSignOut.mockImplementation(async () => {
      getSession.mockResolvedValue({ data: { session: { access_token: token('u1', 's2', Date.now()) } } })
      return { success: true }
    })
    await advance(IDLE_TIMEOUT_MS)
    expect(localSignOut).not.toHaveBeenCalled()
  })

  it("following an old session's sign-out leaves a newer session in the browser alone", async () => {
    signedIn()
    await mountAndSettle()
    // s1 signed out, and someone has already signed in again (s2) in another tab.
    getSession.mockResolvedValue({ data: { session: { access_token: token('u1', 's2', Date.now()) } } })
    setCookie('idle.s1')
    await advance(10_000)
    expect(assign).toHaveBeenCalledWith('/login?error=idle')
    expect(localSignOut).not.toHaveBeenCalled()
  })

  it('does not mistake its own login for a sign-in elsewhere', async () => {
    // amr timestamps are whole seconds; last_sign_in_at is written by the same
    // login a moment later, with sub-second precision.
    signedIn({ signedInAt: T0 - 30 * MIN, lastSignInAt: T0 - 30 * MIN + 1500 })
    await mountAndSettle()
    await advance(2 * MIN) // a second session check
    expect(recordSignOut).not.toHaveBeenCalled()
    expect(assign).not.toHaveBeenCalled()
  })

  it('"Sign out now" signs out, falling back to a local sign-out when the action fails', async () => {
    signedIn()
    signOut.mockRejectedValue(new Error('Failed to fetch'))
    await mountAndSettle()
    await advance(IDLE_TIMEOUT_MS - 90 * 1000)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out now' }))
    await advance(1000)
    expect(signOut).toHaveBeenCalled()
    expect(cookieValue()).toBe('signed_out.s1')
    expect(localSignOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(assign).toHaveBeenCalledWith('/login')
    // The server action audits manual sign-outs; the timer must not add a second row.
    expect(recordSignOut).not.toHaveBeenCalled()
  })

  it('signs this browser out when the account signed in somewhere newer', async () => {
    signedIn({ signedInAt: T0 - 30 * MIN, lastSignInAt: T0 - MIN })
    await mountAndSettle()
    expect(recordSignOut).toHaveBeenCalledWith('signed_in_elsewhere')
    expect(assign).toHaveBeenCalledWith('/login?error=signed_in_elsewhere')
  })

  it('leaves without signing out when another tab signed in as a different user', async () => {
    signedIn()
    await mountAndSettle()
    signedIn({ user: 'u2', session: 's2', signedInAt: T0 })
    await advance(2 * MIN)
    expect(assign).toHaveBeenCalledWith('/login')
    // Signing out here would sign out the new user.
    expect(localSignOut).not.toHaveBeenCalled()
  })

  it('still ends the stored session when this page never identified it', async () => {
    // Supabase unreachable for the whole hour: the session check never succeeds,
    // but the token is still stored locally.
    signedIn()
    getUser.mockResolvedValue({ data: { user: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) })
    await mountAndSettle()
    await advance(IDLE_TIMEOUT_MS)
    expect(localSignOut).toHaveBeenCalledWith({ scope: 'local' })
    // Named, so a reload finishes the job rather than reading it as an older session's.
    expect(cookieValue()).toBe('idle.s1')
  })

  it('never adopts a session that signed in after this page loaded', async () => {
    // This page never identified its session; by the time it expires, the
    // browser holds someone's fresh login.
    signedIn()
    getUser.mockResolvedValue({ data: { user: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) })
    await mountAndSettle()
    await advance(IDLE_TIMEOUT_MS - 5000)
    getSession.mockResolvedValue({ data: { session: { access_token: token('u2', 's2', Date.now()) } } })
    await advance(5000)
    expect(localSignOut).not.toHaveBeenCalled()
    expect(recordSignOut).not.toHaveBeenCalled()
    expect(assign).toHaveBeenCalledWith('/login')
  })

  it('with no session id, never clears a session that signed in after this page loaded', async () => {
    // Session unknown and unreadable at expiry; a fresh login lands during the audit wait.
    signedIn()
    getUser.mockResolvedValue({ data: { user: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) })
    await mountAndSettle()
    getSession.mockReturnValue(new Promise(() => {})) // stalled, as offline
    recordSignOut.mockImplementation(async () => {
      getSession.mockResolvedValue({ data: { session: { access_token: token('u2', 's2', Date.now()) } } })
      return { success: true }
    })
    await advance(IDLE_TIMEOUT_MS + 15_000)
    expect(localSignOut).not.toHaveBeenCalled()
  })

  it("does not sign out a new session that replaced the marker during the follow delay", async () => {
    signedIn()
    await mountAndSettle()
    setCookie('idle.s1')
    await advance(1000)
    // Someone signs in again in another tab; its first page writes a stamp.
    setCookie(String(Date.now()))
    await advance(9000)
    expect(localSignOut).not.toHaveBeenCalled()
    expect(assign).toHaveBeenCalledWith('/login?error=idle')
  })

  it('treats a network failure as no verdict, and a rejected session as over', async () => {
    signedIn()
    getUser.mockResolvedValueOnce({ data: { user: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) })
    await mountAndSettle()
    expect(assign).not.toHaveBeenCalled()

    getUser.mockResolvedValueOnce({ data: { user: null }, error: new AuthApiError('Session not found', 403, 'session_not_found') })
    await advance(2 * MIN)
    expect(localSignOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(assign).toHaveBeenCalledWith('/login')
  })
})
