import { describe, it, expect } from 'vitest'
import { segmentRoster, isPastDue, type RosterStudent } from '@/lib/assignments/submissions'
import { validateSubmissionFile, buildSubmissionPath } from '@/lib/assignments/files'
import {
  parseAccepts,
  parseAssignmentPdfs,
  MAX_SUBMISSION_FILE_SIZE,
} from '@/lib/validations/assignment'
import type { SubmissionRow } from '@/lib/validations/assignment'

const students: RosterStudent[] = [
  { id: 's1', name: 'Ada', email: 'ada@x.edu' },
  { id: 's2', name: 'Bo', email: 'bo@x.edu' },
  { id: 's3', name: 'Cy', email: 'cy@x.edu' },
  { id: 's4', name: 'Di', email: 'di@x.edu' },
]

function sub(student_id: string, status: SubmissionRow['status']): SubmissionRow {
  return {
    id: `sub-${student_id}`,
    assignment_id: 'a1',
    student_id,
    status,
    text_content: 'x',
    files: [],
    score: status === 'graded' ? 90 : null,
    feedback: '',
    submitted_at: status === 'draft' ? null : '2026-06-17T00:00:00Z',
    graded_at: status === 'graded' ? '2026-06-17T01:00:00Z' : null,
  }
}

describe('segmentRoster', () => {
  it('places each student in exactly one bucket by submission status', () => {
    const segments = segmentRoster(students, [
      sub('s1', 'graded'),
      sub('s2', 'submitted'),
      sub('s3', 'draft'), // draft counts as not submitted
      // s4 has no submission
    ])

    expect(segments.graded.map((s) => s.id)).toEqual(['s1'])
    expect(segments.needsGrading.map((s) => s.id)).toEqual(['s2'])
    expect(segments.notSubmitted.map((s) => s.id).sort()).toEqual(['s3', 's4'])

    // every student appears once, total preserved
    const total =
      segments.graded.length + segments.needsGrading.length + segments.notSubmitted.length
    expect(total).toBe(students.length)
  })

  it('keeps the draft submission row for not-yet-submitted students (carries reopen / late-request state)', () => {
    const segments = segmentRoster([students[0]], [sub('s1', 'draft')])
    // The row is preserved (not nulled) so the roster can surface resubmit_until / late_request_at.
    expect(segments.notSubmitted[0].submission?.status).toBe('draft')
  })

  it('places a returned (changes-requested) submission in its own bucket', () => {
    const segments = segmentRoster(students, [
      sub('s1', 'graded'),
      sub('s2', 'submitted'),
      sub('s3', 'returned'), // professor requested changes; awaiting resubmit
      // s4 has no submission
    ])

    expect(segments.returned.map((s) => s.id)).toEqual(['s3'])
    // a returned student is not double-counted elsewhere
    expect(segments.notSubmitted.map((s) => s.id)).toEqual(['s4'])
    expect(segments.graded.map((s) => s.id)).toEqual(['s1'])
    expect(segments.needsGrading.map((s) => s.id)).toEqual(['s2'])

    // every student still appears in exactly one bucket
    const total =
      segments.graded.length +
      segments.needsGrading.length +
      segments.returned.length +
      segments.notSubmitted.length
    expect(total).toBe(students.length)
    // the returned entry retains its submission (the view shows prior work)
    expect(segments.returned[0].submission?.status).toBe('returned')
  })

  it('D. not-submitted student with late_request_at set → lateRequestAt equals that timestamp', () => {
    const LATE_TS = new Date(Date.now() - 30 * 60 * 1000).toISOString() // 30 min ago
    const submissionWithLateRequest = {
      ...sub('s1', 'draft'),
      late_request_at: LATE_TS,
    }
    const segments = segmentRoster([students[0]], [submissionWithLateRequest as SubmissionRow])
    expect(segments.notSubmitted[0].lateRequestAt).toBe(LATE_TS)
  })

  it('E. graded before a rubric existed (graded_with_rubric false) → moves to needsGrading, tagged, score preserved', () => {
    // #471 regression: adding a rubric must NOT silently zero a manually-graded submission. When a
    // rubric now exists but the grade predates it (graded_with_rubric === false — the explicit
    // marker the column carries in prod, NOT NULL default false), surface it for re-grading.
    const graded: SubmissionRow = { ...sub('s1', 'graded'), graded_with_rubric: false } // score 90

    // Without a rubric on the assignment: it stays graded.
    const noRubric = segmentRoster([students[0]], [graded])
    expect(noRubric.graded.map((s) => s.id)).toEqual(['s1'])
    expect(noRubric.needsGrading).toHaveLength(0)

    // With a rubric present (4th arg true): re-surfaced, tagged, and the score is kept on the row.
    const withRubric = segmentRoster([students[0]], [graded], undefined, true)
    expect(withRubric.graded).toHaveLength(0)
    expect(withRubric.needsGrading.map((s) => s.id)).toEqual(['s1'])
    expect(withRubric.needsGrading[0].gradedByOldRubric).toBe(true)
    expect(withRubric.needsGrading[0].submission?.score).toBe(90) // preserved, not zeroed
  })

  it('F. a rubric-era grade (graded_with_rubric true) stays in graded even when a rubric exists', () => {
    const graded: SubmissionRow = { ...sub('s1', 'graded'), rubric_scores: ['0:0'], graded_with_rubric: true }
    const segments = segmentRoster([students[0]], [graded], undefined, true)
    expect(segments.graded.map((s) => s.id)).toEqual(['s1'])
    expect(segments.needsGrading).toHaveLength(0)
    expect(segments.graded[0].gradedByOldRubric).toBeFalsy()
  })

  it('G. a rubric-era ZERO (score 0, no criteria ticked, graded_with_rubric true) stays in graded', () => {
    // The exact case the old "rubric_scores.length === 0" heuristic got wrong: a genuine 0 given
    // through the rubric UI was re-surfaced into needsGrading forever. The column disambiguates it.
    const graded: SubmissionRow = {
      ...sub('s1', 'graded'),
      score: 0,
      rubric_scores: [],
      graded_with_rubric: true,
    }
    const segments = segmentRoster([students[0]], [graded], undefined, true)
    expect(segments.graded.map((s) => s.id)).toEqual(['s1'])
    expect(segments.needsGrading).toHaveLength(0)
    expect(segments.graded[0].gradedByOldRubric).toBeFalsy()
    expect(segments.graded[0].submission?.score).toBe(0)
  })

  it('H. a rubric-era grade whose score now EXCEEDS a shrunk total → moves to needsGrading, tagged, score preserved', () => {
    // Rubric total was dropped to 40 after this was graded 90 (a >100% score). It must not sit
    // silently in Graded showing 90/40 — re-flag it for re-grade.
    const graded: SubmissionRow = { ...sub('s1', 'graded'), rubric_scores: ['0:0'], graded_with_rubric: true } // score 90
    const segments = segmentRoster([students[0]], [graded], undefined, true, 40)
    expect(segments.graded).toHaveLength(0)
    expect(segments.needsGrading.map((s) => s.id)).toEqual(['s1'])
    expect(segments.needsGrading[0].scoreExceedsTotal).toBe(true)
    expect(segments.needsGrading[0].submission?.score).toBe(90) // preserved until re-graded
  })

  it('I. a grade within the current total stays in graded (no false over-max flag)', () => {
    const graded: SubmissionRow = { ...sub('s1', 'graded'), graded_with_rubric: true } // score 90
    const segments = segmentRoster([students[0]], [graded], undefined, true, 100)
    expect(segments.graded.map((s) => s.id)).toEqual(['s1'])
    expect(segments.needsGrading).toHaveLength(0)
    expect(segments.graded[0].scoreExceedsTotal).toBeFalsy()
  })
})

describe('isPastDue', () => {
  it('is true only for a due date in the past', () => {
    expect(isPastDue(new Date(Date.now() - 60_000).toISOString())).toBe(true)
    expect(isPastDue(new Date(Date.now() + 60_000).toISOString())).toBe(false)
    expect(isPastDue(null)).toBe(false)
    expect(isPastDue(undefined)).toBe(false)
  })
})

describe('validateSubmissionFile', () => {
  const pdf = { name: 'essay.pdf', size: 1000, type: 'application/pdf' }

  it('accepts an allowed type', () => {
    expect(validateSubmissionFile(pdf, ['pdf']).ok).toBe(true)
  })

  it('rejects a disallowed extension', () => {
    expect(validateSubmissionFile({ ...pdf, name: 'a.exe' }, ['pdf']).ok).toBe(false)
  })

  it('rejects when the assignment accepts no files', () => {
    expect(validateSubmissionFile(pdf, []).ok).toBe(false)
  })

  it('rejects files over the size cap', () => {
    expect(validateSubmissionFile({ ...pdf, size: MAX_SUBMISSION_FILE_SIZE + 1 }, ['pdf']).ok).toBe(
      false,
    )
  })

  it('rejects a mismatched MIME type even if the extension looks right', () => {
    expect(validateSubmissionFile({ ...pdf, type: 'application/x-msdownload' }, ['pdf']).ok).toBe(
      false,
    )
  })

  it('tolerates a missing MIME type, falling back to extension', () => {
    expect(validateSubmissionFile({ ...pdf, type: '' }, ['pdf']).ok).toBe(true)
  })

  it('accepts a .zip when the zip kind is allowed', () => {
    const zip = { name: 'project.zip', size: 1000, type: 'application/zip' }
    expect(validateSubmissionFile(zip, ['zip']).ok).toBe(true)
  })

  it('tolerates application/octet-stream, falling back to extension', () => {
    // Some browsers report .zip uploads as the generic octet-stream type.
    const zip = { name: 'project.zip', size: 1000, type: 'application/octet-stream' }
    expect(validateSubmissionFile(zip, ['zip']).ok).toBe(true)
  })

  it('still rejects octet-stream when the extension is disallowed', () => {
    // octet-stream is only tolerated; it does not bypass the extension check.
    const exe = { name: 'malware.exe', size: 1000, type: 'application/octet-stream' }
    expect(validateSubmissionFile(exe, ['zip']).ok).toBe(false)
  })
})

describe('buildSubmissionPath', () => {
  it('puts sectionId / assignmentId / studentId as the first 3 segments (RLS contract)', () => {
    // The assignment-submissions bucket RLS keys read access on segment 1
    // (section, for staff) and segment 3 (student owner). This layout must hold
    // or the owner/staff scoping breaks.
    const segs = buildSubmissionPath('sec-1', 'asg-1', 'stu-1', 'My Essay.pdf', 'u1').split('/')
    expect(segs[0]).toBe('sec-1')
    expect(segs[1]).toBe('asg-1')
    expect(segs[2]).toBe('stu-1')
    expect(segs[3]).toBe('u1-My_Essay.pdf') // unique-prefixed + sanitized filename
  })
})

describe('parseAccepts', () => {
  it('reads valid file-type kinds from settings', () => {
    expect(parseAccepts({ accepts: { fileTypes: ['pdf', 'image'] } }).fileTypes).toEqual([
      'pdf',
      'image',
    ])
  })

  it('drops unknown kinds and tolerates garbage settings', () => {
    expect(parseAccepts({ accepts: { fileTypes: ['pdf', 'bogus'] } }).fileTypes).toEqual(['pdf'])
    expect(parseAccepts(null).fileTypes).toEqual([])
    expect(parseAccepts({}).fileTypes).toEqual([])
  })
})

describe('parseAssignmentPdfs', () => {
  it('reads the canonical settings.pdfs array in order', () => {
    const pdfs = parseAssignmentPdfs({
      pdfs: [
        { path: 'sec/a/brief.pdf', name: 'brief.pdf' },
        { path: 'sec/a/rubric.pdf', name: 'rubric.pdf' },
      ],
    })
    expect(pdfs).toEqual([
      { path: 'sec/a/brief.pdf', name: 'brief.pdf' },
      { path: 'sec/a/rubric.pdf', name: 'rubric.pdf' },
    ])
  })

  it('reads a legacy single settings.pdf as a one-item list', () => {
    // Assignments created before multi-PDF support store one object under settings.pdf.
    expect(parseAssignmentPdfs({ pdf: { path: 'sec/a/old.pdf', name: 'old.pdf' } })).toEqual([
      { path: 'sec/a/old.pdf', name: 'old.pdf' },
    ])
  })

  it('prefers the pdfs array and ignores legacy pdf when both exist', () => {
    // The array is canonical; a stray legacy field must not double-count or leak in.
    const pdfs = parseAssignmentPdfs({
      pdfs: [{ path: 'new.pdf', name: 'new.pdf' }],
      pdf: { path: 'old.pdf', name: 'old.pdf' },
    })
    expect(pdfs).toEqual([{ path: 'new.pdf', name: 'new.pdf' }])
  })

  it('skips entries missing path or name, keeping only well-formed ones', () => {
    const pdfs = parseAssignmentPdfs({
      pdfs: [
        { path: 'ok.pdf', name: 'ok.pdf' },
        { path: 'no-name.pdf' },
        { name: 'no-path.pdf' },
        { path: 42, name: 'bad-type.pdf' },
        null,
        'not-an-object',
      ],
    })
    expect(pdfs).toEqual([{ path: 'ok.pdf', name: 'ok.pdf' }])
  })

  it('returns an empty list for absent, null, or non-object settings', () => {
    expect(parseAssignmentPdfs(null)).toEqual([])
    expect(parseAssignmentPdfs(undefined)).toEqual([])
    expect(parseAssignmentPdfs({})).toEqual([])
    expect(parseAssignmentPdfs('nope')).toEqual([])
    expect(parseAssignmentPdfs({ pdf: null })).toEqual([])
    expect(parseAssignmentPdfs({ pdfs: 'not-an-array' })).toEqual([])
  })
})
