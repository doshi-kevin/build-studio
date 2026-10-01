/**
 * Root not-found boundary — the app-wide catch-all for unmatched URLs and for
 * notFound() calls from any route without a nearer boundary. In practice that's
 * the public surface: mistyped URLs, a revoked certificate link (/c/[publicId]),
 * /catalog, and the landing page.
 *
 * Supplies its own full-page frame because it renders outside the dashboard
 * chrome — there's no sidebar here, so the brand mark is the only orientation
 * the visitor gets.
 *
 * IMPORTANT: this file is statically generated at build time. It must never call
 * cookies(), headers(), or any other dynamic API — doing so breaks the build.
 * That's why the CTA is a hardcoded href rather than a role-aware destination.
 *
 * Type: Server Component (static UI, no data fetching)
 */

import { BrandMark } from '@/components/shared/BrandMark'
import { DeadEnd } from '@/components/ui/dead-end'

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4">
      <BrandMark className="h-8 w-8" />
      <DeadEnd
        title="This page isn't available"
        description="The link may be broken, or the page may have been moved or removed."
        action={{ label: 'Go to Scholera', href: '/' }}
      />
    </div>
  )
}
