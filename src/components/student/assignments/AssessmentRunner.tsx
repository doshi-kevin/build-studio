/**
 * Assessment runner — the student's view of a timed, proctored assignment.
 *
 * Three phases (see src/lib/assignments/assessment.ts):
 *   lobby  → rules + camera check + Start
 *   work   → the brief (passed in as briefSlot) + countdown; proctoring + fullscreen on
 *   upload → brief hidden, upload widget only; proctoring still on
 * The brief is only ever sent by the server during the work phase, so a reload can't
 * reveal it in the upload window. This component enforces the same rule in-session and
 * runs the reused quiz proctoring engine.
 *
 * Type: Client Component
 */
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ShieldCheck, Clock, Camera, Upload, CheckCircle2, X, Loader2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
  type AssessmentConfig,
} from '@/lib/validations/assignment'
import { validateSubmissionFile } from '@/lib/assignments/files'
import { computeAssessmentTiming, isAlreadySubmittedError, isTerminalSubmitError, type AssessmentPhase } from '@/lib/assignments/assessment'
import { ProctoringCapture } from '@/lib/quiz/proctoring'
import { VideoProctoring } from '@/lib/quiz/video-proctoring'
import { enterFullscreen, exitFullscreen } from '@/lib/quiz/fullscreen'
import { requestCameraAccess, stopMediaStream } from '@/lib/quiz/camera-permission'
import type { ProctoringEvent } from '@/lib/validations/proctoring'
import {
  startAssessment,
  finishAssessmentWorkEarly,
  submitAssessment,
  saveAssessmentProctoringBatch,
  saveAssessmentProctoringSnapshot,
} from '@/app/(dashboard)/student/courses/[sectionId]/assignments/assessment-actions'

interface Props {
  sectionId: string
  assignmentId: string
  config: AssessmentConfig
  fileTypes: FileTypeKind[]
  /** Server-computed initial state (source of truth on every load). */
  initialStartedAt: string | null
  initialWorkEndedAt: string | null
  initialPhase: AssessmentPhase
  submissionId: string | null
  submitted: boolean
  /** The brief/template, rendered server-side ONLY when the server phase is 'work'. */
  briefSlot: React.ReactNode
}

function mmss(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function AssessmentRunner({
  sectionId,
  assignmentId,
  config,
  fileTypes,
  initialStartedAt,
  initialWorkEndedAt,
  initialPhase,
  submissionId: initialSubmissionId,
  submitted: initialSubmitted,
  briefSlot,
}: Props) {
  const router = useRouter()
  // No work limit set → the work phase has no countdown; the student finishes when ready.
  const untimed = config.workMinutes == null

  const [startedAt, setStartedAt] = useState(initialStartedAt)
  const [workEndedAt, setWorkEndedAt] = useState(initialWorkEndedAt)
  const [submissionId, setSubmissionId] = useState(initialSubmissionId)
  const [submitted, setSubmitted] = useState(initialSubmitted)
  const [phase, setPhase] = useState<AssessmentPhase>(initialPhase)
  const [remaining, setRemaining] = useState(0)

  const [starting, setStarting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // A submit that FAILED with attached work (offline/500 auto-submit, or a failed manual retry).
  // The one-shot auto path won't retry and a transient toast is easy to miss, so surface a
  // persistent banner + retry affordance — otherwise the work is silently lost and auto-zeroed.
  const [autoSubmitFailed, setAutoSubmitFailed] = useState(false)
  // The last submit error message, shown in the banner. When it's a TERMINAL error (window closed /
  // attempt reset / past deadline) the retry is impossible, so the banner stops promising one.
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [confirmFinish, setConfirmFinish] = useState(false)
  const [cameraChecked, setCameraChecked] = useState(false)
  const [files, setFiles] = useState<File[]>([])

  const captureRef = useRef<ProctoringCapture | null>(null)
  const videoRef = useRef<VideoProctoring | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const videoElRef = useRef<HTMLVideoElement | null>(null)
  const canvasElRef = useRef<HTMLCanvasElement | null>(null)
  const videoBatchIndex = useRef(0)
  const submittingRef = useRef(false)
  // Latest attached files, mirrored into a ref. The countdown's auto-submit runs off a doSubmit
  // closure captured at first render (files === []); reading files from this ref instead means the
  // expiry auto-submit posts whatever the student actually attached, not an empty array.
  const filesRef = useRef<File[]>([])
  // The closed-phase auto-submit must fire at most once. doSubmit's error path resets submittingRef,
  // so without this guard the 1s tick re-fires submitAssessment every second on a closed window.
  const closedSubmitAttempted = useRef(false)

  // Keep filesRef current so the auto-submit path (which holds a stale doSubmit) sees live files.
  useEffect(() => {
    filesRef.current = files
  }, [files])

  // ── Countdown: derive phase + remaining from the server-anchored clock every second ──
  useEffect(() => {
    if (!startedAt || submitted) return
    const tick = () => {
      const t = computeAssessmentTiming(startedAt, workEndedAt, config, Date.now())
      setPhase(t.phase)
      setRemaining(t.remainingSeconds)
      if (t.phase === 'closed' && !submittingRef.current && !closedSubmitAttempted.current) {
        closedSubmitAttempted.current = true // fire the expiry auto-submit once; never loop on error
        void doSubmit(true) // window fully elapsed → auto-submit whatever exists
      }
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
    // doSubmit is stable via refs; config/startedAt/workEndedAt drive the clock
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startedAt, workEndedAt, submitted])

  // ── Proctoring: active ONLY during the work phase. Entering the upload phase (or submitting)
  // tears it down — the upload/handout step is not proctored and leaves fullscreen. ──
  useEffect(() => {
    if (!startedAt || !submissionId || submitted || phase !== 'work') return
    let cancelled = false

    const onVideoEvent = (event: ProctoringEvent) => {
      if (captureRef.current) captureRef.current.pushExternalEvent(event)
      else void saveAssessmentProctoringBatch(submissionId, [event], videoBatchIndex.current++, 0)
    }

    if (config.proctoring.activity) {
      const capture = new ProctoringCapture({
        attemptStartedAt: startedAt,
        getCurrentQuestionIndex: () => 0, // assignments have no questions
        onFlush: (events, batchIndex, keystrokeCount) =>
          saveAssessmentProctoringBatch(submissionId, events, batchIndex, keystrokeCount),
      })
      capture.attach()
      captureRef.current = capture
    }

    let fsCleanup: (() => void) | null = null
    if (config.proctoring.fullscreen) {
      const startMs = new Date(startedAt).getTime()
      const handleFullscreenChange = () => {
        // Record an exit only when the element leaves fullscreen — not on entry.
        if (!document.fullscreenElement) {
          const fxEvent = { t: Math.max(0, Date.now() - startMs), type: 'fx' as const }
          if (captureRef.current) {
            captureRef.current.pushExternalEvent(fxEvent)
          } else {
            void saveAssessmentProctoringBatch(submissionId, [fxEvent], videoBatchIndex.current++, 0)
          }
        }
      }
      document.addEventListener('fullscreenchange', handleFullscreenChange)
      fsCleanup = () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
    }

    if (config.proctoring.video) {
      ;(async () => {
        const { stream } = await requestCameraAccess()
        if (!stream || cancelled) {
          stopMediaStream(stream)
          return
        }
        streamRef.current = stream
        // Create the off-screen video + canvas here (same pattern as the quiz proctoring
        // context) so they always exist when detection starts — independent of which phase
        // is currently rendered.
        const videoEl = document.createElement('video')
        videoEl.style.display = 'none'
        videoEl.setAttribute('playsinline', '')
        document.body.appendChild(videoEl)
        videoElRef.current = videoEl
        const canvasEl = document.createElement('canvas')
        canvasEl.style.display = 'none'
        document.body.appendChild(canvasEl)
        canvasElRef.current = canvasEl

        const vp = new VideoProctoring({
          attemptStartedAt: startedAt,
          getCurrentQuestionIndex: () => 0,
          onViolation: onVideoEvent,
          onSnapshot: (blob, violationType, timestampOffset, _qi, faceCount) => {
            const reader = new FileReader()
            reader.onloadend = () => {
              const base64 = String(reader.result).split(',')[1] ?? ''
              if (base64) void saveAssessmentProctoringSnapshot(submissionId, violationType, base64, timestampOffset, faceCount)
            }
            reader.readAsDataURL(blob)
          },
        })
        const ok = await vp.loadModels()
        if (!ok || cancelled) {
          vp.stop()
          stopMediaStream(stream)
          streamRef.current = null
          return
        }
        await vp.start(videoEl, canvasEl, stream)
        videoRef.current = vp
      })()
    }

    return () => {
      cancelled = true
      fsCleanup?.()
      captureRef.current?.detach()
      captureRef.current = null
      videoRef.current?.stop()
      videoRef.current = null
      stopMediaStream(streamRef.current)
      streamRef.current = null
      videoElRef.current?.remove()
      videoElRef.current = null
      canvasElRef.current?.remove()
      canvasElRef.current = null
      // Leave fullscreen when work ends — the upload page is a plain handout step.
      if (config.proctoring.fullscreen) void exitFullscreen()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startedAt, submissionId, submitted, phase])

  const doSubmit = useCallback(
    async (auto: boolean) => {
      if (submittingRef.current) return
      submittingRef.current = true
      setSubmitting(true)
      setAutoSubmitFailed(false)
      setSubmitError(null)
      await captureRef.current?.flushAsync().catch(() => undefined)

      const fd = new FormData()
      const attached = filesRef.current
      attached.forEach((f) => fd.append('files', f))
      let errorMsg: string | null = null
      try {
        const res = await submitAssessment(sectionId, assignmentId, fd)
        if ('error' in res) errorMsg = res.error
      } catch {
        // A network failure REJECTS the action (offline) rather than returning {error}. Treat it as
        // a retryable failure so the banner still appears instead of the promise going unhandled.
        errorMsg = 'Your device looks offline. Reconnect, then submit again.'
      }
      if (errorMsg) {
        submittingRef.current = false
        setSubmitting(false)
        // Already recorded server-side (a prior attempt's response was lost on a flaky network).
        // The work IS in — show the submitted view instead of a "lost work" banner. The proctoring
        // effect tears down when `submitted` flips.
        if (isAlreadySubmittedError(errorMsg)) {
          setSubmitted(true)
          toast.success('Your assessment is already submitted.')
          return
        }
        toast.error(errorMsg)
        // Always remember the error: it's what tells the UI the window is terminally shut. Recording
        // it only when work was attached left a student who arrived after their window closed in the
        // ordinary, actionable upload state — inviting them to attach a file that can never be sent.
        setSubmitError(errorMsg)
        // The "your work didn't reach us" banner is only meaningful when there IS attached work — for
        // BOTH the one-shot auto-submit AND a failed manual retry (so a still-offline student who
        // clicks "Try again" doesn't lose the banner and assume success).
        if (attached.length > 0) setAutoSubmitFailed(true)
        return
      }
      captureRef.current?.detach()
      captureRef.current = null
      videoRef.current?.stop()
      videoRef.current = null
      stopMediaStream(streamRef.current)
      streamRef.current = null
      if (config.proctoring.fullscreen) await exitFullscreen()
      setSubmitted(true)
      toast.success(
        auto
          ? attached.length === 0
            ? 'Time up. The assessment closed.'
            : 'Time up. Your work was submitted.'
          : 'Assessment submitted',
      )
    },
    [sectionId, assignmentId, config.proctoring.fullscreen],
  )

  async function handleStart() {
    setStarting(true)
    const res = await startAssessment(sectionId, assignmentId)
    if ('error' in res) {
      toast.error(res.error)
      setStarting(false)
      return
    }
    setSubmissionId(res.submissionId)
    setStartedAt(res.startedAt)
    if (config.proctoring.fullscreen) await enterFullscreen()
    router.refresh() // server now sends the brief for the work phase
  }

  async function handleFinishEarly() {
    const res = await finishAssessmentWorkEarly(sectionId, assignmentId)
    if ('error' in res) {
      toast.error(res.error)
      return
    }
    setWorkEndedAt(new Date().toISOString())
  }

  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? [])
    e.target.value = ''
    const valid: File[] = []
    for (const f of picked) {
      const result = validateSubmissionFile({ name: f.name, size: f.size, type: f.type }, fileTypes)
      if (!result.ok) {
        // Accepted-types clause only for a type failure (see validateSubmissionFile's `reason`):
        // appending it to a size failure misdirects a student whose format was already correct.
        const acceptedLabel = fileTypes.length === 1
          ? labelForKind(fileTypes[0])
          : fileTypes.map(labelForKind).join(' or ')
        toast.error(result.reason === 'wrong-type' ? `${result.error} Accepted: ${acceptedLabel}.` : (result.error ?? 'That file could not be attached.'))
      } else {
        valid.push(f)
      }
    }
    if (valid.length > 0) {
      setFiles((prev) => [...prev, ...valid].slice(0, MAX_SUBMISSION_FILES))
    }
  }

  // ── Submitted ──
  if (submitted) {
    return (
      <div className="rounded-2xl border border-border bg-card p-6 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <CheckCircle2 className="h-6 w-6 text-primary" />
        </div>
        <p className="text-sm font-semibold text-foreground">Assessment submitted</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Your work and a proctoring report were sent to your instructor.
        </p>
      </div>
    )
  }

  // ── Window closed, nothing to recover ──
  // The one-shot expiry auto-submit has already run and the server confirmed the window is shut
  // (terminal error), and there is no attached work to retry. Without this the student got the
  // ordinary upload form at 0:00 — an enabled Submit button and copy promising an automatic submit —
  // and only discovered it was over after attaching their file. The has-work case deliberately falls
  // through instead, so the retry banner can still show them their attachment.
  if (submitError && isTerminalSubmitError(submitError) && files.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card p-6 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-destructive-muted">
          <AlertTriangle className="h-6 w-6 text-destructive-muted-foreground" />
        </div>
        <p className="text-sm font-semibold text-foreground">Your assessment window has closed</p>
        <p className="mx-auto mt-1 max-w-prose text-sm text-muted-foreground">
          This attempt is over and can no longer be submitted. Ask your instructor to reopen it if you
          need another attempt.
        </p>
      </div>
    )
  }

  // ── Lobby ──
  if (phase === 'lobby') {
    const proctItems = [
      config.proctoring.activity && 'keyboard, clipboard and tab switches',
      config.proctoring.fullscreen && 'fullscreen (exits are flagged)',
      config.proctoring.video && 'webcam checks for extra faces or a phone',
    ].filter(Boolean) as string[]
    const startDisabled = starting || (config.proctoring.video && !cameraChecked)

    return (
      <div className="space-y-4 rounded-2xl border border-border bg-card p-6">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <p className="text-sm font-semibold text-foreground">Proctored{untimed ? '' : ', timed'} assessment</p>
        </div>
        <ul className="space-y-1.5 text-sm text-muted-foreground">
          <li className="flex items-center gap-2">
            <Clock className="h-4 w-4 shrink-0" />
            {untimed
              ? `Work at your own pace, then ${config.uploadMinutes} min to upload your file.`
              : `${config.workMinutes} min to work, then ${config.uploadMinutes} min to upload your file.`}
          </li>
          <li>Once you start, the timer cannot be paused and you get a single attempt.</li>
          {config.proctoring.fullscreen && <li>The assignment opens in fullscreen; the sidebar is hidden.</li>}
          {proctItems.length > 0 && <li>Monitored: {proctItems.join(', ')}.</li>}
          <li>When the work time ends, the brief is hidden and you upload your file.</li>
        </ul>

        {config.proctoring.video && !cameraChecked && (
          <div className="flex items-start gap-3 rounded-xl border border-border p-3">
            <Camera className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="space-y-2">
              <p className="text-sm text-foreground">This assessment uses webcam checks. Allow camera access to continue.</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const { stream, error } = await requestCameraAccess()
                    if (stream) {
                      stopMediaStream(stream)
                      setCameraChecked(true)
                    } else {
                      toast.error(error ?? 'Camera unavailable')
                      setCameraChecked(true) // allow continue; will be flagged as camera denied
                    }
                  }}
                >
                  <Camera className="h-4 w-4" />
                  Enable camera
                </Button>
              </div>
            </div>
          </div>
        )}

        <Button onClick={handleStart} disabled={startDisabled}>
          {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          Start assessment
        </Button>
      </div>
    )
  }

  // ── Work / Upload ──
  const isWork = phase === 'work'
  // Untimed work has no countdown to show; the upload phase is always timed.
  const showCountdown = !(isWork && untimed)
  const lowTime = showCountdown && remaining <= 30
  // A terminal submit error (window closed / attempt reset / past deadline / already submitted)
  // means retrying is pointless — the banner stops promising a retry and the button disables.
  const retryImpossible = !!submitError && isTerminalSubmitError(submitError)
  return (
    /* Timed work and the upload window run on the server's clock and auto-submit
       with the session, so the idle timer stands down for them (see IdleTimeout).
       Untimed work has no clock to beat, and once a submit has failed for good
       there is nothing left to protect. */
    <div className="space-y-4" data-idle-exempt={(isWork && untimed) || retryImpossible ? undefined : ''}>
      {/* Sticky timer bar */}
      <div className="sticky top-0 z-10 flex items-center justify-between rounded-xl border border-border bg-card/95 px-4 py-2.5 shadow-sm backdrop-blur">
        <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
          <Clock className={`h-4 w-4 ${lowTime ? 'text-destructive' : 'text-primary'}`} />
          {isWork ? 'Work time' : 'Upload time'}
        </span>
        <span className={`font-mono text-sm tabular-nums ${lowTime ? 'text-destructive' : 'text-foreground'}`}>
          {showCountdown ? mmss(remaining) : 'No limit'}
        </span>
      </div>

      {isWork ? (
        <>
          {briefSlot}
          {!untimed && remaining <= 60 && (
            <p className="flex items-center gap-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4" />
              Under a minute of work time left. The brief closes next and you upload your file.
            </p>
          )}
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => setConfirmFinish(true)}>
              Finish work &amp; upload now
            </Button>
          </div>

          <AlertDialog open={confirmFinish} onOpenChange={setConfirmFinish}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>End your work time?</AlertDialogTitle>
                <AlertDialogDescription>
                  This closes the brief and moves you to the upload step. You can&apos;t return to the
                  assessment or your work time after this.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep working</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setConfirmFinish(false)
                    void handleFinishEarly()
                  }}
                >
                  End &amp; upload
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : (
        <div className="space-y-4 rounded-2xl border border-border bg-card p-6">
          <div className="flex items-start gap-3">
            <Upload className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div>
              <p className="text-sm font-semibold text-foreground">Upload your file</p>
              <p className="mt-1 text-sm text-muted-foreground">
                The brief is now closed. Attach your file and submit before the timer runs out.
              </p>
            </div>
          </div>

          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-border p-6 text-center hover:bg-muted/50">
            <Upload className="h-5 w-5 text-muted-foreground" />
            <span className="text-sm text-foreground">Choose file(s)</span>
            <span className="text-xs text-muted-foreground">
              {fileTypes.length === 1
                ? `${labelForKind(fileTypes[0])} only`
                : fileTypes.length > 1
                  ? fileTypes.map(labelForKind).join(' or ')
                  : null}
              {fileTypes.length > 0 ? ' · ' : ''}Up to {MAX_SUBMISSION_FILES} files, 25 MB each
            </span>
            <input type="file" multiple accept={acceptAttrForKinds(fileTypes)} onChange={onPickFiles} className="hidden" />
          </label>

          {files.length > 0 && (
            <ul className="space-y-2">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-xl border border-border p-2.5">
                  <span className="truncate text-sm text-foreground">{f.name}</span>
                  <button
                    type="button"
                    onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                    className="ml-auto text-muted-foreground hover:text-foreground"
                    aria-label={`Remove ${f.name}`}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {autoSubmitFailed ? (
            <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {retryImpossible ? (
                  <>{submitError} Your file is still attached below, but the window is no longer open.</>
                ) : (
                  <>Your submission didn&apos;t go through. Your file is still attached below, but it hasn&apos;t reached your instructor yet. Submit again to send it.</>
                )}
              </span>
            </div>
          ) : (
            // `remaining > 0` matters: at 0:00 the automatic submit has already happened, so
            // promising a future one is false — the terminal panel above, or the retry banner,
            // owns that state.
            remaining > 0 &&
            remaining <= 60 && (
              <p className="flex items-center gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" />
                Under a minute left. Whatever is attached is submitted automatically when time runs out.
              </p>
            )
          )}

          <Button onClick={() => doSubmit(false)} disabled={submitting || files.length === 0 || retryImpossible} className="w-full">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {retryImpossible ? 'Submission window closed' : autoSubmitFailed ? 'Try submitting again' : 'Submit assessment'}
          </Button>
        </div>
      )}
    </div>
  )
}
