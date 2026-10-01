// BulkAddStudentsDialog — the commit loop. A big paste is split into chunks and
// commitRosterChunk is called once per chunk, so every chunk gets its OWN 1..N line
// numbering back from the server. Without the remap, the final report would tell the
// admin that row 5 failed when it was really row 25 — the report is the only record
// of what happened, so wrong line numbers are the bug this covers.
// Also asserts client-side parse errors (rows that never reach the server) survive
// into the final report, and that a mid-run chunk failure keeps what already landed.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { BulkAddStudentsDialog } from '@/components/admin/students/BulkAddStudentsDialog'
import { ROSTER_CHUNK_SIZE } from '@/lib/validations/roster-import'

const mockPreview = vi.fn()
const mockCommit = vi.fn()
const mockToastError = vi.fn()

vi.mock('sonner', () => ({
  toast: { error: (...a: unknown[]) => mockToastError(...a), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock('@/app/(dashboard)/admin/students/roster-actions', () => ({
  previewRosterImport: (...a: unknown[]) => mockPreview(...a),
  commitRosterChunk: (...a: unknown[]) => mockCommit(...a),
}))

/** Server double: numbers the rows of the text it was given 1..N, like the real action. */
function serverEcho(text: string) {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  const results = lines.map((raw, i) => ({
    line: i + 1,
    raw,
    email: raw.split(',')[0].trim(),
    courseCode: 'CS-101',
    status: 'enroll' as const,
    detail: 'Enrolled in CS-101 (Section A)',
  }))
  return {
    success: true as const,
    results,
    summary: { enroll: results.length, createAndEnroll: 0, reenroll: 0, alreadyEnrolled: 0, errors: 0, duplicatesDropped: 0 },
    createdAccounts: [],
  }
}

const row = (n: number) => `s${n}@uni.edu, CS-101`

/** Runs paste → Preview → Import and resolves once the dialog reaches "done"
 *  (titled "Import complete" on a clean run, "Import stopped early" when a
 *  chunk failed mid-run). */
async function runImport(text: string) {
  mockPreview.mockResolvedValue({
    ...serverEcho(text),
    createdAccounts: undefined,
  })
  render(<BulkAddStudentsDialog open onOpenChange={vi.fn()} />)

  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: /preview/i }))
  fireEvent.click(await screen.findByRole('button', { name: /^Import \d+ rows?$/ }))
  await waitFor(() =>
    expect(screen.getByText(/Import (complete|stopped early)/i)).toBeInTheDocument()
  )
}

/** The line-number cell rendered in the same table row as `email`. */
function lineNumberFor(email: string): string {
  const cell = screen.getByText(email)
  const tr = cell.closest('tr')!
  return tr.querySelectorAll('td')[0].textContent!.trim()
}

beforeEach(() => {
  mockPreview.mockReset()
  mockCommit.mockReset()
  mockToastError.mockReset()
  mockCommit.mockImplementation(async (text: string) => serverEcho(text))
})

describe('BulkAddStudentsDialog — chunked commit', () => {
  it('splits the paste into chunk-sized calls and never sends a partial row', async () => {
    const total = ROSTER_CHUNK_SIZE + 5
    await runImport(Array.from({ length: total }, (_, i) => row(i + 1)).join('\n'))

    expect(mockCommit).toHaveBeenCalledTimes(2)
    const sent = mockCommit.mock.calls.map((call) => (call[0] as string).split('\n'))
    expect(sent[0]).toHaveLength(ROSTER_CHUNK_SIZE)
    expect(sent[1]).toHaveLength(5)
    // Every original row is sent exactly once, in order.
    expect(sent.flat()).toEqual(Array.from({ length: total }, (_, i) => row(i + 1)))
  })

  it('remaps each chunk\'s 1..N server line numbers back to the pasted line', async () => {
    const total = ROSTER_CHUNK_SIZE + 5
    await runImport(Array.from({ length: total }, (_, i) => row(i + 1)).join('\n'))

    // Chunk 2's first row comes back from the server as line 1 — it must report as 21.
    expect(lineNumberFor(`s${ROSTER_CHUNK_SIZE + 1}@uni.edu`)).toBe(String(ROSTER_CHUNK_SIZE + 1))
    expect(lineNumberFor(`s${total}@uni.edu`)).toBe(String(total))
    expect(lineNumberFor('s1@uni.edu')).toBe('1')
  })

  it('carries rows that failed to parse into the final report (they never reach the server)', async () => {
    const lines = [row(1), 'not-an-email, CS-101', row(3)]
    await runImport(lines.join('\n'))

    // Only the two valid rows were sent.
    expect(mockCommit).toHaveBeenCalledTimes(1)
    expect(mockCommit.mock.calls[0][0].split('\n')).toEqual([row(1), row(3)])
    // The bad row still appears, at its original line, as an error.
    expect(lineNumberFor('not-an-email, CS-101')).toBe('2')
    expect(screen.getByText(/is not a valid email address/i)).toBeInTheDocument()
    expect(screen.getByText(/1 error/)).toBeInTheDocument()
    // …and the valid rows keep their original numbering around it.
    expect(lineNumberFor('s3@uni.edu')).toBe('3')
  })

  it('defuses spreadsheet formulas in the credentials CSV', async () => {
    // The name comes from a list someone handed the admin; "=HYPERLINK(...)" in a
    // cell executes on open in Excel/Sheets and can exfiltrate the temp password.
    mockCommit.mockImplementation(async (text: string) => ({
      ...serverEcho(text),
      createdAccounts: [
        { email: 's1@uni.edu', name: '=HYPERLINK("http://evil","click")', password: 'temp-pw', emailSent: true },
      ],
    }))
    const blobs: Blob[] = []
    const createObjectURL = vi.fn((b: Blob) => {
      blobs.push(b)
      return 'blob:stub'
    })
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() })
    HTMLAnchorElement.prototype.click = vi.fn()

    await runImport(row(1))
    fireEvent.click(screen.getByRole('button', { name: /download credentials/i }))

    const csv = await blobs[0].text()
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`)
    expect(csv).not.toMatch(/,"=HYPERLINK/)
    vi.unstubAllGlobals()
  })

  it('stops after a failing chunk, keeps committed rows, and reports the unprocessed count', async () => {
    const total = ROSTER_CHUNK_SIZE + 5
    mockCommit
      .mockImplementationOnce(async (text: string) => serverEcho(text))
      .mockImplementationOnce(async () => ({ error: 'Unexpected error' }))

    await runImport(Array.from({ length: total }, (_, i) => row(i + 1)).join('\n'))

    expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining('Import stopped'))
    expect(screen.getByText(`${ROSTER_CHUNK_SIZE} enrolled`)).toBeInTheDocument()
    expect(screen.queryByText(`s${total}@uni.edu`)).not.toBeInTheDocument()
    // The persistent UI (not just a transient toast) must say the run stopped
    // and how many rows never ran — with the idempotent-retry recovery path.
    expect(screen.getByText(/Import stopped early/i)).toBeInTheDocument()
    expect(screen.getByText(/5 rows were not processed/i)).toBeInTheDocument()
    expect(screen.getByText(/skipped safely/i)).toBeInTheDocument()
  })
})
