/**
 * Server-only base URL for links we generate outside a request context
 * (emails, Slack messages, invite links).
 *
 * Reads SITE_URL first: it is NOT prefixed with NEXT_PUBLIC_, so Next.js
 * leaves it as a runtime process.env lookup instead of inlining it at build
 * time. Prod/staging set SITE_URL on the Cloud Run service. The
 * NEXT_PUBLIC_SITE_URL fallback covers local dev (.env.local); do not rely
 * on it in deployed builds — it is frozen at image build time (empty in the
 * prod image), which is how invite emails ended up linking to localhost.
 */
export function getSiteUrl(): string {
  return (
    process.env.SITE_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    'http://localhost:3000'
  )
}
