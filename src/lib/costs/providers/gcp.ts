/**
 * GCP actual spend via the Cloud Billing → BigQuery standard usage-cost
 * export — the ONLY programmatic source of real GCP costs (there is no cost
 * API). Covers Cloud Run, Artifact Registry, networking AND the Gemini API
 * line in one table. Data lags ~24h and the current month is provisional
 * until the invoice closes.
 *
 * Setup (one-time, console): enable the standard export into a BigQuery
 * dataset, then grant the Cloud Run runtime service account
 * `roles/bigquery.jobUser` on the project and `roles/bigquery.dataViewer` on
 * the dataset. Auth is ADC — no key file.
 *
 * Env: GCP_BILLING_TABLE — fully-qualified export table, e.g.
 * `my-project.billing_export.gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX`.
 */
import 'server-only'
import { BigQuery } from '@google-cloud/bigquery'
import { logger } from '@/lib/logger'
import { currentMonth, type ProviderBill } from './types'

export async function fetchGcpBills(monthsBack = 6): Promise<ProviderBill[]> {
  const table = process.env.GCP_BILLING_TABLE
  if (!table || !/^[\w.-]+$/.test(table)) {
    return [{ provider: 'gcp', month: currentMonth(), amountUsd: 0, source: 'billed', asOf: new Date().toISOString(), unconfigured: true }]
  }
  try {
    const bigquery = new BigQuery()
    // invoice.month matches real invoices (unlike usage-time bucketing);
    // credits must be added to cost for the net billed amount.
    const [rows] = await bigquery.query({
      query: `
        SELECT
          invoice.month AS month,
          service.description AS service,
          SUM(CAST(cost AS NUMERIC))
            + SUM(IFNULL((SELECT SUM(CAST(c.amount AS NUMERIC)) FROM UNNEST(credits) c), 0)) AS total
        FROM \`${table}\`
        WHERE invoice.month >= FORMAT_DATE('%Y%m', DATE_SUB(CURRENT_DATE(), INTERVAL @monthsBack MONTH))
        GROUP BY 1, 2
        ORDER BY 1 DESC, total DESC`,
      params: { monthsBack },
    })
    const byMonth = new Map<string, { total: number; services: Record<string, number> }>()
    for (const r of rows as Array<{ month: string; service: string; total: number | { toString(): string } }>) {
      const month = `${r.month.slice(0, 4)}-${r.month.slice(4, 6)}`
      const amount = Number(r.total)
      const entry = byMonth.get(month) ?? { total: 0, services: {} }
      entry.total += amount
      entry.services[r.service] = Math.round(amount * 100) / 100
      byMonth.set(month, entry)
    }
    const asOf = new Date().toISOString()
    return [...byMonth.entries()].map(([month, { total, services }]) => ({
      provider: 'gcp' as const,
      month,
      amountUsd: Math.round(total * 100) / 100,
      source: 'billed' as const,
      asOf,
      detail: { services },
    }))
  } catch (err) {
    logger.error('fetchGcpBills: BigQuery query failed', err)
    return [{ provider: 'gcp', month: currentMonth(), amountUsd: 0, source: 'billed', asOf: new Date().toISOString(), unconfigured: true, detail: { error: String(err).slice(0, 200) } }]
  }
}
