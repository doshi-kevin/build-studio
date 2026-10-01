/**
 * Calendar Feed Token Server Actions — generate, regenerate, revoke feed tokens.
 *
 * Tokens are used to authenticate iCal feed URLs for Outlook subscriptions.
 * Each user has at most one active token at a time.
 */
'use server'

import { randomBytes } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'

// ── Helpers ──────────────────────────────────────────────────────

async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

function generateToken(): string {
  return randomBytes(32).toString('hex') // 64-char hex
}

// ── Get or Create Token ──────────────────────────────────────────

export async function getOrCreateCalendarToken() {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    // Check for existing active token
    const { data: existing, error: fetchErr } = await adminDb
      .from('calendar_tokens')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .maybeSingle()

    if (fetchErr) {
      logger.error('getOrCreateCalendarToken: Fetch failed', fetchErr)
      return { error: 'Failed to fetch token' }
    }

    if (existing) return { data: existing }

    // Create new token
    const token = generateToken()
    const { data, error } = await adminDb
      .from('calendar_tokens')
      .insert({
        user_id: user.id,
        token,
        label: 'Default',
        is_active: true,
      })
      .select('*')
      .single()

    if (error) {
      logger.error('getOrCreateCalendarToken: Insert failed', error)
      return { error: 'Failed to create token' }
    }

    await logEvent({
      userId: user.id,
      eventType: 'calendar_token.created',
      eventCategory: 'calendar',
      metadata: { tokenId: data.id },
    })

    return { data }
  } catch (error) {
    logger.error('getOrCreateCalendarToken: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Regenerate Token ─────────────────────────────────────────────

export async function regenerateCalendarToken() {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    // Deactivate existing active token(s)
    await adminDb
      .from('calendar_tokens')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .eq('is_active', true)

    // Create new token
    const token = generateToken()
    const { data, error } = await adminDb
      .from('calendar_tokens')
      .insert({
        user_id: user.id,
        token,
        label: 'Default',
        is_active: true,
      })
      .select('*')
      .single()

    if (error) {
      logger.error('regenerateCalendarToken: Insert failed', error)
      return { error: 'Failed to regenerate token' }
    }

    await logEvent({
      userId: user.id,
      eventType: 'calendar_token.regenerated',
      eventCategory: 'calendar',
      metadata: { tokenId: data.id },
    })

    return { data }
  } catch (error) {
    logger.error('regenerateCalendarToken: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Revoke Token ─────────────────────────────────────────────────

export async function revokeCalendarToken() {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { error } = await adminDb
      .from('calendar_tokens')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .eq('is_active', true)

    if (error) {
      logger.error('revokeCalendarToken: Update failed', error)
      return { error: 'Failed to revoke token' }
    }

    await logEvent({
      userId: user.id,
      eventType: 'calendar_token.revoked',
      eventCategory: 'calendar',
      metadata: {},
    })

    return { success: true }
  } catch (error) {
    logger.error('revokeCalendarToken: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}
