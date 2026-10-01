/**
 * Dashboard not-found boundary — catches notFound() from every authenticated
 * route under (dashboard): professor, student, staff, admin and super-admin.
 * That's ~70 call sites, which previously all fell through to Next.js's bare
 * default 404 with no chrome and no way back.
 *
 * Renders inside (dashboard)/layout.tsx, so the header and sidebar stay put and
 * the user is never stranded. That's also why it adds no viewport centering of
 * its own — <main> already supplies the padding.
 *
 * The CTA is /dashboard for every role deliberately: /dashboard/page.tsx routes
 * institution_admin to /admin and super_admin to /super-admin, so one href is
 * correct for everyone and this boundary needs no profile fetch. (login/page.tsx
 * skips that hop only because it already holds the profile from signing in.)
 *
 * Copy fuses "removed" and "no access" on purpose — cross-tenant denials surface
 * as 404s here, so telling the user which one it was would confirm that another
 * institution's resource exists. See `.claude/rules/dead-ends.md`.
 *
 * Type: Server Component (static UI, no data fetching)
 */

import { DeadEnd } from '@/components/ui/dead-end'

export default function DashboardNotFound() {
  return <DeadEnd action={{ label: 'Back to dashboard', href: '/dashboard' }} />
}
