'use client'

import { BarChart3, Users, BookOpen, ListChecks, Megaphone, GraduationCap, AlertTriangle } from 'lucide-react'

/** Client-safe mirror of CourseSnapshot (the server type lives in a server-only module). */
interface Snapshot {
  courseTitle: string
  courseCode: string
  rosterCount: number
  modules: { title: string; published: boolean; itemCount: number }[]
  quizzes: { title: string; status: string }[]
  publishedAnnouncementCount: number
  classAverage?: number | null
  quizPerformance?: { title: string; attempts: number; avgScore: number; belowPass: number }[]
  atRiskStudents?: { name: string; avgScore: number | null; flaggedFor: string }[]
}

/** Score color: green ≥80, amber ≥60, red <60 (matches the gradebook scale). */
function scoreClass(pct: number): string {
  if (pct >= 80) return 'text-success-muted-foreground'
  if (pct >= 60) return 'text-warning-muted-foreground'
  return 'text-destructive-muted-foreground'
}

function Stat({ icon: Icon, value, label }: { icon: typeof Users; value: string | number; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2">
      <Icon className="h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground tabular-nums">{value}</p>
        <p className="truncate text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

export function InsightsCard({ output }: { output: Snapshot }) {
  if (!output || typeof output !== 'object') return null
  const publishedModules = output.modules?.filter((m) => m.published).length ?? 0
  const draftModules = (output.modules?.length ?? 0) - publishedModules
  const publishedQuizzes = output.quizzes?.filter((q) => q.status === 'published').length ?? 0
  const draftQuizzes = (output.quizzes?.length ?? 0) - publishedQuizzes

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-xl bg-primary/10">
          <BarChart3 className="h-4 w-4 text-primary" />
        </div>
        <span className="text-sm font-semibold text-foreground">Course snapshot</span>
      </div>
      <div className="grid grid-cols-2 gap-2 p-4">
        <Stat icon={Users} value={output.rosterCount ?? 0} label="students enrolled" />
        <Stat icon={Megaphone} value={output.publishedAnnouncementCount ?? 0} label="published announcements" />
        <Stat
          icon={BookOpen}
          value={`${publishedModules} / ${output.modules?.length ?? 0}`}
          label={draftModules > 0 ? `modules published (${draftModules} draft)` : 'modules published'}
        />
        <Stat
          icon={ListChecks}
          value={`${publishedQuizzes} / ${output.quizzes?.length ?? 0}`}
          label={draftQuizzes > 0 ? `quizzes published (${draftQuizzes} draft)` : 'quizzes published'}
        />
        {typeof output.classAverage === 'number' && (
          <Stat icon={GraduationCap} value={`${output.classAverage}%`} label="class average (graded quizzes)" />
        )}
      </div>

      {/* Performance — only when there's graded data */}
      {output.quizPerformance && output.quizPerformance.length > 0 && (
        <div className="border-t border-border px-4 py-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Quiz performance</p>
          <div className="flex flex-col gap-1.5">
            {output.quizPerformance.map((q) => (
              <div key={q.title} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-foreground">{q.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{q.attempts} submitted</span>
                <span className={`w-12 shrink-0 text-right font-semibold tabular-nums ${scoreClass(q.avgScore)}`}>
                  {q.avgScore}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {output.atRiskStudents && output.atRiskStudents.length > 0 && (
        <div className="border-t border-border bg-destructive-muted/30 px-4 py-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-destructive-muted-foreground">
            <AlertTriangle className="h-3.5 w-3.5" />
            {output.atRiskStudents.length} at-risk
          </p>
          <div className="flex flex-col gap-1">
            {output.atRiskStudents.map((s) => (
              <div key={s.name} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-foreground">{s.name}</span>
                <span className="shrink-0 truncate text-xs text-muted-foreground">{s.flaggedFor}</span>
                {typeof s.avgScore === 'number' && (
                  <span className={`w-12 shrink-0 text-right font-semibold tabular-nums ${scoreClass(s.avgScore)}`}>
                    {s.avgScore}%
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
