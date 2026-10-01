// Skill Mastery — pure tier helpers shared by server + client. No DB / React.
// Tiers match the prototype: Weak < 60 · Shaky 60–79 · Strong 80–100 · No data.

export type MasteryTier = 'weak' | 'shaky' | 'strong' | 'none'

/** Lower bounds (inclusive) for each scored display tier (the colored dots/bars).
 *  Distinct from the class proficiency thresholds (config: proficient 70 / at-risk 50). */
export const MASTERY_THRESHOLDS = { shaky: 60, strong: 80 } as const

export function masteryTier(score: number | null | undefined): MasteryTier {
  if (score == null || Number.isNaN(score)) return 'none'
  if (score >= MASTERY_THRESHOLDS.strong) return 'strong'
  if (score >= MASTERY_THRESHOLDS.shaky) return 'shaky'
  return 'weak'
}

export const TIER_META: Record<MasteryTier, { label: string; range: string }> = {
  weak: { label: 'Weak', range: 'Below 60' },
  shaky: { label: 'Shaky', range: '60–79' },
  strong: { label: 'Strong', range: '80–100' },
  none: { label: 'No data', range: '—' },
}

/** "—" for no data, else a rounded percentage. */
export function scoreLabel(score: number | null | undefined): string {
  return score == null || Number.isNaN(score) ? '—' : `${Math.round(score)}%`
}

/** Bar-fill percentage (0–100, integer) for a mastery score — clamped, 0 for no
 *  data. Pairs with the tier colour to render mastery as a bar (RoadmapTopicChip)
 *  instead of a number. */
export function masteryFillPct(score: number | null | undefined): number {
  if (score == null || Number.isNaN(score)) return 0
  return Math.max(0, Math.min(100, Math.round(score)))
}

/** Fixed layout width (px, in canvas units) of the roadmap chip's mastery bar,
 *  and the rendered (screen-space) width below which it's too small to read as a
 *  proportional length — at which point the chip swaps to a tier glyph instead. */
export const MASTERY_BAR_LAYOUT_PX = 40
export const MASTERY_BAR_MIN_SCREEN_PX = 24

/** Show the fixed-length mini bar (comparable across chips) when it renders big
 *  enough to read OR on hover; otherwise no visible mark (the slot stays empty at
 *  overview zoom). Gate on the bar's rendered px (layout px × zoom), never the raw
 *  zoom number. */
export function masteryBarVisible(renderedBarPx: number, hovered: boolean): boolean {
  return hovered || renderedBarPx >= MASTERY_BAR_MIN_SCREEN_PX
}

/** Roll subtopic scores up to one main-skill score, weighted by how much
 *  evidence stands behind each subtopic (≡ pooling raw observations, which
 *  avoids the average-of-averages / Simpson's-paradox error). Tested subtopics
 *  only (n > 0); null when none have data, so a main skill with only untested
 *  subtopics reads "not yet assessed", never 0%. */
export function rollUpScore(
  children: Array<{ score: number | null | undefined; n: number; w?: number | null }>,
): number | null {
  let num = 0
  let den = 0
  for (const c of children) {
    if (c.score != null && !Number.isNaN(c.score) && c.n > 0) {
      // Weight by evidence weight when we have it, falling back to the event
      // count for rows written before the engine started recording it. Counting
      // events instead let eight passed node checks outvote a final exam eight
      // to one, which is the opposite of what the evidence says.
      const wt = c.w != null && c.w > 0 ? c.w : c.n
      num += c.score * wt
      den += wt
    }
  }
  return den === 0 ? null : num / den
}

/** Coverage = fraction of a main skill's subtopics that have data (shown next to
 *  the rolled-up score so a thinly-tested parent reads as such). */
export function skillCoverage(children: Array<{ score: number | null | undefined; n: number }>): number {
  if (children.length === 0) return 0
  const tested = children.filter((c) => c.score != null && !Number.isNaN(c.score) && c.n > 0).length
  return tested / children.length
}
