/**
 * Student Verbal Assessment runner.
 *
 * The student enables camera + mic; we record ONE continuous video (the authoritative
 * artifact the professor grades). For each cell we NARRATE the prompt with the configured
 * voice (ElevenLabs), then listen:
 *   - greeting: spoken, then auto-advances
 *   - question: spoken, then live in-browser STT transcribes the answer; advance on "Next"
 *     or 3s of silence (Web Audio analyser)
 *   - mcq: spoken, student selects, then explains aloud
 * ai_followup cells are skipped (Athena generates those; not wired yet).
 *
 * After the last cell (or when the time limit hits) recording stops and the video is submitted
 * automatically. There is a single attempt: no review screen, no re-record. STT uses one Web
 * Speech instance started in the start gesture (best-effort); each cell records its offset in
 * the recording timeline so grading can seek to it.
 *
 * Once started, there is no going back to a previous question (single attempt).
 *
 * Type: Client Component
 */
'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Mic, MicOff, Video, Loader2, Check, ChevronRight, AlertTriangle, Lock, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { BrandMark } from '@/components/shared/BrandMark'
import { StudioMarkdown } from '@/components/professor/assignments/studio/shared/StudioMarkdown'
import { renderGreeting, pickFollowUp, type VerbalCell } from '@/lib/assignments/verbal/config'
import type { VerbalAnswer } from '@/lib/validations/verbal-assessment'
import { submitVerbalAssessment, narrateVerbalPrompt } from '@/app/(dashboard)/student/courses/[sectionId]/assignments/actions'

// Minimal Web Speech API typing (not in the standard TS DOM lib).
interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}
function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

const SILENCE_MS = 3000
const SILENCE_RMS = 0.012

type Phase = 'intro' | 'requesting' | 'running' | 'submitting' | 'done' | 'error'

interface Props {
  sectionId: string
  assignmentId: string
  studentName: string
  topic: string
  cells: VerbalCell[]
  timeLimitMinutes: number
}

export function VerbalAssessmentRunner({ sectionId, assignmentId, studentName, topic, cells, timeLimitMinutes }: Props) {
  const router = useRouter()
  const flow = useMemo(() => cells.filter((c) => c.type !== 'ai_followup'), [cells])

  const [phase, setPhase] = useState<Phase>('intro')
  const [error, setError] = useState<string>()
  const [index, setIndex] = useState(0)
  const [mcqChoice, setMcqChoice] = useState<string | null>(null)
  const [explaining, setExplaining] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [listening, setListening] = useState(false)
  const [remaining, setRemaining] = useState(timeLimitMinutes * 60)
  const [followUp, setFollowUp] = useState<{ prompt: string; mcqId: string; branch: 'correct' | 'incorrect' } | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recordedBlobRef = useRef<Blob | null>(null)
  const recordStartRef = useRef(0)
  const cellOffsetRef = useRef(0)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const sessionActiveRef = useRef(false)
  const captureRef = useRef(false)
  const finalTextRef = useRef('')
  const answersRef = useRef<VerbalAnswer[]>([])
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const silenceActiveRef = useRef(false)
  const everSpokeRef = useRef(false)
  const lastSoundRef = useRef(0)
  const narrationRef = useRef<HTMLAudioElement | null>(null)
  const sessionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hardLimitRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const advanceRef = useRef<() => void>(() => {})
  const finishRef = useRef<() => void>(() => {})
  const retryRef = useRef<() => void>(() => {})
  const followUpRef = useRef<{ prompt: string; mcqId: string; branch: 'correct' | 'incorrect' } | null>(null)
  const indexRef = useRef(0)
  const mcqChoiceRef = useRef<string | null>(null)

  const current = flow[index]

  // ---- STT: one persistent Web Speech recognition for the whole session ----
  const startRecognition = useCallback(() => {
    const SR = getSpeechRecognition()
    if (!SR) return
    const rec = new SR()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-US'
    // Best-effort capture into finalTextRef as a fallback; the authoritative transcript is
    // generated server-side from the recording. Nothing is shown to the student.
    rec.onresult = (e) => {
      if (!captureRef.current) return
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) finalTextRef.current += r[0].transcript
      }
    }
    rec.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed' || ev.error === 'audio-capture') {
        sessionActiveRef.current = false
      }
    }
    rec.onend = () => { if (sessionActiveRef.current) { try { rec.start() } catch { /* already started */ } } }
    recognitionRef.current = rec
    sessionActiveRef.current = true
    try { rec.start() } catch { /* noop */ }
  }, [])

  const beginCapture = useCallback(() => {
    finalTextRef.current = ''
    captureRef.current = true
    setListening(true)
  }, [])

  const endCapture = useCallback(() => {
    captureRef.current = false
    setListening(false)
  }, [])

  const stopRecognition = useCallback(() => {
    sessionActiveRef.current = false
    captureRef.current = false
    try { recognitionRef.current?.stop() } catch { /* noop */ }
    recognitionRef.current = null
  }, [])

  // ---- Silence detection (Web Audio) ----
  const monitorSilence = useCallback(() => {
    const analyser = analyserRef.current
    if (!analyser) return
    const buf = new Uint8Array(analyser.fftSize)
    const tick = () => {
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
      const rms = Math.sqrt(sum / buf.length)
      const now = performance.now()
      if (rms > SILENCE_RMS) { everSpokeRef.current = true; lastSoundRef.current = now }
      if (silenceActiveRef.current && everSpokeRef.current && now - lastSoundRef.current > SILENCE_MS) {
        advanceRef.current()
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  const startSilence = useCallback(() => {
    everSpokeRef.current = false
    lastSoundRef.current = performance.now()
    silenceActiveRef.current = true
    if (rafRef.current == null) monitorSilence()
  }, [monitorSilence])

  const stopSilence = useCallback(() => {
    silenceActiveRef.current = false
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
  }, [])

  // ---- Narration (ElevenLabs TTS via server action) ----
  const stopNarration = useCallback(() => {
    if (narrationRef.current) { narrationRef.current.pause(); narrationRef.current = null }
    setSpeaking(false)
  }, [])

  const narrate = useCallback(async (cellId: string, branch?: 'correct' | 'incorrect'): Promise<boolean> => {
    try {
      const res = await narrateVerbalPrompt(sectionId, assignmentId, cellId, branch)
      if ('error' in res || !res.audio) return false
      const audio = new Audio('data:audio/mpeg;base64,' + res.audio)
      narrationRef.current = audio
      setSpeaking(true)
      await new Promise<void>((resolve) => {
        audio.onended = () => resolve()
        audio.onerror = () => resolve()
        audio.play().catch(() => resolve())
      })
      return true
    } catch {
      return false
    } finally {
      narrationRef.current = null
      setSpeaking(false)
    }
  }, [sectionId, assignmentId])

  // ---- Cell lifecycle ----
  const beginCell = useCallback((i: number) => {
    const cell = flow[i]
    if (!cell) return
    indexRef.current = i
    setIndex(i)
    setMcqChoice(null)
    setExplaining(false)
    finalTextRef.current = ''
    cellOffsetRef.current = recordStartRef.current ? (performance.now() - recordStartRef.current) / 1000 : 0
    narrate(cell.id).then((played) => {
      if (indexRef.current !== i) return // advanced past this cell already
      if (cell.type === 'greeting') {
        sessionTimerRef.current = setTimeout(() => advanceRef.current(), played ? 500 : 3000)
      } else if (cell.type === 'question') {
        beginCapture()
        startSilence()
      }
    })
  }, [flow, narrate, beginCapture, startSilence])

  const saveCurrentAnswer = useCallback(() => {
    const cell = flow[indexRef.current]
    if (!cell || cell.type === 'greeting') return
    const opt = cell.options?.find((o) => o.id === mcqChoiceRef.current)
    answersRef.current.push({
      cellId: cell.id,
      type: cell.type,
      prompt: cell.prompt,
      transcript: finalTextRef.current.trim(),
      videoOffset: Math.max(0, Math.round(cellOffsetRef.current * 10) / 10),
      ...(cell.type === 'mcq' ? { selectedOptionId: opt?.id, selectedOptionText: opt?.text } : {}),
    })
  }, [flow])

  useEffect(() => { mcqChoiceRef.current = mcqChoice }, [mcqChoice])

  // Inject a deterministic follow-up after an MCQ: narrate the authored branch prompt, then
  // capture the spoken answer. Prompt text is resolved server-side from the cell (by branch).
  const beginFollowUp = useCallback((prompt: string, mcqId: string, branch: 'correct' | 'incorrect') => {
    followUpRef.current = { prompt, mcqId, branch }
    setFollowUp({ prompt, mcqId, branch })
    finalTextRef.current = ''
    cellOffsetRef.current = recordStartRef.current ? (performance.now() - recordStartRef.current) / 1000 : 0
    narrate(mcqId, branch).then(() => {
      if (!followUpRef.current) return // advanced past it already
      beginCapture()
      startSilence()
    })
  }, [narrate, beginCapture, startSilence])

  const saveFollowUpAnswer = useCallback(() => {
    const fu = followUpRef.current
    if (!fu) return
    answersRef.current.push({
      cellId: `${fu.mcqId}__fu`,
      type: 'question',
      prompt: fu.prompt,
      transcript: finalTextRef.current.trim(),
      videoOffset: Math.max(0, Math.round(cellOffsetRef.current * 10) / 10),
    })
  }, [])

  // Upload the recorded video + answers. Single attempt: on success the assessment is done.
  const uploadRecording = useCallback(async () => {
    const blob = recordedBlobRef.current
    if (!blob) {
      setError('We could not find your recording. Please reload and try again.')
      setPhase('error')
      return
    }
    setPhase('submitting')
    const fd = new FormData()
    fd.append('video', blob, 'verbal-recording.webm')
    fd.append('answers', JSON.stringify(answersRef.current))
    const res = await submitVerbalAssessment(sectionId, assignmentId, fd)
    if ('error' in res) {
      setError(res.error)
      setPhase('error') // retryRef already points at this upload, so "Try again" re-sends the same recording
      return
    }
    setPhase('done')
    router.refresh()
  }, [sectionId, assignmentId, router])

  // Stop recording and submit immediately — there is no review or re-record step.
  const finishAndSubmit = useCallback(() => {
    endCapture()
    stopSilence()
    stopNarration()
    stopRecognition()
    if (sessionTimerRef.current) clearTimeout(sessionTimerRef.current)
    if (hardLimitRef.current) clearTimeout(hardLimitRef.current)
    if (tickRef.current) clearInterval(tickRef.current)
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'video/webm' })
        recordedBlobRef.current = blob
        streamRef.current?.getTracks().forEach((t) => t.stop())
        retryRef.current = () => { void uploadRecording() }
        void uploadRecording()
      }
      recorder.stop()
    } else {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      retryRef.current = () => setPhase('intro')
      setError('The recording did not start. Please reload and try again.')
      setPhase('error')
    }
  }, [endCapture, stopNarration, stopRecognition, stopSilence, uploadRecording])

  const advance = useCallback(() => {
    endCapture()
    stopSilence()
    stopNarration()
    if (sessionTimerRef.current) { clearTimeout(sessionTimerRef.current); sessionTimerRef.current = null }

    // Finishing an injected follow-up: save it, then continue to the next base cell.
    if (followUpRef.current) {
      saveFollowUpAnswer()
      followUpRef.current = null
      setFollowUp(null)
      const after = indexRef.current + 1
      if (after >= flow.length) { finishAndSubmit(); return }
      beginCell(after)
      return
    }

    saveCurrentAnswer()

    // After an MCQ with an answer key, branch into the authored follow-up matching correctness.
    const cur = flow[indexRef.current]
    const fu = cur ? pickFollowUp(cur, mcqChoiceRef.current) : null
    if (cur && fu) {
      beginFollowUp(fu.prompt, cur.id, fu.branch)
      return
    }

    const next = indexRef.current + 1
    if (next >= flow.length) { finishAndSubmit(); return }
    beginCell(next)
  }, [beginCell, finishAndSubmit, flow, saveCurrentAnswer, saveFollowUpAnswer, beginFollowUp, endCapture, stopNarration, stopSilence])

  useEffect(() => { advanceRef.current = advance }, [advance])
  useEffect(() => { finishRef.current = finishAndSubmit }, [finishAndSubmit])

  useEffect(() => {
    if (phase === 'running' && videoRef.current && streamRef.current && videoRef.current.srcObject !== streamRef.current) {
      videoRef.current.srcObject = streamRef.current
    }
  }, [phase])

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      sessionActiveRef.current = false
      try { recognitionRef.current?.stop() } catch { /* noop */ }
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      if (sessionTimerRef.current) clearTimeout(sessionTimerRef.current)
      if (hardLimitRef.current) clearTimeout(hardLimitRef.current)
      if (tickRef.current) clearInterval(tickRef.current)
      narrationRef.current?.pause()
      audioCtxRef.current?.close().catch(() => undefined)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  function selectOption(optionId: string) {
    if (explaining || speaking) return
    setMcqChoice(optionId)
    mcqChoiceRef.current = optionId
    setExplaining(true)
    beginCapture()
    startSilence()
  }

  async function startSession() {
    setError(undefined)
    // Drive the permission request ourselves and show a clear "requesting access" state, rather
    // than leaving the student on the intro card while the browser prompt decides.
    setPhase('requesting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      })
      streamRef.current = stream

      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctx()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      audioCtxRef.current = ctx
      analyserRef.current = analyser

      const mime = ['video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || ''
      const recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 1_500_000 })
      chunksRef.current = []
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.start(1000)
      recorderRef.current = recorder
      recordStartRef.current = performance.now()

      startRecognition()

      setRemaining(timeLimitMinutes * 60)
      tickRef.current = setInterval(() => setRemaining((s) => (s > 0 ? s - 1 : 0)), 1000)
      hardLimitRef.current = setTimeout(() => finishRef.current(), timeLimitMinutes * 60_000)

      setPhase('running')
      answersRef.current = []
      beginCell(0)
    } catch {
      retryRef.current = () => { void startSession() }
      setError('We could not access your camera or microphone. Check your browser permissions and try again.')
      setPhase('error')
    }
  }

  // ---- Render ----
  if (phase === 'done') {
    return (
      <div className="rounded-3xl border border-border bg-card p-8 text-center">
        <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Check className="h-6 w-6" />
        </span>
        <p className="text-lg font-semibold text-foreground">Assessment submitted</p>
        <p className="mt-1 text-sm text-muted-foreground">Your recording and answers were sent to your instructor for review.</p>
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <div className="rounded-3xl border border-destructive/20 bg-destructive/5 p-6">
        <p className="flex items-center gap-2 font-medium text-destructive"><AlertTriangle className="h-5 w-5" /> Something went wrong</p>
        <p className="mt-1 text-sm text-foreground">{error}</p>
        <Button className="mt-4" variant="outline" onClick={() => retryRef.current()}>Try again</Button>
      </div>
    )
  }

  if (phase === 'submitting') {
    return (
      <div className="rounded-3xl border border-border bg-card p-8 text-center">
        <Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">Uploading your recording…</p>
        <p className="mt-1 text-xs text-muted-foreground">Please keep this tab open.</p>
      </div>
    )
  }

  if (phase === 'requesting') {
    return (
      <div className="rounded-3xl border border-border bg-card p-8 text-center">
        <Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">Requesting camera and microphone access…</p>
        <p className="mt-1 text-xs text-muted-foreground">Allow access in your browser to begin. Nothing records until you do.</p>
      </div>
    )
  }

  if (phase === 'intro') {
    return (
      <div className="w-full overflow-hidden rounded-3xl bg-gradient-to-b from-primary/5 to-transparent">
        <div className="grid items-center gap-8 p-8 md:grid-cols-2">
          <div className="flex justify-center">
            <Orb speaking={false} large />
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-primary">Verbal assessment</p>
            <h2 className="mt-1 font-[family-name:var(--font-instrument-serif)] text-2xl tracking-tight text-foreground">Before you begin</h2>
            <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
              <li className="flex items-start gap-2.5"><Video className="mt-0.5 h-4 w-4 shrink-0 text-foreground" /> Your camera and mic record one continuous video for your instructor.</li>
              <li className="flex items-start gap-2.5"><Mic className="mt-0.5 h-4 w-4 shrink-0 text-foreground" /> Each question is read aloud. Answer out loud at your own pace.</li>
              <li className="flex items-start gap-2.5"><ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-foreground" /> Click Next when done, or pause for 3 seconds to move on.</li>
              <li className="flex items-start gap-2.5 rounded-xl border border-primary/20 bg-primary/5 p-2.5 text-foreground">
                <Lock className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>
                  <span className="font-semibold">One attempt.</span> When you finish, your recording is submitted automatically. You cannot go back to earlier questions, review, or re-record.
                </span>
              </li>
            </ul>
            <p className="mt-4 text-xs text-muted-foreground">{flow.length} step{flow.length === 1 ? '' : 's'} · up to {timeLimitMinutes} min</p>
            <Button size="lg" className="mt-5 rounded-full" onClick={startSession} disabled={flow.length === 0}>
              <Video className="h-4 w-4" /> Enable camera &amp; mic and start
            </Button>
            {flow.length === 0 && <p className="mt-2 text-xs text-muted-foreground">This assessment has no questions yet.</p>}
          </div>
        </div>
      </div>
    )
  }

  // running (full-bleed, no outer box)
  const isGreeting = !followUp && current?.type === 'greeting'
  const isMcq = !followUp && current?.type === 'mcq'
  const mm = Math.floor(remaining / 60)
  const ss = String(remaining % 60).padStart(2, '0')

  return (
    <div className="w-full space-y-4">
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-xs font-medium text-foreground">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-destructive/70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
          </span>
          Recording
        </span>
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{followUp ? 'Follow-up' : `Step ${index + 1} of ${flow.length}`}</span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs tabular-nums text-foreground">
          <Clock className="h-3.5 w-3.5" /> {mm}:{ss}
        </span>
      </div>

      {/* Equal-size panels: AI prompt (left) and camera (right) */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex aspect-video flex-col items-center justify-center gap-4 rounded-3xl bg-gradient-to-b from-primary/5 to-transparent p-6 text-center">
          <Orb speaking={speaking} />
          <div className="max-h-40 overflow-y-auto text-foreground">
            {followUp
              ? <StudioMarkdown content={followUp.prompt} />
              : isGreeting
                ? <p className="text-lg font-medium">{renderGreeting(current?.prompt ?? '', { name: studentName, topic })}</p>
                : <StudioMarkdown content={current?.prompt ?? ''} />}
          </div>
          {followUp && <p className="text-xs font-medium text-primary">Follow-up based on your answer</p>}
          {speaking && <p className="text-xs text-muted-foreground">Speaking…</p>}
        </div>

        <div className="relative aspect-video overflow-hidden rounded-3xl border border-border bg-foreground/5">
          <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-cover" />
          <span className={cn(
            'absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium backdrop-blur',
            listening ? 'bg-primary/90 text-primary-foreground' : 'bg-background/80 text-muted-foreground',
          )}>
            {listening ? <Mic className="h-3.5 w-3.5" /> : <MicOff className="h-3.5 w-3.5" />}
            {listening ? 'Listening' : 'Mic idle'}
          </span>
        </div>
      </div>

      {/* MCQ options */}
      {isMcq && (
        <div className="space-y-2">
          {current.options?.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => selectOption(o.id)}
              disabled={explaining || speaking}
              className={cn(
                'flex w-full items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors',
                mcqChoice === o.id ? 'border-primary bg-primary/5 text-foreground' : 'border-border text-foreground hover:bg-muted disabled:opacity-60',
              )}
            >
              <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full border', mcqChoice === o.id ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}>
                {mcqChoice === o.id && <Check className="h-3 w-3" />}
              </span>
              {o.text}
            </button>
          ))}
          {explaining && <p className="text-xs text-muted-foreground">Now explain your choice out loud.</p>}
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center gap-3 border-t border-border/60 pt-4">
        <Button className="rounded-full" onClick={() => advanceRef.current()} disabled={speaking || (isMcq && !explaining)}>
          {index + 1 >= flow.length ? 'Finish' : 'Next'} <ChevronRight className="h-4 w-4" />
        </Button>
        {!isGreeting && !speaking && <span className="text-xs text-muted-foreground">or pause 3 seconds to continue</span>}
      </div>
    </div>
  )
}

/** Glowing AI orb (Scholera mark) that pulses while narrating. */
function Orb({ speaking, large }: { speaking: boolean; large?: boolean }) {
  const size = large ? 'h-40 w-40' : 'h-28 w-28'
  const core = large ? 'h-24 w-24' : 'h-16 w-16'
  return (
    <div className={cn('relative flex items-center justify-center', size)}>
      <div className={cn('absolute inset-0 rounded-full bg-gradient-to-br from-primary/50 via-primary/10 to-primary/40 blur-2xl', speaking && 'animate-pulse')} />
      <div className={cn('relative flex items-center justify-center rounded-full border border-border bg-card shadow-lg', core, speaking && 'ring-2 ring-primary/40')}>
        <BrandMark className={large ? 'h-10 w-10' : 'h-7 w-7'} />
      </div>
    </div>
  )
}
