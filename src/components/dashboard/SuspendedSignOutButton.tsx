// Sign-out button shown on the Account Suspended screen so users can exit
// instead of being trapped. Mirrors the logout flow in DashboardHeader.

'use client'

import { useState } from 'react'
import { signOut } from '@/app/(dashboard)/dashboard/actions'
import { Button } from '@/components/ui/button'
import { logger } from '@/lib/logger'

export function SuspendedSignOutButton() {
  const [isLoggingOut, setIsLoggingOut] = useState(false)

  const handleLogout = async () => {
    setIsLoggingOut(true)
    try {
      logger.info('SuspendedSignOutButton: signing out')
      await signOut()
    } catch (error) {
      if (error instanceof Error && error.message?.includes('NEXT_REDIRECT')) {
        throw error
      }
      logger.error('SuspendedSignOutButton', error)
      setIsLoggingOut(false)
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      onClick={handleLogout}
      disabled={isLoggingOut}
      className="rounded-full"
    >
      {isLoggingOut ? 'Signing out…' : 'Sign out'}
    </Button>
  )
}
