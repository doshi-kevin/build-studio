// Loading skeleton for quiz insights — matches QuizInsightsDashboard layout.

import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

export default function InsightsLoading() {
  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5">
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-4 w-3" />
        <Skeleton className="h-4 w-24" />
      </div>

      {/* Header */}
      <div>
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-4 w-40 mt-2" />
      </div>

      {/* 5 stat cards — matches grid-cols-2 lg:grid-cols-5 */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} className="rounded-2xl">
            <CardContent className="p-4">
              <Skeleton className="h-3 w-20 mb-2" />
              <Skeleton className="h-8 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tabs — below stat cards */}
      <Skeleton className="h-10 w-96" />

      {/* Chart placeholder */}
      <Card className="rounded-2xl">
        <CardContent className="p-6">
          <Skeleton className="h-6 w-40 mb-4" />
          <Skeleton className="h-[280px] w-full" />
        </CardContent>
      </Card>
    </div>
  )
}
