// Lightweight voice activity detection hook using the Web Audio API
// AnalyserNode. Returns a 0-1 amplitude level for the UI indicator
// animation. Runs on the same AudioContext as the transcription hook.

'use client'

import { useSyncExternalStore, useRef, useCallback, useEffect } from 'react'

export interface UseVoiceActivityOptions {
  stream: MediaStream | null
  enabled: boolean
}

export interface UseVoiceActivityResult {
  isActive: boolean
  level: number
}

interface VoiceState {
  isActive: boolean
  level: number
}

const SILENCE_THRESHOLD = 0.02
const IDLE_STATE: VoiceState = { isActive: false, level: 0 }

export function useVoiceActivity({
  stream,
  enabled,
}: UseVoiceActivityOptions): UseVoiceActivityResult {
  const stateRef = useRef<VoiceState>(IDLE_STATE)
  const listenersRef = useRef<Set<() => void>>(new Set())
  const rafRef = useRef<number | null>(null)
  const contextRef = useRef<AudioContext | null>(null)

  const subscribe = useCallback((cb: () => void) => {
    listenersRef.current.add(cb)
    return () => { listenersRef.current.delete(cb) }
  }, [])

  const getSnapshot = useCallback(() => stateRef.current, [])

  const notify = useCallback(() => {
    listenersRef.current.forEach((cb) => cb())
  }, [])

  useEffect(() => {
    if (!enabled || !stream) {
      stateRef.current = IDLE_STATE
      notify()
      return
    }

    const audioContext = new AudioContext()
    contextRef.current = audioContext
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 256

    const source = audioContext.createMediaStreamSource(stream)
    source.connect(analyser)

    const dataArray = new Uint8Array(analyser.frequencyBinCount)

    function tick() {
      analyser.getByteFrequencyData(dataArray)

      let sum = 0
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i]
      }
      const avg = sum / dataArray.length / 255

      stateRef.current = { isActive: avg > SILENCE_THRESHOLD, level: avg }
      notify()

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      analyser.disconnect()
      source.disconnect()
      audioContext.close().catch(() => {})
      stateRef.current = IDLE_STATE
      notify()
    }
  }, [stream, enabled, notify])

  const state = useSyncExternalStore(subscribe, getSnapshot, () => IDLE_STATE)
  return state
}
