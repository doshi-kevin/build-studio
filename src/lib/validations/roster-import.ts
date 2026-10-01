/**
 * Roster Import Parsing — pure text→rows parsing for the admin bulk roster import.
 *
 * The admin pastes one row per student-course pair:
 *
 *   Jane Doe, jane@university.edu, CS-101
 *   john@university.edu, MATH-201/B
 *
 * Rules:
 * - Comma OR tab separated (tab means a two/three-column Excel paste works as-is).
 * - 3 columns = name, email, course token; 2 columns = email, course token
 *   (name is only needed when an account has to be created — the server decides).
 * - Course token is COURSE-CODE or COURSE-CODE/SECTION-CODE. The slash picks a
 *   section explicitly when a course has more than one active section.
 * - Emails are normalized (trim + lowercase) here so every later lookup agrees.
 * - An optional header line (a field literally saying "email") is skipped.
 * - Exact duplicate (email, course token) pairs are dropped and counted.
 * - Hard cap of MAX_ROSTER_ROWS data rows per paste — commits run in chunks of
 *   ROSTER_CHUNK_SIZE rows so no single server action can time out.
 *
 * This module is deliberately free of Supabase imports: parsing is unit-tested
 * in isolation, resolution happens server-side in roster-actions.ts.
 */

import { z } from 'zod'

export const MAX_ROSTER_ROWS = 200
export const ROSTER_CHUNK_SIZE = 20

const emailSchema = z.string().email().trim().toLowerCase()

/* Course codes are letters/digits with common separators (CS-101, MATH 201, ML_501).
 * The optional /SECTION suffix uses the same alphabet. Kept permissive on purpose —
 * the real check is the institution-scoped DB lookup. */
const COURSE_TOKEN_PATTERN = /^([A-Za-z0-9][A-Za-z0-9 ._-]*?)(?:\s*\/\s*([A-Za-z0-9][A-Za-z0-9._-]*))?$/

export interface ParsedRosterRow {
  /** 1-based line number in the pasted text (for error reporting) */
  line: number
  raw: string
  /** Present only on 3-column rows; required later if an account must be created */
  name: string | null
  /** Normalized: trimmed + lowercased */
  email: string
  courseCode: string
  /** From the COURSE-CODE/SECTION syntax; null = auto-pick the single active section */
  sectionCode: string | null
}

export interface RosterParseError {
  line: number
  raw: string
  reason: string
}

export interface RosterParseResult {
  rows: ParsedRosterRow[]
  errors: RosterParseError[]
  /** Exact duplicate (email, course token) rows silently dropped */
  duplicateCount: number
}

/** True when a line looks like a pasted header row (e.g. "name,email,course"). */
function isHeaderLine(fields: string[]): boolean {
  return fields.some((f) => f.toLowerCase() === 'email')
}

/**
 * Parses pasted roster text into normalized rows + per-line errors.
 * Never throws; every bad line becomes an error entry and parsing continues.
 */
export function parseRosterText(text: string): RosterParseResult {
  const rows: ParsedRosterRow[] = []
  const errors: RosterParseError[] = []
  const seen = new Set<string>()
  let duplicateCount = 0
  let dataLinesSeen = 0

  const lines = text.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (!raw) continue

    /* Tab wins when present — a comma inside an Excel cell stays part of the field. */
    const delimiter = raw.includes('\t') ? '\t' : ','
    const fields = raw.split(delimiter).map((f) => f.trim()).filter((f) => f !== '')

    if (dataLinesSeen === 0 && rows.length === 0 && isHeaderLine(fields)) {
      continue
    }

    dataLinesSeen++
    if (dataLinesSeen > MAX_ROSTER_ROWS) {
      errors.push({
        line: i + 1,
        raw,
        reason: `Import is capped at ${MAX_ROSTER_ROWS} rows per paste — split the list and paste the rest separately`,
      })
      /* One cap error is enough; stop scanning. */
      break
    }

    const line = i + 1

    if (fields.length < 2 || fields.length > 3) {
      errors.push({
        line,
        raw,
        reason:
          fields.length < 2
            ? 'Expected at least "email, COURSE-CODE"'
            : 'Too many columns — expected "name, email, COURSE-CODE"',
      })
      continue
    }

    const [name, emailField, courseField] =
      fields.length === 3 ? [fields[0], fields[1], fields[2]] : [null, fields[0], fields[1]]

    const emailParsed = emailSchema.safeParse(emailField)
    if (!emailParsed.success) {
      errors.push({ line, raw, reason: `"${emailField}" is not a valid email address` })
      continue
    }

    const courseMatch = courseField.match(COURSE_TOKEN_PATTERN)
    if (!courseMatch) {
      errors.push({ line, raw, reason: `"${courseField}" is not a valid course code` })
      continue
    }

    const courseCode = courseMatch[1].trim()
    const sectionCode = courseMatch[2]?.trim() || null

    const dedupKey = `${emailParsed.data}|${courseCode.toUpperCase()}|${(sectionCode ?? '').toUpperCase()}`
    if (seen.has(dedupKey)) {
      duplicateCount++
      continue
    }
    seen.add(dedupKey)

    rows.push({ line, raw, name, email: emailParsed.data, courseCode, sectionCode })
  }

  return { rows, errors, duplicateCount }
}

/** Splits parsed rows into commit-sized chunks (the client sends one action call per chunk). */
export function chunkRosterRows(rows: ParsedRosterRow[]): ParsedRosterRow[][] {
  const chunks: ParsedRosterRow[][] = []
  for (let i = 0; i < rows.length; i += ROSTER_CHUNK_SIZE) {
    chunks.push(rows.slice(i, i + ROSTER_CHUNK_SIZE))
  }
  return chunks
}

/**
 * Statuses a resolved/committed row can end in. Shared by the preview and commit
 * paths so the UI renders one table for both.
 */
export const ROSTER_ROW_STATUSES = [
  'enroll',          // existing student, will be / was enrolled
  'create_enroll',   // new account will be / was created, then enrolled
  'reenroll',        // previously dropped/withdrawn row flips back to enrolled
  'already_enrolled',// on the roster already — skipped
  'error',
] as const

export type RosterRowStatus = (typeof ROSTER_ROW_STATUSES)[number]

export interface RosterRowResult {
  line: number
  raw: string
  email: string
  courseCode: string
  status: RosterRowStatus
  /** Human-readable detail: the resolved section label, the error reason, or a capacity warning */
  detail: string
  /** Set on commit for rows whose account was created: whether the credentials email sent */
  emailSent?: boolean
  /** Capacity warning — informational, never blocks */
  warning?: string
}
