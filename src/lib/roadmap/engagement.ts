/**
 * engagement — admin-client reads for the Slice 3 signals: mastery trends (from
 * the nightly skill_mastery_snapshots) and content-consumption aggregates (from
 * the material.* events). Server-only; callers verify ownership/enrollment first.
 * The arithmetic lives in pure helpers (aggregates.ts); this is DB glue.
 *
 * Trends need ≥ 2 snapshot days spanning the window, so they stay empty until the
 * nightly cron has accrued history — that's expected, the signal lights up later.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { computeTrends, openCounts, reDownloadCounts, type ViewEvent } from './aggregates'
import { readAllPages } from '@/lib/supabase/paged-read'
import { isUnlockPending } from '@/lib/modules/unlock'

/* eslint-disable @typescript-eslint/no-explicit-any */

const TREND_GAP_DAYS = 14
const VIEW_WINDOW_MS = 30 * 24 * 3600 * 1000
const SPIKE_WINDOW_MS = 7 * 24 * 3600 * 1000
const OPEN_SPIKE_MIN = 3 // distinct students this week to count as a spike
const REDOWNLOAD_REPEAT_MIN = 2 // downloads by ONE student to count as a re-download
const REDOWNLOAD_MIN_STUDENTS = 2 // distinct re-downloaders to flag a resource
const REVISIT_REPEAT_MIN = 3 // views by ONE student to count as a revisit (view depth)
const REVISIT_MIN_STUDENTS = 2 // distinct revisiters to flag a resource
const CLICKTHROUGH_MIN = 3 // distinct students who followed an outbound link (P5)
const CAP = 2 // don't flood the map with engagement notes

const MATERIAL_TYPES = ['lecture', 'video', 'link', 'reference', 'note', 'image']

export interface MaterialItem { id: string; title: string; itemType: string; createdAt: string }

/** Section material items (id/title/type/created_at), for id→title mapping + "new since".
 *
 *  `skipLocked` (student callers) drops items in weeks that aren't open yet. Their
 *  cards never reach the student's map, so a signal naming one could only spend
 *  clutter budget on an annotation with nothing to point at.
 *
 *  `publishedVisibleOnly` narrows further to what a student can ACTUALLY open —
 *  published module + visible item. Required when the result is the DENOMINATOR
 *  of an open-rate: `logMaterialEvent` refuses to record an open for a draft or
 *  hidden item, so counting those in the total understates every student. */
export async function getSectionMaterialItems(
  admin: SupabaseClient,
  sectionId: string,
  opts: { skipLocked?: boolean; publishedVisibleOnly?: boolean } = {},
): Promise<MaterialItem[]> {
  /* Ordered + bounded: an unordered select silently stops at PostgREST's 1000
     rows, so a long course would drop arbitrary materials from every signal
     built on this map. */
  const { data } = await admin
    .from('module_items')
    .select('id, title, item_type, created_at, is_visible, modules!inner(section_id, unlock_date, is_published)')
    .eq('modules.section_id', sectionId)
    .order('created_at', { ascending: true })
    .limit(2000)
  const now = Date.now()
  const moduleOf = (r: any) => (Array.isArray(r.modules) ? r.modules[0] : r.modules)
  const locked = (r: any) => isUnlockPending(moduleOf(r)?.unlock_date, now)
  /* Mirrors logMaterialEvent's gate exactly — it refuses to record an open for
     a draft module or a hidden item, so anything failing this can never appear
     in an open-rate's numerator. */
  const hiddenFromStudents = (r: any) => r.is_visible === false || moduleOf(r)?.is_published === false
  return ((data ?? []) as any[])
    .filter((r) => MATERIAL_TYPES.includes(r.item_type)
      && !(opts.skipLocked && locked(r))
      && !(opts.publishedVisibleOnly && hiddenFromStudents(r)))
    .map((r) => ({ id: r.id as string, title: r.title as string, itemType: r.item_type as string, createdAt: r.created_at as string }))
}

/** The two snapshot days that bound a trend: the latest, and the newest one at
 *  least TREND_GAP_DAYS older (else the earliest available). Null if <2 days. */
async function trendDays(admin: SupabaseClient, sectionId: string, studentId?: string): Promise<{ latest: string; baseline: string } | null> {
  let q = admin.from('skill_mastery_snapshots').select('captured_on').eq('section_id', sectionId)
  if (studentId) q = q.eq('student_id', studentId)
  const { data: latestRow } = await q.order('captured_on', { ascending: false }).limit(1).maybeSingle()
  const latest = (latestRow as any)?.captured_on as string | undefined
  if (!latest) return null
  const cutoff = new Date(new Date(latest).getTime() - TREND_GAP_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10)
  let bq = admin.from('skill_mastery_snapshots').select('captured_on').eq('section_id', sectionId)
  if (studentId) bq = bq.eq('student_id', studentId)
  const { data: baseRow } = await bq.lte('captured_on', cutoff).order('captured_on', { ascending: false }).limit(1).maybeSingle()
  let baseline = (baseRow as any)?.captured_on as string | undefined
  if (!baseline) {
    // no point old enough — fall back to the earliest snapshot on record
    let eq2 = admin.from('skill_mastery_snapshots').select('captured_on').eq('section_id', sectionId)
    if (studentId) eq2 = eq2.eq('student_id', studentId)
    const { data: earliest } = await eq2.order('captured_on', { ascending: true }).limit(1).maybeSingle()
    baseline = (earliest as any)?.captured_on as string | undefined
  }
  if (!baseline || baseline === latest) return null
  return { latest, baseline }
}

/* Trends prefer the UNCAPPED estimate over the displayed score.
 *
 * The score is slew-rate limited, so a big genuine jump is held back and then
 * catches up over later events. Diffing the displayed score therefore reports a
 * second gain in a week where nothing new happened: the learning is real, the
 * week is wrong. `estimate` is what the score is converging toward, so diffing it
 * puts the change in the week it was earned.
 *
 * The choice is made PER COMPARISON, not per row, and that distinction is the
 * whole point. `estimate` is nullable with no backfill, so every day snapshotted
 * before it shipped has only `score`. Choosing per row would then diff a baseline
 * `score` against a latest `estimate` for the first two weeks after deploy:
 *
 *     delta = estimate_latest − score_baseline = (real delta) + (current cap lag)
 *
 * and because the score is always chasing the estimate, that lag carries the same
 * sign as the movement. The reported change would be inflated in whichever
 * direction the student is actually going — the exact error the cap exists to
 * prevent, pointed the other way, arriving the first week a professor sees the
 * arrow. So a skill uses `estimate` only when BOTH days have it, and `score` for
 * both otherwise. */
interface TrendRow { skill_id: string; score: number | null; estimate?: number | null }

const num = (v: unknown): number | null => (v == null ? null : Number(v))

/** Mean of one field per skill, skipping rows that lack it. */
function meanBySkill(rows: TrendRow[], field: 'score' | 'estimate'): Map<string, number> {
  const sum = new Map<string, { s: number; n: number }>()
  for (const r of rows) {
    const v = num(r[field])
    if (v == null) continue
    const g = sum.get(r.skill_id) ?? { s: 0, n: 0 }
    g.s += v
    g.n++
    sum.set(r.skill_id, g)
  }
  const out = new Map<string, number>()
  for (const [k, g] of sum) out.set(k, g.s / g.n)
  return out
}

/** Baseline/latest pairs per skill, each pair drawn from ONE field. */
function pairBySkill(baseRows: TrendRow[], latestRows: TrendRow[]): {
  baseline: Map<string, number>
  latest: Map<string, number>
} {
  const est = { base: meanBySkill(baseRows, 'estimate'), latest: meanBySkill(latestRows, 'estimate') }
  const sc = { base: meanBySkill(baseRows, 'score'), latest: meanBySkill(latestRows, 'score') }
  const baseline = new Map<string, number>()
  const latest = new Map<string, number>()
  const candidates = new Set([...est.latest.keys(), ...sc.latest.keys()])
  for (const skillId of candidates) {
    const useEstimate = est.base.has(skillId) && est.latest.has(skillId)
    const b = useEstimate ? est.base.get(skillId) : sc.base.get(skillId)
    const l = useEstimate ? est.latest.get(skillId) : sc.latest.get(skillId)
    if (b == null || l == null) continue
    baseline.set(skillId, b)
    latest.set(skillId, l)
  }
  return { baseline, latest }
}


/** Class-average mastery change per skill (keyed by skill_id — the caller maps to a node). */
export async function getClassMasteryTrend(admin: SupabaseClient, sectionId: string): Promise<{ skillId: string; from: number; to: number }[]> {
  const days = await trendDays(admin, sectionId)
  if (!days) return []
  /* One row per student per skill per day — 40 students x 30 skills already
     passes 1000. These are averaged across the whole class, so a truncated page
     doesn't soften the trend, it reports the wrong one. */
  const [latestRows, baseRows] = await Promise.all([
    readAllPages<any>(
      () => admin.from('skill_mastery_snapshots').select('skill_id, score, estimate').eq('section_id', sectionId).eq('captured_on', days.latest),
      'skill_id',
      'engagement.classMastery.latest',
    ),
    readAllPages<any>(
      () => admin.from('skill_mastery_snapshots').select('skill_id, score, estimate').eq('section_id', sectionId).eq('captured_on', days.baseline),
      'skill_id',
      'engagement.classMastery.baseline',
    ),
  ])
  const paired = pairBySkill(baseRows as TrendRow[], latestRows as TrendRow[])
  const trends = computeTrends(paired.baseline, paired.latest)
  return trends.map((t) => ({ skillId: t.key, from: t.from, to: t.to }))
}

/** The student's own mastery change per skill, keyed by skill NAME (the caller maps to a node). */
export async function getOwnMasteryTrend(admin: SupabaseClient, sectionId: string, studentId: string): Promise<{ skillName: string; from: number; to: number }[]> {
  const days = await trendDays(admin, sectionId, studentId)
  if (!days) return []
  const [latestRes, baseRes] = await Promise.all([
    admin.from('skill_mastery_snapshots').select('skill_id, score, estimate').eq('section_id', sectionId).eq('student_id', studentId).eq('captured_on', days.latest),
    admin.from('skill_mastery_snapshots').select('skill_id, score, estimate').eq('section_id', sectionId).eq('student_id', studentId).eq('captured_on', days.baseline),
  ])
  // One row per skill for a single student, so the same pairing rule applies.
  const paired = pairBySkill((baseRes.data ?? []) as TrendRow[], (latestRes.data ?? []) as TrendRow[])
  const trends = computeTrends(paired.baseline, paired.latest)
  if (!trends.length) return []
  const { data: skills } = await admin.from('skills').select('id, name').in('id', trends.map((t) => t.key))
  const nameById = new Map<string, string>(((skills ?? []) as any[]).map((s) => [s.id, s.name]))
  return trends.map((t) => ({ skillName: nameById.get(t.key) ?? '', from: t.from, to: t.to })).filter((t) => t.skillName)
}

async function consumptionEvents(admin: SupabaseClient, sectionId: string, eventType: string, studentId?: string): Promise<ViewEvent[]> {
  const since = new Date(Date.now() - VIEW_WINDOW_MS).toISOString()
  let q = admin.from('events').select('user_id, metadata, timestamp').eq('section_id', sectionId).eq('event_type', eventType).gte('timestamp', since)
  if (studentId) q = q.eq('user_id', studentId)
  /* Most-recent-first: the cap is a window, not a truncation to apologise for —
     but without the order it was an arbitrary 5000 of them. */
  const { data } = await q.order('timestamp', { ascending: false }).limit(5000)
  return ((data ?? []) as any[])
    .map((e) => ({ itemId: (e.metadata?.itemId as string) ?? '', studentId: e.user_id as string, at: new Date(e.timestamp).getTime() }))
    .filter((e) => e.itemId)
}

/** Professor engagement from view events: content no one has opened (`noOpens`),
 *  recent open spikes (`openSpike`, breadth = distinct students this week), and
 *  revisits (`revisits`, depth = the SAME student reopening ≥3×). All three come
 *  from one `material.viewed` fetch. */
export async function getSectionOpenSignals(
  admin: SupabaseClient,
  sectionId: string,
  items: MaterialItem[],
): Promise<{ noOpens: { title: string }[]; openSpike: { title: string; count: number }[]; revisits: { title: string; students: number }[] }> {
  if (!items.length) return { noOpens: [], openSpike: [], revisits: [] }
  const now = Date.now()
  const events = await consumptionEvents(admin, sectionId, 'material.viewed')
  const counts = openCounts(events, now, SPIKE_WINDOW_MS)
  const revisitCounts = reDownloadCounts(events, REVISIT_REPEAT_MIN)
  const noOpens = items.filter((it) => (counts.get(it.id)?.ever ?? 0) === 0).slice(0, CAP).map((it) => ({ title: it.title }))
  const openSpike = items
    .map((it) => ({ title: it.title, count: counts.get(it.id)?.recent ?? 0 }))
    .filter((x) => x.count >= OPEN_SPIKE_MIN)
    .sort((a, b) => b.count - a.count)
    .slice(0, CAP)
  const revisits = items
    .map((it) => ({ title: it.title, students: revisitCounts.get(it.id) ?? 0 }))
    .filter((x) => x.students >= REVISIT_MIN_STUDENTS)
    .sort((a, b) => b.students - a.students)
    .slice(0, CAP)
  return { noOpens, openSpike, revisits }
}

/** P2 · resources that students keep re-downloading (repeat pulls by the same
 *  student), a distinct signal from a first view — flags reference-heavy or
 *  confusing material. Returns the head-count of re-downloaders per flagged item. */
export async function getSectionRedownloadSignals(
  admin: SupabaseClient,
  sectionId: string,
  items: MaterialItem[],
): Promise<{ reDownloads: { title: string; students: number }[] }> {
  if (!items.length) return { reDownloads: [] }
  const counts = reDownloadCounts(await consumptionEvents(admin, sectionId, 'material.downloaded'), REDOWNLOAD_REPEAT_MIN)
  const reDownloads = items
    .map((it) => ({ title: it.title, students: counts.get(it.id) ?? 0 }))
    .filter((x) => x.students >= REDOWNLOAD_MIN_STUDENTS)
    .sort((a, b) => b.students - a.students)
    .slice(0, CAP)
  return { reDownloads }
}

/** P5 · outbound link click-throughs: distinct students who followed a link/
 *  reference node's external URL (`material.link_clicked`). Breadth, like an open
 *  spike — "N students clicked through". */
export async function getSectionClickThroughSignals(
  admin: SupabaseClient,
  sectionId: string,
  items: MaterialItem[],
): Promise<{ clickThroughs: { title: string; students: number }[] }> {
  if (!items.length) return { clickThroughs: [] }
  const counts = openCounts(await consumptionEvents(admin, sectionId, 'material.link_clicked'), Date.now(), VIEW_WINDOW_MS)
  const clickThroughs = items
    .map((it) => ({ title: it.title, students: counts.get(it.id)?.ever ?? 0 }))
    .filter((x) => x.students >= CLICKTHROUGH_MIN)
    .sort((a, b) => b.students - a.students)
    .slice(0, CAP)
  return { clickThroughs }
}

/** Student engagement: the node of their most recent view ("you are here") and
 *  content added since their last visit to the section. */
export async function getStudentEngagement(
  admin: SupabaseClient,
  sectionId: string,
  studentId: string,
  items: MaterialItem[],
): Promise<{ youAreHere?: { title: string; key?: string }; newSinceVisit: { title: string; key?: string }[] }> {
  const titleById = new Map(items.map((it) => [it.id, it.title]))
  /* The card key beside the title. These two signals name a MATERIAL, and two
     materials can share a title — the id is the only thing that separates them, and
     it is right here rather than needing to be looked up again. */
  const keyOf = (id: string) => `module_item:${id}`

  // Most recent view → "you are here".
  const { data: lastView } = await admin
    .from('events').select('metadata').eq('section_id', sectionId).eq('user_id', studentId).eq('event_type', 'material.viewed')
    .order('timestamp', { ascending: false }).limit(1).maybeSingle()
  const hereId = (lastView as any)?.metadata?.itemId as string | undefined
  const youAreHere = hereId && titleById.has(hereId)
    ? { title: titleById.get(hereId) as string, key: keyOf(hereId) }
    : undefined

  // Content created after the student's last activity of any kind in the section.
  const { data: lastAny } = await admin
    .from('events').select('timestamp').eq('section_id', sectionId).eq('user_id', studentId)
    .order('timestamp', { ascending: false }).limit(1).maybeSingle()
  const lastVisit = (lastAny as any)?.timestamp ? new Date((lastAny as any).timestamp).getTime() : 0
  const newSinceVisit = lastVisit
    ? items.filter((it) => new Date(it.createdAt).getTime() > lastVisit).slice(0, CAP).map((it) => ({ title: it.title, key: keyOf(it.id) }))
    : []

  return { youAreHere, newSinceVisit }
}
