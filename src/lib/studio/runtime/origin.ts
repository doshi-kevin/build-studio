/**
 * The two origins of the plugin runtime, and what each may serve.
 *
 *   App origin      Scholera itself. Trusted. Holds the session cookie.
 *   Runtime origin  STUDIO_RUNTIME_ORIGIN. Untrusted, credential-free. Serves only the
 *                   plugin frame document and the versioned runtime files.
 *
 * Both are served by the same Next.js server; the request's host decides which role it
 * plays. Pure and free of Node APIs, because middleware calls it.
 *
 * The runtime origin must be a different site from the app (a different registrable
 * domain in production). Auth cookies are host-only (no Domain attribute, see
 * src/lib/supabase/cookie-options.ts), so the browser never sends them to it.
 */

export interface StudioOrigins {
  app: string
  runtime: string
}

type Env = Record<string, string | undefined>

function originOf(value: string | undefined): URL | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

/**
 * The host the browser asked for. Not `request.nextUrl.host`: a production Next server
 * (`next start`, the standalone build) builds that URL from its own listen address
 * (`next-server.js`, initURL), so it is never the runtime origin's host there. The Host
 * header is what the browser targeted and what Cloud Run routes on.
 */
export function requestHost(request: { headers: { get(name: string): string | null }; nextUrl: { host: string } }): string {
  return request.headers.get('host') || request.nextUrl.host
}

/** Both origins, or null when the runtime is off or misconfigured. Fails closed. */
export function studioOrigins(env: Env = process.env): StudioOrigins | null {
  const runtime = originOf(env.STUDIO_RUNTIME_ORIGIN)
  // Same source and fallback order as getSiteUrl() (src/lib/site-url.ts).
  const app = originOf(env.SITE_URL || env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000')
  if (!runtime || !app) return null
  if (env.NODE_ENV === 'production' && runtime.protocol !== 'https:') return null

  const a = app.hostname
  const r = runtime.hostname
  // Never the app's host, a subdomain of it, or a parent of it: those can share cookies
  // and are the same site. A different registrable domain is required in production;
  // without a public-suffix list this catches the common mistakes.
  if (a === r || a.endsWith(`.${r}`) || r.endsWith(`.${a}`)) return null

  return { app: app.origin, runtime: runtime.origin }
}

export type RuntimeRequest = 'continue' | 'serve-runtime' | 'not-found'

// The frame document is versioned on its own; the runtime files follow each bridge version.
const RUNTIME_PREFIXES = ['/studio-frame/v1/', '/studio-runtime/v1/', '/studio-runtime/v2/']

/** What middleware does with a request, by host and path:
 *  - runtime origin: only the frame and runtime files exist; everything else is a 404,
 *    so the app (and its login, and its cookies) never runs there;
 *  - app origin: the frame document doesn't exist there. */
export function classifyRuntimeRequest(host: string, pathname: string, origins: StudioOrigins | null): RuntimeRequest {
  const isFramePath = pathname.startsWith('/studio-frame/')
  if (!origins) return isFramePath ? 'not-found' : 'continue'
  if (host === new URL(origins.runtime).host) {
    return RUNTIME_PREFIXES.some((p) => pathname.startsWith(p)) ? 'serve-runtime' : 'not-found'
  }
  return isFramePath ? 'not-found' : 'continue'
}
