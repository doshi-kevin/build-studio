/**
 * BulkAddStudentsDialog — paste a roster list, preview it, commit it in chunks.
 *
 * Flow (one dialog, four phases):
 *   paste      → textarea; "Preview" runs previewRosterImport (server dry-run, no writes)
 *   preview    → summary chips + per-row table; "Import" starts the commit
 *   committing → the parsed rows are split into chunks of ROSTER_CHUNK_SIZE and
 *                commitRosterChunk runs once per chunk, sequentially, with progress —
 *                one big server action would time out on account creation
 *   done       → final per-row results + credentials CSV download for created accounts.
 *                Temp passwords exist ONLY on this screen: when any credentials email
 *                failed, Download is the primary action and closing warns first.
 *
 * The server re-parses and re-resolves everything on commit; this component's parsing
 * only exists to split the text into chunks, count rows, and map results back to the
 * pasted line numbers.
 *
 * Type: Client Component
 */
'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Download, Loader2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import {
  parseRosterText,
  chunkRosterRows,
  MAX_ROSTER_ROWS,
  type RosterRowResult,
  type RosterRowStatus,
} from '@/lib/validations/roster-import'
import {
  previewRosterImport,
  commitRosterChunk,
  type RosterImportSummary,
  type CreatedAccount,
} from '@/app/(dashboard)/admin/students/roster-actions'

type Phase = 'paste' | 'preview' | 'committing' | 'done'

const STATUS_META: Record<RosterRowStatus, { label: string; doneLabel: string; className: string }> = {
  enroll: { label: 'Will enroll', doneLabel: 'Enrolled', className: 'bg-success-muted text-success-muted-foreground border-success/30' },
  create_enroll: { label: 'New account + enroll', doneLabel: 'Account created + enrolled', className: 'bg-primary/10 text-primary border-primary/20' },
  reenroll: { label: 'Will re-enroll', doneLabel: 'Re-enrolled', className: 'bg-success-muted text-success-muted-foreground border-success/30' },
  already_enrolled: { label: 'Already enrolled', doneLabel: 'Skipped', className: 'bg-muted text-muted-foreground border-border' },
  error: { label: 'Error', doneLabel: 'Error', className: 'bg-destructive/10 text-destructive border-destructive/20' },
}

function StatusBadge({ status, done }: { status: RosterRowStatus; done: boolean }) {
  const meta = STATUS_META[status]
  return (
    <span className={cn('inline-block text-xs font-medium px-2 py-0.5 rounded-full border whitespace-nowrap', meta.className)}>
      {done ? meta.doneLabel : meta.label}
    </span>
  )
}

function SummaryChips({ summary, done }: { summary: RosterImportSummary; done: boolean }) {
  const enrolled = summary.enroll + summary.reenroll
  const chips = [
    { count: enrolled, label: done ? 'enrolled' : 'will be enrolled' },
    {
      count: summary.createAndEnroll,
      label: done
        ? (summary.createAndEnroll === 1 ? 'account created' : 'accounts created')
        : (summary.createAndEnroll === 1 ? 'new account' : 'new accounts'),
    },
    { count: summary.alreadyEnrolled, label: 'already enrolled' },
    { count: summary.errors, label: summary.errors === 1 ? 'error' : 'errors', destructive: true },
  ].filter((c) => c.count > 0)
  return (
    <div className="flex flex-wrap gap-2">
      {chips.map((chip) => (
        <span
          key={chip.label}
          className={cn(
            'text-xs font-medium px-2.5 py-1 rounded-full border',
            chip.destructive ? 'bg-destructive/10 text-destructive border-destructive/20' : 'bg-muted text-foreground border-border'
          )}
        >
          {chip.count} {chip.label}
        </span>
      ))}
      {summary.duplicatesDropped > 0 && (
        <span className="text-xs font-medium px-2.5 py-1 rounded-full border bg-muted text-muted-foreground border-border">
          {summary.duplicatesDropped} duplicate {summary.duplicatesDropped === 1 ? 'row' : 'rows'} ignored
        </span>
      )}
    </div>
  )
}

/* The Course column is deliberately absent: every Details string already names the
   resolved course/section, and the reclaimed width lets the error reasons — the
   whole point of the preview — wrap instead of clipping. */
function ResultsTable({ results, done }: { results: RosterRowResult[]; done: boolean }) {
  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <div className="max-h-72 overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">Line</TableHead>
              <TableHead>Student</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((row) => (
              <TableRow key={`${row.line}-${row.email}-${row.courseCode}`}>
                <TableCell className="text-xs text-muted-foreground tabular-nums align-top">{row.line}</TableCell>
                <TableCell className="text-xs font-mono max-w-40 truncate align-top" title={row.email || row.raw}>
                  {row.email || row.raw}
                </TableCell>
                <TableCell className="align-top"><StatusBadge status={row.status} done={done} /></TableCell>
                <TableCell className="text-xs text-muted-foreground whitespace-normal min-w-64 align-top">
                  {row.detail}
                  {row.warning && <span className="block text-warning-muted-foreground">⚠ {row.warning}</span>}
                  {done && row.status === 'create_enroll' && row.emailSent === false && (
                    <span className="block text-destructive">Credentials email failed — use the CSV download</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function downloadCredentialsCsv(accounts: CreatedAccount[]) {
  /* Quote-escape AND formula-escape: a name field starting with = + - @ (from a
     roster list someone handed the admin) would otherwise execute as a formula
     when the credentials file is opened in Excel/Sheets (CSV injection). */
  const escape = (v: string) => {
    const defused = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
    return `"${defused.replace(/"/g, '""')}"`
  }
  const lines = [
    'Email,Name,Temporary Password,Email Sent',
    ...accounts.map((a) => [escape(a.email), escape(a.name), escape(a.password), a.emailSent ? 'yes' : 'no'].join(',')),
  ]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'scholera-student-credentials.csv'
  link.click()
  URL.revokeObjectURL(url)
}

interface BulkAddStudentsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function BulkAddStudentsDialog({ open, onOpenChange }: BulkAddStudentsDialogProps) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('paste')
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<RosterRowResult[]>([])
  const [summary, setSummary] = useState<RosterImportSummary | null>(null)
  const [createdAccounts, setCreatedAccounts] = useState<CreatedAccount[]>([])
  const [progress, setProgress] = useState(0)
  const [processedRows, setProcessedRows] = useState(0)
  const [totalRows, setTotalRows] = useState(0)
  /** Rows never attempted because a chunk failed mid-run (0 = clean run). */
  const [unprocessedRows, setUnprocessedRows] = useState(0)
  const [csvDownloaded, setCsvDownloaded] = useState(false)
  const [closeWarned, setCloseWarned] = useState(false)

  /* Live row count for the paste phase; also powers the over-cap guard. */
  const pasteStats = useMemo(() => {
    if (!text.trim()) return { rows: 0, overCap: false }
    const parsed = parseRosterText(text)
    return {
      rows: parsed.rows.length,
      overCap: parsed.errors.some((e) => e.reason.includes(`${MAX_ROSTER_ROWS} rows`)),
    }
  }, [text])

  const reset = () => {
    setPhase('paste')
    setText('')
    setResults([])
    setSummary(null)
    setCreatedAccounts([])
    setProgress(0)
    setProcessedRows(0)
    setTotalRows(0)
    setUnprocessedRows(0)
    setCsvDownloaded(false)
    setCloseWarned(false)
  }

  /* Temp passwords exist only on the done screen — closing without the CSV when
     no email went out would strand those students. First close attempt warns. */
  const needsCsvAcknowledgement =
    phase === 'done' && createdAccounts.some((a) => !a.emailSent) && !csvDownloaded

  const handleOpenChange = (next: boolean) => {
    /* Don't allow closing mid-commit — chunks already written would be invisible. */
    if (!next && phase === 'committing') return
    if (!next && needsCsvAcknowledgement && !closeWarned) {
      setCloseWarned(true)
      return
    }
    if (!next) reset()
    onOpenChange(next)
  }

  const handlePreview = async () => {
    setLoading(true)
    const result = await previewRosterImport(text)
    setLoading(false)
    if ('error' in result) {
      toast.error(result.error)
      return
    }
    setResults(result.results)
    setSummary(result.summary)
    setPhase('preview')
  }

  /* A ref, not state: the two clicks that trigger this land in the SAME tick, and
     state updates are batched — so setPhase('committing') and any `committing`
     boolean are both still queued when the second click arrives. The `disabled`
     prop didn't help either; it only asked whether there were rows, and the button
     stopped being clickable purely because the preview branch unmounted, which needs
     a render. A ref is written synchronously, so it holds inside one tick. (#743)

     The consequence was not duplicate data — the server is idempotent — it was
     duplicate REPORTING. Run 2 hit a database where run 1 had already created the
     accounts, so every row came back already_enrolled with an EMPTY createdAccounts,
     and whichever run resolved last won the setState race. Run 2 landing last called
     setCreatedAccounts([]), so the Done screen offered no credentials download —
     and that screen is the only place those temp passwords ever exist. */
  const committingRef = useRef(false)

  const handleCommit = async () => {
    if (committingRef.current) return
    committingRef.current = true
    try {
      await runCommit()
    } catch (error) {
      /* A rejected fetch (offline mid-import) would otherwise escape as an unhandled
         rejection, leaving the ref latched and the dialog stuck on the Importing…
         spinner forever — the same shape as the stuck spinner in #729. The server is
         idempotent, so dropping back to the preview lets them safely retry. */
      logger.error('BulkAddStudentsDialog.handleCommit', error)
      toast.error('Import stopped unexpectedly. Nothing further was saved — review the rows and try again.')
      setPhase('preview')
    } finally {
      committingRef.current = false
    }
  }

  const runCommit = async () => {
    setPhase('committing')
    /* Same parser the server uses — here only to split into chunk-sized texts.
       Parse-level error rows (bad email, bad columns) never reach the server, so
       they must be carried into the final report ourselves — and the server
       numbers rows within each rebuilt chunk, so every committed result's line
       is mapped back to the original paste via the chunk's rows. */
    const { rows, errors: parseErrors } = parseRosterText(text)
    const chunks = chunkRosterRows(rows)
    setTotalRows(rows.length)
    setProcessedRows(0)
    const allResults: RosterRowResult[] = parseErrors.map((e) => ({
      line: e.line,
      raw: e.raw,
      email: '',
      courseCode: '',
      status: 'error' as const,
      detail: e.reason,
    }))
    const allAccounts: CreatedAccount[] = []
    let enroll = 0, createAndEnroll = 0, reenroll = 0, alreadyEnrolled = 0
    let errors = parseErrors.length
    let attempted = 0

    for (let i = 0; i < chunks.length; i++) {
      setProgress(Math.round((i / chunks.length) * 100))
      const chunkText = chunks[i].map((r) => r.raw).join('\n')
      const result = await commitRosterChunk(chunkText)
      if ('error' in result) {
        toast.error(`Import stopped: ${result.error}`)
        break
      }
      attempted += chunks[i].length
      setProcessedRows(attempted)
      /* Server results are chunk-numbered 1..N in order; row j is chunk row j. */
      const remapped = result.results
        .slice()
        .sort((a, b) => a.line - b.line)
        .map((r, j) => ({
          ...r,
          line: chunks[i][j]?.line ?? r.line,
          raw: chunks[i][j]?.raw ?? r.raw,
        }))
      allResults.push(...remapped)
      allAccounts.push(...result.createdAccounts)
      enroll += result.summary.enroll
      createAndEnroll += result.summary.createAndEnroll
      reenroll += result.summary.reenroll
      alreadyEnrolled += result.summary.alreadyEnrolled
      errors += result.summary.errors
      setProgress(Math.round(((i + 1) / chunks.length) * 100))
    }

    setUnprocessedRows(rows.length - attempted)
    setResults(allResults.sort((a, b) => a.line - b.line))
    setSummary({ enroll, createAndEnroll, reenroll, alreadyEnrolled, errors, duplicatesDropped: summary?.duplicatesDropped ?? 0 })
    setCreatedAccounts(allAccounts)
    setPhase('done')
    router.refresh()
  }

  const actionableCount = results.filter((r) => r.status !== 'error' && r.status !== 'already_enrolled').length
  const stopped = unprocessedRows > 0

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto" showCloseButton={phase !== 'committing'}>
        {phase === 'paste' && (
          <>
            <DialogHeader>
              <DialogTitle>Bulk Add Students</DialogTitle>
              <DialogDescription>
                One row per student per course: <span className="font-mono text-xs">Name, email, COURSE-CODE</span>.
                Pasting columns from a spreadsheet works too. If a course has several sections, pick one
                with <span className="font-mono text-xs">COURSE-CODE/SECTION</span>. Nothing is saved until you confirm the preview.
              </DialogDescription>
            </DialogHeader>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'Jane Doe, jane@university.edu, CS-101\nJohn Smith, john@university.edu, CS-101/A'}
              className="min-h-48 font-mono text-xs"
              aria-label="Roster rows"
              autoFocus
            />
            <div className="flex items-center justify-between">
              <p className={cn('text-xs', pasteStats.overCap ? 'text-destructive' : 'text-muted-foreground')}>
                {pasteStats.rows > 0 &&
                  (pasteStats.overCap
                    ? `More than ${MAX_ROSTER_ROWS} rows — split the list and paste the rest separately`
                    : `${pasteStats.rows} ${pasteStats.rows === 1 ? 'row' : 'rows'} · up to ${MAX_ROSTER_ROWS} per paste`)}
              </p>
              <Button onClick={handlePreview} disabled={loading || text.trim() === '' || pasteStats.overCap}>
                {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
                Preview
              </Button>
            </div>
          </>
        )}

        {phase === 'preview' && summary && (
          <>
            <DialogHeader>
              <DialogTitle>Review before importing</DialogTitle>
              <DialogDescription>
                Nothing has been saved yet. Fix error rows by going back, or import the valid rows now.
              </DialogDescription>
            </DialogHeader>
            <SummaryChips summary={summary} done={false} />
            <ResultsTable results={results} done={false} />
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setPhase('paste')}>Back</Button>
              {/* No `|| committingRef.current` here: a ref read during render cannot
                  trigger a re-render, so it always evaluates stale and does nothing.
                  The re-entrancy guard in handleCommit is the real fix; repeating it
                  here would only mislead the next reader. */}
              <Button onClick={handleCommit} disabled={actionableCount === 0}>
                Import {actionableCount} {actionableCount === 1 ? 'row' : 'rows'}
              </Button>
            </div>
          </>
        )}

        {phase === 'committing' && (
          <>
            <DialogHeader>
              <DialogTitle>Importing…</DialogTitle>
              <DialogDescription>
                Creating accounts and enrollments. Keep this dialog open until it finishes.
              </DialogDescription>
            </DialogHeader>
            <div className="py-6 space-y-3">
              <Progress value={progress} />
              <p className="text-sm text-muted-foreground text-center flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {processedRows} of {totalRows} rows imported
              </p>
            </div>
          </>
        )}

        {phase === 'done' && summary && (
          <>
            <DialogHeader>
              <DialogTitle>{stopped ? 'Import stopped early' : 'Import complete'}</DialogTitle>
              <DialogDescription>
                {createdAccounts.length === 0
                  ? 'All attempted rows are listed below.'
                  : createdAccounts.some((a) => a.emailSent)
                    ? 'New students were emailed their temporary password. Download the credentials file as a backup — it cannot be retrieved later.'
                    : 'Email delivery failed for the new accounts — download the credentials file and share it securely. It cannot be retrieved later.'}
              </DialogDescription>
            </DialogHeader>
            {stopped && (
              <div className="rounded-xl border border-warning/30 bg-warning-muted p-3 text-sm text-warning-muted-foreground">
                {unprocessedRows} {unprocessedRows === 1 ? 'row was' : 'rows were'} not processed.
                Re-paste the full list to finish — rows already imported will be skipped safely.
              </div>
            )}
            <SummaryChips summary={summary} done />
            <ResultsTable results={results} done />
            {closeWarned && needsCsvAcknowledgement && (
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                You haven&apos;t downloaded the credentials file — those students can&apos;t log in without it.
              </div>
            )}
            <div className="flex justify-between">
              {createdAccounts.length > 0 ? (
                <Button
                  onClick={() => {
                    downloadCredentialsCsv(createdAccounts)
                    setCsvDownloaded(true)
                  }}
                >
                  <Download className="h-4 w-4 mr-2" />
                  Download credentials CSV
                </Button>
              ) : <span />}
              <Button
                variant={createdAccounts.length > 0 ? 'outline' : 'default'}
                onClick={() => handleOpenChange(false)}
              >
                {closeWarned && needsCsvAcknowledgement ? 'Close anyway' : 'Done'}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
