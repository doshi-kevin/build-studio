// Admin Feedback Page — view all feedback submitted by students and professors
// in the caller's institution. Tenant-scoped via verifyInstitutionAdmin().
// Shows stats, filterable table, and allows status/notes updates.

import { createAdminClient } from '@/lib/supabase/admin'
import { feedbackQueries } from '@/lib/supabase/queries'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { logger } from '@/lib/logger'
import { FeedbackDashboard } from '@/components/admin/feedback/FeedbackDashboard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default async function AdminFeedbackPage() {
  const auth = await verifyInstitutionAdmin('AdminFeedbackPage')
  if ('error' in auth) {
    return (
      <Card className="max-w-md mx-auto mt-16">
        <CardHeader><CardTitle>Access denied</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">{auth.error}</CardContent>
      </Card>
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  logger.debug('AdminFeedbackPage: Fetching feedback data', { institutionId: auth.institutionId })

  const [feedbacks, stats] = await Promise.all([
    feedbackQueries.getAllFeedbacks(adminDb, auth.institutionId),
    feedbackQueries.getFeedbackStats(adminDb, auth.institutionId),
  ])

  logger.info('AdminFeedbackPage: Loaded', { total: stats.total, new: stats.byStatus.new })

  return (
    <div className="space-y-8">
      <div>
        <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.2em] uppercase mb-2">Administration</p>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">Feedback</h1>
        <p className="text-[15px] text-muted-foreground mt-2">
          View and manage feedback from students and professors.
        </p>
      </div>

      <FeedbackDashboard feedbacks={feedbacks} stats={stats} />
    </div>
  )
}
