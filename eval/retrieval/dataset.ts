// Golden-set loading and gold-page resolution for the retrieval eval gate.
//
// Gold pages are labelled by MATERIAL TITLE + page, not by module_item_id: the
// eval corpus is a seeded course, and a re-seed mints new UUIDs, so a
// UUID-keyed dataset silently rots into 0% recall. Titles survive re-seeding;
// this module turns them back into ids against whatever section is being
// evaluated, and refuses to run on a label it can't resolve.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { pageKey, type PageKey } from './metrics'

// CJS `__dirname`, not `import.meta.url`: the repo has no `"type": "module"`,
// so tsx runs these files as CommonJS.
const HERE = __dirname

export interface GoldPageLabel {
  material: string
  page: number
}

export interface GoldenCase {
  id: string
  /** Traceability back to the catalogue in athena-students.md (§12.1 U*, §12.3 G*,
   *  §15.2 copilot prompts) — so a case can be read against the row it came from. */
  use_case?: string
  category: string
  query: string
  expected_behavior: 'answer' | 'refuse'
  gold_pages: GoldPageLabel[]
}

export interface GoldenSet {
  corpus: string
  cases: GoldenCase[]
}

export interface ResolvedCase extends GoldenCase {
  /** `${moduleItemId}#${page}` for every labelled gold page. */
  gold: Set<PageKey>
}

export function loadGoldenSet(path = join(HERE, 'golden.json')): GoldenSet {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as GoldenSet
  const ids = new Set<string>()
  for (const c of raw.cases) {
    if (ids.has(c.id)) throw new Error(`golden.json: duplicate case id "${c.id}"`)
    ids.add(c.id)
    // A refusal case with gold pages, or an answer case without any, is a
    // dataset bug that would quietly score as a pass — reject it at load.
    if (c.expected_behavior === 'refuse' && c.gold_pages.length > 0) {
      throw new Error(`golden.json: refusal case "${c.id}" must have no gold pages`)
    }
    if (c.expected_behavior === 'answer' && c.gold_pages.length === 0) {
      throw new Error(`golden.json: answer case "${c.id}" has no gold pages to measure against`)
    }
  }
  return raw
}

/**
 * Turn every `{ material, page }` label into a `${moduleItemId}#${page}` key for
 * the section under evaluation, and verify each one is actually indexed.
 *
 * Both failure modes throw rather than degrade: an unresolvable title or an
 * unindexed gold page would show up as a permanent recall miss, i.e. a dataset
 * bug masquerading as a retrieval regression — the one thing a gate must never
 * do.
 */
export async function resolveGoldPages(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  sectionId: string,
  set: GoldenSet,
): Promise<ResolvedCase[]> {
  const { data: items, error } = await admin
    .from('module_items')
    .select('id, title, modules!inner(section_id)')
    .eq('modules.section_id', sectionId)
  if (error) throw new Error(`could not read module_items for section ${sectionId}: ${error.message}`)

  const byTitle = new Map<string, string[]>()
  for (const item of (items ?? []) as Array<{ id: string; title: string | null }>) {
    const key = (item.title ?? '').trim().toLowerCase()
    if (!key) continue
    byTitle.set(key, [...(byTitle.get(key) ?? []), item.id])
  }

  const resolved: ResolvedCase[] = []
  const wanted: Array<{ moduleItemId: string; page: number; label: string }> = []
  for (const c of set.cases) {
    const gold = new Set<PageKey>()
    for (const g of c.gold_pages) {
      const matches = byTitle.get(g.material.trim().toLowerCase())
      if (!matches) {
        throw new Error(`case "${c.id}": no material titled "${g.material}" in section ${sectionId}`)
      }
      if (matches.length > 1) {
        throw new Error(`case "${c.id}": "${g.material}" matches ${matches.length} items — titles must be unique`)
      }
      gold.add(pageKey(matches[0], g.page))
      wanted.push({ moduleItemId: matches[0], page: g.page, label: `${g.material} p.${g.page}` })
    }
    resolved.push({ ...c, gold })
  }

  // Confirm every gold page exists as an indexed chunk. Cheap (one query) and it
  // turns "the eval corpus was re-seeded shallower" into a clear message.
  if (wanted.length > 0) {
    const { data: chunks, error: chunkError } = await admin
      .from('material_vector_chunks')
      .select('module_item_id, page_number')
      .eq('section_id', sectionId)
      .in('module_item_id', [...new Set(wanted.map((w) => w.moduleItemId))])
      .in('page_number', [...new Set(wanted.map((w) => w.page))])
    if (chunkError) throw new Error(`could not verify gold pages: ${chunkError.message}`)
    const indexed = new Set(
      ((chunks ?? []) as Array<{ module_item_id: string; page_number: number }>).map((r) =>
        pageKey(r.module_item_id, r.page_number),
      ),
    )
    const missing = wanted.filter((w) => !indexed.has(pageKey(w.moduleItemId, w.page)))
    if (missing.length > 0) {
      throw new Error(
        `gold pages are not indexed in this corpus — re-index or fix the labels:\n  ${missing
          .map((m) => m.label)
          .join('\n  ')}`,
      )
    }
  }

  return resolved
}
