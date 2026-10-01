/**
 * Cookie attributes for the Supabase auth cookies — the single source of truth.
 *
 * @supabase/ssr's DEFAULT_COOKIE_OPTIONS is `{ path, sameSite: 'lax', httpOnly: false,
 * maxAge }` with NO `secure` key, and the library never adds one for https requests. So
 * by default the session cookies ride along on any plaintext request to our domain, and
 * an attacker with network position (campus wifi, hostile router) who can provoke one —
 * an `<img src="http://app.scholera-inc.com/x">` on any unencrypted page — reads the
 * access and refresh token off the wire and replays them against the Supabase REST API.
 *
 * `secure` is set only in production. Note the precise reason: browsers DO treat
 * http://localhost as a secure context and will store a Secure cookie there, so plain
 * localhost dev would survive it. The condition earns its keep for the other dev
 * shapes — a LAN IP or a tunnel hostname over http, where a Secure cookie is silently
 * dropped and sign-in fails with no visible error.
 *
 * This lives in one module rather than being inlined at each of the four constructors
 * (browser client, server client, middleware, auth callback) because those four must
 * agree: a cookie written with Secure by one and without by another is a session bug,
 * and drift between copies is exactly the failure this centralises away.
 */
export const AUTH_COOKIE_OPTIONS = {
  secure: process.env.NODE_ENV === 'production',
} as const
