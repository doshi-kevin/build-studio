/**
 * Admin Extraction Jobs Viewer — observability for the document
 * extraction queue. Read-only; no edit actions.
 *
 * Renders the 50 most-recent jobs from the extraction_jobs table:
 * status, kind, attempts, elapsed time, error message. Linked from
 * nowhere in the main nav — it's a troubleshooting tool, not a
 * first-class admin feature. Bookmark the URL to get here.
 *
 * Role guard is enforced HERE, inline — NOT inherited from the parent
 * /admin layout. Layout and page segments render in parallel, and that
 * layout denies by returning a <DeadEnd/> rather than throwing, so
 * relying on it let this page's data stream to any authenticated user.
 * The service-role admin client lets us SELECT from the RLS-locked
 * extraction_jobs table, which is exactly why the inline gate matters.
 *
 * Tenant-scoped in SQL via extraction_jobs.institution_id (added and backfilled
 * by migration 20260807153351). Unattributable rows keep a NULL and are therefore
 * invisible to every tenant, which is the fail-closed direction.
 *
 * Type: Server Component (reads live DB on each request — no caching)
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

export const dynamic = 'force-dynamic'

interface ExtractionJobRow {
  id: string
  kind: string
  module_item_id: string | null
  status: string
  attempts: number
  max_attempts: number
  error: string | null
  payload: Record<string, unknown> | null
  claimed_by: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

function humanDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso || !endIso) return '—'
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime()
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: 'bg-muted text-muted-foreground',
    running: 'bg-info-muted text-info-muted-foreground',
    completed: 'bg-success-muted text-success-muted-foreground',
    partial: 'bg-warning-muted text-warning-muted-foreground',
    failed: 'bg-destructive-muted text-destructive-muted-foreground',
  }
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
        styles[status] ?? 'bg-muted text-muted-foreground'
      }`}
    >
      {status}
    </span>
  )
}

const PAGE_SIZE = 50

export default async function ExtractionJobsPage() {
  /* Re-check the role HERE, not only in the admin layout. Layout and page segments
     render in PARALLEL and the admin layout denies by RETURNING a <DeadEnd/> rather
     than throwing, so without this guard the page still executed and streamed its
     admin-only data into the response body for any authenticated user of this
     institution. Returning null is correct here and is not the usual page pattern —
     the layout is already rendering the visible no-access dead end around this slot. */
  const auth = await verifyInstitutionAdmin('ExtractionJobsPage')
  if ('error' in auth) {
    logger.warn('ExtractionJobsPage: denied, skipping fetch', { reason: auth.error })
    return null
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any
  /* Scoped in SQL now that extraction_jobs carries institution_id (migration
     20260807153351 added and backfilled it). This replaces an application-side filter
     that had to over-fetch 500 rows to show 50, and starved a tenant whose jobs were
     older than the 500 newest platform-wide. Rows with a NULL institution_id are
     unattributable — a job whose module item was deleted belongs to no tenant — and
     equality never matches NULL, so they stay invisible. Fail-closed. */
  const { data: rawJobs, error } = await admin
    .from('extraction_jobs')
    .select(
      'id, kind, module_item_id, status, attempts, max_attempts, error, payload, claimed_by, created_at, started_at, completed_at',
    )
    .eq('institution_id', auth.institutionId)
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE)

  if (error) {
    return (
      <div className="py-12 max-w-5xl mx-auto px-6">
        <Card>
          <CardHeader>
            <CardTitle>Extraction Jobs</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-destructive">Failed to load: {error.message}</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const rows = (rawJobs ?? []) as ExtractionJobRow[]

  // Summary counts by status — gives an at-a-glance health signal.
  const statusCounts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="py-12 max-w-6xl mx-auto px-6">
      <div className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-[clamp(28px,3vw,40px)] font-[family-name:var(--font-instrument-serif)] leading-tight">
            Extraction jobs
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Latest 50 jobs from the document-extraction queue.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {Object.entries(statusCounts).map(([status, count]) => (
            <div key={status} className="flex items-center gap-1.5">
              <StatusBadge status={status} />
              <span className="text-muted-foreground">{count}</span>
            </div>
          ))}
        </div>
      </div>

      <Card className="rounded-2xl">
        <CardContent className="p-0 overflow-x-auto">
          {rows.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground text-sm">
              No extraction jobs yet. Enqueue one by uploading a lecture PDF/PPT in a course section.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-[11px] uppercase tracking-widest text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Status</th>
                  <th className="px-3 py-2 text-left font-semibold">Kind</th>
                  <th className="px-3 py-2 text-left font-semibold">Module item</th>
                  <th className="px-3 py-2 text-left font-semibold">Attempts</th>
                  <th className="px-3 py-2 text-left font-semibold">Created</th>
                  <th className="px-3 py-2 text-left font-semibold">Elapsed</th>
                  <th className="px-3 py-2 text-left font-semibold">Error</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t border-border hover:bg-muted/20">
                    <td className="px-3 py-2">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="outline" className="text-[10px]">{row.kind}</Badge>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                      {row.module_item_id
                        ? row.module_item_id.slice(0, 8)
                        : ((row.payload?.moduleItemId as string | undefined) ?? '').slice(0, 8) || '—'}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {row.attempts}/{row.max_attempts}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {new Date(row.created_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">
                      {humanDuration(row.started_at, row.completed_at)}
                    </td>
                    <td className="px-3 py-2 max-w-[320px]">
                      {row.error ? (
                        <span className="text-xs text-destructive line-clamp-2">{row.error}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
