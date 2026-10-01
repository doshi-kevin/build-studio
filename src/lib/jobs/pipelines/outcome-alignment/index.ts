import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import type { BackgroundPipeline, PipelineContext } from '../../types'
import { logger } from '@/lib/logger'
import { gatherEvidence } from './gather'
import { mapCandidate, matchesFromCached, matchesToCached, type MappedCandidate } from './map'
import { reduceAlignments, buildSummary } from './reduce'
import {
  attainmentHash,
  candidateHash,
  contentHash,
  indicatorListHash,
  loadCachedMatches,
  pruneStaleCache,
  storeCacheResults,
  type CachedMatch,
} from './cache'
import { UNCHANGED_NOTICE, type AlignmentRollup, type Indicator } from './types'

const MAP_CONCURRENCY = 4

async function loadIndicators(
  db: SupabaseClient,
  standardId: string,
): Promise<{ indicators: Indicator[]; outcomeCodes: string[] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any
  const { data: outcomes } = await anyDb
    .from('accreditation_outcomes')
    .select('id, code, order_index')
    .eq('standard_id', standardId)
    .order('order_index')
  const outcomeRows = (outcomes ?? []) as Array<{ id: string; code: string }>
  const codeById = new Map(outcomeRows.map((o) => [o.id, o.code]))
  const { data: inds } = await anyDb
    .from('accreditation_indicators')
    .select('id, code, description, outcome_id')
    .in('outcome_id', outcomeRows.map((o) => o.id))
    .order('order_index')
  const indicators: Indicator[] = ((inds ?? []) as Array<{ id: string; code: string; description: string; outcome_id: string }>).map(
    (i) => ({ id: i.id, code: i.code, description: i.description, outcomeCode: codeById.get(i.outcome_id) ?? '' }),
  )
  return { indicators, outcomeCodes: outcomeRows.map((o) => o.code) }
}

/** The previous completed run's fingerprints + summary, for change detection. */
async function loadPreviousRun(
  db: SupabaseClient,
  sectionId: string,
  currentJobId: string,
): Promise<{ rollup: AlignmentRollup; summary: string | null } | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (db as any)
    .from('background_jobs')
    .select('id, result, summary')
    .eq('type', 'outcome_alignment')
    .eq('section_id', sectionId)
    .eq('status', 'done')
    .neq('id', currentJobId)
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data?.result) return null
  return { rollup: data.result as AlignmentRollup, summary: data.summary ?? null }
}

/** Run each item through `fn` with at most `cap` in flight (I/O-bound LLM calls). */
async function pool<T, R>(items: T[], cap: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(cap, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++
      results[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return results
}

export const outcomeAlignmentPipeline: BackgroundPipeline = {
  type: 'outcome_alignment',
  async run(params, ctx: PipelineContext) {
    const standardId = String(params.standardId ?? '')
    // Tenant + subject come from the authoritative job row, never from params.
    const sectionId = ctx.job.section_id
    const institutionId = ctx.job.institution_id
    if (!standardId) throw new Error('outcome_alignment: standardId is required')
    if (!sectionId) throw new Error('outcome_alignment: job has no section_id')

    const db = ctx.adminDb
    // params are server-authored today, but the pipeline runs with a service-role
    // client, so verify anyway: the standard must be global or belong to this tenant.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: standard } = await (db as any)
      .from('accreditation_standards')
      .select('id, institution_id')
      .eq('id', standardId)
      .maybeSingle()
    if (!standard) throw new Error('outcome_alignment: standard not found')
    if (standard.institution_id !== null && standard.institution_id !== institutionId) {
      throw new Error('outcome_alignment: standard belongs to another institution')
    }
    const { indicators, outcomeCodes } = await loadIndicators(db, standardId)
    if (indicators.length === 0) throw new Error('outcome_alignment: standard has no indicators')

    const { candidates, masteryBySkill, quizResponseCount } = await gatherEvidence(db, sectionId)
    const byType = candidates.reduce<Record<string, number>>((acc, c) => {
      acc[c.sourceType] = (acc[c.sourceType] ?? 0) + 1
      return acc
    }, {})
    logger.info('OutcomeAlignment.gather', { sectionId, candidates: candidates.length, byType, quizResponseCount })

    // Fingerprint this run's inputs. If NOTHING changed since the last completed
    // run (course content AND quiz data), stop here: re-running would only
    // re-roll the LLM dice and confuse the professor with a shifted report.
    const indListHash = indicatorListHash(indicators)
    const hashes = candidates.map((c) => candidateHash(c, indListHash))
    const runContentHash = contentHash(hashes)
    const runAttainmentHash = attainmentHash(masteryBySkill, quizResponseCount)
    const prev = await loadPreviousRun(db, sectionId, ctx.job.id)
    if (
      prev &&
      prev.rollup.standardId === standardId && // a standard switch must re-persist even if hashes collide
      prev.rollup.contentHash === runContentHash &&
      prev.rollup.attainmentHash === runAttainmentHash
    ) {
      logger.info('OutcomeAlignment.unchanged', { sectionId, contentHash: runContentHash })
      /* Strip the notice off the PREVIOUS summary before re-prepending it (#633).
         `prev.summary` is the last run's summary, and if that run was itself an early
         abort it already opens with this exact sentence — so a second consecutive
         re-run printed it twice, back to back, before the real text. Stripping first
         makes this idempotent however many times it aborts in a row. */
      const previous = (prev.summary ?? '').replace(UNCHANGED_NOTICE, '').trim()
      const summary = `${UNCHANGED_NOTICE} ${previous}`.trim()
      return { result: prev.rollup, summary }
    }

    // Map — per-artifact cache first, LLM only for new/changed material. This is
    // what keeps the report stable: unchanged artifacts reuse their exact stored
    // matches instead of being re-sampled.
    const cached = await loadCachedMatches(db, institutionId, hashes)
    const freshResults: Array<{ inputHash: string; matches: CachedMatch[] }> = []
    const hitHashes: string[] = []
    let llmCalls = 0
    const work = candidates.map((c, i) => ({ c, inputHash: hashes[i] }))
    const mapped = await pool(work, MAP_CONCURRENCY, async ({ c, inputHash }): Promise<MappedCandidate> => {
      const startedAt = new Date().toISOString()
      const label = c.title // human-readable worker name for the live roster
      await ctx.reportProgress({ label, status: 'running', startedAt })
      const hit = cached.get(inputHash)
      let res: MappedCandidate
      if (hit) {
        hitHashes.push(inputHash)
        res = { candidate: c, matches: matchesFromCached(hit, indicators), ok: true }
      } else {
        llmCalls++
        res = await mapCandidate(c, indicators, { institutionId, sectionId })
        if (res.ok) freshResults.push({ inputHash, matches: matchesToCached(res.matches) })
      }
      logger.info('OutcomeAlignment.map', { sourceType: c.sourceType, title: c.title, matches: res.matches.length, cached: !!hit })
      await ctx.reportProgress({ label, status: 'done', startedAt })
      return res
    })
    logger.info('OutcomeAlignment.mapStats', { sectionId, llmCalls, cacheHits: hitHashes.length, total: candidates.length })
    await storeCacheResults(db, institutionId, freshResults, hitHashes)

    // If EVERY material failed to analyze (LLM outage, bad credentials), fail the
    // job: Athena then tells the professor it couldn't finish — far better than
    // persisting a confident all-gaps report built from zero evidence.
    const failedCalls = mapped.filter((m) => !m.ok).length
    if (failedCalls > 0 && failedCalls === candidates.length) {
      throw new Error(`outcome_alignment: all ${failedCalls} map calls failed`)
    }

    const { rows, rollup } = reduceAlignments({
      mapped,
      indicators,
      outcomeCodes,
      masteryBySkill,
      quizResponseCount,
      standardId,
    })
    // A partial-failure run must NOT record the content fingerprint: the next
    // ask would early-abort as "unchanged" and the failed materials (which are
    // never cached) would never be retried.
    if (failedCalls === 0) rollup.contentHash = runContentHash
    rollup.attainmentHash = runAttainmentHash
    /* Only a run that actually asked the model something advances the analysis date.
       `llmCalls === 0` means every candidate came back from the per-artifact cache, which
       happens when course content is untouched and only quiz attainment moved: the run is
       real, but no material was re-read, so the mapping behind these numbers is still the
       one produced whenever it was last genuinely computed. Stamping now would tell a
       professor their course was analysed today when nothing about it was looked at, which
       is the same lie the early-abort branch avoids by returning the previous rollup
       untouched. Carry the old stamp forward instead. */
    if (llmCalls > 0) {
      rollup.analyzedAt = new Date().toISOString()
    } else if (prev?.rollup.analyzedAt) {
      rollup.analyzedAt = prev.rollup.analyzedAt
    }
    let summary = buildSummary(rollup, indicators, byType)
    if (prev && prev.rollup.contentHash === runContentHash && failedCalls === 0) {
      summary += ' Course content is unchanged since the last analysis; quiz attainment was refreshed.'
    }
    if (failedCalls > 0) {
      // Natural-language, non-technical — this summary feeds Athena's nudge.
      summary +=
        failedCalls === 1
          ? ' One course material could not be analyzed this time; re-run the analysis to include it.'
          : ` ${failedCalls} course materials could not be analyzed this time; re-run the analysis to include them.`
    }
    logger.info('OutcomeAlignment.reduce', { rows: rows.length, aligned: rollup.aligned, gaps: rollup.gaps.length })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any).rpc('persist_ai_outcome_alignments', {
      p_section_id: sectionId,
      p_institution_id: institutionId,
      p_created_by: ctx.job.created_by,
      p_rows: rows,
    })
    if (error) throw new Error(`persist_ai_outcome_alignments failed: ${error.message}`)

    await pruneStaleCache(db, institutionId)

    return { result: rollup, summary }
  },
}
