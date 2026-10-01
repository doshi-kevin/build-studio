/**
 * ChangePasswordSection — form for changing password from profile page.
 *
 * Verifies current password via signInWithPassword(), then updates
 * via updateUser({ password }). Always visible (not tied to edit mode).
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { PASSWORD_MIN_LENGTH, passwordProblem } from '@/lib/validations/password'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { logger } from '@/lib/logger'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface ChangePasswordSectionProps {
  email: string
}

export function ChangePasswordSection({ email }: ChangePasswordSectionProps) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const problem = passwordProblem(newPassword, 'New password')
    if (problem) {
      setError(problem)
      return
    }

    if (newPassword !== confirmPassword) {
      setError('New passwords do not match')
      return
    }

    if (currentPassword === newPassword) {
      setError('New password must be different from current password')
      return
    }

    setLoading(true)
    const supabase = createClient()

    // Verify current password
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password: currentPassword,
    })

    if (signInError) {
      logger.error('ChangePassword: Current password verification failed', signInError)
      setError('Current password is incorrect')
      setLoading(false)
      return
    }

    // Update to new password
    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
    })

    if (updateError) {
      logger.error('ChangePassword: Update failed', updateError)
      setError(updateError.message)
      setLoading(false)
      return
    }

    logger.info('ChangePassword: Password updated successfully')
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setLoading(false)
    toast.success('Password updated successfully')
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Choose a strong password you don&apos;t use elsewhere.
      </p>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="currentPassword" className="text-sm">Current Password</Label>
          <Input
            id="currentPassword"
            type="password"
            placeholder="••••••••"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            disabled={loading}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="newPassword" className="text-sm">New Password</Label>
          <Input
            id="newPassword"
            type="password"
            placeholder="••••••••"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={PASSWORD_MIN_LENGTH}
            disabled={loading}
            aria-describedby="newPassword-hint"
          />
          {/* Persistent, not a placeholder: this form's placeholder is a dot mask, so
              the length rule was invisible until it failed — and a placeholder
              disappears on the first keystroke, exactly while the reader is composing
              the password. */}
          <p id="newPassword-hint" className="text-xs text-muted-foreground">
            At least {PASSWORD_MIN_LENGTH} characters.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirmPassword" className="text-sm">Confirm New Password</Label>
          <Input
            id="confirmPassword"
            type="password"
            placeholder="••••••••"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={PASSWORD_MIN_LENGTH}
            disabled={loading}
          />
        </div>

        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}

        <Button type="submit" size="sm" disabled={loading || !currentPassword || !newPassword || !confirmPassword}>
          {loading ? (
            <>
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              Updating...
            </>
          ) : (
            'Update Password'
          )}
        </Button>
      </form>
    </div>
  )
}
