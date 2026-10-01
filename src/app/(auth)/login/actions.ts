/**
 * Login Server Actions — helpers for the login page.
 *
 * resolveCwidToEmail: Resolves a student's 8-digit CWID to their email address,
 * but only for a caller who supplies that account's password. This enables
 * CWID-based login: the login page detects an 8-digit input, calls this action,
 * then authenticates with signInWithPassword(email, password).
 *
 * sendPasswordResetForIdentifier: the reset flow's equivalent — it has no password
 * to check, so it resolves the CWID and sends the mail entirely server-side and
 * never returns the address.
 *
 * Both use the admin client for the profiles lookup because the user isn't
 * authenticated yet and RLS would hide the row. That lookup is exactly why the
 * password gate exists: without it, this was an unauthenticated oracle mapping the
 * walkable 8-digit CWID space to real email addresses across every institution.
 */
'use server'

import { randomUUID } from 'node:crypto'
import { headers } from 'next/headers'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getSiteUrl } from '@/lib/site-url'
import { logger } from '@/lib/logger'

/** Caps for the pre-auth limiters. Failures only — a success clears the bucket. */
const CWID_ATTEMPT_CAP = 10
const IP_ATTEMPT_CAP = 50
const ATTEMPT_WINDOW_MINUTES = 60

/**
 * Caller IP for the limiters below.
 *
 * Takes the LAST x-forwarded-for entry, not the first. Cloud Run APPENDS to whatever
 * the client sent, so the leftmost value is client-supplied and spoofable — reading it
 * would hand an attacker an unlimited supply of fresh buckets just by rotating a
 * header. The rightmost entry is the one Google's infrastructure added.
 *
 * Absent header collapses everything to one bucket, which is the safe direction
 * (stricter, never more permissive). Treat this as a speed bump regardless: the
 * CWID-keyed bucket is the trustworthy bound, since an attacker cannot forge which
 * account they are attacking.
 */
async function callerIp(): Promise<string> {
  try {
    const h = await headers()
    const parts = h.get('x-forwarded-for')?.split(',').map((p) => p.trim()).filter(Boolean)
    return parts?.[parts.length - 1] || 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Claim one pre-auth attempt against every supplied bucket. Rejects if ANY is at cap.
 *
 * Cross-instance by construction: the counter lives in Postgres and the whole
 * check-and-increment is one atomic statement, so unlike the in-memory limiter this
 * replaces, spreading attempts across Cloud Run instances buys the attacker nothing.
 *
 * FAILS CLOSED. If the RPC errors, the attempt is refused. That is the opposite of the
 * Athena limiter's deliberate fail-open — there, a counter glitch must not take a
 * professor's assistant down mid-lesson. Here the protected thing is an unauthenticated
 * brute-force surface, so a broken counter must not silently become an open door.
 */
async function claimAuthAttempt(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  buckets: { key: string; cap: number }[],
): Promise<boolean> {
  for (const { key, cap } of buckets) {
    const { data, error } = await adminDb.rpc('increment_auth_rate_limit', {
      p_key: key,
      p_cap: cap,
      p_window_minutes: ATTEMPT_WINDOW_MINUTES,
    })
    if (error) {
      logger.error('claimAuthAttempt: limiter rpc failed, refusing attempt', error, { key })
      return false
    }
    const row = Array.isArray(data) ? data[0] : data
    if (!row?.accepted) {
      logger.warn('claimAuthAttempt: rate limited', { key, resetsAt: row?.resets_at })
      return false
    }
  }
  return true
}

/** Drop the buckets after a successful login so only failures ever accumulate. */
async function clearAuthAttempts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  keys: string[],
): Promise<void> {
  for (const key of keys) {
    const { error } = await adminDb.rpc('clear_auth_rate_limit', { p_key: key })
    if (error) logger.warn('clearAuthAttempts: failed', { key, error: error.message })
  }
}

/**
 * Marks a professor's invite as accepted when they arrive via an invite link.
 * Called from the login page when a hash fragment (#access_token) is detected.
 * Only updates if the current invite_status is 'pending'.
 *
 * Takes NO userId: the caller is resolved from the session. This action used to
 * accept the id to stamp, which made it a publicly callable write on any pending
 * profile in any institution — a student can read classmate profile ids from the
 * roster surfaces, and flipping someone's invite_status to 'accepted' permanently
 * strips their admin's ability to revoke or resend that invite (every one of those
 * actions requires status 'pending', and nothing sets it back). Same
 * derive-the-caller-from-the-session shape as completeOnboarding below.
 */
export async function handleInviteAcceptance(): Promise<void> {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return
    const userId = user.id

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { data: profile } = await adminDb
      .from('profiles')
      .select('invite_status')
      .eq('id', userId)
      .single()

    if (profile?.invite_status === 'pending') {
      await adminDb
        .from('profiles')
        .update({
          invite_status: 'accepted',
          invite_accepted_at: new Date().toISOString(),
        })
        .eq('id', userId)
      logger.info('handleInviteAcceptance: Invite accepted', { userId })
    }
  } catch (error) {
    logger.warn('handleInviteAcceptance: Failed', { error })
  }
}

/**
 * Called from SetPasswordDialog once the user has successfully set a password.
 * Authenticated callers ONLY operate on their own account — the caller's
 * session identity is resolved server-side; no userId argument is accepted
 * because that would be an obvious privilege-escalation vector (an attacker
 * could clear another user's requires_password_set flag and access the app
 * without ever setting a password).
 *
 * State transitions (role-aware):
 *  - Always: clears user.app_metadata.requires_password_set so middleware
 *    stops force-redirecting them to the password dialog. Only the admin
 *    client can write app_metadata, which is what makes that gate real.
 *  - Professors: marks invite_status='accepted' + invite_accepted_at. Leaves
 *    onboarding_completed=false so OnboardingGate routes them through the
 *    profile wizard (which then flips onboarding_completed=true and
 *    invite_status='active' on save or skip).
 *  - Other roles (staff TA/grader, etc.): no wizard exists — password set IS
 *    the entire onboarding. Set both onboarding_completed=true and
 *    invite_status='active' so the admin directory stops labelling them.
 */
export async function completeOnboarding(): Promise<{ success: boolean }> {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      logger.warn('completeOnboarding: Unauthenticated caller', { authError })
      return { success: false }
    }
    const userId = user.id

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Clear the middleware gate first. If a later update fails we still want
     * the user unstuck — a stale invite_status is a cosmetic directory issue;
     * a stuck requires_password_set is a lockout.
     *
     * We set the flag to `false` rather than `null`. GoTrue's admin API merges
     * app_metadata but does NOT reliably treat `null` as a delete — the key
     * gets stored as `null` (or silently ignored) depending on version, and
     * production has been seen to retain the old `true` value when null was
     * passed. Middleware's check is strict `=== true`, so `false` closes the
     * gate reliably. */
    const { error: metaError } = await adminDb.auth.admin.updateUserById(userId, {
      app_metadata: { requires_password_set: false },
    })
    if (metaError) {
      logger.error('completeOnboarding: Failed to clear requires_password_set', metaError, { userId })
    }

    const { data: profile } = await adminDb
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .single()

    const now = new Date().toISOString()

    if (profile?.role === 'professor') {
      /* Professors still need the wizard. Advance pending → accepted only;
       * the wizard's completeOnboarding will move them to active. The
       * invite_status='pending' guard makes this idempotent — re-runs after
       * the wizard finishes won't downgrade an active professor. */
      const { error } = await adminDb
        .from('profiles')
        .update({ invite_status: 'accepted', invite_accepted_at: now })
        .eq('id', userId)
        .eq('invite_status', 'pending')

      if (error) {
        logger.error('completeOnboarding: Profile update failed', error, { userId })
        return { success: false }
      }
    } else if (profile?.role === 'student') {
      /* Students don't have a wizard, but we still want a 3-state lifecycle
       * (pending → accepted → active) so the admin Students view can show the
       * same progression as Professors. Setting password = accepted; the
       * student layout flips accepted → active on first dashboard visit.
       * onboarding_completed is set so middleware stops gating the user. */
      const { error } = await adminDb
        .from('profiles')
        .update({
          invite_status: 'accepted',
          invite_accepted_at: now,
          onboarding_completed: true,
        })
        .eq('id', userId)
        .eq('invite_status', 'pending')

      if (error) {
        logger.error('completeOnboarding: Profile update failed', error, { userId })
        return { success: false }
      }
    } else {
      /* Staff and other roles: no wizard, no progression past accepted, so
       * password set goes straight to active. */
      const { error } = await adminDb
        .from('profiles')
        .update({
          invite_status: 'active',
          invite_accepted_at: now,
          onboarding_completed: true,
        })
        .eq('id', userId)
        .eq('onboarding_completed', false)

      if (error) {
        logger.error('completeOnboarding: Profile update failed', error, { userId })
        return { success: false }
      }
    }

    logger.info('completeOnboarding: Marked complete', { userId, role: profile?.role })
    return { success: true }
  } catch (error) {
    logger.warn('completeOnboarding: Failed', { error })
    return { success: false }
  }
}

/**
 * Resolves a CWID (Campus-Wide ID) to an email address, but ONLY for a caller who
 * already proved they own that account by supplying its password.
 *
 * This action is exported from a public page, so it is a publicly callable endpoint
 * reachable with no session at all. Resolving a CWID to an email on the strength of
 * the CWID alone therefore made it an unauthenticated PII-harvest oracle: CWIDs are
 * sequential 8-digit student numbers, so the whole space is walkable, and the admin
 * client meant RLS never applied. Requiring the password makes a probe useless
 * without valid credentials. Note what this does NOT buy, because an earlier version
 * of this comment claimed the opposite: verifying server-side moves the GoTrue call
 * off the caller's IP and onto the single Cloud Run egress IP, so it takes the attempt
 * OUT from behind GoTrue's per-IP limiter rather than putting it behind one. That is
 * why claimAuthAttempt() below is load-bearing and not belt-and-braces — without it
 * this action is an unthrottled password-guessing amplifier, and one attacker could
 * exhaust the shared sign-in budget for every tenant's CWID logins. It is DB-backed
 * rather than in-memory precisely because Cloud Run runs many instances: a
 * per-instance counter is bypassed by spreading attempts across them.
 *
 * Verification uses a throwaway ANON-key client with persistSession:false — the same
 * key and the same call the browser is about to make, so if the real sign-in would
 * succeed this succeeds, and no session or cookie is established here. (Deliberately
 * not the service-role client: the password grant's behaviour under a service_role
 * key is not something worth betting the login path on.)
 *
 * @param cwid - The 8-digit student ID
 * @param password - The password for that account; wrong password resolves to null
 * @returns { email } only when cwid+password identify a real account, else { email: null }
 */
export async function resolveCwidToEmail(
  cwid: string,
  password: string
): Promise<{ email: string | null }> {
  try {
    if (!cwid || !password) return { email: null }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Two buckets, because one of them alone leaves a hole: the CWID bucket bounds
       brute-forcing a single account, the IP bucket bounds WALKING the CWID space
       (where each new CWID would otherwise start with a fresh budget). Claimed BEFORE
       the lookup and the verification, so a rate-limited caller costs us neither.
       Rejection returns the same shape as a wrong password, so being throttled is not
       itself a signal that the CWID was valid. */
    const cwidBucket = `cwid:${cwid}`
    const ipBucket = `ip:${await callerIp()}`
    const allowed = await claimAuthAttempt(adminDb, [
      { key: cwidBucket, cap: CWID_ATTEMPT_CAP },
      { key: ipBucket, cap: IP_ATTEMPT_CAP },
    ])
    if (!allowed) return { email: null }
    const { data, error } = await adminDb
      .from('profiles')
      .select('email')
      .eq('cwid', cwid)
      .maybeSingle()

    if (error) logger.error('resolveCwidToEmail', error, { cwid })
    const email: string | null = error ? null : (data?.email ?? null)

    /**
     * Verify unconditionally, even when the CWID matched nothing.
     *
     * Returning early on a miss made the two outcomes identical in the RESPONSE but
     * not in the WORK: a miss cost one Postgres round-trip, a hit additionally paid a
     * full password-hash verification. That delta is far larger than network jitter,
     * so it kept a CWID-validity oracle alive over the walkable 8-digit space. Paying
     * the same cost on both paths is what actually closes it — a fixed delay floor
     * would be weaker. The sentinel address is random so it can never collide with a
     * real account, and .invalid is reserved by RFC 2606 so it can never be routable.
     *
     * Same anon key and same call the browser makes a moment later; persistSession
     * false so nothing is stored and no cookie is written.
     */
    const verifyEmail = email ?? `cwid-miss-${randomUUID()}@invalid.scholera.internal`
    const verifier = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )
    const { error: credentialError } = await verifier.auth.signInWithPassword({
      email: verifyEmail,
      password,
    })

    // A successful verification mints a real refresh token GoTrue would otherwise
    // keep forever — the browser is about to establish its own session, so discard
    // this one rather than leaving an orphan behind on every CWID login.
    //
    // scope:'local' is load-bearing. signOut() defaults to scope:'global', which
    // revokes EVERY refresh token for the user — that would sign the student out of
    // all their other devices on every CWID login, which is a worse bug than the
    // orphan it cleans up. 'local' revokes only this throwaway session's token.
    if (!credentialError) await verifier.auth.signOut({ scope: 'local' })

    if (!email || credentialError) return { email: null }

    /* Correct credentials — drop both buckets so only FAILURES ever accumulate. This
       is what keeps the cap off legitimate users: signing in successfully, however
       often, never walks anyone toward the limit. */
    await clearAuthAttempts(adminDb, [cwidBucket, ipBucket])
    return { email }
  } catch (error) {
    logger.error('resolveCwidToEmail', error, { cwid })
    return { email: null }
  }
}

/**
 * Sends a password-reset email for either an email address or a CWID, resolving the
 * CWID server-side so the address is never returned to the caller.
 *
 * The reset flow has no password to prove ownership with, so it cannot use the gate
 * above. Instead it keeps the resolution entirely on the server: the caller learns
 * only that the request was accepted, never whether the identifier matched an account
 * or what address the mail went to.
 *
 * ALWAYS returns bare success, and that is load-bearing. Reporting a send failure to the
 * caller looks like an obvious improvement — a real Supabase 500 told users "check your
 * email" for over a week — but it cannot be done here without reopening the enumeration
 * oracle. Supabase sends nothing for an unknown address and so never errors on it, and an
 * unmatched CWID goes to an unroutable sentinel that always errors. So during a mail outage
 * "the send failed" would mean "this identifier is real" and its absence would mean "it
 * isn't" — a working oracle over the 8-digit CWID space.
 *
 * The failure is surfaced two OTHER ways instead, neither of which is caller-visible:
 * logger.error (so monitoring sees it) and honest copy on the page that no longer promises
 * an email arrived. A proper fix is an identifier-INDEPENDENT mail-health signal — a banner
 * driven by recent send failures, shown to everyone regardless of input.
 */
export async function sendPasswordResetForIdentifier(
  identifier: string
): Promise<{ success: true }> {
  try {
    const trimmed = identifier.trim()
    if (!trimmed) return { success: true }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Unauthenticated, and it triggers REAL mail — so unlimited calls here are both a
       mail-bomb against any known address and a way to drain the shared Resend quota,
       which would take password resets down for every institution. Keyed on the
       identifier as well as the IP: the identifier bucket is what stops one victim
       being mail-bombed even from rotating addresses. Rejection returns the same
       success shape, so throttling reveals nothing. */
    const allowed = await claimAuthAttempt(adminDb, [
      { key: `reset:${trimmed}`, cap: CWID_ATTEMPT_CAP },
      { key: `ip:${await callerIp()}`, cap: IP_ATTEMPT_CAP },
    ])
    if (!allowed) return { success: true }

    let email = trimmed

    /* True when the CWID matched nothing and we fell through to the unroutable sentinel.
       That send is EXPECTED to fail, and its failure is account-dependent — so reporting it
       would make CWID validity observable again, reopening the exact oracle the sentinel
       closes. Real addresses report transport failures; the sentinel never does. */
    let usedSentinel = false

    if (/^\d{8}$/.test(trimmed)) {
      const { data } = await adminDb
        .from('profiles')
        .select('email')
        .eq('cwid', trimmed)
        .maybeSingle()

      /* Same equalization as resolveCwidToEmail: returning early on a miss made
         CWID validity observable by timing, since only a hit paid the cost of the
         reset call. Fall through with an unroutable sentinel instead — Supabase
         returns success for an unknown address and sends nothing, so the work
         matches and no mail is generated. */
      usedSentinel = !data?.email
      email = data?.email ?? `cwid-miss-${randomUUID()}@invalid.scholera.internal`
    }

    const supabase = await createClient()
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${getSiteUrl()}/auth/callback?redirect_to=/reset-password`,
    })
    if (error) {
      /* `sentinel` distinguishes the EXPECTED failures from real ones. Without it a mistyped
         student ID logs a line byte-identical to a live mail outage, so neither alerting nor
         a human reading the logs can tell them apart — which is why a genuine Supabase 500
         sat unnoticed from 2026-08-03 until a user complained.

         A real failure is logger.ERROR, not warn: nobody can act on a warn, and this is a
         user-visible outage. The sentinel stays warn — it is routine. */
      if (usedSentinel) {
        logger.warn('sendPasswordResetForIdentifier: sentinel send failed (expected)', { sentinel: true })
      } else {
        logger.error('sendPasswordResetForIdentifier: MAIL SEND FAILED — no reset email was created', error, {
          sentinel: false,
        })
      }
    }
  } catch (error) {
    logger.error('sendPasswordResetForIdentifier', error)
  }

  return { success: true }
}

/**
 * Records a successful sign-in by stamping profiles.last_login_at = now() for the CURRENT
 * user — the dormancy signal that drives re-engagement nudges. The caller's identity is
 * resolved server-side (getUser); no userId argument is accepted, so a client can't stamp
 * someone else's row. Password sign-in happens client-side, so this is the hook that
 * captures it (the /auth/callback route covers OAuth / magic-link flows). Best-effort,
 * fire-and-forget from the login page — a failure never blocks login.
 */
export async function recordSignIn(): Promise<void> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    await adminDb
      .from('profiles')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', user.id)
  } catch (error) {
    logger.warn('recordSignIn: Failed', { error })
  }
}
