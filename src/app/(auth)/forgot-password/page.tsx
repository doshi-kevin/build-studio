/**
 * Forgot Password Page — sends a password reset link via Supabase Auth.
 *
 * Supports both email and CWID input. Resolution and sending both happen in the
 * sendPasswordResetForIdentifier() server action, so a CWID is never resolved to an
 * address in the browser — that lookup used to be an unauthenticated email-harvest
 * oracle over the sequential 8-digit CWID space.
 *
 * The action wraps Supabase's resetPasswordForEmail(), which sends an email
 * with a link that redirects through /auth/callback → /reset-password.
 *
 * Type: Client Component
 */
'use client'

// Centered auth page for password reset requests — editorial style with
// Instrument Serif headings, theme tokens, and framer-motion animations.

import { useState } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import { SURFACE_ENTER, SPRING, ENTER } from '@/lib/motion'
import { ArrowLeft, ArrowRight, AlertCircle, MailCheck } from 'lucide-react'
import { BrandMark } from '@/components/shared/BrandMark'
import { logger } from '@/lib/logger'
import { sendPasswordResetForIdentifier } from '@/app/(auth)/login/actions'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const trimmed = identifier.trim()

    /* Resolution and sending both happen server-side so the caller never learns the address
       behind a CWID, nor whether the identifier matched an account — and deliberately not
       whether the send itself succeeded either. Conditioning this panel on the send result
       would make "it failed" mean "this identifier is real" during a mail outage, which is
       the enumeration oracle the server action is built to avoid. The honesty lives in the
       COPY below instead, which no longer claims an email is on its way. */
    try {
      await sendPasswordResetForIdentifier(trimmed)
      setSuccess(true)
    } catch (err) {
      /* With no network the server-action fetch REJECTS. Uncaught, neither
         setSuccess nor setLoading ran, so the button kept its spinner forever and
         reconnecting did not heal it — only a full reload did (#729). Someone
         resetting a password is often on a flaky connection, which makes this more
         likely than it looks.

         Note this failure is safe to report honestly: it says the request never
         left the browser, which reveals nothing about whether the identifier exists.
         That is why the success panel deliberately does NOT depend on the send
         result — see the comment above. */
      logger.error('ForgotPasswordPage.handleSubmit', err)
      setError('We couldn\'t reach Scholera. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6 relative overflow-hidden">
      {/* Subtle background glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-foreground/[0.02] rounded-full blur-[100px] pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={SURFACE_ENTER}
        className="relative w-full max-w-[400px]"
      >
        {/* Logo */}
        <div className="flex items-center gap-2.5 mb-12">
          <BrandMark className="h-8 w-8" />
          <span className="font-[family-name:var(--font-instrument-serif)] text-[22px] tracking-tight">
            Schol<em className="italic">era</em>
          </span>
        </div>

        <AnimatePresence mode="wait">
          {success ? (
            /* ── Success state ──────────────────────────────────────── */
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={SPRING}
              className="space-y-8"
            >
              <div className="flex justify-center">
                <div className="h-16 w-16 rounded-full bg-foreground/5 border border-border flex items-center justify-center">
                  <MailCheck className="h-7 w-7 text-foreground" />
                </div>
              </div>
              <div className="text-center space-y-3">
                <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">
                  Check your email
                </h1>
                <p className="text-[15px] text-muted-foreground leading-relaxed">
                  If an account exists with that email or Student ID, you may receive a reset
                  link. If one arrives, follow it to set a new password. Delivery can take a few
                  minutes, so check spam too.{' '}
                  {/* Deliberately non-committal: "you MAY receive". The action returns success
                      even when Supabase rejects the send, and it must — conditioning this panel
                      on the send result would leak whether the identifier is real. So the copy
                      cannot promise delivery at all. An earlier pass said "we've sent", and a
                      Supabase 500 meant nothing was ever created; the next said "is on its way",
                      which is the same promise in softer words (caught in review). The escape
                      hatch below is shown to everyone, so it leaks nothing either. */}
                  <span className="block mt-2 text-muted-foreground">
                    Nothing after 10 minutes? Email{' '}
                    <a
                      href="mailto:support@scholera-inc.com"
                      className="underline underline-offset-4 hover:no-underline"
                    >
                      support@scholera-inc.com
                    </a>{' '}
                    and we&apos;ll reset it for you.
                  </span>
                </p>
              </div>
              <Link
                href="/login"
                className="group w-full h-11 rounded-full bg-primary text-primary-foreground text-[14px] font-semibold flex items-center justify-center gap-2 hover:scale-[1.02] active:scale-[0.98] transition-transform duration-300"
              >
                Back to sign in
              </Link>
            </motion.div>
          ) : (
            /* ── Form state ─────────────────────────────────────────── */
            <motion.div key="form" className="space-y-8">
              <div className="space-y-3">
                <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">
                  Reset your password
                </h1>
                <p className="text-[15px] text-muted-foreground leading-relaxed">
                  Enter your email address or Student ID and we&apos;ll send you a link to reset your password.
                </p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-5">
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
                      Send Reset Link
                      <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                    </>
                  )}
                </button>
              </form>

              <div className="text-center">
                <Link
                  href="/login"
                  className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back to sign in
                </Link>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
