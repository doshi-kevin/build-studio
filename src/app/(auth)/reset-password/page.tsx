/**
 * Reset Password Page — allows users to set a new password after clicking
 * the reset link from their email.
 *
 * The user arrives here via: email link → /auth/callback (exchanges code
 * for recovery session) → redirect to /reset-password.
 *
 * Uses supabase.auth.updateUser({ password }) to set the new password,
 * then signs out and redirects to login.
 *
 * Type: Client Component
 */
'use client'

// Centered auth page for setting a new password — editorial style with
// Instrument Serif headings, theme tokens, and framer-motion animations.

import { useState } from 'react'
import { PASSWORD_MIN_LENGTH, passwordProblem } from '@/lib/validations/password'
import { authErrorMessage } from '@/lib/auth/auth-error-message'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import { SURFACE_ENTER, SPRING, ENTER } from '@/lib/motion'
import { ArrowRight, AlertCircle, CheckCircle2, Eye, EyeOff } from 'lucide-react'
import { BrandMark } from '@/components/shared/BrandMark'
import { createClient } from '@/lib/supabase/client'
import { logger } from '@/lib/logger'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)
  const supabase = createClient()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const problem = passwordProblem(password)
    if (problem) {
      setError(problem)
      return
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    setLoading(true)

    const { error } = await supabase.auth.updateUser({
      password,
      data: { password_set: true },
    })

    if (error) {
      logger.error('ResetPassword: Update failed', error)
      setError(authErrorMessage(error))
      setLoading(false)
      return
    }

    logger.info('ResetPassword: Password updated successfully')

    // Sign out so user can log in fresh with new password
    await supabase.auth.signOut()
    setSuccess(true)
    setLoading(false)
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
                  <CheckCircle2 className="h-7 w-7 text-foreground" />
                </div>
              </div>
              <div className="text-center space-y-3">
                <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">
                  Password updated
                </h1>
                <p className="text-[15px] text-muted-foreground leading-relaxed">
                  Your password has been reset successfully. You can now sign in with your new password.
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
                  Set new password
                </h1>
                <p className="text-[15px] text-muted-foreground leading-relaxed">
                  Choose a strong password for your account.
                </p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-5">
                <div className="space-y-1.5">
                  <Label htmlFor="password" className="text-sm font-medium">
                    New Password
                  </Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      placeholder={`Min. ${PASSWORD_MIN_LENGTH} characters`}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={PASSWORD_MIN_LENGTH}
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

                <div className="space-y-1.5">
                  <Label htmlFor="confirmPassword" className="text-sm font-medium">
                    Confirm Password
                  </Label>
                  <div className="relative">
                    <Input
                      id="confirmPassword"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      placeholder="Re-enter your password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                      minLength={PASSWORD_MIN_LENGTH}
                      className="h-11 rounded-lg pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      aria-controls="confirmPassword"
                      className="group absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <span className="flex h-8 w-8 items-center justify-center rounded-md transition-colors group-hover:bg-muted/60">
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </span>
                    </button>
                  </div>
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
                      Update Password
                      <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                    </>
                  )}
                </button>
              </form>

              <p className="text-center text-sm text-muted-foreground">
                <Link
                  href="/login"
                  className="font-medium text-foreground hover:underline underline-offset-4"
                >
                  Back to sign in
                </Link>
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
