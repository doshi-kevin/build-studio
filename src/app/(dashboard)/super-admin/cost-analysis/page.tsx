/**
 * Super Admin — Cost Analysis (overview)
 *
 * Exact cost transparency across the platform: per-institution metered spend
 * (both usage ledgers, via RPC), platform provider bills (GCP BigQuery export,
 * ElevenLabs invoice, Supabase plan, Resend computed), and the reconciliation
 * between the two — the gap is shown, never hidden. Supersedes the old
 * AI Costs page.
 *
 * Role-guarded by the /super-admin layout; reads via the admin client.
 * Type: Server Component. Route: /super-admin/cost-analysis?month=YYYY-MM
 */

import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { verifySuperAdmin } from '@/lib/auth/super-admin-context'
import { RATES_DATED } from '@/lib/ai/cost'
import { getProviderBills } from '@/lib/costs/providers'
import { fetchCostSummary, fetchDailySeries, fetchUnpricedCount, fetchUnverifiedRateSpend, monthRange } from './data'
import { Kpi, Section, SourceBadge, Table, num, usd } from '@/components/super-admin/cost-analysis/bits'
import { CostDailyChart, type DailyPoint } from '@/components/super-admin/cost-analysis/CostCharts'
import { CATEGORY_LABELS, categoryColor } from '@/components/super-admin/cost-analysis/categories'

export const dynamic = 'force-dynamic'

const PROVIDER_LABELS: Record<string, string> = {
  gcp: 'Google Cloud (Cloud Run, Gemini API, registry, network)',
  elevenlabs: 'ElevenLabs (transcription + TTS)',
  supabase: 'Supabase (database, auth, storage, realtime)',
  resend: 'Resend (email)',
  pinecone: 'Pinecone (vector search)',
}

export default async function CostAnalysisPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>
}) {
  // Explicit page-level gate: the layout renders Access Denied for non-super-
  // admins, but a child page's server component still EXECUTES under it — and
  // this page's getProviderBills() performs privileged external-API calls + a
  // snapshot DB write via the admin client. Guard here so none of that runs for
  // an unauthorized caller (defense-in-depth per the mutating-op rule).
  const ctx = await verifySuperAdmin()
  if ('error' in ctx) return null

  const { month, from, to } = await searchParams.then((p) => monthRange(p.month))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const [summary, daily, unpricedCount, unverifiedRate, bills, instsRes] = await Promise.all([
    fetchCostSummary(from, to),
    fetchDailySeries(from, to),
    fetchUnpricedCount(from, to),
    fetchUnverifiedRateSpend(from, to),
    getProviderBills(),
    adminDb.from('institutions').select('id, name, status').order('name'),
  ])
  if (instsRes.error) logger.error('CostAnalysisPage: institutions load failed', instsRes.error)
  const institutions = (instsRes.data ?? []) as Array<{ id: string; name: string; status: string }>

  // ── Metered rollups ──
  const meteredTotal = summary.reduce((s, r) => s + Number(r.cost_usd), 0)
  const byInstitution = new Map<string, { total: number; byCategory: Map<string, number> }>()
  for (const r of summary) {
    const key = r.institution_id ?? 'platform'
    const e = byInstitution.get(key) ?? { total: 0, byCategory: new Map() }
    e.total += Number(r.cost_usd)
    e.byCategory.set(r.category, (e.byCategory.get(r.category) ?? 0) + Number(r.cost_usd))
    byInstitution.set(key, e)
  }
  const platformOnly = byInstitution.get('platform')
  const categories = [...new Set(summary.map((r) => r.category))].sort()

  // ── Daily chart data ──
  const dayMap = new Map<string, DailyPoint>()
  for (const r of daily) {
    const label = r.day.slice(5).replace('-', '/')
    const point = dayMap.get(label) ?? { day: label }
    point[r.category] = Math.round((Number(point[r.category] ?? 0) + Number(r.cost_usd)) * 10000) / 10000
    dayMap.set(label, point)
  }
  const dailyData = [...dayMap.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)))

  // ── Provider bills for this month + reconciliation ──
  const monthBills = bills.filter((b) => b.month === month)
  const billedTotal = monthBills.reduce((s, b) => s + b.amountUsd, 0)
  const gap = billedTotal - meteredTotal

  // Month options: last 6 months.
  const monthOptions: string[] = []
  const now = new Date()
  for (let i = 0; i < 6; i++) {
    monthOptions.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7))
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Platform</p>
          <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">Cost Analysis</h1>
          <p className="mt-2 max-w-2xl text-[15px] text-muted-foreground">
            Metered spend per institution from the usage ledgers, reconciled against real provider bills.
            Rates dated {RATES_DATED}; every cost is frozen per call at write time.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-xl border border-border bg-card p-1">
          {monthOptions.map((m) => (
            <Link
              key={m}
              href={`/super-admin/cost-analysis?month=${m}`}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                m === month ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {new Date(`${m}-15T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })}
            </Link>
          ))}
        </div>
      </div>

      {unpricedCount > 0 && (
        <div className="rounded-2xl border border-border bg-warning-muted p-4">
          <p className="text-sm text-warning-muted-foreground">
            {num(unpricedCount)} model call{unpricedCount === 1 ? '' : 's'} this month used a model with no rate row
            (priced at the fallback rate). Add the model to <code className="font-mono text-xs">src/lib/ai/cost.ts</code> so
            costs stay exact.
          </p>
        </div>
      )}

      {unverifiedRate.rows > 0 && (
        <div className="rounded-2xl border border-border bg-warning-muted p-4">
          <p className="text-sm text-warning-muted-foreground">
            {usd(unverifiedRate.costUsd)} of metered spend this month ({num(unverifiedRate.rows)} act
            {unverifiedRate.rows === 1 ? '' : 's'}) is priced from an unverified vendor rate (published range floor).
            Re-verify against the vendor&apos;s bill and bump{' '}
            <code className="font-mono text-xs">src/lib/costs/external-rates.ts</code>.
          </p>
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Metered spend" value={usd(meteredTotal)} sub="sum of both usage ledgers" />
        <Kpi label="Provider bills" value={usd(billedTotal)} sub="what vendors report/charge" />
        <Kpi
          label="Reconciliation gap"
          value={usd(Math.abs(gap))}
          sub={gap >= 0 ? 'bills exceed metered (fixed fees, infra, lag)' : 'metered exceeds bills (billing data lag)'}
        />
        <Kpi label="Institutions" value={num(institutions.length)} sub={`${num(byInstitution.size - (platformOnly ? 1 : 0))} with spend this month`} />
      </div>

      {/* Daily trend */}
      {dailyData.length > 0 && (
        <Section title="Daily spend" sub="Metered usage by category. Metering began at feature ship date — earlier days have no data by design.">
          <div className="p-4">
            <CostDailyChart data={dailyData} categories={categories} />
          </div>
        </Section>
      )}

      {/* Institution cards */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Institutions</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Click an institution for its full per-feature breakdown.</p>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {institutions.map((inst) => {
            const agg = byInstitution.get(inst.id)
            const catRows = agg ? [...agg.byCategory.entries()].sort((a, b) => b[1] - a[1]) : []
            const top = catRows[0]
            return (
              <Link
                key={inst.id}
                href={`/super-admin/cost-analysis/${inst.id}?month=${month}`}
                className="group rounded-2xl border border-border bg-card p-5 transition-colors hover:border-ring"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="font-medium text-foreground">{inst.name}</p>
                  {inst.status !== 'active' && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{inst.status}</span>
                  )}
                </div>
                <p className="mt-2 text-2xl font-semibold tabular-nums text-foreground">{usd(agg?.total ?? 0)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {top ? `top: ${CATEGORY_LABELS[top[0]] ?? top[0]} (${usd(top[1])})` : 'no metered usage this month'}
                </p>
                {catRows.length > 0 && agg && agg.total > 0 && (
                  <div className="mt-3 flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    {catRows.map(([cat, cost]) => (
                      <div
                        key={cat}
                        title={CATEGORY_LABELS[cat] ?? cat}
                        style={{ width: `${Math.max(2, (cost / agg.total) * 100)}%`, background: categoryColor(cat) }}
                      />
                    ))}
                  </div>
                )}
              </Link>
            )
          })}
        </div>
        {platformOnly && (
          <p className="text-xs text-muted-foreground">
            Plus {usd(platformOnly.total)} of platform-level metered usage not owned by any institution (e.g. auth emails).
          </p>
        )}
      </section>

      {/* Provider bills */}
      <Section
        title="Platform bills"
        sub="What each vendor actually charges. GCP figures lag ~24h and the current month is provisional until the invoice closes."
      >
        {monthBills.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            No provider bills recorded for this month yet — they appear once a connector fetches (or has snapshotted) this month&apos;s figures.
          </p>
        ) : (
        <Table
          head={['Provider', 'Month', 'Amount', 'Source', 'As of']}
          rows={monthBills
            .sort((a, b) => b.amountUsd - a.amountUsd)
            .map((b) => [
              <span key="p">
                {PROVIDER_LABELS[b.provider] ?? b.provider}
                {b.unconfigured ? <span className="ml-2 text-xs text-muted-foreground">(not configured)</span> : null}
              </span>,
              b.month,
              usd(b.amountUsd),
              <SourceBadge key="s" source={b.source} />,
              new Date(b.asOf).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
            ])}
        />
        )}
      </Section>
    </div>
  )
}
