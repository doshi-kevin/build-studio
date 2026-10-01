/**
 * Loading skeleton for the student projects page.
 * Mirrors the final layout to prevent content shift.
 */

export default function ProjectsLoading() {
  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="space-y-2">
        <div className="h-9 w-36 bg-muted/30 rounded-lg animate-pulse" />
        <div className="h-4 w-52 bg-muted/20 rounded animate-pulse" />
      </div>

      {/* Search bar skeleton */}
      <div className="h-9 w-72 bg-muted/20 rounded-lg animate-pulse" />

      {/* Project card grid */}
      <div className="grid gap-4 md:grid-cols-2">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="rounded-2xl border border-border bg-card p-5 space-y-3">
            <div className="h-4 w-3/4 bg-muted/30 rounded animate-pulse" />
            <div className="h-3 w-full bg-muted/20 rounded animate-pulse" />
            <div className="h-3 w-2/3 bg-muted/20 rounded animate-pulse" />
            <div className="flex items-center gap-3 pt-2">
              <div className="h-3 w-16 bg-muted/20 rounded animate-pulse" />
              <div className="h-3 w-20 bg-muted/20 rounded animate-pulse" />
            </div>
            <div className="border-t border-border/40 pt-3 flex items-center gap-3">
              <div className="h-3 w-14 bg-muted/20 rounded-full animate-pulse" />
              <div className="h-3 w-12 bg-muted/20 rounded-full animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
