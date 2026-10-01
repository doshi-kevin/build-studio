import type { NextConfig } from "next";

// Local-only: production Supabase is always the public *.supabase.co host below,
// which is never a private IP, so isLocalDev is always false there.
const isLocalDev = process.env.NODE_ENV !== 'production'

const nextConfig: NextConfig = {
  output: 'standalone',
  experimental: {
    serverActions: {
      // Assignment submissions POST files through a Server Action (FormData), so this
      // — not proxyClientMaxBodySize — is the real ceiling. Must cover the advertised
      // submission max (MAX_SUBMISSION_FILE_SIZE 25 MB × MAX_SUBMISSION_FILES 10);
      // otherwise an in-spec upload is rejected by Next with an opaque 413 before the
      // action runs. Kept in step with proxyClientMaxBodySize below.
      bodySizeLimit: '260mb',
    },
    // Raise the route-handler body limit so /api/live-classroom/render-deck
    // accepts large lecture decks. Default is 10 MB, which silently
    // truncates the multipart body and surfaces as an opaque 500
    // ("Failed to parse body as FormData"). Must stay above
    // MAX_DECK_BYTES (250 MB) so the route's own size validation can
    // return a friendly 413 instead.
    proxyClientMaxBodySize: '260mb',
  },
  images: {
    // Landing imagery requests quality 90; Next 16 requires every quality
    // used by next/image to be declared here (default is [75] only).
    qualities: [75, 90],
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        pathname: '/storage/v1/**',
      },
      // Local Supabase serves storage over plain HTTP on 127.0.0.1 — without this,
      // next/image throws "hostname not configured" on any local storage URL, signed
      // or public.
      ...(isLocalDev
        ? [{ protocol: 'http' as const, hostname: '127.0.0.1', pathname: '/storage/v1/**' }]
        : []),
    ],
    // The allowlist above isn't the only gate: Next separately refuses to fetch
    // any URL whose hostname resolves to a private/loopback IP (SSRF hardening),
    // regardless of remotePatterns — 127.0.0.1 always trips it. Without this,
    // the allowlist entry above passes validation but the actual image fetch
    // still throws the same "url parameter is not allowed" error.
    dangerouslyAllowLocalIP: isLocalDev,
  },
  // Keep these packages as native Node.js requires instead of bundling
  // them. pdfjs-dist's internal worker resolution breaks when
  // re-bundled. sharp and @napi-rs/canvas ship native binaries that
  // Next.js must not touch. fflate works either way but is hoisted
  // here to keep all extractor deps grouped.
  serverExternalPackages: [
    'pdfjs-dist',
    'officeparser',
    'sharp',
    '@napi-rs/canvas',
    'fflate',
  ],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Anti-clickjacking. Without these, evil.example can iframe a real
          // authenticated page invisibly under a lure and harvest a click onto a
          // destructive professor/admin control — Next's Server Action origin check
          // does not stop it, because the POST originates from the framed Scholera
          // page and is therefore same-origin.
          //
          // SAMEORIGIN / 'self', not DENY: the app frames its own routes (PDF and
          // deck viewers, the projector view). frame-ancestors is the modern form and
          // wins where both are understood; X-Frame-Options covers older browsers.
          //
          // NOTE for the LTI Tool Mode work: LTI runs Scholera inside the LMS's
          // iframe, so that branch must WIDEN frame-ancestors to the permitted
          // platform origins on its routes. Do not resolve that by deleting this —
          // dropping anti-framing app-wide to unblock LTI reopens the hole.
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
        ],
      },
    ]
  },
};

export default nextConfig;
