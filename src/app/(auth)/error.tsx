// Auth error boundary — catches unhandled errors in login, signup, forgot/reset password pages.
// Shows a friendly message instead of the raw Next.js error page.
'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { AlertCircle } from 'lucide-react'
import { logger } from '@/lib/logger'

export default function AuthError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    logger.error('AuthError', error, {
      digest: error.digest,
      message: error.message,
    })
  }, [error])

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6">
      <div className="w-full max-w-sm text-center space-y-5">
        <div className="mx-auto w-12 h-12 rounded-xl border border-border bg-muted/50 flex items-center justify-center">
          <AlertCircle className="h-6 w-6 text-muted-foreground" />
        </div>
        <div>
          <h1 className="font-[family-name:var(--font-instrument-serif)] text-2xl">
            Something went wrong
          </h1>
          <p className="text-sm text-muted-foreground mt-2">
            We couldn&apos;t complete your request. Please try again.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <button
            onClick={reset}
            className="px-6 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
          >
            Try again
          </button>
          <Link
            href="/login"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Back to login
          </Link>
        </div>
      </div>
    </div>
  )
}
