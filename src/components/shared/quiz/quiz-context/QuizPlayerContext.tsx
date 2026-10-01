// Quiz player context — manages timer, auto-save answers, periodic time sync,
// per-question time tracking (dict approach: {questionId: seconds}),
// and proctoring event capture when enabled.
// Provides state + dispatch to all child quiz components via React Context.
'use client'

import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  useEffect,
  useRef,
  useCallback,
  useState,
  type ReactNode,
} from 'react'
import type { Quiz, Question, QuizAttempt } from '@/lib/validations/quiz'
import {
  quizPlayerReducer,
  type QuizPlayerState,
  type QuizPlayerAction,
} from './use-quiz-player-reducer'
import {
  saveAnswer,
  updateAttemptTime,
  saveProctoringBatch,
  saveProctoringSnapshot,
} from '@/app/(dashboard)/student/courses/[sectionId]/quizzes/actions'
import { ProctoringCapture } from '@/lib/quiz/proctoring'
import { VideoProctoring } from '@/lib/quiz/video-proctoring'
import { requestCameraAccess, stopMediaStream } from '@/lib/quiz/camera-permission'
import { logger } from '@/lib/logger'

// ── Context Value ────────────────────────────────────────────

interface QuizPlayerContextValue {
  state: QuizPlayerState
  dispatch: React.Dispatch<QuizPlayerAction>
  /** Returns a snapshot of accumulated per-question seconds. Used to flush time on submit. */
  getQuestionTime: (questionId: string) => number
  /** Timestamp (ms) of the last successful auto-save. 0 if never saved. */
  lastSavedAt: number
  /** True if the most recent auto-save attempt failed. Resets on next success. */
  saveFailed: boolean
  /** Cancel any pending or in-flight auto-save. Call before submit flush. */
  cancelAutoSave: () => void
  videoProctoringState: {
    isActive: boolean
    isDenied: boolean
    violationCount: number
    videoRef: React.RefObject<HTMLVideoElement | null>
    canvasRef: React.RefObject<HTMLCanvasElement | null>
  }
}

const QuizPlayerContext = createContext<QuizPlayerContextValue | null>(null)

// ── Hook ─────────────────────────────────────────────────────

export function useQuizPlayer() {
  const ctx = useContext(QuizPlayerContext)
  if (!ctx) throw new Error('useQuizPlayer must be used within QuizPlayerProvider')
  return ctx
}

// ── Provider ─────────────────────────────────────────────────

interface QuizPlayerProviderProps {
  quiz: Quiz
  questions: Question[]
  attempt: QuizAttempt
  children: ReactNode
}

export function QuizPlayerProvider({
  quiz,
  questions,
  attempt,
  children,
}: QuizPlayerProviderProps) {
  // Wall-clock deadline: startedAt + timeLimitMinutes.
  // Timer keeps counting even when the student closes the tab.
  const deadlineMs =
    quiz.timeLimitMinutes != null
      ? new Date(attempt.startedAt).getTime() + quiz.timeLimitMinutes * 60 * 1000
      : null

  const timeRemaining =
    deadlineMs != null ? Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000)) : null

  const [state, dispatch] = useReducer(quizPlayerReducer, {
    quiz,
    questions,
    attempt,
    currentQuestionIndex: 0,
    timeRemainingSeconds: timeRemaining,
    isDirty: false,
    dirtyQuestionIds: new Set<string>(),
  })

  // Auto-save feedback: timestamp of last successful save + failure flag
  const [lastSavedAt, setLastSavedAt] = useState(0)
  const [saveFailed, setSaveFailed] = useState(false)

  // Refs to track latest values for use in interval callbacks and cleanup
  const timeSpentRef = useRef(attempt.timeSpentSeconds)
  const attemptIdRef = useRef(state.attempt.id)
  const questionIndexRef = useRef(0)

  // Per-question time dict: { questionId: accumulatedSeconds }
  // Initialized from loaded answers so resumed attempts preserve existing time.
  const questionTimeRef = useRef<Record<string, number>>(
    Object.fromEntries(
      Object.entries(attempt.answers)
        .filter(([, ans]) => (ans.timeSpentSeconds ?? 0) > 0)
        .map(([qid, ans]) => [qid, ans.timeSpentSeconds ?? 0])
    )
  )

  // Wall-clock timestamp (ms) when the student arrived at the current question.
  // Used to compute elapsed time accurately when they navigate away.
  const questionEnteredAtRef = useRef<number>(Date.now())

  useEffect(() => {
    timeSpentRef.current = state.attempt.timeSpentSeconds
  }, [state.attempt.timeSpentSeconds])

  useEffect(() => {
    attemptIdRef.current = state.attempt.id
  }, [state.attempt.id])

  // When the current question index changes, commit elapsed time to the
  // PREVIOUS question's entry in the dict, then reset the wall clock.
  // This captures time accurately even for sub-second navigation.
  useEffect(() => {
    const prevIndex = questionIndexRef.current
    const prevQuestion = state.questions[prevIndex]

    if (prevQuestion && state.attempt.status !== 'submitted') {
      const elapsed = Math.round((Date.now() - questionEnteredAtRef.current) / 1000)
      if (elapsed > 0) {
        questionTimeRef.current[prevQuestion.id] =
          (questionTimeRef.current[prevQuestion.id] ?? 0) + elapsed
      }
    }

    questionIndexRef.current = state.currentQuestionIndex
    questionEnteredAtRef.current = Date.now()
  }, [state.currentQuestionIndex, state.questions, state.attempt.status])

  // Timer tick — only depends on status, not on timeRemainingSeconds
  useEffect(() => {
    if (state.timeRemainingSeconds === null) return
    if (state.attempt.status === 'submitted') return

    const interval = setInterval(() => {
      dispatch({ type: 'TICK_TIMER', payload: deadlineMs ? { deadlineMs } : undefined })
    }, 1000)

    return () => clearInterval(interval)
    // Only re-create when status changes (not every tick)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.attempt.status])

  // Auto-save answers to server (debounced).
  // Only saves questions that changed since last successful save (dirty tracking).
  // Uses parallel saves and supports cancellation when a new save cycle starts.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveAbortRef = useRef(false)

  /** The exact payload the debounced save writes for one answer. Shared with the
   *  unmount/beforeunload flush so both paths persist identical rows. */
  const buildAnswerPayload = useCallback((questionId: string, answer: QuizAttempt['answers'][string]) => ({
    selectedChoiceIds: answer.selectedChoiceIds,
    booleanAnswer: answer.booleanAnswer,
    textAnswer: answer.textAnswer,
    blankAnswers: answer.blankAnswers,
    isFlagged: answer.isFlagged ?? false,
    timeSpentSeconds: questionTimeRef.current[questionId] ?? answer.timeSpentSeconds ?? 0,
    optionChanges: answer.optionChanges ?? 0,
    tabSwitches: answer.tabSwitches ?? 0,
    copyAttempts: answer.copyAttempts ?? 0,
  }), [])

  // Latest dirty set + answers, mirrored into a ref so the unmount flush below
  // can read them. The flush must NOT depend on this state, or its cleanup would
  // fire on every keystroke instead of only when the player goes away.
  const pendingSaveRef = useRef({
    attemptId: state.attempt.id,
    dirtyIds: state.dirtyQuestionIds,
    answers: state.attempt.answers,
    status: state.attempt.status,
  })
  useEffect(() => {
    pendingSaveRef.current = {
      attemptId: state.attempt.id,
      dirtyIds: state.dirtyQuestionIds,
      answers: state.attempt.answers,
      status: state.attempt.status,
    }
  })

  /** Write any answer the 1500ms debounce had not yet committed. Fire-and-forget,
   *  like flushTime — a student who answers and immediately navigates away or
   *  reloads used to lose that answer entirely, since the pending timer was
   *  cleared on unmount and only time was flushed. */
  const flushAnswers = useCallback(() => {
    const { attemptId, dirtyIds, answers, status } = pendingSaveRef.current
    if (status === 'submitted' || dirtyIds.size === 0) return
    dirtyIds.forEach((questionId) => {
      const answer = answers[questionId]
      if (!answer) return
      void saveAnswer(attemptId, questionId, buildAnswerPayload(questionId, answer)).catch(() => {
        // Nothing to surface — the component is going away. The answer is either
        // written or lost to the navigation; the UI can't recover either way.
      })
    })
  }, [buildAnswerPayload])

  // Unmount-only: `flushAnswers` is stable, so this cleanup runs when the player
  // is torn down (navigate away), never on a re-render.
  useEffect(() => () => flushAnswers(), [flushAnswers])

  useEffect(() => {
    if (!state.isDirty) return
    if (state.attempt.status === 'submitted') return

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)

    // Capture the dirty IDs and answers at the time the effect runs.
    // These won't change while the timeout is pending (React re-runs the effect
    // on every state change, which cancels the old timer and queues a new one).
    const dirtyIds = state.dirtyQuestionIds
    const answers = state.attempt.answers
    const attemptId = state.attempt.id

    saveTimerRef.current = setTimeout(async () => {
      if (dirtyIds.size === 0) {
        dispatch({ type: 'MARK_SAVED' })
        return
      }

      // Abort flag — if a new save cycle starts (or submit fires) while this
      // one is in-flight, we skip the completion bookkeeping.
      saveAbortRef.current = false

      // Save only the dirty answers in parallel for speed.
      const promises = Array.from(dirtyIds).map((questionId) => {
        const answer = answers[questionId]
        if (!answer) return Promise.resolve()
        return saveAnswer(attemptId, questionId, buildAnswerPayload(questionId, answer))
      })

      try {
        await Promise.all(promises)

        // Only mark as saved if this cycle wasn't superseded by a newer one
        if (!saveAbortRef.current) {
          setSaveFailed(false)
          setLastSavedAt(Date.now())
          dispatch({ type: 'MARK_SAVED' })
        }
      } catch {
        // Network or server error — flag so the UI can show a warning
        if (!saveAbortRef.current) {
          setSaveFailed(true)
        }
      }
    }, 1500)

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      // Signal any in-flight save loop to skip its completion bookkeeping
      saveAbortRef.current = true
    }
  }, [state.isDirty, state.attempt, state.dirtyQuestionIds, buildAnswerPayload])

  // Flush time to DB — used by interval, unmount, and beforeunload
  const flushTime = useCallback(() => {
    updateAttemptTime(attemptIdRef.current, timeSpentRef.current)
  }, [])

  // Save time_spent_seconds to DB every 30s + flush on unmount
  useEffect(() => {
    if (state.attempt.status === 'submitted') return

    const interval = setInterval(flushTime, 30000)

    return () => {
      clearInterval(interval)
      // Flush final time when component unmounts (student navigates away)
      flushTime()
    }
  }, [state.attempt.status, flushTime])

  // Also flush time on browser/tab close via beforeunload
  useEffect(() => {
    if (state.attempt.status === 'submitted') return

    const handleBeforeUnload = () => {
      flushTime()
      // A reload within the debounce window is the reported data-loss case (#311).
      flushAnswers()
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [state.attempt.status, flushTime, flushAnswers])

  // ── Proctoring capture ─────────────────────────────────────
  const proctoringRef = useRef<ProctoringCapture | null>(null)

  useEffect(() => {
    if (!quiz.proctoringEnabled) return
    if (state.attempt.status === 'submitted') return

    const capture = new ProctoringCapture({
      attemptStartedAt: attempt.startedAt,
      getCurrentQuestionIndex: () => questionIndexRef.current,
      onFlush: (events, batchIndex, keystrokeCount) => {
        // Fire-and-forget — don't block quiz interaction
        saveProctoringBatch(attempt.id, events, batchIndex, keystrokeCount)
      },
    })

    capture.attach()
    proctoringRef.current = capture

    return () => {
      capture.detach()
      proctoringRef.current = null
    }
  }, [quiz.proctoringEnabled, attempt.startedAt, attempt.id, state.attempt.status])

  // Flush proctoring buffer on beforeunload for better reliability
  useEffect(() => {
    if (!quiz.proctoringEnabled) return
    if (state.attempt.status === 'submitted') return

    const handleBeforeUnload = () => {
      proctoringRef.current?.flush()
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [quiz.proctoringEnabled, state.attempt.status])

  // ── Video proctoring capture ──────────────────────────────────
  const videoProctoringRef = useRef<VideoProctoring | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [videoActive, setVideoActive] = useState(false)
  const [cameraDenied, setCameraDenied] = useState(false)
  const [violationCount, setViolationCount] = useState(0)

  useEffect(() => {
    if (!quiz.videoProctoringEnabled) return
    if (state.attempt.status === 'submitted') return

    let cancelled = false

    async function initVideoProctoring() {
      // Create hidden video and canvas elements
      const videoEl = document.createElement('video')
      videoEl.style.display = 'none'
      videoEl.setAttribute('playsinline', '')
      document.body.appendChild(videoEl)
      videoRef.current = videoEl

      const canvasEl = document.createElement('canvas')
      canvasEl.style.display = 'none'
      document.body.appendChild(canvasEl)
      canvasRef.current = canvasEl

      // Request camera access
      const { stream, error } = await requestCameraAccess()
      if (cancelled) {
        stopMediaStream(stream)
        return
      }

      if (!stream || error) {
        logger.warn('[SCHOLERA WARN] Video proctoring: camera denied', { error })
        setCameraDenied(true)
        return
      }

      const videoCapture = new VideoProctoring({
        attemptStartedAt: attempt.startedAt,
        getCurrentQuestionIndex: () => questionIndexRef.current,
        onViolation: (event) => {
          // Push video violation events into the existing proctoring batch system
          proctoringRef.current?.pushExternalEvent(event)
          setViolationCount((c: number) => c + 1)
        },
        onSnapshot: async (blob, violationType, timestampOffset, qi, faceCount) => {
          try {
            // Convert blob to base64 for server action serialization
            const arrayBuffer = await blob.arrayBuffer()
            const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))
            await saveProctoringSnapshot(attempt.id, violationType, base64, timestampOffset, qi, faceCount)
          } catch {
            // Silently ignore snapshot errors — proctoring events are still recorded
            logger.warn('[SCHOLERA WARN] Snapshot upload/save failed', { violationType, timestampOffset })
          }
        },
      })

      const loaded = await videoCapture.loadModels()
      if (cancelled || !loaded) {
        stopMediaStream(stream)
        return
      }

      await videoCapture.start(videoEl, canvasEl, stream)
      if (cancelled) {
        videoCapture.stop()
        return
      }

      videoProctoringRef.current = videoCapture
      setVideoActive(true)
    }

    initVideoProctoring().catch((err) => {
      logger.warn('[SCHOLERA WARN] Video proctoring init failed', { error: String(err) })
    })

    return () => {
      cancelled = true
      videoProctoringRef.current?.stop()
      videoProctoringRef.current = null
      setVideoActive(false)

      // Clean up hidden DOM elements
      if (videoRef.current) {
        videoRef.current.remove()
        videoRef.current = null
      }
      if (canvasRef.current) {
        canvasRef.current.remove()
        canvasRef.current = null
      }
    }
  }, [quiz.videoProctoringEnabled, attempt.startedAt, attempt.id, state.attempt.status])

  const videoProctoringState = useMemo(() => ({
    isActive: videoActive,
    isDenied: cameraDenied,
    violationCount,
    videoRef,
    canvasRef,
  }), [videoActive, cameraDenied, violationCount])

  // Cancel pending auto-save timer and abort any in-flight save loop.
  // Called by the submit handler to prevent races.
  const cancelAutoSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    saveAbortRef.current = true
  }, [])

  // Stable callback — reads the mutable ref directly so it never triggers re-renders
  const getQuestionTime = useCallback(
    (questionId: string) => {
      // Also include any time accumulated since the student arrived at the current question
      const currentQuestion = state.questions[questionIndexRef.current]
      const bonusMs = currentQuestion?.id === questionId
        ? Date.now() - questionEnteredAtRef.current
        : 0
      return (questionTimeRef.current[questionId] ?? 0) + Math.round(bonusMs / 1000)
    },
    // Intentionally stable — reads mutable refs, no deps needed
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const value = useMemo(
    () => ({ state, dispatch, getQuestionTime, lastSavedAt, saveFailed, cancelAutoSave, videoProctoringState }),
    [state, getQuestionTime, lastSavedAt, saveFailed, cancelAutoSave, videoProctoringState],
  )

  return (
    <QuizPlayerContext.Provider value={value}>
      {children}
    </QuizPlayerContext.Provider>
  )
}
