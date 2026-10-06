/**
 * Login Page — email/password or CWID/password authentication form.
 *
 * Supports two login methods:
 * 1. Email + password — standard Supabase auth for professors and admins
 * 2. CWID + password — for students who log in with their 8-digit Campus-Wide ID
 *
 * CWID login flow:
 * 1. Detect if the identifier field contains exactly 8 digits (CWID pattern)
 * 2. Call resolveCwidToEmail() server action to look up the associated email
 * 3. Use the resolved email with signInWithPassword()
 *
 * Auth redirects for already-logged-in users are handled by middleware.ts,
 * not by this component.
 *
 * Type: Client Component (needs useState for form state + useRouter for navigation)
 * Tables: auth.users (read via Supabase Auth), profiles (CWID lookup via server action)
 */
'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import { SURFACE_ENTER, ENTER } from '@/lib/motion'
import { ArrowRight, AlertCircle, Map, Trophy, Radio, BookOpen, Eye, EyeOff } from 'lucide-react'
import { BrandMark } from '@/components/shared/BrandMark'
import { createClient } from '@/lib/supabase/client'
import { resolveCwidToEmail, handleInviteAcceptance, recordSignIn } from '@/app/(auth)/login/actions'
import { authErrorMessage } from '@/lib/auth/auth-error-message'
import { logger } from '@/lib/logger'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** Regex to detect an 8-digit CWID input */
const CWID_PATTERN = /^\d{8}$/

export default function LoginPage() {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /* Why the last session ended when nothing went wrong (idle timeout, signed in
     elsewhere). Shown in a neutral banner, not the red error one. */
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [processingInvite, setProcessingInvite] = useState(false)
  const [supabase] = useState(() => createClient())

  /**
   * Handle Supabase invite/magic link redirects.
   *
   * The @supabase/ssr browser client does NOT auto-process hash fragments,
   * so we manually extract tokens and call setSession(). Steps:
   * 1. Check for error hash (#error=...) — show it and bail
   * 2. Extract access_token + refresh_token from hash fragment
   * 3. Call setSession() to establish the session (no signOut first — that kills cookies)
   * 4. If setSession fails, fall back to getSession() (in case another client processed it)
   * 5. Mark invite accepted and redirect to dashboard
   */
  useEffect(() => {
    const hash = window.location.hash
    const url = new URL(window.location.href)
    const code = url.searchParams.get('code')

    /* Pick up error query param from auth callback redirect */
    const queryError = url.searchParams.get('error')
    if (queryError) {
      const messages: Record<string, string> = {
        auth_callback_failed: 'Login failed. Please try again or contact support.',
      }
      const notices: Record<string, string> = {
        idle: 'You were signed out after 60 minutes of inactivity.',
        signed_in_elsewhere: 'You were signed out because your account was signed in on another device.',
      }
      // Own-key checks: a plain lookup would let ?error=constructor reach a prototype member.
      if (Object.hasOwn(notices, queryError)) {
        setNotice(notices[queryError])
      } else {
        setError(Object.hasOwn(messages, queryError) ? messages[queryError] : 'An authentication error occurred. Please try again.')
      }
      window.history.replaceState(null, '', '/login')
      if (!hash && !code) return
    }

    /* Nothing to process — normal login page visit */
    if (!hash && !code) return

    /* 1. Error hash fragments from Supabase (e.g. otp_expired) */
    if (hash) {
      const hashParams = new URLSearchParams(hash.substring(1))
      const hashError = hashParams.get('error_description') || hashParams.get('error')
      if (hashError) {
        window.history.replaceState(null, '', '/login')
        setError(decodeURIComponent(hashError.replace(/\+/g, ' ')))
        return
      }
    }

    /* Show spinner for both implicit and PKCE flows */
    const hasInviteTokens = (hash && hash.includes('access_token')) || !!code
    if (!hasInviteTokens) return

    setProcessingInvite(true)
    setLoading(true)

    async function processInvite() {
      try {
        let userId: string | null = null

        if (hash && hash.includes('access_token')) {
          /* 2. Implicit flow — extract tokens from hash and set session */
          logger.debug('LoginPage: [STEP 1] Detected implicit flow hash')
          const hashParams = new URLSearchParams(hash.substring(1))
          const accessToken = hashParams.get('access_token')
          const refreshToken = hashParams.get('refresh_token')
          logger.debug('LoginPage: [STEP 2] Tokens extracted', {
            hasAccessToken: !!accessToken,
            hasRefreshToken: !!refreshToken,
            accessTokenLength: accessToken?.length ?? 0,
          })
          window.history.replaceState(null, '', '/login')

          if (!accessToken || !refreshToken) {
            logger.warn('LoginPage: [STEP 2-FAIL] Missing tokens in hash')
            setError('Invalid invite link. Please ask your admin to resend the invite.')
            setProcessingInvite(false)
            setLoading(false)
            return
          }

          /* Try setSession directly — do NOT signOut first as that clears cookies */
          logger.debug('LoginPage: [STEP 3] Calling setSession...')
          const { data, error: sessionError } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          })
          logger.debug('LoginPage: [STEP 4] setSession returned', {
            hasUser: !!data?.user,
            hasError: !!sessionError,
            errorMessage: sessionError?.message ?? 'none',
            errorStatus: sessionError?.status ?? 'none',
          })

          if (sessionError || !data.user) {
            /* setSession failed — check if session exists anyway (another client may have processed it) */
            logger.warn('LoginPage: [STEP 4-WARN] setSession failed, trying getSession fallback', { error: sessionError?.message })
            const { data: { session } } = await supabase.auth.getSession()
            logger.debug('LoginPage: [STEP 5] getSession fallback result', { hasSession: !!session, hasUser: !!session?.user })
            if (session?.user) {
              userId = session.user.id
              logger.info('LoginPage: [STEP 5-OK] Session found via fallback getSession', { userId })
            } else {
              logger.error('LoginPage: [STEP 5-FAIL] No session after setSession + fallback', sessionError)
              setError('Invite link has expired. Please ask your admin to resend the invite.')
              setProcessingInvite(false)
              setLoading(false)
              return
            }
          } else {
            userId = data.user.id
            logger.info('LoginPage: [STEP 4-OK] Invite session established (implicit)', { userId })
          }
        } else if (code) {
          /* 3. PKCE flow — exchange code for session */
          logger.debug('LoginPage: [STEP 1] Detected PKCE flow code')
          window.history.replaceState(null, '', '/login')
          const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)

          if (exchangeError || !data.user) {
            logger.error('LoginPage: [PKCE-FAIL] Code exchange failed', exchangeError)
            setError('Invite link has expired. Please ask your admin to resend the invite.')
            setProcessingInvite(false)
            setLoading(false)
            return
          }

          userId = data.user.id
          logger.info('LoginPage: [PKCE-OK] Invite session established', { userId })
        }

        if (userId) {
          logger.debug('LoginPage: [STEP 6] Calling handleInviteAcceptance', { userId })
          await handleInviteAcceptance()
          logger.debug('LoginPage: [STEP 7] Redirecting to /dashboard')
          // Hard redirect — soft navigation via router.push doesn't reliably
          // unmount the login page after invite processing
          window.location.href = '/dashboard'
        }
      } catch (err) {
        logger.warn('LoginPage: [CATCH] processInvite threw, trying fallback', { error: String(err) })
        /* Last resort — check if a session exists despite the error */
        try {
          const { data: { session } } = await supabase.auth.getSession()
          logger.debug('LoginPage: [CATCH-FALLBACK] getSession result', { hasSession: !!session, hasUser: !!session?.user })
          if (session?.user) {
            logger.info('LoginPage: [CATCH-OK] Session recovered via catch fallback', { userId: session.user.id })
            await handleInviteAcceptance()
            window.location.href = '/dashboard'
            return
          }
        } catch { /* ignore */ }
        setError('Something went wrong processing your invite. Please try again or ask your admin to resend.')
        setProcessingInvite(false)
        setLoading(false)
      }
    }

    processInvite()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const trimmedIdentifier = identifier.trim()
    let loginEmail = trimmedIdentifier

    /* If the identifier looks like a CWID (8 digits), resolve it to an email */
    if (CWID_PATTERN.test(trimmedIdentifier)) {
      logger.debug('LoginPage.handleLogin: CWID detected, resolving to email', { cwid: trimmedIdentifier })
      const result = await resolveCwidToEmail(trimmedIdentifier, password)

      if (!result.email) {
        // Deliberately the same message the password branch would produce: the
        // server no longer distinguishes "no such CWID" from "wrong password",
        // so the UI must not either, or it re-creates the enumeration oracle.
        setError('Invalid Student ID or password')
        setLoading(false)
        return
      }

      loginEmail = result.email
    }

    logger.debug('LoginPage.handleLogin: Attempt', { identifier: trimmedIdentifier })

    const { data, error } = await supabase.auth.signInWithPassword({
      email: loginEmail,
      password,
    })

    if (error) {
      logger.error('LoginPage.handleLogin', error, { identifier: trimmedIdentifier })
      setError(authErrorMessage(error))
      setLoading(false)
    } else {
      logger.info('LoginPage.handleLogin: Success', { identifier: trimmedIdentifier })
      /* Awaited, not fire-and-forget (#731). `void` left the request racing the
         window.location assignment a few statements down, and a full document
         navigation can abort an in-flight fetch. recordSignIn swallows its own
         failures and returns void, so awaiting it costs one fast round trip and
         cannot block or fail the login. */
      await recordSignIn()
      // Invited users still on their temp password get the SetPasswordDialog
      // auto-opened — it's a nudge, not a gate, so they can dismiss it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const needsPasswordSetup = (data.user?.app_metadata as any)?.requires_password_set === true

      /* Route by role to skip the /dashboard redirect hop. The /dashboard page
       * still handles role-aware redirects as a fallback for any other entry
       * point (manually typed URL, header logo, etc.). */
      let target = '/dashboard'
      if (data.user?.id) {
        const { data: profileRow } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', data.user.id)
          .maybeSingle()
        if (profileRow?.role === 'super_admin') target = '/super-admin'
        else if (profileRow?.role === 'institution_admin') target = '/admin'
      }

      const finalTarget = needsPasswordSetup ? `${target}?setup=password` : target
      // Hard redirect — a soft router.push right after signInWithPassword races
      // the freshly-set auth cookies against middleware, leaving the login page
      // stuck loading until a manual refresh. A full document load carries the
      // cookies so middleware sees the session on the first request. (Same
      // reason the invite flow above uses window.location.href.)
      window.location.href = finalTarget
    }
  }

  return (
    <div className="min-h-screen flex bg-background">

      {/* ── Left brand panel (desktop only) ─────────────────────────── */}
      <div className="hidden lg:flex lg:w-[45%] xl:w-[40%] flex-col justify-between bg-muted/30 border-r border-border p-12 relative overflow-hidden shrink-0">
        {/* Ambient glow */}
        <div className="absolute top-1/4 right-0 w-[500px] h-[500px] bg-foreground/[0.03] rounded-full blur-[100px] pointer-events-none" />
        <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-foreground/[0.02] rounded-full blur-[80px] pointer-events-none" />

        {/* Logo */}
        <div className="relative flex items-center gap-2.5">
          <BrandMark className="h-8 w-8" />
          <span className="font-[family-name:var(--font-instrument-serif)] text-[22px] tracking-tight">Schol<em className="italic">era</em></span>
        </div>

        {/* Main marketing content */}
        <div className="relative space-y-10">
          <div className="space-y-3">
            <p className="text-[11px] font-semibold tracking-[0.2em] uppercase text-muted-foreground">
              Built for modern education
            </p>
            <h2 className="font-[family-name:var(--font-instrument-serif)] text-[36px] leading-[1.15] tracking-tight text-foreground">
              Your entire course.
              <br />
              <em className="italic text-muted-foreground">One coherent platform.</em>
            </h2>
          </div>

          {/* Testimonial */}
          <div className="rounded-2xl border border-border bg-background p-6 space-y-4 shadow-sm">
            <p className="text-[15px] text-foreground leading-relaxed font-medium">
              &ldquo;My students know exactly what&apos;s coming, how they&apos;re doing, and where to go next. Scholera removed the chaos from my classroom entirely.&rdquo;
            </p>
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-full bg-muted border border-border flex items-center justify-center text-xs font-bold text-muted-foreground">
                PN
              </div>
              <div>
                <p className="text-[13px] font-semibold text-foreground">Dr. Priya Nair</p>
                <p className="text-[12px] text-muted-foreground">Associate Professor of Data Science</p>
              </div>
            </div>
          </div>

          {/* Platform capability tiles */}
          <div className="grid grid-cols-2 gap-3">
            {[
              { icon: Map,     label: 'Roadmaps',     value: 'Visual learning paths' },
              { icon: Trophy,  label: 'Quizzes',       value: 'Auto-graded + insights' },
              { icon: Radio,   label: 'Live Sessions', value: 'Polls, Q&A & attendance' },
              { icon: BookOpen,label: 'Gradebook',     value: 'Auto-calculated scores' },
            ].map(({ icon: Icon, label, value }) => (
              <div key={label} className="rounded-xl border border-border bg-background px-4 py-3.5 space-y-1.5 hover:-translate-y-0.5 transition-transform duration-500">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Icon className="h-3.5 w-3.5" />
                  <span className="text-[11px] font-semibold uppercase tracking-wider">{label}</span>
                </div>
                <p className="text-[13px] font-medium text-foreground">{value}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="relative text-[12px] text-muted-foreground tracking-wide">
          © {new Date().getFullYear()} Scholera Inc.
        </div>
      </div>

      {/* ── Right form panel ──────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, x: 16 }}
        animate={{ opacity: 1, x: 0 }}
        transition={SURFACE_ENTER}
        className="flex-1 flex items-center justify-center px-6 py-12"
      >
        <div className="w-full max-w-sm">
          {/* Mobile logo */}
          <div className="flex lg:hidden items-center gap-2 mb-10">
            <BrandMark className="h-7 w-7" />
            <span className="font-[family-name:var(--font-instrument-serif)] text-[20px] tracking-tight">Schol<em className="italic">era</em></span>
          </div>

          {/* Header */}
          <div className="mb-8">
            <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight mb-1.5">
              {processingInvite ? 'Setting up your account...' : 'Welcome back'}
            </h1>
            <p className="text-sm text-muted-foreground">
              {processingInvite
                ? 'Please wait while we verify your invite and log you in.'
                : 'Sign in to your account to continue.'}
            </p>
          </div>

          {processingInvite && !error ? (
            <div className="flex flex-col items-center gap-4 py-8">
              <div className="h-8 w-8 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
              <p className="text-sm text-muted-foreground">Verifying invite link...</p>
            </div>
          ) : null}

          {/* Form — hidden while processing invite */}
          <form onSubmit={handleLogin} className={processingInvite && !error ? 'hidden' : 'space-y-5'}>
            <div className="space-y-1.5">
              <Label htmlFor="identifier" className="text-sm font-medium">
                Email or Student ID
              </Label>
              <Input
                id="identifier"
                type="text"
                placeholder="you@stevens.edu or 12345678"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
                className="h-11 rounded-lg"
              />
              <p className="text-xs text-muted-foreground">
                Students: 8-digit CWID · Staff: email address
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-sm font-medium">Password</Label>
                <Link
                  href="/forgot-password"
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="h-11 rounded-lg pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-controls="password"
                  className="group absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-md transition-colors group-hover:bg-muted/60">
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </span>
                </button>
              </div>
            </div>

            {notice && !error && (
              <div
                role="status"
                className="px-3.5 py-2.5 rounded-lg bg-muted border border-border text-sm text-muted-foreground"
              >
                {notice}
              </div>
            )}

            {/* Error */}
            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={ENTER}
                  className="flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg bg-destructive/8 border border-destructive/20 text-sm text-destructive"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </motion.div>
              )}
            </AnimatePresence>

            <button
              type="submit"
              disabled={loading}
              className="group w-full h-11 rounded-full bg-primary text-primary-foreground text-[14px] font-semibold flex items-center justify-center gap-2 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 transition-[opacity,transform] duration-300"
            >
              {loading ? (
                <div className="h-4 w-4 rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground animate-spin" />
              ) : (
                <>
                  Sign In
                  <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </>
              )}
            </button>
          </form>

          {/* Footer — Scholera is invite-only; no public signup. */}
          <p className="mt-6 text-center text-sm text-muted-foreground">
            New here? Ask your institution administrator for an invite.
          </p>
        </div>
      </motion.div>
    </div>
  )
}
