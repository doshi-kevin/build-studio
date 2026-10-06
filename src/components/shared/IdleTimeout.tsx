'use client'

/**
 * Signs the user out after 60 minutes with no interaction, with a two-minute
 * warning first, and signs this browser out when the account signs in on
 * another device. Mounted once per signed-in layout (dashboard, projector) and
 * on /reset-password. Renders nothing until the warning is due.
 *
 * The rules, each one a way this goes wrong otherwise:
 *  · Time is read from the shared cookie on every tick, never counted locally.
 *    A sleeping laptop or a throttled background tab stops timers but not
 *    clocks, so the first tick after waking sees the real gap.
 *  · The clock never starts before this session signed in (read from the stored
 *    token), or before this page loaded until that is known. So an old stamp
 *    from a previous session can't sign a fresh login out, a reload doesn't buy
 *    an absent user another hour, and a tab that can't reach Supabase still
 *    times out.
 *  · While the warning is open, this tab's own mouse and keys are NOT activity.
 *    Moving the mouse to reach "Stay signed in" would otherwise close the dialog
 *    before it could be clicked. Activity in another tab still closes it.
 *  · Surfaces that are busy without input (a timed quiz, a verbal recording, a
 *    live lecture) put `data-idle-exempt` on their root while that lasts, and a
 *    playing <video>/<audio> counts the same. Exempt tabs keep the cookie fresh,
 *    which keeps every other tab (and the projector) signed in with them.
 *  · Input inside an iframe (PDF viewer, YouTube) never reaches this window.
 *    Focus moving into one counts as one interaction; reading for an hour inside
 *    it still gets the warning, and one click keeps the session.
 *  · A sign-out leaves `<reason>.<session_id>` in the cookie, and nothing but
 *    a new session's first page may overwrite it. If Supabase can't be reached
 *    (offline), the page is covered and the sign-out retried; if the page is
 *    reloaded first, the marker still names this session and the next load
 *    finishes the job.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { isAuthApiError, isAuthSessionMissingError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import { recordSignOut, signOut } from '@/app/(dashboard)/dashboard/actions'
import {
  idleState,
  parseSignedOut,
  readLastActiveCookie,
  sessionFromAccessToken,
  signedOutCookieValue,
  writeLastActiveCookie,
  type SignOutReason,
  type SignedOutMarker,
} from '@/lib/auth/idle-timeout'
import { formatTime } from '@/lib/quiz/utils'
import { logger } from '@/lib/logger'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

const TICK_MS = 1000
/** At most one cookie write per this long from ordinary activity. */
const WRITE_THROTTLE_MS = 10_000
/** How often to ask Supabase whether the account signed in somewhere newer. */
const SESSION_CHECK_MS = 2 * 60 * 1000
/** last_sign_in_at and the session's own sign-in timestamp are written a few
 *  hundred ms apart by the same login. Anything beyond this is another login. */
const SIGN_IN_SLACK_MS = 10_000
/** How often a sign-out that couldn't reach Supabase is tried again. */
const SIGN_OUT_RETRY_MS = 10_000
/** How long the deciding tab waits for its audit request before signing out
 *  anyway. Generous because the page is already covered, and a cold Cloud Run
 *  instance can take several seconds to answer a server action. */
const AUDIT_WAIT_MS = 8000
/** How long a tab following another tab's sign-out waits before clearing the
 *  shared login cookies: past AUDIT_WAIT_MS, because the deciding tab's audit
 *  request needs the session to say who signed out. */
const FOLLOW_DELAY_MS = AUDIT_WAIT_MS + 1000

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const

type SessionInfo = { userId: string; sessionId: string; signedInAt: number | null }

function isExempt(): boolean {
  if (document.querySelector('[data-idle-exempt]')) return true
  return Array.from(document.querySelectorAll<HTMLMediaElement>('video, audio')).some(
    (m) => !m.paused && !m.ended
  )
}

/** The stored session, decoded locally. No network unless the token needs a refresh. */
async function readSession(): Promise<SessionInfo | null> {
  const { data } = await createClient().auth.getSession()
  return data.session ? sessionFromAccessToken(data.session.access_token) : null
}

/** `promise`, or null if it hasn't settled within `ms`. Offline, supabase-js
 *  queues every auth call behind its own token-refresh retries for tens of
 *  seconds, and the server action can hang just as long. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))])
}

/** The cookie's stamp, or 0 when it holds a sign-out marker or nothing. */
function stampOf(raw: string | null): number {
  return /^\d+$/.test(raw ?? '') ? Number(raw) : 0
}

export function IdleTimeout({
  silent = false,
}: {
  /** Run the timer but never show the dialog. For the projector wall: nobody
   *  there can answer it, anyone in the room could tap "Sign out now", and the
   *  presenter's tab shows the same warning at the same moment. */
  silent?: boolean
} = {}) {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
  /** Covers the page from the moment a sign-out starts until the browser leaves:
   *  'signing' while Supabase is asked, 'retrying' once it couldn't be reached. */
  const [cover, setCover] = useState<null | 'signing' | 'retrying'>(null)
  const warningOpenRef = useRef(false)
  const lastWriteRef = useRef(0)
  const loadedAtRef = useRef(0)
  /* Null until the first session check answers. Until then sign-out markers are
     left alone: only that check knows whether a marker belongs to this session
     (follow it) or an earlier one (replace it). */
  const sessionRef = useRef<SessionInfo | null>(null)
  const leavingRef = useRef(false)
  /** Set while a sign-out is waiting on Supabase; the tick retries it. */
  const pendingRef = useRef<{ marker: SignedOutMarker; sessionId: string; lastTry: number } | null>(null)

  /** The clock floor: the session's sign-in time, or page load until it is known. */
  // Supabase always puts sign-in timestamps in amr. A custom access-token hook
  // that dropped them would make every reload restart the clock.
  const countFrom = useCallback(() => sessionRef.current?.signedInAt ?? loadedAtRef.current, [])

  const recordActivity = useCallback((now: number, force = false) => {
    if (leavingRef.current) return
    if (!force && now - lastWriteRef.current < WRITE_THROTTLE_MS) return
    // Never write over a sign-out: the tabs that haven't seen it yet must still follow it.
    if (parseSignedOut(readLastActiveCookie())) return
    lastWriteRef.current = now
    writeLastActiveCookie(now)
  }, [])

  /* Full-page navigation on purpose: it drops every piece of already-rendered
     data from memory, which a client-side route change would keep. */
  const leave = useCallback((reason?: SignOutReason) => {
    leavingRef.current = true
    window.location.assign(reason ? `/login?error=${reason}` : '/login')
  }, [])

  /* Clears this browser's session `sessionId`. The page is covered first,
     because the call can stall offline. If the browser already holds a different
     session (someone signed in again in another tab), that one is not ours to
     end: just leave. supabase-js keeps the session when /logout fails for a
     non-auth reason (network down, 5xx), so a failure means the user is still
     signed in: stay covered and retry rather than navigate to a /login that
     middleware would bounce straight back. */
  const finishSignOut = useCallback(
    async (marker: SignedOutMarker, sessionId: string) => {
      leavingRef.current = true
      pendingRef.current = { marker, sessionId, lastTry: Date.now() }
      setCover((c) => c ?? 'signing')
      const reason = marker === 'signed_out' ? undefined : marker
      const current = await within(readSession(), 2000)
      // Not ours: a named session that has been replaced, or, with no name, a
      // session that signed in after this page loaded (someone's fresh login).
      const notOurs = sessionId
        ? current !== null && current.sessionId !== sessionId
        : current !== null && (current.signedInAt === null || current.signedInAt > loadedAtRef.current)
      if (notOurs) {
        pendingRef.current = null
        leave(reason)
        return
      }
      const { error } = await createClient().auth.signOut({ scope: 'local' })
      if (error) {
        // Another tab signing out at the same moment also surfaces here as an
        // error. If no session is stored any more, the sign-out happened.
        const after = await within(createClient().auth.getSession(), 2000)
        if (after && !after.data.session) {
          pendingRef.current = null
          leave(reason)
          return
        }
        logger.warn('IdleTimeout.finishSignOut: retrying', { marker, message: error.message })
        setCover('retrying')
        return
      }
      pendingRef.current = null
      leave(reason)
    },
    [leave]
  )

  /* Follows a sign-out some other tab wrote (or one a reload found unfinished).
     Cover now, but clear the shared cookies only after FOLLOW_DELAY_MS: the tab
     that wrote it may still be sending its audit row, which needs the session.
     When the delay is up, read the cookie again: if a new session's first page
     has replaced the marker with a stamp meanwhile, that session is not ours to
     end, so just leave. finishSignOut also leaves any newer session alone. */
  const followTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const followSignOut = useCallback(
    (marker: SignedOutMarker) => {
      leavingRef.current = true
      setCover((c) => c ?? 'signing')
      followTimerRef.current = setTimeout(() => {
        const still = parseSignedOut(readLastActiveCookie())
        if (!still) {
          leave(marker === 'signed_out' ? undefined : marker)
          return
        }
        void finishSignOut(still.marker, still.sessionId)
      }, FOLLOW_DELAY_MS)
    },
    [finishSignOut, leave]
  )

  useEffect(() => () => {
    if (followTimerRef.current) clearTimeout(followTimerRef.current)
  }, [])

  const endSession = useCallback(
    async (reason: SignOutReason) => {
      if (leavingRef.current) return
      leavingRef.current = true
      const known = sessionRef.current?.sessionId ?? ''
      // Cover now: nothing below may leave the page readable while it waits.
      setCover('signing')
      // Marker first, synchronously, before any await. Tabs share the cookie and
      // usually expire within the same second; this way the rest follow it
      // instead of each deciding (and auditing) on its own, and no late
      // activity can undo it. Only when the session is known: a marker that
      // names no session could be followed into signing out a newer one.
      if (known) writeLastActiveCookie(signedOutCookieValue(reason, known))
      // A sign-in in another tab may already have replaced this session. Then
      // there is nothing of ours to end or to audit; just reload as the new one
      // (whose next check replaces the marker, since it names another session).
      const current = await within(readSession(), 2000)
      if (known && current && current.sessionId !== known) {
        leave()
        return
      }
      if (!known) {
        // This page never identified its session (Supabase unreachable all
        // along). The stored one is ours only if it existed when this page
        // loaded; one that signed in later is someone's fresh login.
        const ours =
          current !== null && current.signedInAt !== null && current.signedInAt <= loadedAtRef.current
        if (current && !ours) {
          leave()
          return
        }
      }
      const sessionId = known || current?.sessionId || ''
      if (!known && sessionId) writeLastActiveCookie(signedOutCookieValue(reason, sessionId))
      // Audit while the session can still say who this is, but never let a
      // stalled request hold the sign-out up.
      await within(
        recordSignOut(reason).catch((error: unknown) => {
          logger.error('IdleTimeout.endSession', error, { reason })
        }),
        AUDIT_WAIT_MS
      )
      await finishSignOut(reason, sessionId)
    },
    [finishSignOut, leave]
  )

  useEffect(() => {
    loadedAtRef.current = Date.now()
  }, [])

  useEffect(() => {
    const onActivity = () => {
      if (!warningOpenRef.current) recordActivity(Date.now())
    }
    const onBlur = () => {
      // activeElement only switches to the iframe after blur has fired.
      setTimeout(() => {
        if (document.activeElement instanceof HTMLIFrameElement) onActivity()
      }, 0)
    }
    for (const type of ACTIVITY_EVENTS) {
      window.addEventListener(type, onActivity, { capture: true, passive: true })
    }
    window.addEventListener('blur', onBlur)
    return () => {
      for (const type of ACTIVITY_EVENTS) {
        window.removeEventListener(type, onActivity, { capture: true })
      }
      window.removeEventListener('blur', onBlur)
    }
  }, [recordActivity])

  useEffect(() => {
    const tick = () => {
      const now = Date.now()
      const pending = pendingRef.current
      if (pending) {
        if (now - pending.lastTry >= SIGN_OUT_RETRY_MS) void finishSignOut(pending.marker, pending.sessionId)
        return
      }
      if (leavingRef.current) return
      const exempt = isExempt()
      if (exempt) recordActivity(now)

      const raw = readLastActiveCookie()
      if (sessionRef.current) {
        const ended = parseSignedOut(raw)
        if (ended) {
          // Another tab of this browser signed out after this page checked in.
          followSignOut(ended.marker)
          return
        }
        if (raw === null) {
          // The cookie was cleared after this page wrote it.
          leave()
          return
        }
      }

      const { state, msUntilSignOut } = idleState({
        now,
        lastActiveAt: stampOf(raw),
        countFrom: countFrom(),
        exempt,
      })
      if (state === 'expired') {
        void endSession('idle')
      } else if (state === 'warning') {
        warningOpenRef.current = true
        setSecondsLeft(Math.ceil(msUntilSignOut / 1000))
      } else if (warningOpenRef.current) {
        warningOpenRef.current = false
        setSecondsLeft(null)
      }
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick()
    }
    const id = setInterval(tick, TICK_MS)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [countFrom, endSession, finishSignOut, followSignOut, leave, recordActivity])

  useEffect(() => {
    const check = async () => {
      if (leavingRef.current) return
      const { data: { user }, error } = await createClient().auth.getUser()
      if (error) {
        // Network trouble is not a verdict. A rejected or missing session is.
        const sessionGone =
          isAuthSessionMissingError(error) ||
          (isAuthApiError(error) && (error.status === 401 || error.status === 403))
        if (sessionGone) {
          // Clear the local cookies too. If the server still saw a session,
          // middleware would bounce /login back here and this would loop.
          // The rejected session is whichever one this browser holds, even if
          // this page never got as far as recording it.
          const sessionId =
            sessionRef.current?.sessionId ?? (await within(readSession(), 2000))?.sessionId ?? ''
          writeLastActiveCookie(signedOutCookieValue('signed_out', sessionId))
          void finishSignOut('signed_out', sessionId)
        }
        return
      }
      if (!user) return
      const session = await readSession()
      if (!session) return

      // Another tab signed in as someone else: this page still shows the old
      // account's data while every request now runs as the new one.
      if (sessionRef.current && sessionRef.current.userId !== session.userId) {
        leave()
        return
      }

      const raw = readLastActiveCookie()
      const ended = parseSignedOut(raw)
      if (ended && ended.sessionId === session.sessionId) {
        // This session was signed out, by another tab whose audit may still be
        // in flight, or before the device went offline or the tab reloaded.
        sessionRef.current = session
        followSignOut(ended.marker)
        return
      }
      // First page of a new session: replace a missing stamp or an earlier
      // session's sign-out marker.
      if (raw === null || ended) writeLastActiveCookie(Date.now())
      sessionRef.current = session

      /* Single session per user is ON in the Supabase dashboard, so a newer
         sign-in means this session is being retired. Supabase only enforces that
         at this browser's next token refresh (up to an hour away) and gives no
         reason; this leaves within SESSION_CHECK_MS and says why. If
         single-session is ever turned off, remove this branch with it. */
      const lastSignIn = user.last_sign_in_at ? Date.parse(user.last_sign_in_at) : 0
      if (session.signedInAt !== null && lastSignIn > session.signedInAt + SIGN_IN_SLACK_MS) {
        void endSession('signed_in_elsewhere')
      }
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    void check()
    const id = setInterval(() => void check(), SESSION_CHECK_MS)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [endSession, finishSignOut, followSignOut, leave])

  const staySignedIn = () => {
    warningOpenRef.current = false
    setSecondsLeft(null)
    recordActivity(Date.now(), true)
  }

  // Mirrors the logout flow in DashboardHeader, with the same offline fallback
  // as the timer: if the server action can't run, clear the session here.
  const signOutNow = async () => {
    leavingRef.current = true
    try {
      await signOut()
    } catch (error) {
      if (error instanceof Error && error.message?.includes('NEXT_REDIRECT')) {
        throw error
      }
      logger.error('IdleTimeout.signOutNow', error)
      const sessionId = sessionRef.current?.sessionId ?? ''
      writeLastActiveCookie(signedOutCookieValue('signed_out', sessionId))
      await finishSignOut('signed_out', sessionId)
    }
  }

  if (cover) {
    return (
      <div
        role="alert"
        className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-2 bg-background p-6 text-center"
      >
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
        <p className="text-sm font-medium text-foreground">Signing you out</p>
        {cover === 'retrying' && (
          <p className="max-w-sm text-sm text-muted-foreground">
            We couldn&apos;t reach Scholera. This page stays hidden until the sign-out goes through.
            Check your internet connection.
          </p>
        )}
      </div>
    )
  }

  if (silent) return null

  return (
    <AlertDialog
      open={secondsLeft !== null}
      onOpenChange={(open) => {
        // Escape, Enter on the focused Stay button, or clicking it: all "stay".
        // "Sign out now" also closes the dialog, but sets leavingRef first in its onClick.
        if (!open && !leavingRef.current) staySignedIn()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you still there?</AlertDialogTitle>
          <AlertDialogDescription>
            You&apos;ve been inactive for a while. For your security, you&apos;ll be signed out in{' '}
            <span className="font-medium tabular-nums text-foreground">
              {formatTime(secondsLeft ?? 0)}
            </span>
            .
          </AlertDialogDescription>
        </AlertDialogHeader>
        {/* "Stay" is the Cancel button because Radix focuses Cancel when the dialog
            opens: a returning user's reflexive Enter must keep them signed in, the
            same as Escape. Closing runs staySignedIn via onOpenChange. */}
        <AlertDialogFooter>
          <AlertDialogAction variant="outline" onClick={signOutNow}>
            Sign out now
          </AlertDialogAction>
          <AlertDialogCancel variant="default">Stay signed in</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
