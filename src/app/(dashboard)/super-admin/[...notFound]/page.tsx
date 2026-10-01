/**
 * Catch-all 404 for unmatched routes under /super-admin.
 *
 * Next.js only renders a `not-found.tsx` boundary for a `notFound()` thrown by a
 * route that MATCHED. A URL matching nothing at all skips every nested boundary
 * and falls through to the app-root `not-found.tsx` — no header, no sidebar, and
 * a CTA pointing at `/` rather than `/dashboard` (#727). A signed-in reader
 * hitting `/super-admin/nope` was dropped out of the app entirely.
 *
 * Matching the path is what fixes it: this segment matches, so
 * `(dashboard)/layout.tsx` renders and the `notFound()` below reaches
 * `(dashboard)/not-found.tsx` with the chrome and a working exit intact.
 *
 * Catch-alls are the LOWEST routing precedence in the App Router, so every real
 * route under /super-admin — static or dynamic, at any depth — still wins. This only
 * runs when nothing else would have.
 *
 * Type: Server Component (no data fetching)
 */

import { notFound } from 'next/navigation'

export default function SuperAdminNotFoundCatchAll(): never {
  notFound()
}
