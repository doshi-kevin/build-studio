// Pre-Class Primer generation orchestrator. Runs once per lecture item (fired
// by the internal /api/preclass-audio/generate route — from a student's lazy
// on-view kick or the professor's toggle-time pre-warm). Idempotent and
// herd-safe via an atomic claim on the preclass_primers row keyed on
// module_item_id, mirroring Class Insights' claimGeneration.
//
// Freshness: the claim compares the row's source_hash to the freshly-assembled
// content hash. A 'ready' row whose hash still matches is left untouched (no
// paid regeneration); any other state (missing / failed / stale-generating /
// ready-but-hash-changed) is (re)claimed and regenerated.
//
// Security: server-only, admin client. The caller (the internal route) is gated
// by a shared secret; this never trusts a user session.

import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { generatePrimerScript } from '@/lib/ai/llm-client'
import { checkAiFeature } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'
import { buildPrimerSource } from './content'
import { synthesizeSpeech } from './tts'
import { truncateScriptForTts, estimateDurationSeconds } from './script'

const PRECLASS_AUDIO_BUCKET = 'preclass-audio'

/** A 'generating' claim older than this is treated as crashed and reclaimed. */
export const STALE_CLAIM_MS = 5 * 60 * 1000

export interface GeneratePrimerResult {
  ok: boolean
  /** Another run already holds the claim, or the primer is already fresh. */
  skipped?: boolean
  error?: string
}

interface ClaimResult {
  won: boolean
  /** A ready row with a matching hash already exists — nothing to do. */
  alreadyFresh: boolean
}

/**
 * Atomically claim the primer row for regeneration. Returns won=true only if
 * this call transitioned the row into 'generating' with the new source hash.
 */
async function claimPrimer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  moduleItemId: string,
  sectionId: string,
  institutionId: string,
  sourceHash: string,
  force: boolean,
): Promise<ClaimResult> {
  const now = new Date().toISOString()

  const { data: existing } = await adminDb
    .from('preclass_primers')
    .select('status, generated_at, source_hash')
    .eq('module_item_id', moduleItemId)
    .maybeSingle()

  if (!existing) {
    const { data: claimed } = await adminDb
      .from('preclass_primers')
      .upsert(
        {
          module_item_id: moduleItemId,
          section_id: sectionId,
          institution_id: institutionId,
          status: 'generating',
          source_hash: sourceHash,
          generated_at: now,
        },
        { onConflict: 'module_item_id', ignoreDuplicates: true },
      )
      .select('module_item_id')
    return { won: !!claimed && claimed.length > 0, alreadyFresh: false }
  }

  // A ready primer whose source is unchanged is already fresh — skip the paid
  // regeneration, UNLESS the professor pressed Regenerate (force). On a forced
  // regen the row keeps its old audio_path until the new file lands, so students
  // keep hearing the previous take with no gap.
  if (!force && existing.status === 'ready' && existing.source_hash === sourceHash) {
    return { won: false, alreadyFresh: true }
  }

  if (
    existing.status === 'generating' &&
    Date.now() - new Date(existing.generated_at).getTime() < STALE_CLAIM_MS
  ) {
    return { won: false, alreadyFresh: false } // a fresh run is in flight
  }

  // Stale / failed / ready-but-hash-changed → reclaim via compare-and-set on
  // the generated_at we just read (loses the race iff someone else reclaimed).
  const { data: reclaimed } = await adminDb
    .from('preclass_primers')
    .update({ status: 'generating', source_hash: sourceHash, generated_at: now })
    .eq('module_item_id', moduleItemId)
    .eq('generated_at', existing.generated_at)
    .select('module_item_id')
  return { won: !!reclaimed && reclaimed.length > 0, alreadyFresh: false }
}

/** Mark a claimed row failed — but only if WE still hold the claim. Guarding on
 *  our own source_hash (not just status='generating') prevents a superseded run
 *  from stomping the row of the newer run that reclaimed it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function markFailed(adminDb: any, moduleItemId: string, sourceHash?: string): Promise<void> {
  let q = adminDb
    .from('preclass_primers')
    .update({ status: 'failed', generated_at: new Date().toISOString() })
    .eq('module_item_id', moduleItemId)
    .eq('status', 'generating')
  if (sourceHash) q = q.eq('source_hash', sourceHash)
  await q
}

export async function generatePrimer(moduleItemId: string, force = false): Promise<GeneratePrimerResult> {
  // Hoisted so the catch-block markFailed can guard on OUR hash (only fail the
  // row if we still hold this claim — never a run that superseded us).
  let claimedHash: string | undefined
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const source = await buildPrimerSource(adminDb, moduleItemId)
    if (!source) return { ok: false, error: 'Lecture not found' }

    // Institution/platform AI kill switch — checked here (not the route) so the
    // secret-authenticated worker route AND the inline makePrimerAvailable
    // fallback are both covered. Refuses before claiming, so a disabled tenant's
    // primer row is never parked in 'generating'.
    const aiVerdict = await checkAiFeature(adminDb, source.institutionId, 'preclass-ai')
    if (!aiVerdict.allowed) {
      return { ok: false, error: aiRefusalMessage(aiVerdict.lockedBy) }
    }

    const claim = await claimPrimer(
      adminDb,
      moduleItemId,
      source.sectionId,
      source.institutionId,
      source.sourceHash,
      force,
    )
    if (claim.alreadyFresh) return { ok: true, skipped: true }
    if (!claim.won) return { ok: true, skipped: true } // another run owns it
    claimedHash = source.sourceHash

    // Nothing substantive to prime from → fail cleanly rather than hallucinate.
    if (!source.hasMaterial) {
      await markFailed(adminDb, moduleItemId, source.sourceHash)
      return { ok: false, error: 'No lecture material to generate a primer from' }
    }

    // 1. Script.
    const { script, error: scriptError } = await generatePrimerScript(source.userContent, {
      institutionId: source.institutionId,
      sectionId: source.sectionId,
    })
    if (scriptError || !script) {
      await markFailed(adminDb, moduleItemId, source.sourceHash)
      return { ok: false, error: scriptError ?? 'Empty script' }
    }
    const spoken = truncateScriptForTts(script)

    // 2. Speech.
    const { audio, error: ttsError } = await synthesizeSpeech(spoken, {
      institutionId: source.institutionId,
      sectionId: source.sectionId,
    })
    if (ttsError || !audio) {
      await markFailed(adminDb, moduleItemId, source.sourceHash)
      return { ok: false, error: ttsError ?? 'Empty audio' }
    }

    // 3. Upload. Path is tenant-hierarchical (institution → section → lecture)
    //    so storage mirrors ownership; the hash filename means a regenerate
    //    writes a NEW object, so an in-flight listener on the old signed URL is
    //    never interrupted.
    const audioPath = `${source.institutionId}/${source.sectionId}/${moduleItemId}/${source.sourceHash}.mp3`
    const { error: uploadError } = await adminDb.storage
      .from(PRECLASS_AUDIO_BUCKET)
      .upload(audioPath, audio, { contentType: 'audio/mpeg', upsert: true })
    if (uploadError) {
      await markFailed(adminDb, moduleItemId, source.sourceHash)
      return { ok: false, error: `Upload failed: ${uploadError.message}` }
    }

    // 4. Finalize — but only if we still hold the claim (a newer reclaim with a
    //    different hash may have superseded us). Guard on our own source_hash and
    //    branch on rows-affected: if 0 rows updated, a newer run owns the row, so
    //    we must NOT delete the previous audio (the row still points at it — a
    //    blind delete would 404 students until the newer run finishes).
    const { data: prevRow } = await adminDb
      .from('preclass_primers')
      .select('audio_path')
      .eq('module_item_id', moduleItemId)
      .maybeSingle()

    const { data: finalized } = await adminDb
      .from('preclass_primers')
      .update({
        status: 'ready',
        script: spoken,
        audio_path: audioPath,
        duration_seconds: estimateDurationSeconds(spoken),
        generated_at: new Date().toISOString(),
      })
      .eq('module_item_id', moduleItemId)
      .eq('source_hash', source.sourceHash)
      .select('module_item_id')

    const won = !!finalized && finalized.length > 0
    // Only reap the superseded object if OUR finalize landed (else a newer run
    // owns the current audio_path and we'd be deleting a live file).
    const oldPath = prevRow?.audio_path
    if (won && oldPath && oldPath !== audioPath) {
      await adminDb.storage.from(PRECLASS_AUDIO_BUCKET).remove([oldPath]).catch(() => {})
    }

    return { ok: true }
  } catch (error) {
    logger.error('generatePrimer: unexpected error', error, { moduleItemId })
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adminDb = createAdminClient() as any
      await markFailed(adminDb, moduleItemId, claimedHash)
    } catch {
      // best effort
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
