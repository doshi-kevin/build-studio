/**
 * Super Admin — Cost Analysis: one institution's detailed breakdown.
 * Category donut + daily trend + per-feature cost table + Athena per-professor
 * drill-down (migrated from the retired AI Costs page) + recent calls.
 *
 * Role-guarded by the /super-admin layout; reads via the admin client.
 * Type: Server Component. Route: /super-admin/cost-analysis/[institutionId]?month=YYYY-MM
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { verifySuperAdmin } from '@/lib/auth/super-admin-context'
import { aggregateUsage } from '@/lib/ai/cost-aggregate'
import { EXTERNAL_RATES } from '@/lib/costs/external-rates'
import { fetchCostSummary, fetchDailySeries, monthRange } from '../data'
import { Kpi, Section, Table, featureLabel, num, usd } from '@/components/super-admin/cost-analysis/bits'
import { CategoryDonut, CostDailyChart, type DailyPoint } from '@/components/super-admin/cost-analysis/CostCharts'
import { CATEGORY_LABELS } from '@/components/super-admin/cost-analysis/categories'

export const dynamic = 'force-dynamic'

const RECENT_CAP = 25

export default async function InstitutionCostPage({
  params,
  searchParams,
}: {
  params: Promise<{ institutionId: string }>
  searchParams: Promise<{ month?: string }>
}) {
  // Page-level gate — the layout guard doesn't stop this child page's server
  // component from running its cross-tenant admin-client reads (see overview).
  const ctx = await verifySuperAdmin()
  if ('error' in ctx) return null

  const { institutionId } = await params
  const { month, from, to } = await searchParams.then((p) => monthRange(p.month))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data: inst } = await adminDb.from('institutions').select('id, name, status').eq('id', institutionId).single()
  if (!inst) notFound()

  const [summaryAll, daily, aiRowsRes, extRecentRes] = await Promise.all([
    fetchCostSummary(from, to),
    fetchDailySeries(from, to, institutionId),
    adminDb
      .from('ai_usage_events')
      .select('feature, model, cost_usd, total_tokens, input_tokens, output_tokens, institution_id, user_id, created_at')
      .eq('institution_id', institutionId)
      .gte('created_at', from)
      .lt('created_at', to)
      .order('created_at', { ascending: false })
      .limit(5000),
    adminDb
      .from('external_usage_events')
      .select('provider, feature, unit, quantity, cost_usd, created_at')
      .eq('institution_id', institutionId)
      .gte('created_at', from)
      .lt('created_at', to)
      .order('created_at', { ascending: false })
      .limit(RECENT_CAP),
  ])
  if (aiRowsRes.error) logger.error('InstitutionCostPage: ai rows load failed', aiRowsRes.error)

  const summary = summaryAll.filter((r) => r.institution_id === institutionId)
  const total = summary.reduce((s, r) => s + Number(r.cost_usd), 0)
  const byCategory = new Map<string, number>()
  for (const r of summary) byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + Number(r.cost_usd))
  const donutData = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => ({ key, name: CATEGORY_LABELS[key] ?? key, value: Math.round(value * 10000) / 10000 }))

  const featureRows = [...summary].sort((a, b) => Number(b.cost_usd) - Number(a.cost_usd))
  const categories = [...new Set(daily.map((r) => r.category))].sort()
  const dayMap = new Map<string, DailyPoint>()
  for (const r of daily) {
    const label = r.day.slice(5).replace('-', '/')
    const point = dayMap.get(label) ?? { day: label }
    point[r.category] = Math.round((Number(point[r.category] ?? 0) + Number(r.cost_usd)) * 10000) / 10000
    dayMap.set(label, point)
  }
  const dailyData = [...dayMap.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)))

  // Athena per-professor drill-down (migrated from the old AI Costs page).
  const aiRows = aiRowsRes.data ?? []
  const { athenaByInstitution } = aggregateUsage(aiRows)
  const athenaProfs = [...(athenaByInstitution.get(institutionId)?.entries() ?? [])].sort((a, b) => b[1].cost - a[1].cost)
  const profIds = athenaProfs.map(([id]) => id)
  const { data: profs } = profIds.length
    ? await adminDb.from('profiles').select('id, name, email').in('id', profIds)
    : { data: [] }
  const profName = new Map<string, string>(
    (profs ?? []).map((p: { id: string; name: string | null; email: string | null }) => [p.id, p.name || p.email || p.id.slice(0, 8)]),
  )

  const aiTotal = byCategory.get('ai') ?? 0
  const externalTotal = total - aiTotal

  return (
    <div className="space-y-8">
      <div>
        <nav className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Link href={`/super-admin/cost-analysis?month=${month}`} className="hover:text-foreground">
            Cost Analysis
          </Link>
          <span>/</span>
          <span className="text-foreground">{inst.name}</span>
        </nav>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          {new Date(`${month}-15T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}
        </p>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">{inst.name}</h1>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Kpi label="Total metered spend" value={usd(total)} sub="this month, both ledgers" />
        <Kpi label="AI / LLM" value={usd(aiTotal)} sub={`${num(summary.filter((r) => r.category === 'ai').reduce((s, r) => s + Number(r.calls), 0))} model calls`} />
        <Kpi label="External APIs" value={usd(externalTotal)} sub="transcription, TTS, email" />
      </div>

      {total === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No metered usage for this institution this month. Costs appear as its members use AI and audio features.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            <div className="rounded-2xl border border-border bg-card p-4 lg:col-span-2">
              <h2 className="mb-1 text-sm font-semibold text-foreground">By category</h2>
              <CategoryDonut data={donutData} />
            </div>
            <div className="rounded-2xl border border-border bg-card p-4 lg:col-span-3">
              <h2 className="mb-1 text-sm font-semibold text-foreground">Daily spend</h2>
              {dailyData.length > 0 ? (
                <CostDailyChart data={dailyData} categories={categories} />
              ) : (
                <p className="py-16 text-center text-sm text-muted-foreground">No daily data yet.</p>
              )}
            </div>
          </div>

          <Section title="By feature" sub="Every metered feature this institution used, most expensive first.">
            <Table
              head={['Feature', 'Category', 'Calls', 'Tokens / units', 'Cost']}
              rows={featureRows.map((r) => [
                featureLabel(r.feature),
                CATEGORY_LABELS[r.category] ?? r.category,
                num(Number(r.calls)),
                r.tokens != null ? num(Number(r.tokens)) : `${num(Number(r.quantity ?? 0))} ${unitHint(r.category, r.feature)}`,
                usd(Number(r.cost_usd)),
              ])}
            />
          </Section>

          {athenaProfs.length > 0 && (
            <Section title="Athena by professor" sub="Professor-assistant spend within this institution.">
              <Table
                head={['Professor', 'Calls', 'Tokens', 'Cost']}
                rows={athenaProfs.map(([id, a]) => [profName.get(id) ?? id.slice(0, 8), num(a.calls), num(a.tokens), usd(a.cost)])}
              />
            </Section>
          )}

          <Section title="Recent AI calls" sub={`Latest ${RECENT_CAP} model calls.`}>
            <Table
              head={['When', 'Feature', 'Model', 'In', 'Out', 'Cost']}
              rows={aiRows.slice(0, RECENT_CAP).map((r: { created_at: string; feature: string; model: string; input_tokens: number; output_tokens: number; cost_usd: number }) => [
                new Date(r.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
                featureLabel(r.feature),
                r.model,
                num(r.input_tokens),
                num(r.output_tokens),
                usd(Number(r.cost_usd) || 0),
              ])}
            />
          </Section>

          {(extRecentRes.data ?? []).length > 0 && (
            <Section title="Recent external usage" sub={`Latest ${RECENT_CAP} metered acts (audio, email).`}>
              <Table
                head={['When', 'Feature', 'Quantity', 'Cost']}
                rows={(extRecentRes.data ?? []).map((r: { created_at: string; feature: string; unit: string; quantity: number; cost_usd: number }) => [
                  new Date(r.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
                  featureLabel(r.feature),
                  `${num(Number(r.quantity))} ${r.unit}`,
                  usd(Number(r.cost_usd) || 0),
                ])}
              />
            </Section>
          )}
        </>
      )}
    </div>
  )
}

// Derived from the rate table (category === provider for external rows), so a
// new rate row gets its unit word for free and this can never drift from
// pricing. Read units vs write units matter: they're priced 4× apart.
const UNIT_WORDS: Record<string, string> = {
  audio_seconds: 'sec',
  characters: 'chars',
  emails: 'emails',
  queries: 'queries',
  read_units: 'read units',
  write_units: 'write units',
}

function unitHint(category: string, feature: string): string {
  const unit = EXTERNAL_RATES[`${category}:${feature}`]?.unit
  return (unit && UNIT_WORDS[unit]) || 'units'
}
