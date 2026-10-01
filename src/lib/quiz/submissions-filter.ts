// Pure sort & filter logic for quiz submission rows.
// Extracted from QuizSubmissionsView so it can be tested independently.

/** Minimal shape required for sorting/filtering — any superset will work. */
export interface SortableSubmissionRow {
  studentName: string
  score: number | null
  status: string
  startedAt: string
  submittedAt: string | null
  timeSpentSeconds: number
  proctoringSummary: { suspiciousFlags: string[] } | null
}

export type SortKey = 'name' | 'score' | 'time' | 'date'
export type SortDir = 'asc' | 'desc'

export interface SubmissionFilterOptions {
  nameFilter: string
  statusFilter: 'all' | 'submitted' | 'in_progress'
  flagFilter: 'all' | 'flagged' | 'clean'
  sortKey: SortKey
  sortDir: SortDir
}

/**
 * Filters and sorts submission rows by name, status, proctoring flags,
 * and a configurable sort key + direction.
 * Returns a new array — does not mutate the input.
 */
export function sortAndFilterSubmissions<T extends SortableSubmissionRow>(
  rows: T[],
  opts: SubmissionFilterOptions,
): T[] {
  let result = [...rows]

  // Name filter
  if (opts.nameFilter.trim()) {
    const q = opts.nameFilter.toLowerCase()
    result = result.filter((r) => r.studentName.toLowerCase().includes(q))
  }

  // Status filter
  if (opts.statusFilter !== 'all') {
    result = result.filter((r) => r.status === opts.statusFilter)
  }

  // Flag filter
  if (opts.flagFilter === 'flagged') {
    result = result.filter((r) => (r.proctoringSummary?.suspiciousFlags?.length ?? 0) > 0)
  } else if (opts.flagFilter === 'clean') {
    result = result.filter((r) => !(r.proctoringSummary?.suspiciousFlags?.length))
  }

  // Sort
  result.sort((a, b) => {
    let diff = 0
    switch (opts.sortKey) {
      case 'name':
        diff = a.studentName.localeCompare(b.studentName)
        break
      case 'score':
        diff = (a.score ?? -1) - (b.score ?? -1)
        break
      case 'time':
        diff = a.timeSpentSeconds - b.timeSpentSeconds
        break
      case 'date':
        diff =
          new Date(a.submittedAt ?? a.startedAt).getTime() -
          new Date(b.submittedAt ?? b.startedAt).getTime()
        break
    }
    return opts.sortDir === 'asc' ? diff : -diff
  })

  return result
}
