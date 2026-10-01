// Onboarding gate — redirects professors to /professor/onboarding if they
// haven't completed their profile yet. Wraps all professor pages.

'use client'

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'

interface OnboardingGateProps {
  onboardingCompleted: boolean
  children: React.ReactNode
}

export function OnboardingGate({ onboardingCompleted, children }: OnboardingGateProps) {
  const pathname = usePathname()
  const router = useRouter()

  useEffect(() => {
    if (!onboardingCompleted && !pathname.startsWith('/professor/onboarding')) {
      router.replace('/professor/onboarding')
    }
  }, [onboardingCompleted, pathname, router])

  /* Allow rendering the onboarding page itself, or if already completed */
  if (!onboardingCompleted && !pathname.startsWith('/professor/onboarding')) {
    return null
  }

  return <>{children}</>
}
