// Tests for the sort and filter logic extracted into src/lib/quiz/submissions-filter.ts.
// Verifies filtering by name/status/flags and sorting by name/score/time/date.
import { describe, it, expect } from 'vitest'
import {
  sortAndFilterSubmissions,
  type SortableSubmissionRow,
  type SubmissionFilterOptions,
} from '@/lib/quiz/submissions-filter'

// ── Test Data ───────────────────────────────────────────────────

const rows: SortableSubmissionRow[] = [
  {
    studentName: 'Alice Johnson',
    score: 90,
    status: 'submitted',
    startedAt: '2026-03-01T10:00:00Z',
    submittedAt: '2026-03-01T10:30:00Z',
    timeSpentSeconds: 1800,
    proctoringSummary: null,
  },
  {
    studentName: 'Bob Smith',
    score: 45,
    status: 'submitted',
    startedAt: '2026-03-01T11:00:00Z',
    submittedAt: '2026-03-01T11:45:00Z',
    timeSpentSeconds: 2700,
    proctoringSummary: { suspiciousFlags: ['excessive_copy', 'tab_switch'] },
  },
  {
    studentName: 'Charlie Davis',
    score: null,
    status: 'in_progress',
    startedAt: '2026-03-01T12:00:00Z',
    submittedAt: null,
    timeSpentSeconds: 600,
    proctoringSummary: null,
  },
  {
    studentName: 'Diana Prince',
    score: 72,
    status: 'submitted',
    startedAt: '2026-03-01T09:00:00Z',
    submittedAt: '2026-03-01T09:20:00Z',
    timeSpentSeconds: 1200,
    proctoringSummary: { suspiciousFlags: [] },
  },
]

const defaults: SubmissionFilterOptions = {
  nameFilter: '',
  statusFilter: 'all',
  flagFilter: 'all',
  sortKey: 'date',
  sortDir: 'desc',
}

// ── Tests ───────────────────────────────────────────────────────

describe('sortAndFilterSubmissions', () => {
  describe('Filtering', () => {
    it('returns all rows when no filters applied', () => {
      const result = sortAndFilterSubmissions(rows, defaults)
      expect(result).toHaveLength(4)
    })

    it('filters by name (case-insensitive)', () => {
      const result = sortAndFilterSubmissions(rows, { ...defaults, nameFilter: 'alice' })
      expect(result).toHaveLength(1)
      expect(result[0].studentName).toBe('Alice Johnson')
    })

    it('filters by partial name match', () => {
      const result = sortAndFilterSubmissions(rows, { ...defaults, nameFilter: 'a' })
      // Alice, Charlie, Diana all contain 'a'
      expect(result.length).toBeGreaterThanOrEqual(2)
    })

    it('filters by submitted status', () => {
      const result = sortAndFilterSubmissions(rows, { ...defaults, statusFilter: 'submitted' })
      expect(result).toHaveLength(3)
      result.forEach((r) => expect(r.status).toBe('submitted'))
    })

    it('filters by in_progress status', () => {
      const result = sortAndFilterSubmissions(rows, { ...defaults, statusFilter: 'in_progress' })
      expect(result).toHaveLength(1)
      expect(result[0].studentName).toBe('Charlie Davis')
    })

    it('filters flagged students', () => {
      const result = sortAndFilterSubmissions(rows, { ...defaults, flagFilter: 'flagged' })
      expect(result).toHaveLength(1)
      expect(result[0].studentName).toBe('Bob Smith')
    })

    it('filters clean students (no flags or empty flags array)', () => {
      const result = sortAndFilterSubmissions(rows, { ...defaults, flagFilter: 'clean' })
      // Alice (null summary), Charlie (null summary), Diana (empty flags)
      expect(result).toHaveLength(3)
      result.forEach((r) => {
        const flags = r.proctoringSummary?.suspiciousFlags?.length ?? 0
        expect(flags).toBe(0)
      })
    })

    it('combines name + status filters', () => {
      const result = sortAndFilterSubmissions(rows, {
        ...defaults,
        nameFilter: 'bob',
        statusFilter: 'submitted',
      })
      expect(result).toHaveLength(1)
      expect(result[0].studentName).toBe('Bob Smith')
    })

    it('returns empty when no match', () => {
      const result = sortAndFilterSubmissions(rows, { ...defaults, nameFilter: 'Zzzz' })
      expect(result).toHaveLength(0)
    })
  })

  describe('Sorting', () => {
    it('sorts by name ascending', () => {
      const result = sortAndFilterSubmissions(rows, { ...defaults, sortKey: 'name', sortDir: 'asc' })
      expect(result[0].studentName).toBe('Alice Johnson')
      expect(result[result.length - 1].studentName).toBe('Diana Prince')
    })

    it('sorts by name descending', () => {
      const result = sortAndFilterSubmissions(rows, { ...defaults, sortKey: 'name', sortDir: 'desc' })
      expect(result[0].studentName).toBe('Diana Prince')
      expect(result[result.length - 1].studentName).toBe('Alice Johnson')
    })

    it('sorts by score descending (highest first)', () => {
      const result = sortAndFilterSubmissions(rows, { ...defaults, sortKey: 'score', sortDir: 'desc' })
      expect(result[0].score).toBe(90)
      expect(result[1].score).toBe(72)
      expect(result[2].score).toBe(45)
      // null score treated as -1, comes last in desc
      expect(result[3].score).toBeNull()
    })

    it('sorts by score ascending (lowest first)', () => {
      const result = sortAndFilterSubmissions(rows, { ...defaults, sortKey: 'score', sortDir: 'asc' })
      // null score treated as -1, comes first in asc
      expect(result[0].score).toBeNull()
      expect(result[1].score).toBe(45)
    })

    it('sorts by time descending (longest first)', () => {
      const result = sortAndFilterSubmissions(rows, { ...defaults, sortKey: 'time', sortDir: 'desc' })
      expect(result[0].timeSpentSeconds).toBe(2700) // Bob
      expect(result[1].timeSpentSeconds).toBe(1800) // Alice
    })

    it('sorts by date descending (newest first)', () => {
      const result = sortAndFilterSubmissions(rows, { ...defaults, sortKey: 'date', sortDir: 'desc' })
      // Charlie started at 12:00 (no submit, uses startedAt)
      expect(result[0].studentName).toBe('Charlie Davis')
    })

    it('sorts by date ascending (oldest first)', () => {
      const result = sortAndFilterSubmissions(rows, { ...defaults, sortKey: 'date', sortDir: 'asc' })
      // Diana submitted at 09:20, earliest
      expect(result[0].studentName).toBe('Diana Prince')
    })
  })

  describe('Combined sort + filter', () => {
    it('filters submitted then sorts by score desc', () => {
      const result = sortAndFilterSubmissions(rows, {
        ...defaults,
        statusFilter: 'submitted',
        sortKey: 'score',
        sortDir: 'desc',
      })
      expect(result).toHaveLength(3)
      expect(result[0].score).toBe(90)
      expect(result[1].score).toBe(72)
      expect(result[2].score).toBe(45)
    })
  })

  describe('Edge cases', () => {
    it('handles empty rows', () => {
      const result = sortAndFilterSubmissions([], defaults)
      expect(result).toHaveLength(0)
    })

    it('does not mutate the input array', () => {
      const original = [...rows]
      sortAndFilterSubmissions(rows, { ...defaults, sortKey: 'name', sortDir: 'asc' })
      expect(rows).toEqual(original)
    })

    it('preserves extra properties on row objects (generic type)', () => {
      const extended = rows.map((r, i) => ({ ...r, attemptId: `attempt-${i}` }))
      const result = sortAndFilterSubmissions(extended, { ...defaults, nameFilter: 'alice' })
      expect(result[0].attemptId).toBe('attempt-0')
    })
  })
})
