/**
 * Idle sign-out: the rules shared by the <IdleTimeout /> component and the
 * signOut server actions.
 *
 * Every tab of a browser writes the time of the user's last interaction into one
 * cookie. Cookies are shared across tabs, so activity in any tab keeps all of
 * them signed in, and one tab signing out is visible to the rest on their next
 * tick (the cookie stops holding a number).
 *
 * This is the client half. The server half lives in the Supabase dashboard
 * (Authentication -> Sessions: 24h time-box, 2h inactivity, single session per
 * user) and is mirrored for local dev in supabase/config.toml. Supabase cannot
 * see clicks, only token refreshes, which an open tab keeps doing on its own,
 * so "60 minutes with nobody at the keyboard" has to be decided here.
 */

export const IDLE_TIMEOUT_MS = 60 * 60 * 1000
export const IDLE_WARNING_MS = 2 * 60 * 1000

export const LAST_ACTIVE_COOKIE = 'scholera_last_active'

/** Why a session was ended for the user rather than by them. Doubles as the
 *  /login ?error= key that picks the message shown there. */
export type SignOutReason = 'idle' | 'signed_in_elsewhere'
export const SIGN_OUT_REASONS: readonly SignOutReason[] = ['idle', 'signed_in_elsewhere']

/** What a sign-out writes into the cookie in place of the stamp, as
 *  `<marker>.<session_id>`. Naming the session matters: every tab of that
 *  session follows it to /login, a later sign-in (a different session) simply
 *  overwrites it, and a session whose sign-out never reached Supabase (the
 *  device was offline) finishes signing out the next time a page loads. */
export type SignedOutMarker = SignOutReason | 'signed_out'
const SIGNED_OUT_MARKERS: readonly SignedOutMarker[] = [...SIGN_OUT_REASONS, 'signed_out']

export function signedOutCookieValue(marker: SignedOutMarker, sessionId: string): string {
  return `${marker}.${sessionId}`
}

/** The marker and session id from a sign-out value, or null for anything else
 *  (a stamp, a missing cookie, a hand-edited value). */
export function parseSignedOut(raw: string | null): { marker: SignedOutMarker; sessionId: string } | null {
  if (raw === null) return null
  const dot = raw.indexOf('.')
  const marker = SIGNED_OUT_MARKERS.find((m) => m === (dot === -1 ? raw : raw.slice(0, dot)))
  return marker ? { marker, sessionId: dot === -1 ? '' : raw.slice(dot + 1) } : null
}

export type IdleState = 'active' | 'warning' | 'expired'

/** A stamp further ahead than this is ignored rather than trusted. Clamping it
 *  to "now" would renew it on every tick for as long as it stays in the future. */
const FUTURE_STAMP_TOLERANCE_MS = 60 * 1000

/**
 * Where the user stands, given the last recorded activity and the earliest the
 * clock may start (`countFrom`): this session's sign-in time, or page load until
 * that is known. The clock runs from whichever is later, so a fresh login always
 * gets the full window even when an older stamp from a previous session (or
 * another account in the same browser) is still in the cookie, and a cookie with
 * no stamp still times out. A reload does not restart it once the sign-in time
 * is known.
 */
export function idleState({
  now,
  lastActiveAt,
  countFrom,
  exempt,
}: {
  now: number
  /** The cookie's stamp, or 0 when it holds none. */
  lastActiveAt: number
  countFrom: number
  exempt: boolean
}): { state: IdleState; msUntilSignOut: number } {
  if (exempt) return { state: 'active', msUntilSignOut: IDLE_TIMEOUT_MS }
  const stamp = lastActiveAt > now + FUTURE_STAMP_TOLERANCE_MS ? 0 : lastActiveAt
  const from = Math.max(Math.min(stamp, now), countFrom)
  const msUntilSignOut = Math.max(0, IDLE_TIMEOUT_MS - (now - from))
  if (msUntilSignOut === 0) return { state: 'expired', msUntilSignOut }
  if (msUntilSignOut <= IDLE_WARNING_MS) return { state: 'warning', msUntilSignOut }
  return { state: 'active', msUntilSignOut }
}

/** The session's own sign-in time: the newest timestamp in the token's amr
 *  claim (password, otp, recovery, sso...). It survives token refreshes, unlike
 *  iat. Null if the claim carries no timestamps. */
export function sessionSignedInAt(amr: unknown): number | null {
  if (!Array.isArray(amr)) return null
  const stamps = amr
    .map((e) => (typeof e === 'object' && e !== null ? (e as { timestamp?: unknown }).timestamp : null))
    .filter((t): t is number => typeof t === 'number')
  return stamps.length > 0 ? Math.max(...stamps) * 1000 : null
}

/** Who this browser's session is, read from the stored access token without a
 *  network call (same decoding as RecoveryLinkHandoff). Only used to compare the
 *  user's own tabs with each other, never to authorize anything. */
export function sessionFromAccessToken(
  accessToken: string
): { userId: string; sessionId: string; signedInAt: number | null } | null {
  try {
    const payload = accessToken.split('.')[1]
    if (!payload) return null
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      sub?: unknown
      session_id?: unknown
      amr?: unknown
    }
    if (typeof claims.sub !== 'string' || typeof claims.session_id !== 'string') return null
    return { userId: claims.sub, sessionId: claims.session_id, signedInAt: sessionSignedInAt(claims.amr) }
  } catch {
    return null
  }
}

/** The cookie's raw value: a millisecond timestamp while signed in, a
 *  signedOutCookieValue() after a sign-out, null when absent. */
export function readLastActiveCookie(): string | null {
  const prefix = `${LAST_ACTIVE_COOKIE}=`
  const entry = document.cookie.split('; ').find((c) => c.startsWith(prefix))
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : null
}

/** Writes an activity stamp or a signedOutCookieValue(). Kept a day either way:
 *  a marker has to outlive however long an offline device stays offline. */
export function writeLastActiveCookie(value: number | string): void {
  const secure = window.location.protocol === 'https:' ? '; secure' : ''
  document.cookie = `${LAST_ACTIVE_COOKIE}=${value}; path=/; max-age=86400; samesite=lax${secure}`
}
