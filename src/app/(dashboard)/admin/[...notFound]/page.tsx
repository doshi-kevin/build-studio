/**
 * Catch-all 404 for unmatched routes under /admin.
 *
 * Next.js only renders a `not-found.tsx` boundary for a `notFound()` thrown by a
 * route that MATCHED. A URL matching nothing at all skips every nested boundary
 * and falls through to the app-root `not-found.tsx` — no header, no sidebar, and
 * a CTA pointing at `/` rather than `/dashboard` (#727). A signed-in reader
 * hitting `/admin/nope` was dropped out of the app entirely.
 *
 * Matching the path is what fixes it: this segment matches, so
 * `(dashboard)/layout.tsx` renders and the `notFound()` below reaches
 * `(dashboard)/not-found.tsx` with the chrome and a working exit intact.
 *
 * Catch-alls are the LOWEST routing precedence in the App Router, so every real
 * route under /admin — static or dynamic, at any depth — still wins. This only
 * runs when nothing else would have.
 *
 * KNOWN, and not fixable from here: this route answers **HTTP 200** while the
 * professor/student equivalents answer 404. `admin/loading.tsx` puts the segment
 * behind a Suspense boundary, so the response is committed and streaming before
 * `notFound()` throws — a status can't be changed after that. The 404 UI still
 * renders correctly; only the status line is wrong, which matters for monitoring
 * and crawlers rather than for the reader. `.claude/rules/dead-ends.md` documents
 * the same interaction. Removing the loading skeleton would fix the status and
 * cost the loading state; not worth it.
 *
 * Type: Server Component (no data fetching)
 */

import { notFound } from 'next/navigation'

export default function AdminNotFoundCatchAll(): never {
  notFound()
}
