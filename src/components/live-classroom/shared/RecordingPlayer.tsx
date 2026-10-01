// In-app recording player for a live classroom session. NOT a baked video — it
// re-renders the broadcast (slide images + annotation strokes + captions) in
// sync with the recorded audio, which is the master clock. Editable-as-data by
// construction; feels like a video to the viewer (play / pause / scrub).
//
// Used by both the professor report and the student insights page via
// <RecordingSection roomId=…/>, which fetches getRecording and handles the
// none / processing / failed / ready states.

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Image from 'next/image'
import { Loader2, Pause, Play, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { computeSlideRect } from '@/lib/live-classroom/drawings/render'
import type { Stroke } from '@/lib/live-classroom/drawings/types'
import { getRecording } from '@/lib/live-classroom/recording/actions'
import {
  buildChapters,
  buildPlaybackTimeline,
  mapWallClockToAudioElapsed,
  slideAt,
  totalAudioDurationSec,
  type AudioSessionInfo,
} from '@/lib/live-classroom/recording/reconstruct'
import type { RecordingData } from '@/lib/live-classroom/recording/types'

const POLL_MS = 5000

function formatTime(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec < 0) totalSec = 0
  const m = Math.floor(totalSec / 60)
  const s = Math.floor(totalSec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// ── Self-fetching section (mounted by both insights pages) ───────────

export function RecordingSection({ roomId }: { roomId: string }) {
  const [data, setData] = useState<RecordingData | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      const result = await getRecording(roomId)
      if (cancelled) return
      setData(result)
      // Keep polling while the recording is still being captured/finalized.
      if (result.status === 'processing' || result.status === 'recording') {
        timer = setTimeout(() => void run(), POLL_MS)
      }
    }
    void run()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [roomId])

  // No recording for this session → render nothing (don't show an empty shell).
  if (!data || data.status === 'none') return null

  return (
    <section className="space-y-4">
      {/* Role-neutral section header (matches the SectionLabel look used across
          both insights views, without coupling to a role-specific component). */}
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        <Video className="h-3.5 w-3.5" aria-hidden />
        Recording
      </p>
      {data.status === 'ready' ? (
        <RecordingPlayer data={data} />
      ) : data.status === 'failed' ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-border bg-card p-8 text-center">
          <span className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <Video className="h-5 w-5" aria-hidden />
          </span>
          <p className="text-sm font-medium">This recording couldn&apos;t be processed</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            If it was a long session, please check back shortly.
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-border bg-card p-8 text-center">
          <span className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          </span>
          <p className="text-sm font-medium">Preparing the recording…</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            This can take a little while after a long session.
          </p>
        </div>
      )}
    </section>
  )
}

// ── The player (ready data only) ─────────────────────────────────────

function RecordingPlayer({ data }: { data: RecordingData }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // A seek that lands in a different session sets the target here; it's applied
  // once that session's audio metadata has loaded (see onLoadedMetadata). A ref
  // (not a listener per seek) so rapid cross-session scrubs can't leak stale
  // listeners that later yank the playhead to an old offset.
  const pendingSeekRef = useRef<number | null>(null)
  const [sessionIndex, setSessionIndex] = useState(0)
  const [globalTime, setGlobalTime] = useState(0) // seconds across all sessions
  const [playing, setPlaying] = useState(false)
  const [slideAspect, setSlideAspect] = useState(16 / 9)
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 })

  const sessions = useMemo<AudioSessionInfo[]>(
    () => (data.audio ?? []).map((a) => ({ startedAt: a.startedAt, durationMs: a.durationMs })),
    [data.audio],
  )
  const total = useMemo(() => totalAudioDurationSec(sessions), [sessions])

  // Cumulative audio-seconds before each session start (for global<->local time).
  const sessionStarts = useMemo(() => {
    const starts: number[] = []
    let acc = 0
    for (const s of sessions) {
      starts.push(acc)
      acc += Math.max(0, s.durationMs) / 1000
    }
    return starts
  }, [sessions])

  const playback = useMemo(
    () => buildPlaybackTimeline(data.timeline ?? [], sessions),
    [data.timeline, sessions],
  )
  const chapters = useMemo(() => buildChapters(playback), [playback])

  // Pre-map every annotation stroke to its audio-elapsed time once.
  const annotations = useMemo(
    () =>
      (data.annotations ?? []).map((a) => ({
        deckId: a.deckId,
        slideIndex: a.slideIndex,
        at: mapWallClockToAudioElapsed(sessions, a.ts),
        stroke: a.stroke as Stroke,
      })),
    [data.annotations, sessions],
  )

  const current = slideAt(playback, globalTime)
  const slideUrl =
    current && data.slideUrls?.[current.deckId ?? '']
      ? data.slideUrls[current.deckId ?? ''][current.slideIndex] ?? ''
      : ''

  // Strokes visible on the current slide up to the current audio time.
  const visibleStrokes = useMemo(() => {
    if (!current) return []
    return annotations
      .filter(
        (a) => a.deckId === current.deckId && a.slideIndex === current.slideIndex && a.at <= globalTime,
      )
      .map((a) => a.stroke)
  }, [annotations, current, globalTime])

  // ── Audio → global time ──
  const onTimeUpdate = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    setGlobalTime((sessionStarts[sessionIndex] ?? 0) + audio.currentTime)
  }, [sessionStarts, sessionIndex])

  // On a session ending, roll to the next one (multi-session recordings from a
  // reload); otherwise stop at the end.
  const onEnded = useCallback(() => {
    if (sessionIndex < sessions.length - 1) {
      setSessionIndex((i) => i + 1)
      // Autoplay continuation handled by the effect below (playing stays true).
    } else {
      setPlaying(false)
    }
  }, [sessionIndex, sessions.length])

  // Load the src for the active session; resume playback if we were playing.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const url = data.audio?.[sessionIndex]?.url
    if (!url) return
    audio.src = url
    audio.load()
    if (playing) void audio.play().catch(() => setPlaying(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionIndex])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
      setPlaying(false)
    } else {
      void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
    }
  }, [playing])

  // Seek to a global time: pick the covering session + local offset.
  const seekTo = useCallback(
    (t: number) => {
      const clamped = Math.max(0, Math.min(t, total))
      let idx = 0
      for (let i = sessions.length - 1; i >= 0; i--) {
        if (clamped >= (sessionStarts[i] ?? 0)) {
          idx = i
          break
        }
      }
      const local = clamped - (sessionStarts[idx] ?? 0)
      setGlobalTime(clamped)
      if (idx !== sessionIndex) {
        // Different session: swap the src (effect) and stash the offset; it's
        // applied by onLoadedMetadata once the new audio is ready.
        pendingSeekRef.current = local
        setSessionIndex(idx)
      } else if (audioRef.current) {
        audioRef.current.currentTime = local
      }
    },
    [total, sessions.length, sessionStarts, sessionIndex],
  )

  // Apply a pending cross-session seek once the swapped audio has metadata.
  const handleLoadedMetadata = useCallback(() => {
    if (pendingSeekRef.current !== null && audioRef.current) {
      audioRef.current.currentTime = pendingSeekRef.current
      pendingSeekRef.current = null
    }
  }, [])

  // Track the canvas's rendered size so strokes re-scale when the layout
  // reflows (window resize, sidebar toggle) — otherwise they'd stay drawn at the
  // old dimensions and drift off the slide.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCanvasSize({ w: entry.contentRect.width, h: entry.contentRect.height })
      }
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])

  // ── Draw strokes on the overlay whenever they or the size change ──
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (w <= 0 || h <= 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const slide = computeSlideRect(w, h, slideAspect || w / h)
    const widthScale = slide.width / 1000 // widths stored as if slide were 1000px wide
    for (const stroke of visibleStrokes) {
      if (!stroke?.points?.length) continue
      if (stroke.color === '__eraser__') {
        ctx.globalCompositeOperation = 'destination-out'
        ctx.strokeStyle = 'rgba(0,0,0,1)'
      } else {
        ctx.globalCompositeOperation = 'source-over'
        ctx.strokeStyle = stroke.color
      }
      ctx.lineWidth = Math.max(1, stroke.width * widthScale)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      const [first, ...rest] = stroke.points
      ctx.moveTo(slide.x + first.x * slide.width, slide.y + first.y * slide.height)
      for (const p of rest) ctx.lineTo(slide.x + p.x * slide.width, slide.y + p.y * slide.height)
      ctx.stroke()
    }
    ctx.globalCompositeOperation = 'source-over'
  }, [visibleStrokes, slideAspect, canvasSize])

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      {/* Slide viewport + annotation overlay */}
      <div className="relative aspect-video w-full bg-muted">
        {slideUrl ? (
          <Image
            key={slideUrl}
            src={slideUrl}
            alt={current ? `Slide ${current.slideIndex + 1}` : 'Slide'}
            fill
            className="object-contain"
            unoptimized
            onLoad={(e) => {
              const img = e.currentTarget
              if (img.naturalWidth && img.naturalHeight) {
                setSlideAspect(img.naturalWidth / img.naturalHeight)
              }
            }}
          />
        ) : (
          <div className="flex size-full items-center justify-center text-sm text-muted-foreground">
            No slide
          </div>
        )}
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 size-full" />
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 border-t border-border px-4 py-3">
        <Button
          type="button"
          size="icon"
          variant="secondary"
          onClick={togglePlay}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>

        <span className="w-14 shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatTime(globalTime)}
        </span>

        {/*
          Custom track: the track line, the played fill, and the chapter pips all
          share the same 0–100% coordinate space, so they align exactly. The
          native range input sits transparent on top purely for interaction
          (drag / click / keyboard), which is why the pips no longer drift off a
          separate baseline the way the styled native track did.
        */}
        <div className="relative flex h-9 flex-1 items-center">
          <div className="absolute inset-x-0 h-1 rounded-full bg-muted" />
          <div
            className="absolute h-1 rounded-full bg-primary"
            style={{ width: `${total > 0 ? (Math.min(globalTime, total) / total) * 100 : 0}%` }}
          />
          {total > 0 &&
            chapters.map((c, i) => (
              <span
                key={i}
                aria-hidden
                className="pointer-events-none absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/40"
                style={{ left: `${(c.t / total) * 100}%` }}
              />
            ))}
          <input
            type="range"
            min={0}
            max={total || 0}
            step={1}
            value={Math.min(globalTime, total)}
            onChange={(e) => seekTo(Number(e.target.value))}
            className="absolute inset-x-0 h-9 w-full cursor-pointer appearance-none bg-transparent accent-primary outline-none [&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-ring focus-visible:[&::-webkit-slider-thumb]:ring-offset-2 focus-visible:[&::-webkit-slider-thumb]:ring-offset-card"
            aria-label="Seek"
          />
        </div>

        <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {formatTime(total)}
        </span>
      </div>

      {/* Hidden audio element — the master clock. No native controls (custom UI
          above); nothing to download from the chrome. */}
      <audio
        ref={audioRef}
        controlsList="nodownload"
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
        onEnded={onEnded}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        className="hidden"
      />
    </div>
  )
}
