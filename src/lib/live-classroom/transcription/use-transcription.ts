// Core transcription hook for the live classroom. Manages the full
// audio pipeline: getUserMedia → AudioWorklet (PCM conversion) →
// WebSocket to ElevenLabs Scribe v2. Debounces committed transcripts
// and appends them to the database via the appendTranscription action.

'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import { getPreferredMicConstraints, buildMicConstraints } from '@/lib/live-classroom/audio-devices'
import {
  SCRIBE_WS_URL,
  SCRIBE_SAMPLE_RATE,
  SCRIBE_MODEL,
  TRANSCRIPT_DEBOUNCE_MS,
  RECONNECT_MAX_RETRIES,
  RECONNECT_BASE_DELAY_MS,
  type ScribeMessage,
} from './types'

export interface UseTranscriptionOptions {
  roomId: string
  /** The deck currently presented. Committed chunks are tagged with whatever
   *  this is at capture time, so a chunk spoken on deck A still saves to A
   *  even if it flushes just after a switch to B. Null = no active deck yet
   *  (chunks are dropped — nothing to attribute them to). */
  deckId: string | null
  currentSlide: number
  enabled: boolean
}

export interface UseTranscriptionResult {
  isListening: boolean
  isConnected: boolean
  partialText: string
  transcriptByPage: Map<number, string>
  error: string | null
  stream: MediaStream | null
  start: () => Promise<void>
  stop: () => void
  hydrateTranscripts: (data: Array<{ page_number: number; text: string }>) => void
}

export function useTranscription({
  roomId,
  deckId,
  currentSlide,
  enabled,
}: UseTranscriptionOptions): UseTranscriptionResult {
  const [isListening, setIsListening] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [partialText, setPartialText] = useState('')
  const [transcriptByPage, setTranscriptByPage] = useState<Map<number, string>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const currentSlideRef = useRef(currentSlide)
  const deckIdRef = useRef(deckId)
  // Pending chunks keyed by `${deckId}:${pageNumber}` so a switch mid-buffer
  // never re-tags an earlier deck's text. Each entry carries its own deck.
  const pendingTextRef = useRef<Map<string, { deckId: string; pageNumber: number; text: string }>>(new Map())
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retriesRef = useRef(0)
  const stoppingRef = useRef(false)
  // Ref mirror of isListening for the start() re-entry guard — the mic-died
  // auto-restart calls start() before React commits stop()'s state update,
  // so a state-based guard would read stale `true` and skip the restart.
  // Same pattern as isRecordingRef in use-recording-capture.
  const isListeningRef = useRef(false)
  // Self-reference for the mic-died auto-restart (start isn't in scope
  // inside its own closure). Assigned in the render body like the other refs.
  const startRef = useRef<(() => Promise<void>) | null>(null)

  // Ref mirror of `enabled` so the mic-died restart (fired from a track
  // event, outside React) can tell whether the session is still live.
  const enabledRef = useRef(enabled)

  currentSlideRef.current = currentSlide
  deckIdRef.current = deckId
  enabledRef.current = enabled

  const flushPending = useCallback(async () => {
    const pending = new Map(pendingTextRef.current)
    pendingTextRef.current.clear()

    if (pending.size === 0) return

    const { appendTranscription } = await import(
      '@/app/(dashboard)/professor/courses/[sectionId]/live-classroom/actions'
    )

    for (const [key, entry] of pending) {
      if (!entry.text.trim()) continue
      appendTranscription({
        roomId,
        deckId: entry.deckId,
        pageNumber: entry.pageNumber,
        text: entry.text.trim(),
      }).catch(() => {
        // Re-queue on failure under the same deck:page key.
        const existing = pendingTextRef.current.get(key)
        pendingTextRef.current.set(key, {
          deckId: entry.deckId,
          pageNumber: entry.pageNumber,
          text: existing ? `${existing.text} ${entry.text}` : entry.text,
        })
      })
    }
  }, [roomId])

  const scheduleDebouncedFlush = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = setTimeout(() => {
      flushPending()
    }, TRANSCRIPT_DEBOUNCE_MS)
  }, [flushPending])

  const sampleRateRef = useRef(SCRIBE_SAMPLE_RATE)

  // ── Usage metering ────────────────────────────────────────────
  // ElevenLabs bills Scribe by CONNECTION time (open WebSocket), not by
  // transcript coverage. Heartbeat the cumulative connected seconds to the
  // server every 60s (plus a final flush on close), keyed by one session key
  // per start(), so the cost ledger upserts a single row per session and a
  // crash loses at most a minute.
  const usageKeyRef = useRef<string | null>(null)
  const usageSecondsRef = useRef(0)
  const connectedSinceRef = useRef<number | null>(null)
  const usageTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const reportUsage = useCallback(() => {
    const live = connectedSinceRef.current ? (Date.now() - connectedSinceRef.current) / 1000 : 0
    const seconds = Math.round(usageSecondsRef.current + live)
    if (!usageKeyRef.current || seconds <= 0) return
    void fetch('/api/live-classroom/scribe-usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, sessionKey: usageKeyRef.current, seconds }),
      keepalive: true, // survives tab close for the final flush
    }).catch(() => {})
  }, [roomId])

  const connectWebSocket = useCallback(async (token: string) => {
    const rate = sampleRateRef.current
    const url = `${SCRIBE_WS_URL}?token=${encodeURIComponent(token)}&model_id=${SCRIBE_MODEL}&language_code=en&audio_format=pcm_${rate}&commit_strategy=vad`

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      setIsConnected(true)
      setError(null)
      if (!usageKeyRef.current) usageKeyRef.current = crypto.randomUUID()
      connectedSinceRef.current = Date.now()
      if (usageTimerRef.current) clearInterval(usageTimerRef.current)
      usageTimerRef.current = setInterval(reportUsage, 60_000)
      // Only reset retries after the connection survives 10s
      // to prevent infinite reconnect loops on immediate close
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          retriesRef.current = 0
        }
      }, 10_000)
    }

    ws.onmessage = (event) => {
      try {
        const msg: ScribeMessage = JSON.parse(event.data)

        if (msg.message_type === 'partial_transcript') {
          setPartialText(msg.text)
        } else if (msg.message_type === 'committed_transcript') {
          if (msg.text.trim()) {
            const deck = deckIdRef.current
            // No active deck → nothing to attribute this chunk to; drop it.
            if (!deck) {
              setPartialText('')
              return
            }
            const page = currentSlideRef.current
            const key = `${deck}:${page}`
            const existing = pendingTextRef.current.get(key)
            pendingTextRef.current.set(key, {
              deckId: deck,
              pageNumber: page,
              text: existing ? `${existing.text} ${msg.text}` : msg.text,
            })

            setTranscriptByPage((prev) => {
              const next = new Map(prev)
              const pageText = next.get(page) ?? ''
              next.set(page, pageText ? `${pageText} ${msg.text}` : msg.text)
              return next
            })

            setPartialText('')
            scheduleDebouncedFlush()
          }
        }
      } catch {
        // Ignore unparseable messages
      }
    }

    ws.onclose = (event) => {
      setIsConnected(false)
      if (connectedSinceRef.current) {
        usageSecondsRef.current += (Date.now() - connectedSinceRef.current) / 1000
        connectedSinceRef.current = null
      }
      if (usageTimerRef.current) {
        clearInterval(usageTimerRef.current)
        usageTimerRef.current = null
      }
      reportUsage()
      console.warn('[Transcription] WebSocket closed', { code: event.code, reason: event.reason, wasClean: event.wasClean })
      if (!stoppingRef.current && retriesRef.current < RECONNECT_MAX_RETRIES) {
        const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, retriesRef.current)
        retriesRef.current++
        setTimeout(async () => {
          try {
            const res = await fetch('/api/live-classroom/scribe-token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ roomId }),
            })
            const data = await res.json()
            if (data.token) {
              connectWebSocket(data.token)
            }
          } catch {
            setError('Failed to reconnect transcription')
          }
        }, delay)
      }
    }

    ws.onerror = (event) => {
      console.error('[Transcription] WebSocket error', event)
      setError('Transcription connection error')
    }
  }, [roomId, scheduleDebouncedFlush, reportUsage])

  const start = useCallback(async () => {
    if (isListeningRef.current) return
    stoppingRef.current = false
    setError(null)

    // stop()/unmount can fire while start() is mid-await; without these
    // checks the remaining awaits would resolve and leave a mic stream +
    // billed ElevenLabs socket running with nobody left to clean them up.
    const abortIfStopping = () => {
      if (!stoppingRef.current) return false
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      audioContextRef.current?.close().catch(() => {})
      audioContextRef.current = null
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      setActiveStream(null)
      return true
    }

    try {
      // Preferred mic (e.g. an external wireless mic) from the stored
      // per-browser preference; resolves to the browser default when unset
      // or when the device isn't connected.
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: await getPreferredMicConstraints(),
        })
      } catch (err) {
        // Device vanished between enumerate and acquire — fall back to the
        // default mic rather than failing the lecture.
        if (err instanceof Error && err.name === 'OverconstrainedError') {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: buildMicConstraints(null),
          })
          toast.warning('Selected microphone unavailable — using the default microphone.')
        } else {
          throw err
        }
      }
      streamRef.current = stream
      setActiveStream(stream)
      if (abortIfStopping()) return

      // Mic died mid-class (unplug / battery). Restart on whatever the
      // preference now resolves to (the dead device won't be found → the
      // default mic), so transcription survives without the professor
      // debugging audio mid-lecture. Skipped when the session is no longer
      // enabled (room ended while the device died).
      const track = stream.getAudioTracks()[0]
      if (track) {
        track.onended = () => {
          if (stoppingRef.current) return
          stop()
          if (!enabledRef.current) return
          toast.warning('Microphone disconnected — switching to the default microphone.')
          void startRef.current?.()
        }
      }

      // Use the browser's native sample rate — forcing 16kHz can fail
      // on some browsers. ElevenLabs accepts multiple PCM rates.
      const audioContext = new AudioContext()
      audioContextRef.current = audioContext
      // Map to nearest ElevenLabs-supported PCM rate
      const supported = [8000, 16000, 22050, 24000, 44100, 48000]
      const actual = audioContext.sampleRate
      const closest = supported.reduce((a, b) =>
        Math.abs(b - actual) < Math.abs(a - actual) ? b : a
      )
      sampleRateRef.current = closest

      await audioContext.audioWorklet.addModule('/worklets/pcm-processor.js')
      if (abortIfStopping()) return

      const source = audioContext.createMediaStreamSource(stream)
      const worklet = new AudioWorkletNode(audioContext, 'pcm-processor')

      const tokenRes = await fetch('/api/live-classroom/scribe-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId }),
      })

      if (!tokenRes.ok) {
        const data = await tokenRes.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to get transcription token')
      }

      const { token } = await tokenRes.json()
      await connectWebSocket(token)
      if (abortIfStopping()) return

      worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          const bytes = new Uint8Array(event.data)
          let binary = ''
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i])
          }
          const base64 = btoa(binary)
          wsRef.current.send(JSON.stringify({
            message_type: 'input_audio_chunk',
            audio_base_64: base64,
          }))
        }
      }

      source.connect(worklet)
      worklet.connect(audioContext.destination)

      isListeningRef.current = true
      setIsListening(true)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start transcription'
      if (message.includes('Permission') || message.includes('NotAllowed')) {
        setError('Microphone access denied. Please allow microphone access in your browser settings.')
      } else if (message.includes('NotFound')) {
        setError('No microphone found. Please connect a microphone and try again.')
      } else {
        setError(message)
      }
      stop()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, connectWebSocket])

  startRef.current = start

  const stop = useCallback(() => {
    stoppingRef.current = true
    isListeningRef.current = false

    // Flush any remaining pending transcription
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
    flushPending()

    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    setIsListening(false)
    setIsConnected(false)
    setPartialText('')
    setActiveStream(null)
  }, [flushPending])

  // Stop transcription when disabled or component unmounts
  useEffect(() => {
    if (!enabled && isListening) {
      stop()
    }
  }, [enabled, isListening, stop])

  useEffect(() => {
    return () => {
      stoppingRef.current = true
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
      flushPending()
      if (wsRef.current) wsRef.current.close()
      if (audioContextRef.current) audioContextRef.current.close().catch(() => {})
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop())
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // On a deck switch, clear the displayed transcript so the panel shows the
  // now-active deck (the parent re-hydrates it for that deck). Pending chunks
  // are left untouched — they still flush to whichever deck captured them.
  const prevDeckIdRef = useRef(deckId)
  useEffect(() => {
    if (prevDeckIdRef.current !== deckId) {
      prevDeckIdRef.current = deckId
      setTranscriptByPage(new Map())
    }
  }, [deckId])

  const hydrateTranscripts = useCallback((data: Array<{ page_number: number; text: string }>) => {
    if (data.length === 0) return
    setTranscriptByPage((prev) => {
      const next = new Map(prev)
      for (const row of data) {
        if (!next.has(row.page_number)) {
          next.set(row.page_number, row.text)
        }
      }
      return next
    })
  }, [])

  return {
    isListening,
    isConnected,
    partialText,
    transcriptByPage,
    error,
    stream: activeStream,
    start,
    stop,
    hydrateTranscripts,
  }
}
