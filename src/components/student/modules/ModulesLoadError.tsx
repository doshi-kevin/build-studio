/**
 * ModulesLoadError — shown when the materials query itself fails.
 *
 * Distinct from the empty state on purpose: "your instructor hasn't published
 * anything" and "we couldn't reach the server" call for different next steps,
 * and the page used to show the first message for both. Plain language, no
 * status codes — the technical detail is logged server-side.
 *
 * Type: Client Component (needs router.refresh for the retry)
 */
'use client'

import { useRouter } from 'next/navigation'
import { RefreshCw, WifiOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/professor/PageHeader'

export function ModulesLoadError() {
  const router = useRouter()

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title="Modules" description="Course content organized by week." />
      <div className="rounded-2xl border border-dashed border-border bg-card/50 px-4 py-16 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-muted">
          <WifiOff className="h-6 w-6 text-muted-foreground" aria-hidden />
        </div>
        <h3 className="mt-4 text-base font-semibold">Couldn’t load your course materials</h3>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          Something went wrong on our end — your materials are still there. Check your connection
          and try again.
        </p>
        <Button className="mt-6" onClick={() => router.refresh()}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          Try again
        </Button>
      </div>
    </div>
  )
}
