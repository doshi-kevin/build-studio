// Loading skeleton for student quiz detail — matches StudentQuizDetail layout.

import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

export default function StudentQuizDetailLoading() {
  return (
    <div className="space-y-6">
      {/* Back link */}
      <Skeleton className="h-4 w-28 rounded-full" />

      {/* Title + description — matches PageHeader */}
      <div className="space-y-2">
        <Skeleton className="h-7 w-64 rounded-xl" />
        <Skeleton className="h-4 w-80 rounded-full" />
      </div>

      {/* Quiz info card — matches Card p-6 with grid-cols-2 md:grid-cols-4 */}
      <Card className="p-6">
        <CardContent className="p-0 space-y-4">
          <Skeleton className="h-5 w-32" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-1">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-4 w-4" />
                  <Skeleton className="h-3 w-16" />
                </div>
                <Skeleton className="h-5 w-12" />
              </div>
            ))}
          </div>
          <Skeleton className="h-px w-full" />
          <Skeleton className="h-12 w-32 rounded-full" />
        </CardContent>
      </Card>
    </div>
  )
}
