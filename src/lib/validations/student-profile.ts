/**
 * Student Profile Validation — Zod schemas for student-editable profile fields.
 *
 * Students can edit: avatar, bio, linkedin_url, github_url.
 * Admin-controlled fields (name, email, cwid, role, etc.) are NOT editable here.
 */

import { z } from 'zod'

/**
 * Normalize a user-typed link before URL validation: trim it, and if it has no
 * scheme, assume https. Students routinely type `linkedin.com/in/me` (no
 * `https://`), which `z.string().url()` rejects — this makes that input save
 * cleanly instead of failing with "please enter a valid URL". Empty stays empty.
 */
function normalizeUrl(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed === '' || /^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

export const studentProfileSchema = z.object({
  bio: z
    .string()
    .max(300, 'Bio must be 300 characters or fewer')
    .optional()
    .default(''),
  linkedinUrl: z.preprocess(
    normalizeUrl,
    z
      .string()
      .url('Please enter a valid URL')
      .refine((url) => url.includes('linkedin.com'), 'Must be a LinkedIn URL')
      .optional()
      .or(z.literal('')),
  ),
  githubUrl: z.preprocess(
    normalizeUrl,
    z
      .string()
      .url('Please enter a valid URL')
      .refine((url) => url.includes('github.com'), 'Must be a GitHub URL')
      .optional()
      .or(z.literal('')),
  ),
})

export type StudentProfileInput = z.infer<typeof studentProfileSchema>

export interface StudentProfileData {
  bio: string
  linkedinUrl: string
  githubUrl: string
}

const DEFAULT_PROFILE_DATA: StudentProfileData = {
  bio: '',
  linkedinUrl: '',
  githubUrl: '',
}

/** Bio length cap, matching studentProfileSchema. Re-applied on read below. */
const BIO_MAX = 300

/**
 * A link that is safe to put in someone else's `href`, or '' if it isn't.
 *
 * Two conditions, and both matter:
 *   • the scheme is http(s), so `javascript:` and `data:` can never become an
 *     href. React only warns about those, and only in the dev bundle;
 *   • the host is the one the label claims, so a link captioned "LinkedIn" with
 *     LinkedIn's icon cannot point at an attacker's sign-in page.
 *
 * NOT `safeHref()` from `@/lib/dashboard/todos` — that one requires a leading
 * '/' and would blank every legitimate profile link.
 */
function safeProfileUrl(value: unknown, requiredHost: string): string {
  if (typeof value !== 'string' || value === '') return ''
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return ''
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
  // Suffix match on a dot boundary, so `linkedin.com` and `www.linkedin.com`
  // pass while `linkedin.com.evil.test` and `notlinkedin.com` do not.
  const host = url.hostname.toLowerCase()
  if (host !== requiredHost && !host.endsWith(`.${requiredHost}`)) return ''
  return value
}

/**
 * Safely parse profile data from settings JSONB.
 * Returns defaults for missing or malformed data.
 *
 * VALIDATES ON READ, deliberately, rather than trusting that the value went
 * through `studentProfileSchema` on the way in. `updateStudentProfile` is not
 * the only writer: `profiles` has a table-wide self-update policy whose trigger
 * pins only `role` and `institution_id`, and no column-level grants, so a
 * student can PATCH their own `settings` straight from the browser with the
 * public anon key and skip the schema entirely.
 *
 * That was harmless while these values were only ever rendered back to the
 * student who wrote them. It stopped being harmless when the professor-side
 * student profile began rendering them as links in a professor's page: a
 * student-chosen `href` in a higher-privileged reader's browser is a phishing
 * primitive, and the read path is where that trust boundary actually sits.
 */
export function parseStudentProfile(
  settings: Record<string, unknown> | null | undefined,
): StudentProfileData {
  if (!settings || typeof settings !== 'object') return DEFAULT_PROFILE_DATA

  const profile = (settings as Record<string, unknown>).profile
  if (!profile || typeof profile !== 'object') return DEFAULT_PROFILE_DATA

  const p = profile as Record<string, unknown>
  return {
    // Capped on read too: the write schema's 300-char limit is bypassable the
    // same way, and this string is rendered in full on both profile pages.
    bio: typeof p.bio === 'string' ? p.bio.slice(0, BIO_MAX) : '',
    linkedinUrl: safeProfileUrl(p.linkedinUrl, 'linkedin.com'),
    githubUrl: safeProfileUrl(p.githubUrl, 'github.com'),
  }
}
