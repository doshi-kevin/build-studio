/**
 * StudentAssignmentWorkspace — submit (and resubmit) an assignment.
 *
 * Renders the allowed file picker (if any) plus an always-optional text box.
 * Files are POSTed through the submitAssignment server action as FormData, so
 * the browser never touches storage directly. Once graded, the view locks and
 * shows the submitted content (the grade block lives in StudentGradePanel in
 * the sticky rail).
 *
 * Type: Client Component
 */
'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Upload, X, FileText, CheckCircle2, Paperclip, RotateCcw } from 'lucide-react'
import { SubmissionFileViewer } from '@/components/assignments/SubmissionFileViewer'
import { SubquestionCommentThread } from '@/components/assignments/SubquestionCommentThread'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  acceptAttrForKinds,
  labelForKind,
  MAX_SUBMISSION_FILES,
  type FileTypeKind,
  type SubmissionStatus,
  type SubmissionCommentRow,
} from '@/lib/validations/assignment'
import { validateSubmissionFile } from '@/lib/assignments/files'
import {
  submitAssignment,
  requestLateSubmission,
} from '@/app/(dashboard)/student/courses/[sectionId]/assignments/actions'

interface ExistingFile {
  name: string
  path: string
  url: string | null
}

interface StudentAssignmentWorkspaceProps {
  sectionId: string
  assignmentId: string
  fileTypes: FileTypeKind[]
  points: number
  submission: {
    id: string
    status: SubmissionStatus
    /** True when graded but grade not yet published: show read-only view, no submit button. */
    locked?: boolean
    text: string
    files: ExistingFile[]
    score: number | null
    feedback: string
  } | null
  /** Per-question comments held until a grade action — rendered read-only in the returned view. */
  heldComments?: SubmissionCommentRow[]
  /** True when the deadline has passed and no reopen window is active: hide the submit form. */
  submissionsClosed?: boolean
  /** True when a professor-granted reopen window is currently active. */
  reopenWindowActive?: boolean
  /** ISO string for the reopen window expiry, or null. */
  resubmitUntil?: string | null
  /** Timestamp when the student submitted a late request, or null. */
  lateRequestAt?: string | null
  /** A RELEASED score this student can currently see, when the professor has reopened the work for
   *  resubmission. Resubmitting clears the grade (the work changed, so it must be re-graded), which
   *  is correct — but it must never happen silently while the old score is on screen. */
  releasedScoreAtRisk?: number | null
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function StudentAssignmentWorkspace({
  sectionId,
  assignmentId,
  fileTypes,
  submission,
  heldComments = [],
  submissionsClosed = false,
  reopenWindowActive = false,
  resubmitUntil = null,
  lateRequestAt = null,
  releasedScoreAtRisk = null,
  points,
}: StudentAssignmentWorkspaceProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isPending, startTransition] = useTransition()
  const [lateRequested, setLateRequested] = useState(!!lateRequestAt)
  const [text, setText] = useState(submission?.text ?? '')
  const [files, setFiles] = useState<File[]>([])
  const [justSubmitted, setJustSubmitted] = useState<{ text: string; files: { name: string }[] } | null>(null)
  // Held while the student confirms that resubmitting replaces their released grade.
  const [confirmReplaceGrade, setConfirmReplaceGrade] = useState(false)

  /* Warn before a refresh or a tab close throws away unsubmitted work. The response lives
     only in component state until Submit, so a stray Cmd-R costs the student everything
     they have typed with no prompt at all.

     Gated on ACTUALLY dirty — unsaved text, or attached files not yet sent — rather than on
     "not submitted". A blanket unsubmitted check (as StudentSubmissionTab does) nags on a
     page the student only opened to read, which trains people to dismiss the dialog.

     Must sit above the early return below: hooks cannot run after a conditional return.

     Covers refresh, tab close and leaving the site. It does NOT cover in-app navigation —
     App Router gives no route-change guard — so a student clicking a sidebar link still
     loses the text silently. Closing that needs draft persistence (issue #613 notes the
     quiz player already solves the same problem), which is a larger change than this. */
  const isDirty = !justSubmitted && (text !== (submission?.text ?? '') || files.length > 0)
  useEffect(() => {
    if (!isDirty) return
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  const acceptsFiles = fileTypes.length > 0
  const isGraded = submission?.status === 'graded'
  const isLocked = !!submission?.locked
  const isSubmitted = submission?.status === 'submitted'
  const isReturned = submission?.status === 'returned'

  // ── Graded (grade released) OR locked (graded, not yet released) OR just submitted:
  //    show read-only "Submitted, awaiting grade" card + submitted content ──
  if ((isGraded || isLocked || justSubmitted) && (submission || justSubmitted)) {
    const snapshotText = justSubmitted?.text ?? submission?.text ?? ''
    const snapshotFiles: ExistingFile[] = justSubmitted
      ? justSubmitted.files.map((f) => ({ name: f.name, path: '', url: null }))
      : submission?.files ?? []
    const snapshotId = submission?.id ?? ''

    // Graded (grade released): just show the submitted content without the banner
    // (the grade panel in the rail handles the graded state).
    if (isGraded && !justSubmitted) {
      return (
        <SubmittedContent
          submissionId={snapshotId}
          text={snapshotText}
          files={snapshotFiles}
        />
      )
    }

    // Locked (graded, grade not published) or just submitted: show banner + content.
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-2xl border border-border bg-muted/40 p-4">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="text-sm">
            <p className="font-medium text-foreground">Submitted, awaiting grade</p>
            <p className="text-muted-foreground">Your work was sent to your instructor.</p>
          </div>
        </div>
        <SubmittedContent
          submissionId={snapshotId}
          text={snapshotText}
          files={snapshotFiles}
        />
      </div>
    )
  }

  // Submissions closed: past deadline with no active reopen window.
  // Show a read-only blocked state instead of the submit form.
  if (submissionsClosed) {
    const returnedWithFeedback = submission?.status === 'returned'

    function handleLateRequest() {
      startTransition(async () => {
        const result = await requestLateSubmission(sectionId, assignmentId)
        if ('error' in result) {
          toast.error(result.error)
          return
        }
        setLateRequested(true)
        toast.success('Request sent to your instructor.')
      })
    }

    return (
      <div className="space-y-3">
        <div className="flex items-start gap-3 rounded-2xl border border-border bg-muted/40 p-4">
          <X className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="flex-1 text-sm">
            <p className="font-medium text-foreground">Submissions closed</p>
            <p className="text-muted-foreground">The deadline has passed.</p>
          </div>
          {lateRequested ? (
            <p className="shrink-0 text-sm text-muted-foreground">
              Requested, waiting on your instructor
            </p>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={handleLateRequest}
              disabled={isPending}
              className="shrink-0"
            >
              Request late submission
            </Button>
          )}
        </div>
        {returnedWithFeedback && submission?.feedback && (
          <div className="rounded-2xl border border-border bg-card p-4 text-sm">
            <p className="font-medium text-foreground">Changes your professor requested</p>
            <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{submission.feedback}</p>
          </div>
        )}
      </div>
    )
  }

  function addFiles(list: FileList | null) {
    if (!list) return
    const next = [...files]
    for (const f of Array.from(list)) {
      if (next.length >= MAX_SUBMISSION_FILES) {
        toast.error(`You can attach at most ${MAX_SUBMISSION_FILES} files.`)
        break
      }
      // Validate at selection, the same way the assessment runner does. Without this a wrong-type
      // or oversized file (drag-drop, or "All Files" in the OS picker) sat in the list looking
      // accepted and was only rejected by the server after the student pressed Submit.
      const check = validateSubmissionFile({ name: f.name, size: f.size, type: f.type }, fileTypes)
      if (!check.ok) {
        // Only name the accepted types when the TYPE was the problem — appending "Accepted: PDF"
        // to "is larger than 25 MB" sends a student off converting a file that was already fine.
        const acceptedLabel =
          fileTypes.length === 1 ? labelForKind(fileTypes[0]) : fileTypes.map(labelForKind).join(' or ')
        const base = check.error ?? 'That file could not be attached.'
        toast.error(check.reason === 'wrong-type' && fileTypes.length > 0 ? `${base} Accepted: ${acceptedLabel}.` : base)
        continue
      }
      next.push(f)
    }
    setFiles(next)
    if (inputRef.current) inputRef.current.value = ''
  }

  function submit() {
    if (!text.trim() && files.length === 0) {
      toast.error('Add a response or attach a file before submitting.')
      return
    }
    // A released grade is about to be replaced — confirm first. submitAssignment clears score and
    // graded_at (correct: the work changed, so it must be re-graded), but the student can SEE the
    // old score on this page, so voiding it on a single click with no warning is indefensible.
    if (releasedScoreAtRisk != null) {
      setConfirmReplaceGrade(true)
      return
    }
    doSubmit()
  }

  function doSubmit() {
    setConfirmReplaceGrade(false)
    startTransition(async () => {
      const fd = new FormData()
      fd.set('text', text)
      files.forEach((f) => fd.append('files', f))
      const result = await submitAssignment(sectionId, assignmentId, fd)
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      toast.success('Submitted')
      setJustSubmitted({ text, files: files.map((f) => ({ name: f.name })) })
      setFiles([])
    })
  }

  return (
    <div className="space-y-5">
      {reopenWindowActive && resubmitUntil && (
        <div className="flex items-start gap-3 rounded-2xl border border-border bg-muted/40 p-4">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="text-sm">
            <p className="font-medium text-foreground">Submission reopened</p>
            <p className="text-muted-foreground">
              You can submit until {new Date(resubmitUntil).toLocaleString()}.
            </p>
          </div>
        </div>
      )}

      {isReturned && submission && (
        <div className="flex items-start gap-3 rounded-2xl border border-destructive/20 bg-destructive/10 p-4">
          <RotateCcw className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="text-sm">
            <p className="font-medium text-destructive">Changes requested</p>
            {submission.feedback ? (
              <p className="mt-1 whitespace-pre-wrap text-foreground">{submission.feedback}</p>
            ) : (
              <p className="text-foreground">Your professor asked you to revise and resubmit.</p>
            )}
          </div>
        </div>
      )}

      {isReturned && heldComments.length > 0 && (
        <HeldCommentThreads comments={heldComments} />
      )}

      {isSubmitted && submission && (
        <div className="flex items-start gap-3 rounded-2xl border border-border bg-muted/40 p-4">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="text-sm">
            {releasedScoreAtRisk != null ? (
              <>
                <p className="font-medium text-foreground">Reopened for another submission</p>
                <p className="text-muted-foreground">
                  Your instructor reopened this. Your current grade of {releasedScoreAtRisk} / {points} stands
                  until you submit again — resubmitting replaces it and sends your work back for grading.
                </p>
              </>
            ) : (
              <>
                <p className="font-medium text-foreground">Submitted, awaiting grade</p>
                <p className="text-muted-foreground">
                  You can update your submission below until it&apos;s graded.
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {acceptsFiles && (
        <div className="space-y-2">
          <Label>
            Files{' '}
            <span className="font-normal text-muted-foreground">
              ({fileTypes.map(labelForKind).join(', ')})
            </span>
          </Label>

          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-muted/30 px-4 py-8 text-center transition-colors hover:bg-muted/50"
          >
            <Upload className="h-6 w-6 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">Choose files to upload</span>
            <span className="text-xs text-muted-foreground">Up to 25 MB each</span>
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={acceptAttrForKinds(fileTypes)}
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
          />

          {files.length > 0 && (
            <ul className="space-y-2">
              {files.map((f, i) => (
                <li
                  key={`${f.name}-${i}`}
                  className="flex items-center gap-3 rounded-xl border border-border bg-card p-3"
                >
                  <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{f.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {formatBytes(f.size)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setFiles(files.filter((_, idx) => idx !== i))}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={`Remove ${f.name}`}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {(isSubmitted || isReturned) &&
            submission &&
            submission.files.length > 0 &&
            files.length === 0 && (
              <SubmittedContent submissionId={submission.id} text="" files={submission.files} compact />
            )}
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="response">
          Written response <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id="response"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type your response here…"
          rows={8}
          spellCheck
        />
      </div>

      <div className="flex justify-end">
        <Button onClick={submit} disabled={isPending || (!text.trim() && files.length === 0)}>
          <FileText className="h-4 w-4" />
          {isReturned ? 'Resubmit' : isSubmitted ? 'Update submission' : 'Submit'}
        </Button>
      </div>

      <AlertDialog open={confirmReplaceGrade} onOpenChange={setConfirmReplaceGrade}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace your graded work?</AlertDialogTitle>
            <AlertDialogDescription>
              You currently have a grade of {releasedScoreAtRisk} / {points}. Submitting again replaces
              that submission and clears the grade until your instructor grades the new one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my current grade</AlertDialogCancel>
            <AlertDialogAction onClick={doSubmit}>Submit and be re-graded</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** Groups held staff comments by question and renders each thread read-only. */
function HeldCommentThreads({ comments }: { comments: SubmissionCommentRow[] }) {
  // Group by question_index, preserving order of first appearance.
  const groups = new Map<number, { label: string; comments: SubmissionCommentRow[] }>()
  for (const c of comments) {
    if (!groups.has(c.question_index)) {
      groups.set(c.question_index, {
        label: c.question_label || `Question ${c.question_index + 1}`,
        comments: [],
      })
    }
    groups.get(c.question_index)!.comments.push(c)
  }

  return (
    <div className="space-y-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Instructor comments
      </p>
      {[...groups.entries()].map(([qi, group]) => (
        <div key={qi}>
          <p className="text-sm font-medium text-foreground">{group.label}</p>
          <SubquestionCommentThread
            comments={group.comments}
            canComment={false}
            onPost={async () => ({ success: true as const })}
          />
        </div>
      ))}
    </div>
  )
}

function SubmittedContent({
  submissionId,
  text,
  files,
  compact,
}: {
  submissionId: string
  text: string
  files: ExistingFile[]
  compact?: boolean
}) {
  return (
    <div className="space-y-3">
      {!compact && text && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Your response
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{text}</p>
        </div>
      )}
      {files.length > 0 && (
        <div className="space-y-2">
          {compact && (
            <p className="text-xs font-medium text-muted-foreground">Currently submitted</p>
          )}
          {files.map((f, i) => (
            <SubmissionFileViewer
              key={`${f.name}-${i}`}
              submissionId={submissionId}
              file={{ name: f.name, path: f.path, url: f.url }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
