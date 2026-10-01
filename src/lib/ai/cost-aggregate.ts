/**
 * Pure aggregation over ai_usage_events rows, shared by the super-admin AI Costs
 * page and its Athena per-professor drill-down.
 *
 * Kept dependency-free and pure (no DB, no React) so it can be unit-tested
 * against exact synthetic rows — see src/__tests__/ai-cost.test.ts. The page was
 * doing this inline; extracting it here keeps one source of truth for the math.
 */

/** Feature label Athena (the professor AI assistant) writes to the ledger. */
export const ATHENA_FEATURE = 'professor_assistant'

/** Minimal row shape the aggregation needs — the page's UsageRow is a superset. */
export interface AggregatableRow {
  feature: string
  cost_usd: number
  total_tokens: number
  institution_id: string
  user_id: string | null
}

export interface Agg {
  cost: number
  tokens: number
  calls: number
}

export interface UsageAggregation {
  total: Agg
  byFeature: Map<string, Agg>
  byInstitution: Map<string, Agg>
  byProfessor: Map<string, Agg>
  /** feature = ATHENA_FEATURE only: institution_id → (user_id → Agg). */
  athenaByInstitution: Map<string, Map<string, Agg>>
}

function emptyAgg(): Agg {
  return { cost: 0, tokens: 0, calls: 0 }
}

function bump(map: Map<string, Agg>, key: string, row: AggregatableRow): void {
  const a = map.get(key) ?? emptyAgg()
  a.cost += Number(row.cost_usd) || 0
  a.tokens += Number(row.total_tokens) || 0
  a.calls += 1
  map.set(key, a)
}

/**
 * Roll up usage rows into platform / feature / institution / professor totals,
 * plus the per-institution→per-professor Athena breakdown for the drill-down.
 * Counting matches the original inline logic exactly: platform totals count every
 * row, byProfessor counts only rows that have a user_id.
 */
export function aggregateUsage(rows: AggregatableRow[]): UsageAggregation {
  const total = emptyAgg()
  const byFeature = new Map<string, Agg>()
  const byInstitution = new Map<string, Agg>()
  const byProfessor = new Map<string, Agg>()
  const athenaByInstitution = new Map<string, Map<string, Agg>>()

  for (const row of rows) {
    total.cost += Number(row.cost_usd) || 0
    total.tokens += Number(row.total_tokens) || 0
    total.calls += 1

    bump(byFeature, row.feature, row)
    bump(byInstitution, row.institution_id, row)
    if (row.user_id) bump(byProfessor, row.user_id, row)

    if (row.feature === ATHENA_FEATURE && row.user_id) {
      let perProf = athenaByInstitution.get(row.institution_id)
      if (!perProf) {
        perProf = new Map<string, Agg>()
        athenaByInstitution.set(row.institution_id, perProf)
      }
      bump(perProf, row.user_id, row)
    }
  }

  return { total, byFeature, byInstitution, byProfessor, athenaByInstitution }
}
