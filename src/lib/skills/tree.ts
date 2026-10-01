// Shape flat skill rows into the two-level tree the editor renders.

import type { SkillRow, SkillTreeNode } from '@/lib/validations/skill'

/**
 * The leaf skills of a section — the finest granularity at which mastery
 * evidence is recorded and the set a live quiz can be tagged against. A skill is
 * a leaf when no tracked skill names it as parent, so a childless top-level
 * skill counts as its own leaf (not just subtopics). Untracked skills — excluded
 * (professor dropped) or suppressed (AI-suggested, not yet corroborated) — are
 * never leaves. Input order is preserved.
 *
 * Single source of truth for "what can hold mastery" — the recompute engine, the
 * manual-composer skill chips, and the AI concept pool all resolve leaves here so
 * they can never disagree about which skills a live quiz may feed.
 */
export function selectLeafSkills<T extends { id: string; parent_id: string | null; excluded?: boolean; suppressed?: boolean }>(
  skills: T[],
): T[] {
  const tracked = (t: T) => !t.excluded && !t.suppressed
  const hasChildren = new Set<string>()
  for (const t of skills) {
    if (tracked(t) && t.parent_id) hasChildren.add(t.parent_id)
  }
  return skills.filter((t) => tracked(t) && !hasChildren.has(t.id))
}


/** Group rows into main-skills-with-subtopics, ordered by position then name.
 *  Subskills whose parent isn't present are dropped (defensive). */
export function buildSkillTree(rows: SkillRow[]): SkillTreeNode[] {
  const byParent = new Map<string, SkillRow[]>()
  for (const r of rows) {
    if (r.parent_id) {
      const list = byParent.get(r.parent_id) ?? []
      list.push(r)
      byParent.set(r.parent_id, list)
    }
  }

  const sort = (a: SkillRow, b: SkillRow) =>
    a.position - b.position || a.name.localeCompare(b.name)

  return rows
    .filter((r) => r.parent_id === null)
    .sort(sort)
    .map((main) => ({
      ...main,
      subtopics: (byParent.get(main.id) ?? []).sort(sort),
    }))
}
