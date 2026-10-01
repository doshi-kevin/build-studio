/**
 * The needle gate — corpus-wide retrieval coverage (§11, Hit@5/10/20).
 *
 *   npm run eval:needles                        # measure, compare to the baseline
 *   npm run eval:needles -- --update-baseline
 *   npm run eval:needles -- --rerank            # include the cross-encoder
 *   npm run eval:needles -- --json=tmp/n.json
 *
 * A different question from the curated gate's. That one asks "does the right
 * page rank near the top for a question we care about"; this one asks "can the
 * index still find EVERY corner of the corpus at all" — a lecture dropping out of
 * the index, a format regressing to text-only, an embedding-model swap that hurts
 * one topic. So the metric is hit-rate at depth, not precision at the top.
 *
 * **Dense by default, no reranker.** A needle's gold page is machine-labelled
 * (whichever page the question was written from), which is a strong claim about
 * *presence* and a weak one about *ranking* — and the cross-encoder only reorders
 * what the embedding already found, so it cannot fix a coverage miss. Running
 * dense keeps the signal clean and the cost at one embedding per needle.
 * `--rerank` is there for the occasional check that reranking doesn't push a
 * needle out of the top 5.
 */

import { readFileSync, writeFileSync } from 'node:fs'

import { searchMaterialPages } from '@/lib/pinecone/search'
import { createAdminClient } from '@/lib/supabase/admin'

import { pageKey, round4, type PageKey } from './metrics'
import { loadNeedleSet, NEEDLES_BASELINE_PATH, type Needle } from './needles'

/** The depths §11 names. 20 is the "did it find it at all" depth. */
const HIT_DEPTHS = [5, 10, 20] as const
const TOPK = 20
const CONCURRENCY = 4
/** Hit-rates over ~100 needles move in ~0.01 steps, so this is ~2 needles' worth. */
const TOLERANCE = 0.02

interface NeedleResult {
  id: string
  material: string
  page: number
  query: string
  /** 1-based rank of the gold page, or null when it never appeared in topK. */
  rank: number | null
  top: string[]
}

interface NeedleBaseline {
  corpus: string
  recorded: string
  rerank: boolean
  needleCount: number
  aggregates: Record<string, number>
  /** Per needle: the rank it achieved, so a specific page falling out is named. */
  needles: Record<string, number | null>
}

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : undefined
}

/**
 * Resolve each needle's `material` title to a module_item_id in this section.
 *
 * Same rule as the curated set (dataset.ts): titles survive a re-seed, UUIDs
 * don't. An unresolvable title is a hard error — it would otherwise read as a
 * permanent miss, i.e. a dataset bug wearing a coverage regression's clothes.
 */
async function resolveNeedles(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  sectionId: string,
  needles: Needle[],
): Promise<Map<string, PageKey>> {
  const { data: items, error } = await admin
    .from('module_items')
    .select('id, title, modules!inner(section_id)')
    .eq('modules.section_id', sectionId)
  if (error) throw new Error(`could not read module_items: ${error.message}`)

  const byTitle = new Map<string, string[]>()
  for (const item of (items ?? []) as Array<{ id: string; title: string | null }>) {
    const key = (item.title ?? '').trim().toLowerCase()
    if (!key) continue
    byTitle.set(key, [...(byTitle.get(key) ?? []), item.id])
  }

  const gold = new Map<string, PageKey>()
  const unresolved: string[] = []
  for (const n of needles) {
    const matches = byTitle.get(n.material.trim().toLowerCase())
    if (!matches || matches.length !== 1) {
      unresolved.push(`${n.id} → "${n.material}"${matches ? ` (${matches.length} matches)` : ''}`)
      continue
    }
    gold.set(n.id, pageKey(matches[0], n.page))
  }
  if (unresolved.length > 0) {
    throw new Error(
      `needles reference materials that don't resolve in section ${sectionId} —\n` +
        `re-generate the set against this corpus:\n  ${unresolved.join('\n  ')}`,
    )
  }
  return gold
}

async function runNeedle(
  n: Needle,
  gold: PageKey,
  scope: { institutionId: string; sectionId: string },
  rerank: boolean,
): Promise<NeedleResult> {
  const pages = await searchMaterialPages({
    ...scope,
    query: n.query,
    topK: TOPK,
    rerank,
    ...(rerank ? { rerankTopN: TOPK } : {}),
  })
  const keys = pages.map((p) => pageKey(p.moduleItemId, p.pageNumber))
  const idx = keys.indexOf(gold)
  return {
    id: n.id,
    material: n.material,
    page: n.page,
    query: n.query,
    rank: idx === -1 ? null : idx + 1,
    top: pages.slice(0, 3).map((p) => `${p.title} p.${p.pageNumber} (${p.score.toFixed(3)})`),
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

function aggregate(results: NeedleResult[]): Record<string, number> {
  const total = results.length || 1
  const agg: Record<string, number> = {}
  for (const k of HIT_DEPTHS) {
    agg[`hit@${k}`] = round4(results.filter((r) => r.rank !== null && r.rank <= k).length / total)
  }
  // Mean reciprocal rank over the needles that were found at all — the ranking
  // read on a set whose job is coverage, reported but never gated on.
  const found = results.filter((r) => r.rank !== null)
  agg.mrr = round4(found.length ? found.reduce((s, r) => s + 1 / (r.rank as number), 0) / total : 0)
  return agg
}

function printReport(results: NeedleResult[], agg: Record<string, number>): void {
  for (const [k, v] of Object.entries(agg)) console.log(`  ${k.padEnd(10)} ${v}`)

  const missed = results.filter((r) => r.rank === null)
  if (missed.length > 0) {
    // A missed needle is the whole point of this set: a page the index cannot
    // reach from a plain-words question. Print every one — the list IS the finding.
    console.log(`\nnot found in the top ${TOPK} (${missed.length}) — pages a student can't reach by description:`)
    for (const r of missed) {
      console.log(`  · ${r.material} p.${r.page}`)
      console.log(`      "${r.query}"`)
      console.log(`      got: ${r.top.join(' · ') || '(nothing)'}`)
    }
  }

  const deep = results.filter((r) => r.rank !== null && (r.rank as number) > 5)
  if (deep.length > 0) {
    console.log(`\nfound but below rank 5 (${deep.length}):`)
    for (const r of deep) console.log(`  · ${r.material} p.${r.page} — rank ${r.rank}`)
  }
}

function compare(baseline: NeedleBaseline, agg: Record<string, number>, results: NeedleResult[]): string[] {
  const failures: string[] = []
  for (const [metric, was] of Object.entries(baseline.aggregates)) {
    if (metric === 'mrr') continue // reported, not gated — see aggregate()
    const now = agg[metric]
    if (now === undefined) continue
    if (now < was - TOLERANCE) failures.push(`${metric}: ${now} < baseline ${was} (tolerance ${TOLERANCE})`)
  }
  // The sharp check: a page that used to be findable and now isn't at any depth.
  for (const r of results) {
    const was = baseline.needles[r.id]
    if (was === undefined) continue // new needle
    if (was !== null && r.rank === null) {
      failures.push(`${r.id}: was found at rank ${was}, now missing from the top ${TOPK}`)
    }
  }
  return failures
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const flag = (name: string) => args.includes(`--${name}`)
  const value = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

  const sectionId = env('EVAL_SECTION_ID')
  const institutionId = env('EVAL_INSTITUTION_ID')
  if (!sectionId || !institutionId) {
    throw new Error('set EVAL_SECTION_ID and EVAL_INSTITUTION_ID (the seeded eval course) in .env.local')
  }
  const url = env('NEXT_PUBLIC_SUPABASE_URL') ?? ''
  if (!/127\.0\.0\.1|localhost/.test(url) && env('EVAL_ALLOW_REMOTE') !== '1') {
    throw new Error(`refusing to run against ${url || '(no URL)'} — the eval corpus is a local seed (EVAL_ALLOW_REMOTE=1 to override)`)
  }

  const rerank = flag('rerank')
  const set = loadNeedleSet()
  const admin = createAdminClient()
  const gold = await resolveNeedles(admin, sectionId, set.needles)

  console.log(
    `needle set · ${set.needles.length} needles · generated ${set.generated} by ${set.generator}\n` +
      `pinecone index ${env('PINECONE_INDEX_MATERIALS') ?? '(unset)'} · section ${sectionId} · ` +
      `topK ${TOPK} · rerank ${rerank ? 'on' : 'off (dense)'}\n`,
  )

  const results = await mapWithConcurrency(set.needles, CONCURRENCY, (n) =>
    runNeedle(n, gold.get(n.id) as PageKey, { institutionId, sectionId }, rerank),
  )
  const agg = aggregate(results)
  printReport(results, agg)

  const jsonPath = value('json')
  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({ aggregates: agg, needles: results }, null, 2))
    console.log(`\nfull results → ${jsonPath}`)
  }

  const snapshot: NeedleBaseline = {
    corpus: set.corpus,
    recorded: new Date().toISOString().slice(0, 10),
    rerank,
    needleCount: results.length,
    aggregates: agg,
    needles: Object.fromEntries(results.map((r) => [r.id, r.rank])),
  }

  if (flag('update-baseline')) {
    writeFileSync(NEEDLES_BASELINE_PATH, JSON.stringify(snapshot, null, 2) + '\n')
    console.log(`\nbaseline updated → eval/retrieval/needles-baseline.json (commit it with the change that moved it)`)
    return 0
  }

  let baseline: NeedleBaseline
  try {
    baseline = JSON.parse(readFileSync(NEEDLES_BASELINE_PATH, 'utf8')) as NeedleBaseline
  } catch {
    console.log('\nno needle baseline committed yet — run with --update-baseline to record this run')
    return 0
  }
  // Hit-rates are means over a population; a baseline recorded with the
  // reranker on is a different population from a dense run.
  if (baseline.rerank !== rerank) {
    console.log(
      `\n⚠️  baseline was recorded with rerank ${baseline.rerank ? 'ON' : 'off'} and this run is ` +
        `${rerank ? 'ON' : 'off'} — aggregates are not comparable, per-needle checks still apply.`,
    )
  }

  const failures = compare(
    baseline.rerank === rerank ? baseline : { ...baseline, aggregates: {} },
    agg,
    results,
  )
  if (failures.length > 0) {
    console.error(`\n✗ needle coverage regressed vs baseline (${baseline.recorded}):`)
    for (const f of failures) console.error(`  · ${f}`)
    return 1
  }
  console.log(`\n✓ no coverage regression vs baseline (${baseline.recorded})`)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
