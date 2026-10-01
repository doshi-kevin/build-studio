/**
 * "Is this string a path inside our own app?" — one implementation, because two
 * dialects of this check is how one of them ends up wrong.
 *
 * Extracted from the roadmap annotation layer, which had the only correct
 * version in the codebase. Athena's propose directive had its own, and it was
 * missing the backslash case below — a security review caught it before it
 * shipped, which is exactly the kind of near-miss that argues for one copy.
 *
 * Use this anywhere a value that did not originate in `src/lib/routes/` is about
 * to become an `href` or reach `router.push`.
 */

/**
 * A leading slash followed by neither `/` nor `\`.
 *
 * The backslash is the part people miss: the WHATWG URL parser folds `\` into
 * `/` for special schemes, so `/\evil.com` is protocol-relative and resolves
 * off-origin exactly like `//evil.com` — `new URL('/\\evil.com', 'https://app.example')`
 * is `https://evil.com/`. A check that only rejects `//` therefore still hands
 * an attacker a full off-site navigation inside a trusted session.
 *
 * Rejecting anything with a scheme (`https:`, `javascript:`) falls out of the
 * same rule: a scheme has no leading slash.
 */
const IN_APP_PATH = /^\/(?![/\\])/

/** Length cap, so a pathological value can't be carried around or logged. */
const MAX_PATH = 400

export function isInAppPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PATH && IN_APP_PATH.test(value)
}

/** The path if it's safe to navigate to, else null. */
export function safeAppPath(href: string | undefined | null): string | null {
  return isInAppPath(href) ? href : null
}
