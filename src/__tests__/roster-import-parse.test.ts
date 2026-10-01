/**
 * Roster import parser — pure parsing rules for the admin bulk roster import.
 * Resolution/commit behavior is covered in actions-roster-import.test.ts.
 */
import { describe, it, expect } from 'vitest'
import {
  parseRosterText,
  chunkRosterRows,
  MAX_ROSTER_ROWS,
  ROSTER_CHUNK_SIZE,
} from '@/lib/validations/roster-import'

describe('parseRosterText', () => {
  it('parses 3-column comma rows into name/email/course', () => {
    const { rows, errors } = parseRosterText('Jane Doe, JANE@Uni.edu , CS-101')
    expect(errors).toEqual([])
    expect(rows).toEqual([
      {
        line: 1,
        raw: 'Jane Doe, JANE@Uni.edu , CS-101',
        name: 'Jane Doe',
        email: 'jane@uni.edu', // normalized: trimmed + lowercased
        courseCode: 'CS-101',
        sectionCode: null,
      },
    ])
  })

  it('parses 2-column rows as email/course with no name', () => {
    const { rows } = parseRosterText('john@uni.edu, MATH-201')
    expect(rows[0].name).toBeNull()
    expect(rows[0].email).toBe('john@uni.edu')
    expect(rows[0].courseCode).toBe('MATH-201')
  })

  it('accepts tab-separated rows (Excel paste)', () => {
    const { rows, errors } = parseRosterText('Jane Doe\tjane@uni.edu\tCS-101')
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ name: 'Jane Doe', email: 'jane@uni.edu', courseCode: 'CS-101' })
  })

  it('extracts an explicit section code from COURSE/SECTION syntax', () => {
    const { rows } = parseRosterText('jane@uni.edu, CS-101/A')
    expect(rows[0].courseCode).toBe('CS-101')
    expect(rows[0].sectionCode).toBe('A')
  })

  it('skips a header line', () => {
    const { rows, errors } = parseRosterText('Name, Email, Course\njane@uni.edu, CS-101')
    expect(errors).toEqual([])
    expect(rows).toHaveLength(1)
    expect(rows[0].email).toBe('jane@uni.edu')
  })

  it('reports invalid emails as per-line errors and keeps parsing', () => {
    const { rows, errors } = parseRosterText('not-an-email, CS-101\njane@uni.edu, CS-101')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ line: 1 })
    expect(errors[0].reason).toContain('not-an-email')
    expect(rows).toHaveLength(1)
  })

  it('rejects rows with too many or too few columns', () => {
    const { errors } = parseRosterText('a, b, c, d\nonly-one-field')
    expect(errors).toHaveLength(2)
    expect(errors[0].reason).toContain('Too many columns')
    expect(errors[1].reason).toContain('email, COURSE-CODE')
  })

  it('drops exact duplicate (email, course) pairs and counts them', () => {
    const { rows, duplicateCount } = parseRosterText(
      'jane@uni.edu, CS-101\nJANE@uni.edu, cs-101\njane@uni.edu, CS-102'
    )
    expect(rows).toHaveLength(2)
    expect(duplicateCount).toBe(1)
  })

  it('keeps two rows for the same email in different courses', () => {
    const { rows } = parseRosterText('jane@uni.edu, CS-101\njane@uni.edu, MATH-201')
    expect(rows).toHaveLength(2)
  })

  it('ignores blank lines and trims whitespace', () => {
    const { rows, errors } = parseRosterText('\n\n  jane@uni.edu ,  CS-101  \n\n')
    expect(errors).toEqual([])
    expect(rows).toHaveLength(1)
    expect(rows[0].line).toBe(3)
  })

  it(`caps the import at ${MAX_ROSTER_ROWS} rows with a single error`, () => {
    const text = Array.from({ length: MAX_ROSTER_ROWS + 5 }, (_, i) => `s${i}@uni.edu, CS-101`).join('\n')
    const { rows, errors } = parseRosterText(text)
    expect(rows).toHaveLength(MAX_ROSTER_ROWS)
    expect(errors).toHaveLength(1)
    expect(errors[0].reason).toContain(`${MAX_ROSTER_ROWS} rows`)
  })
})

describe('chunkRosterRows', () => {
  it(`splits rows into chunks of ${ROSTER_CHUNK_SIZE}`, () => {
    const { rows } = parseRosterText(
      Array.from({ length: 45 }, (_, i) => `s${i}@uni.edu, CS-101`).join('\n')
    )
    const chunks = chunkRosterRows(rows)
    expect(chunks.map((c) => c.length)).toEqual([20, 20, 5])
  })
})
