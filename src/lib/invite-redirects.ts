// Short-URL redirect layer for transactional email links. Wraps a Supabase
// action_link (or any external URL) in a branded app.scholera-inc.com/i/<shortId>
// URL so email clients cannot mangle the token round-trip.
//
// See supabase/migrations/00000000000068_reconcile_prod_drift.sql for schema + rationale.

import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { getSiteUrl } from '@/lib/site-url'

/** Crockford-ish alphabet — ambiguous characters (0, O, 1, l, I) removed. */
const SHORT_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
const SHORT_ID_LENGTH = 16
const DEFAULT_EXPIRES_SEC = 7 * 24 * 60 * 60 // 7 days, matches Supabase invite default

export type InviteRedirectPurpose = 'staff_invite' | 'professor_invite' | 'password_reset' | 'magic_link'

/**
 * Generates a short_id with ~95 bits of entropy — collision-proof at our scale.
 * Uses crypto.getRandomValues for uniform randomness (modulo bias is
 * negligible since 256 % 55 is only a ~2% skew and entropy budget dominates).
 */
function generateShortId(): string {
  const bytes = new Uint8Array(SHORT_ID_LENGTH)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += SHORT_ID_ALPHABET[bytes[i] % SHORT_ID_ALPHABET.length]
  }
  return out
}

interface CreateInviteRedirectInput {
  actionLink: string
  purpose: InviteRedirectPurpose
  createdBy?: string | null
  expiresSec?: number
}

type CreateInviteRedirectResult =
  | { shortUrl: string; shortId: string }
  | { error: string }

/**
 * Inserts a new row into invite_redirects and returns the short public URL
 * that should be embedded in the outbound email.
 */
/**
 * Origin allowlist — we only ever wrap URLs that come straight back from
 * Supabase's own admin.generateLink(). Rejecting anything outside the
 * configured NEXT_PUBLIC_SUPABASE_URL origin closes the latent open-redirect
 * vector at the insert boundary, so a compromised caller cannot use this as
 * a redirect gadget.
 */
function isAllowedActionLink(actionLink: string): boolean {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!supabaseUrl) return false
  try {
    const linkOrigin = new URL(actionLink).origin
    const allowedOrigin = new URL(supabaseUrl).origin
    return linkOrigin === allowedOrigin
  } catch {
    return false
  }
}

export async function createInviteRedirect(
  input: CreateInviteRedirectInput
): Promise<CreateInviteRedirectResult> {
  try {
    if (!isAllowedActionLink(input.actionLink)) {
      logger.warn('createInviteRedirect: rejected action_link outside Supabase origin', {
        purpose: input.purpose,
      })
      return { error: 'Invalid action link' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const shortId = generateShortId()
    const expiresAt = new Date(
      Date.now() + (input.expiresSec ?? DEFAULT_EXPIRES_SEC) * 1000
    ).toISOString()

    const { error } = await adminDb.from('invite_redirects').insert({
      short_id: shortId,
      action_link: input.actionLink,
      purpose: input.purpose,
      created_by: input.createdBy ?? null,
      expires_at: expiresAt,
    })

    if (error) {
      logger.error('createInviteRedirect: Insert failed', error, { purpose: input.purpose })
      return { error: error.message || 'Failed to create redirect' }
    }

    const siteUrl = getSiteUrl()

    return { shortUrl: `${siteUrl}/i/${shortId}`, shortId }
  } catch (error) {
    logger.error('createInviteRedirect: Exception', error)
    return { error: 'Failed to create redirect' }
  }
}

/**
 * Fetches a redirect row by short_id and validates it is still usable.
 * Returns the action_link on success, or an error status otherwise.
 */
export async function resolveInviteRedirect(
  shortId: string
): Promise<
  | { status: 'ok'; actionLink: string; firstHit: boolean }
  | { status: 'not_found' | 'revoked' | 'expired' }
> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data: row, error } = await adminDb
    .from('invite_redirects')
    .select('action_link, expires_at, redeemed_at, revoked_at')
    .eq('short_id', shortId)
    .single()

  if (error || !row) {
    return { status: 'not_found' }
  }
  if (row.revoked_at) {
    return { status: 'revoked' }
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { status: 'expired' }
  }

  const firstHit = !row.redeemed_at
  if (firstHit) {
    /* Best-effort — we don't block the redirect if this update fails. The
     * Supabase token underneath is single-use, so replay is prevented at
     * the auth layer regardless of what we record here. */
    await adminDb
      .from('invite_redirects')
      .update({ redeemed_at: new Date().toISOString() })
      .eq('short_id', shortId)
      .is('redeemed_at', null)
  }

  return { status: 'ok', actionLink: row.action_link, firstHit }
}
