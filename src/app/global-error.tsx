/**
 * Global Error Boundary — catches unhandled errors at the root level.
 *
 * This is the last-resort error handler. If an error occurs in the root layout
 * or any page that isn't caught by a more specific error.tsx, this component
 * renders a full-page recovery UI.
 *
 * Must include its own <html> and <body> tags because it replaces the root layout
 * entirely when triggered. Logs the error to our centralized logger.
 *
 * The reset() function re-renders the page to attempt recovery.
 *
 * Type: Client Component (required for error boundaries)
 */
'use client'

import { useEffect } from 'react'
import { logger } from '@/lib/logger'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    logger.error('GlobalError', error, {
      digest: error.digest,
      message: error.message,
    })
  }, [error])

  return (
    <html>
      <body>
        <div className="min-h-screen flex items-center justify-center bg-background px-4">
          <div className="text-center space-y-4">
            <h1 className="font-[family-name:var(--font-instrument-serif)] text-[28px] text-foreground">Something went wrong</h1>
            <p className="text-muted-foreground">
              An unexpected error occurred. Our team has been notified.
            </p>
            <button
              onClick={reset}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-full hover:bg-primary/90 transition-colors font-medium"
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}
