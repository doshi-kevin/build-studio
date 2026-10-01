import 'server-only'

import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import type { EvidenceCandidate, Indicator, Level, MapMatch } from './types'

// Per-artifact cache for the Map stage (table: outcome_alignment_map_cache).
// Repeated analyses over unchanged material reuse the stored matches instead
// of re-sampling the LLM — identical inputs therefore produce an identical
// report. Keys are content hashes of the exact LLM input, so any edit to the
// material (or to the indicator list / prompt) naturally misses the cache.

/** Bump when map.ts's SYSTEM prompt or mapOutputSchema changes — invalidates every cache entry.
 *  v2 also added `title` to the key: the prompt has always sent the candidate's title to the
 *  model, but the key omitted it, so renaming a lecture changed the LLM input without
 *  changing the hash. The run then early-aborted as "unchanged" and kept the old mapping. */
export const MAP_PROMPT_VERSION = 2

/** The lean match shape persisted in the cache (indicator referenced by code, level already capped). */
export interface CachedMatch {
  indicatorCode: string
  level: Level
  justification: string
  confidence: MapMatch['confidence']
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** Stable hash of the indicator list — part of every candidate key. */
export function indicatorListHash(indicators: Indicator[]): string {
  const canonical = indicators
    .map((i) => [i.code, i.outcomeCode, i.description])
    .sort((a, b) => a[0].localeCompare(b[0]))
  return sha256(JSON.stringify(canonical))
}

/** Cache key for one candidate: everything the LLM call depends on.
 *
 *  Every field here is something map.ts actually sends to the model, and that is the rule
 *  for adding one: if the model sees it, it belongs in the key. `title` is in the prompt
 *  (mapCandidate writes "Title: ..."), so a rename is a different LLM input and must be a
 *  different key. `sourceId` is deliberately absent — it never reaches the model, and
 *  including it would stop two identical artifacts from sharing a cached answer. */
export function candidateHash(candidate: EvidenceCandidate, indListHash: string): string {
  return sha256(
    JSON.stringify({
      v: MAP_PROMPT_VERSION,
      sourceType: candidate.sourceType,
      cap: candidate.cap,
      title: candidate.title,
      signal: candidate.signal,
      indicators: indListHash,
    }),
  )
}

/** Course-content fingerprint: order-independent over the candidates. */
export function contentHash(candidateHashes: string[]): string {
  return sha256(JSON.stringify([...candidateHashes].sort()))
}

/** Attainment fingerprint: key-order-independent over the mastery map. */
export function attainmentHash(masteryBySkill: Record<string, number>, quizResponseCount: number): string {
  const entries = Object.entries(masteryBySkill).sort(([a], [b]) => a.localeCompare(b))
  return sha256(JSON.stringify({ entries, quizResponseCount }))
}

// PostgREST turns `.in()` into URL query params — a big course's worth of
// 64-char hashes would blow past URL length limits (HTTP 414) and silently
// bypass the cache. Keep each request comfortably small.
const HASH_CHUNK = 50
const chunk = <T,>(arr: T[]): T[][] =>
  Array.from({ length: Math.ceil(arr.length / HASH_CHUNK) }, (_, i) => arr.slice(i * HASH_CHUNK, (i + 1) * HASH_CHUNK))

/** Load cached matches for the given hashes; returns hash → matches. */
export async function loadCachedMatches(
  db: SupabaseClient,
  institutionId: string,
  hashes: string[],
): Promise<Map<string, CachedMatch[]>> {
  if (hashes.length === 0) return new Map()
  const result = new Map<string, CachedMatch[]>()
  for (const part of chunk(hashes)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('outcome_alignment_map_cache')
      .select('input_hash, matches')
      .eq('institution_id', institutionId)
      .in('input_hash', part)
    if (error) {
      // A broken cache read must never fail the run — fall back to fresh LLM calls.
      logger.warn('outcome-alignment.cache: read failed, treating chunk as misses', { error: error.message })
      continue
    }
    for (const r of (data ?? []) as Array<{ input_hash: string; matches: CachedMatch[] }>) {
      result.set(r.input_hash, r.matches)
    }
  }
  return result
}

/** Upsert fresh LLM results and touch last_used_at on the hashes we reused. */
export async function storeCacheResults(
  db: SupabaseClient,
  institutionId: string,
  fresh: Array<{ inputHash: string; matches: CachedMatch[] }>,
  hitHashes: string[],
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any
  // Duplicate artifacts (identical signals) produce the same hash — a single
  // upsert statement must not contain the same key twice, so dedupe first.
  const freshByHash = Array.from(new Map(fresh.map((f) => [f.inputHash, f])).values())
  if (freshByHash.length > 0) {
    const now = new Date().toISOString()
    const { error } = await anyDb.from('outcome_alignment_map_cache').upsert(
      freshByHash.map((f) => ({
        institution_id: institutionId,
        input_hash: f.inputHash,
        matches: f.matches,
        last_used_at: now,
      })),
      { onConflict: 'institution_id,input_hash' },
    )
    if (error) logger.warn('outcome-alignment.cache: upsert failed', { error: error.message })
  }
  for (const part of chunk(hitHashes)) {
    const { error } = await anyDb
      .from('outcome_alignment_map_cache')
      .update({ last_used_at: new Date().toISOString() })
      .eq('institution_id', institutionId)
      .in('input_hash', part)
    if (error) logger.warn('outcome-alignment.cache: touch failed', { error: error.message })
  }
}

const PRUNE_AFTER_DAYS = 60

/** Delete this institution's entries unused for 60+ days (cheap, indexed, best-effort). */
export async function pruneStaleCache(db: SupabaseClient, institutionId: string): Promise<void> {
  const cutoff = new Date(Date.now() - PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db as any)
    .from('outcome_alignment_map_cache')
    .delete()
    .eq('institution_id', institutionId)
    .lt('last_used_at', cutoff)
  if (error) logger.warn('outcome-alignment.cache: prune failed', { error: error.message })
}
