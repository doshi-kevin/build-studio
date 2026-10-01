// Professor-side audio capture for a live classroom recording. Opt-in: nothing
// runs until start(). Uses its OWN audio-only mic stream (decoupled from
// transcription — if transcription stops, the recording keeps going). Uploads
// MediaRecorder chunks during the session so a crash loses at most one chunk,
// then closes the session and kicks finalization.

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { getPreferredMicConstraints, buildMicConstraints } from '@/lib/live-classroom/audio-devices'
import {
  addAudioSession,
  createChunkUploadUrl,
  finishAudioSession,
  startRecording,
  stopRecording,
} from './actions'
import { RECORDING_TIMESLICE_MS } from './types'

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  for (const t of prefs) if (MediaRecorder.isTypeSupported(t)) return t
  return ''
}

export interface UseRecordingCaptureResult {
  isRecording: boolean
  error: string | null
  start: () => Promise<void>
  stop: () => Promise<void>
}

export function useRecordingCapture({
  roomId,
  enabled,
}: {
  roomId: string
  enabled: boolean
}): UseRecordingCaptureResult {
  const [isRecording, setIsRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const seqRef = useRef(0)
  const startTsRef = useRef(0)
  const uploadsRef = useRef<Promise<unknown>[]>([])
  const isRecordingRef = useRef(false)
  // Self-references for the mic-died auto-restart (start/stop aren't in scope
  // inside their own closures). Assigned in the render body below.
  const startRef = useRef<(() => Promise<void>) | null>(null)
  const stopRef = useRef<(() => Promise<void>) | null>(null)
  // Unmount + enabled mirrors: start() spans several awaits, and the
  // mic-died restart fires from a track event — both need a truth source
  // that isn't a stale closure.
  const unmountedRef = useRef(false)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  const uploadChunk = useCallback(
    (blob: Blob) => {
      const sessionId = sessionIdRef.current
      if (!sessionId || blob.size === 0) return
      const seq = seqRef.current++ // advance even on failure so ordering holds
      const p = (async () => {
        try {
          const res = await createChunkUploadUrl({ roomId, sessionId, seq })
          if (!res.signedUrl || !res.token) throw new Error(res.error || 'no upload url')
          const put = await fetch(res.signedUrl, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${res.token}`, 'Content-Type': 'audio/webm' },
            body: blob,
          })
          if (!put.ok) throw new Error(`chunk upload ${put.status}`)
        } catch {
          // Best-effort — a dropped chunk is simply skipped at finalize.
        }
      })()
      uploadsRef.current.push(p)
    },
    [roomId],
  )

  const start = useCallback(async () => {
    if (isRecordingRef.current) return
    setError(null)
    const mimeType = pickMimeType()
    if (!mimeType) {
      setError('Recording is not supported in this browser.')
      return
    }
    try {
      // Acquire the mic FIRST. startRecording flips lc_recordings.status to
      // 'recording' — which drives the students' "This session is being recorded"
      // banner — so a denied/absent mic must never reach it. getUserMedia throwing
      // here is caught below before any DB write, so no phantom recording state
      // is shown when capture never actually starts.
      // Uses the same stored mic preference as transcription (separate stream
      // by design — stopping one never kills the other).
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: await getPreferredMicConstraints(),
        })
      } catch (err) {
        if (err instanceof Error && err.name === 'OverconstrainedError') {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: buildMicConstraints(null),
          })
          toast.warning('Selected microphone unavailable — recording with the default microphone.')
        } else {
          throw err
        }
      }
      streamRef.current = stream

      // Unmounted (or room ended) while the mic was being acquired — release
      // it before any DB write, or the capture would run headless forever.
      if (unmountedRef.current || !enabledRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        return
      }

      // Mic died mid-class (unplug / battery): finalize this session's chunks,
      // then restart on whatever the preference now resolves to (the dead
      // device won't be found → the default mic) so the recording continues.
      // Skipped when the session is no longer enabled or the page is gone.
      const track = stream.getAudioTracks()[0]
      if (track) {
        track.onended = () => {
          if (!isRecordingRef.current) return
          void (async () => {
            await stopRef.current?.()
            if (unmountedRef.current || !enabledRef.current) return
            toast.warning('Microphone disconnected — recording continues on the default microphone.')
            void startRef.current?.()
          })()
        }
      }
      const rec = await startRecording({ roomId })
      if (rec.error) {
        setError(rec.error)
        stream.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        return
      }
      const session = await addAudioSession({ roomId })
      if (!session.sessionId) {
        setError(session.error || 'Failed to start recording')
        stream.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        // startRecording already flipped lc_recordings.status (the students'
        // "being recorded" banner) — revert it, or it sticks without capture.
        void stopRecording({ roomId })
        return
      }
      // Unmounted during the DB round-trips: revert the recording status and
      // bail before the MediaRecorder ever starts.
      if (unmountedRef.current || !enabledRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        void stopRecording({ roomId })
        return
      }
      sessionIdRef.current = session.sessionId
      seqRef.current = 0
      uploadsRef.current = []
      startTsRef.current = performance.now()

      const recorder = new MediaRecorder(stream, { mimeType })
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) uploadChunk(e.data)
      }
      recorderRef.current = recorder
      recorder.start(RECORDING_TIMESLICE_MS)
      isRecordingRef.current = true
      setIsRecording(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      setError(
        msg.includes('NotAllowed') || msg.includes('Permission')
          ? 'Microphone access is required to record.'
          : 'Could not start recording.',
      )
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [roomId, uploadChunk])

  const stop = useCallback(async () => {
    if (!isRecordingRef.current) return
    isRecordingRef.current = false
    setIsRecording(false)

    const recorder = recorderRef.current
    const sessionId = sessionIdRef.current
    const durationMs = Math.max(0, Math.round(performance.now() - startTsRef.current))

    // Stop the recorder and wait for its final dataavailable to flush.
    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve()
        try {
          recorder.stop()
        } catch {
          resolve()
        }
      })
    }
    recorderRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null

    // Wait for chunk uploads, close the session (accurate duration), THEN kick
    // finalization so the concat job sees complete session rows.
    await Promise.allSettled(uploadsRef.current)
    if (sessionId) {
      await finishAudioSession({ roomId, sessionId, durationMs, chunkCount: seqRef.current })
      await stopRecording({ roomId })
    }
    sessionIdRef.current = null
  }, [roomId])

  startRef.current = start
  stopRef.current = stop

  // Auto-stop when the room is no longer live (e.g. End Class flipped enabled).
  useEffect(() => {
    if (!enabled && isRecordingRef.current) void stop()
  }, [enabled, stop])

  // Warn before an accidental reload/close would split the recording.
  useEffect(() => {
    if (!isRecording) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isRecording])

  // Best-effort stop on unmount (navigation after End Class). Dispatched
  // fetches complete in-flight; the lazy-on-view backstop covers a lost kick.
  // unmountedRef also aborts any start() still mid-await (see checks above).
  useEffect(() => {
    return () => {
      unmountedRef.current = true
      if (isRecordingRef.current) void stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { isRecording, error, start, stop }
}
