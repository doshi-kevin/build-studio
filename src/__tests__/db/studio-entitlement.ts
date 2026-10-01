/**
 * The `studio` entitlement is off by default (src/lib/entitlements/entitled-features.ts),
 * and without it Studio is read-only. DB-tier tests that create, install or write grant
 * it to the fixture institution for their run and put the old settings back afterwards.
 */
import type { Client } from 'pg'

const GRANTED = { granted: ['studio'], revoked: [], pendingRevocation: {}, version: 1 }

/** Grants Studio to one institution. Returns a function that restores its settings. */
export async function grantStudio(db: Client, institutionId: string): Promise<() => Promise<void>> {
  const { rows } = await db.query('select settings from public.institutions where id = $1', [institutionId])
  const saved = rows[0]?.settings ?? {}
  await db.query(
    `update public.institutions set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{entitlements}', $2::jsonb) where id = $1`,
    [institutionId, JSON.stringify(GRANTED)],
  )
  return async () => {
    await db.query('update public.institutions set settings = $2::jsonb where id = $1', [institutionId, JSON.stringify(saved)])
  }
}
