/**
 * ElevenLabs actual bill via GET /v1/user/subscription — invoice-exact:
 * next_invoice.amount_due_cents covers the current billing cycle. Uses the
 * existing ELEVENLABS_API_KEY.
 */
import 'server-only'
import { logger } from '@/lib/logger'
import { currentMonth, type ProviderBill } from './types'

export async function fetchElevenLabsBill(): Promise<ProviderBill> {
  const key = process.env.ELEVENLABS_API_KEY
  const base: ProviderBill = {
    provider: 'elevenlabs',
    month: currentMonth(),
    amountUsd: 0,
    source: 'billed',
    asOf: new Date().toISOString(),
  }
  if (!key) return { ...base, unconfigured: true }
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': key },
      // Bill data changes slowly; avoid hammering the API from every page view.
      next: { revalidate: 3600 },
    })
    if (!res.ok) {
      logger.warn('fetchElevenLabsBill: subscription fetch failed', { status: res.status })
      return { ...base, unconfigured: true, detail: { status: res.status } }
    }
    const data = (await res.json()) as {
      tier?: string
      character_count?: number
      character_limit?: number
      next_invoice?: { amount_due_cents?: number }
      currency?: string
    }
    const cents = data.next_invoice?.amount_due_cents ?? 0
    return {
      ...base,
      amountUsd: Math.round(cents) / 100,
      detail: {
        tier: data.tier,
        characterCount: data.character_count,
        characterLimit: data.character_limit,
      },
    }
  } catch (err) {
    logger.error('fetchElevenLabsBill: exception', err)
    return { ...base, unconfigured: true, detail: { error: String(err).slice(0, 200) } }
  }
}
