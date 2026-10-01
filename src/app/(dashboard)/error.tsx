/**
 * Dashboard Error Boundary — catches errors within the (dashboard) route group.
 *
 * When any dashboard page or component throws an error, this component renders
 * instead of crashing the entire app. The rest of the layout (header, etc.)
 * stays intact — only the main content area shows the error.
 *
 * Logs the error to our centralized logger and provides a "Try again" button
 * that re-renders the failed component.
 *
 * Type: Client Component (required for error boundaries)
 */
'use client'

import { useEffect } from 'react'
import { logger } from '@/lib/logger'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    logger.error('DashboardError', error, {
      digest: error.digest,
      message: error.message,
    })
  }, [error])

  return (
    <div className="flex items-center justify-center py-16">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle>Dashboard Error</CardTitle>
        </CardHeader>
        <CardContent className="text-center space-y-4">
          <p className="text-muted-foreground">
            Something went wrong loading the dashboard.
          </p>
          <Button onClick={reset}>Try again</Button>
        </CardContent>
      </Card>
    </div>
  )
}
