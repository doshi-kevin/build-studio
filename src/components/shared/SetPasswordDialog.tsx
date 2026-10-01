// Set Password Dialog — shown to users who logged in via magic link and
// haven't set a password yet. After setting, they can login with email/password.
'use client'

import { useState } from 'react'
import { PASSWORD_MIN_LENGTH, passwordProblem } from '@/lib/validations/password'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { Lock, Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { createClient } from '@/lib/supabase/client'
import { completeOnboarding } from '@/app/(auth)/login/actions'

export function SetPasswordDialog() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const showSetup = searchParams.get('setup') === 'password'
  const isMandatory = searchParams.get('mandatory') === '1'

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  function handleClose() {
    // Remove the query params from URL without reload — this makes
    // showSetup false, which closes the dialog and unmounts the component.
    const url = new URL(window.location.href)
    url.searchParams.delete('setup')
    url.searchParams.delete('mandatory')
    router.replace(url.pathname + url.search, { scroll: false })
  }

  async function handleSubmit(e: React.FormEvent) {
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
    const supabase = createClient()

    // Set the password
    const { error: updateError } = await supabase.auth.updateUser({
      password,
      data: { password_set: true },
    })

    if (updateError) {
      setError(updateError.message)
      setLoading(false)
      return
    }

    /* Refresh FIRST so the server-action call that follows gets fresh session
     * cookies. Without this, the cookies sent with the completeOnboarding()
     * POST can be stale from before the password change, causing
     * `supabase.auth.getUser()` inside the action to return null and the
     * action to bail out with `{ success: false }` — leaving
     * app_metadata.requires_password_set stuck at true. Observed in prod
     * 2026-04-14: Patrick's flag remained `true` even after a successful
     * password set. */
    await supabase.auth.refreshSession()

    /* completeOnboarding: clears the middleware gate (app_metadata.requires_password_set)
     * and flips profiles.onboarding_completed. The action resolves the caller from
     * the session — we do NOT pass a userId because that would be a trust boundary. */
    await completeOnboarding()

    setLoading(false)
    toast.success('Password set! You can now login with your email and password.')
    handleClose()
  }

  if (!showSetup) return null

  return (
    <Dialog open={showSetup} onOpenChange={(v) => { if (!v && !isMandatory) handleClose() }}>
      <DialogContent
        className="sm:max-w-[420px]"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => { if (isMandatory) e.preventDefault() }}
        showCloseButton={!isMandatory}
      >
        <DialogHeader>
          <div className="flex items-center gap-3 mb-1">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-foreground/5 border border-border">
              <Lock className="h-5 w-5 text-foreground" />
            </div>
            <div>
              <DialogTitle className="font-[family-name:var(--font-instrument-serif)] text-xl">
                {isMandatory ? 'Set your password to continue' : 'Set your password'}
              </DialogTitle>
              <DialogDescription className="text-xs mt-0.5">
                {isMandatory
                  ? 'Your admin asked you to set a password before accessing Scholera.'
                  : 'So you can sign in normally next time'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label htmlFor="setup-password" className="text-sm font-medium">
              Password
            </Label>
            <div className="relative">
              <Input
                id="setup-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder={`Min. ${PASSWORD_MIN_LENGTH} characters`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={PASSWORD_MIN_LENGTH}
                className="h-10 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-controls="setup-password"
                className="group absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-md transition-colors group-hover:bg-muted/60">
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </span>
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="setup-confirm" className="text-sm font-medium">
              Confirm password
            </Label>
            <Input
              id="setup-confirm"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              placeholder="Re-enter your password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={PASSWORD_MIN_LENGTH}
              className="h-10"
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <div className="flex gap-3 pt-1">
            {!isMandatory && (
              <Button
                type="button"
                variant="ghost"
                className="flex-1"
                onClick={handleClose}
                disabled={loading}
              >
                Skip for now
              </Button>
            )}
            <Button
              type="submit"
              className={isMandatory ? 'w-full' : 'flex-1'}
              disabled={loading || !password || !confirmPassword}
            >
              {loading ? 'Setting...' : 'Set Password'}
            </Button>
          </div>

          <p className="text-[11px] text-muted-foreground/60 text-center">
            {isMandatory
              ? 'You can change your password later from your profile.'
              : 'You can always change your password later from your profile.'}
          </p>
        </form>
      </DialogContent>
    </Dialog>
  )
}
