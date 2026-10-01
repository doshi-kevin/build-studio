/**
 * RecoveryLinkHandoff — rescues a password-reset link opened while signed in as
 * someone else (#728).
 *
 * The problem: recovery tokens arrive in the URL HASH
 * (`#access_token=…&type=recovery`), and hash fragments are never sent to the server.
 * Middleware RULE 2 sees `user && pathname === '/login'`, looks for a bypass QUERY
 * parameter (`?invite` / `?code`), finds none — because the token is in the hash — and
 * 307s to /dashboard. The login page's client code never mounts. The browser carries
 * the fragment across the redirect, so the tokens end up sitting inert in the address
 * bar of a completely normal-looking dashboard: no error, no message, nothing to
 * suggest anything was lost.
 *
 * This is not a contrived state. It is what happens whenever someone clicks a reset
 * link on a device where another account is already signed in — a shared machine, a
 * family computer, a professor helping a student.
 *
 * Why the tokens survive: `createBrowserClient` runs the PKCE flow, which looks for
 * `?code=` and ignores an implicit-flow hash entirely. So nothing has consumed them
 * client-side, and `setSession` can still complete the handoff — which is why this
 * offers to CONTINUE rather than only apologising.
 *
 * ── Security: this dialog acts on attacker-suppliable input ──────────────────────
 *
 * Anyone can send a victim `…/dashboard#access_token=<their own JWT>&type=recovery`.
 * A dialog that offered a one-click "Continue" without saying WHOSE account it was
 * switching to would be a session-fixation / login-CSRF vector: the victim ends up
 * operating inside the attacker's account and typing into it. The attacker never gets
 * the victim's tokens, but they get everything the victim then writes.
 *
 * You cannot tell a stolen-looking token from a legitimate reset link's token — they
 * are structurally identical — so the defence is to make the destination visible and
 * the action deliberate:
 *
 *   1. The target account's email is decoded from the token and shown in the title.
 *      An unfamiliar address makes the attack self-evident, and it also improves the
 *      legitimate flow, which otherwise never says which account you're switching to.
 *   2. No email in the payload → no dialog. A token we can't describe isn't offered.
 *   3. The token's own subject matching the current user → no dialog; there is nothing
 *      to hand off.
 *   4. The copy states plainly that this should only be continued if they asked for it.
 *
 * The payload is decoded WITHOUT verification and used ONLY for display. Nothing is
 * authorised on its basis — `setSession` re-validates server-side, so a forged payload
 * can at worst mislabel a token that then fails.
 *
 * Only `type=recovery` is handled. The magic-link/invite flow has no live callers —
 * `handleInviteAcceptance`, the `/i/{shortId}` short links and `createInviteRedirect`
 * are all dead, because both `createProfessor` and `approveStaffRequest` were migrated
 * to a temp-password flow after email scanners kept redeeming single-use action links
 * during pre-fetch. Handling `invite` here would mean copy describing a password step
 * that doesn't happen, for a flow nothing produces.
 *
 * The hash is stripped the moment it is read, so a reload can't re-trigger this and
 * the tokens stop being visible in the address bar.
 *
 * Type: Client Component (needs window.location.hash — invisible to the server)
 */
'use client'

import { useEffect, useState } from 'react'
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
import { createClient } from '@/lib/supabase/client'
import { logger } from '@/lib/logger'

type Tokens = { accessToken: string; refreshToken: string; email: string }

/**
 * The `email` and `sub` claims out of an unverified JWT payload, for display only.
 * Returns nulls on anything malformed rather than throwing — this runs on a value a
 * stranger can put in the address bar.
 */
function describeToken(accessToken: string): { email: string | null; sub: string | null } {
  try {
    const payload = accessToken.split('.')[1]
    if (!payload) return { email: null, sub: null }
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const claims = JSON.parse(json) as { email?: unknown; sub?: unknown }
    return {
      email: typeof claims.email === 'string' && claims.email ? claims.email : null,
      sub: typeof claims.sub === 'string' && claims.sub ? claims.sub : null,
    }
  } catch {
    return { email: null, sub: null }
  }
}

export function RecoveryLinkHandoff({
  currentEmail,
  currentUserId,
}: {
  currentEmail: string | null
  currentUserId: string | null
}) {
  const [tokens, setTokens] = useState<Tokens | null>(null)
  const [expired, setExpired] = useState(false)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    const hash = window.location.hash
    if (!hash || !hash.includes('access_token')) return

    const params = new URLSearchParams(hash.slice(1))
    const accessToken = params.get('access_token')
    const refreshToken = params.get('refresh_token')

    /* Recovery only — see the note above. An `error` hash from Supabase is a different
       conversation and not ours to hijack. */
    if (!accessToken || !refreshToken || params.get('type') !== 'recovery') return

    /* Strip before doing anything else: stops a reload re-firing this and gets the
       credentials out of the address bar. */
    window.history.replaceState(null, '', window.location.pathname + window.location.search)

    const { email, sub } = describeToken(accessToken)
    /* Can't name the account → don't offer the swap. Same subject as the current user →
       nothing to hand off. */
    if (!email || (sub && currentUserId && sub === currentUserId)) {
      logger.warn('RecoveryLinkHandoff: recovery hash ignored', {
        reason: email ? 'same-user' : 'unnamed-token',
      })
      return
    }

    logger.warn('RecoveryLinkHandoff: recovery link opened while signed in as another user')
    /* window.location.hash does not exist at render time, and reading it also has to
       strip it — a side effect. So this cannot be seeded from a lazy useState
       initializer; an effect is the correct place. Same shape as
       src/lib/discussion/hooks.ts. */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTokens({ accessToken, refreshToken, email })
  }, [currentUserId])

  const handleContinue = async () => {
    if (!tokens) return
    setWorking(true)
    const supabase = createClient()
    const { error } = await supabase.auth.setSession({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
    })
    if (error) {
      logger.error('RecoveryLinkHandoff: setSession failed', error)
      setWorking(false)
      setExpired(true)
      return
    }
    /* Full document load so middleware sees the swapped session on the first request,
       same reasoning as the login page's hard redirect. */
    window.location.href = '/reset-password'
  }

  /**
   * Sign out, THEN go to /forgot-password.
   *
   * Linking there directly is a dead end: the caller is still signed in, so middleware
   * RULE 2 matches `/forgot-password` and 307s them to /dashboard — the exact silent
   * bounce this component exists to rescue people from, reintroduced inside the rescue.
   */
  const handleRequestNew = async () => {
    setWorking(true)
    const supabase = createClient()
    await supabase.auth.signOut()
    window.location.href = '/forgot-password'
  }

  return (
    <AlertDialog
      open={tokens !== null}
      onOpenChange={(o) => { if (!o) { setTokens(null); setExpired(false) } }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {expired ? 'That link can no longer be used' : `Reset the password for ${tokens?.email}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {expired ? (
              <>
                The link has expired or has already been used. You&apos;ll need a new one —
                we can sign you out and take you to the reset form.
              </>
            ) : (
              <>
                You opened a password-reset link for <strong>{tokens?.email}</strong>
                {currentEmail ? <> while signed in as <strong>{currentEmail}</strong></> : null}.
                Continuing signs you out here and opens the reset form for that other
                account. <strong>If you didn&apos;t request this reset, don&apos;t
                continue</strong> — close this and the link stops working.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={working}>
            {expired ? 'Close' : 'Stay signed in here'}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={working}
            onClick={(e) => {
              e.preventDefault()
              if (expired) void handleRequestNew()
              else void handleContinue()
            }}
          >
            {working ? 'Working…' : expired ? 'Sign out and request a new link' : 'Continue'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
