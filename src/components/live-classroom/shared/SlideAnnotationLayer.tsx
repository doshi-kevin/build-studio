// Shared canvas overlay used by both the professor (draw mode) and
// student (view mode) for live slide annotations.
//
// COORDINATE SYSTEM (the important bit): stroke points are stored in
// normalized SLIDE coordinates — (0,0) is the top-left of the slide IMAGE,
// (1,1) is the bottom-right. This is invariant to:
//   - viewport size (window, sidebar, mobile vs desktop)
//   - fullscreen toggle
//   - the canvas aspect ratio vs the slide image aspect ratio (letterboxing)
//
// We compute the slide's actual rendered rectangle inside the canvas using
// `object-contain` math against the slide image's natural dimensions. The
// pointer-down/move handlers convert client coords → slide coords; the
// render path converts slide coords → canvas pixels. Both sides see the
// same stroke at the same point on the slide regardless of how their
// browser is laid out.

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createClient } from '@/lib/supabase/client'
import { ephemeralTopic } from '@/lib/live-classroom/broadcast/types'
import { sendStroke, sendClear } from '@/lib/live-classroom/drawings/send-stroke'
import { persistStrokes, clearSlideAnnotations } from '@/lib/live-classroom/drawings/actions'
import { useDrawings } from '@/lib/live-classroom/broadcast/use-drawings'
import {
  MAX_STROKES_PER_BATCH,
  type Stroke,
  type StrokePoint,
} from '@/lib/live-classroom/drawings/types'
import type { EventBus } from '@/lib/live-classroom/broadcast/event-bus'
import { computeSlideRect, drawStrokes } from '@/lib/live-classroom/drawings/render'
import { logger } from '@/lib/logger'
import { generateId } from '@/lib/quiz/utils'
import { AnnotationToolbar, type DrawColor } from './AnnotationToolbar'

interface Props {
  mode: 'draw' | 'view'
  roomId: string
  /** The active deck — strokes are persisted/cleared against it so they
   *  don't collide with another deck's same slide index. */
  deckId: string
  slideIndex: number
  /** URL of the current slide image — used to detect natural aspect ratio
   *  so strokes are normalized to the slide content, not the canvas. */
  slideUrl: string
  authorId: string
  bus: EventBus
  /** All strokes ever drawn in this room, from getRoomSnapshot.
   *  useDrawings filters to the current slide internally. */
  initialAnnotations: Stroke[]
}

const PERSIST_INTERVAL_MS = 2000
const MAX_STROKES_PER_SEC = 15

export function SlideAnnotationLayer({
  mode,
  roomId,
  deckId,
  slideIndex,
  slideUrl,
  authorId,
  bus,
  initialAnnotations,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const supabase = useMemo(() => createClient(), [])
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
  const drawingRef = useRef<{ stroke: Stroke; startedAt: number } | null>(null)
  const pendingPersistRef = useRef<Stroke[]>([])
  const strokeTimestampsRef = useRef<number[]>([])

  const [color, setColor] = useState<DrawColor>('red')
  const [width, setWidth] = useState<number>(3)
  const [erasing, setErasing] = useState<boolean>(false)

  // External slot for the toolbar — rendered below the slide by the
  // parent (LivePresenter). When the slot is missing (e.g. student
  // view-only mode), the toolbar falls back to an inline overlay
  // pinned to the slide's bottom-center.
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null)
  // The toolbar no longer tracks fullscreen itself — it is portaled INTO the
  // control bar, which sits inside the `.lc-stage` scope, so the cascade skins it.
  // The `fullscreenchange` listener is now only a cheap re-lookup of the portal
  // target, NOT a theming trigger: the slot is rendered unconditionally, so React
  // keeps the same node across a fullscreen toggle and this callback usually bails
  // out. Kept because losing the target would silently drop the toolbar back to
  // its inline fallback, and a no-op listener is cheaper than that failure mode.
  useEffect(() => {
    const update = () => {
      setToolbarSlot(document.getElementById('lc-annotation-toolbar-slot'))
    }
    update()
    document.addEventListener('fullscreenchange', update)
    return () => document.removeEventListener('fullscreenchange', update)
  }, [])

  // Slide aspect ratio (width / height) loaded from the actual image.
  // While unknown, we fall back to the canvas aspect — strokes still draw
  // sensibly, just without slide-relative correction.
  const [slideAspect, setSlideAspect] = useState<number | null>(null)
  useEffect(() => {
    if (!slideUrl) return
    let cancelled = false
    const img = new window.Image()
    img.onload = () => {
      if (cancelled) return
      if (img.naturalHeight > 0) {
        setSlideAspect(img.naturalWidth / img.naturalHeight)
      }
    }
    img.src = slideUrl
    return () => {
      cancelled = true
    }
  }, [slideUrl])

  // Canvas CSS size, kept in state so resizes trigger a re-render of the
  // strokes (otherwise strokes draw with stale dimensions when the window
  // resizes or the user toggles fullscreen).
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const measure = () => {
      const r = canvas.getBoundingClientRect()
      setCanvasSize((prev) =>
        prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height },
      )
    }
    // ResizeObserver fires synchronously when the canvas resizes — but the
    // browser may not have committed the new layout yet. Defer to the next
    // frame so getBoundingClientRect returns the post-layout size.
    const update = () => {
      requestAnimationFrame(measure)
    }
    measure()
    const ro = new ResizeObserver(update)
    ro.observe(canvas)
    window.addEventListener('resize', update)
    // Fullscreen transitions can take >1 frame to settle (CSS animations,
    // browser chrome reflow). Re-measure on the change event AND ~250ms
    // later to catch the post-transition size.
    const onFullscreenChange = () => {
      update()
      setTimeout(measure, 250)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
      document.removeEventListener('fullscreenchange', onFullscreenChange)
    }
  }, [])

  const { strokes, clearStrokes, addStroke } = useDrawings({
    bus,
    initialAnnotations,
    slideIndex,
    deckId,
  })

  // Grab the ephemeral channel handle for sending strokes.
  //
  // CRITICAL: Supabase JS dedupes channels by topic — calling
  // supabase.channel(topic) returns the SAME channel that useRoomChannel
  // already created and subscribed to. We MUST NOT call subscribe() or
  // removeChannel() here, because doing so would kill the parent's
  // subscription on cleanup and break the receive side (no strokes arrive
  // at the student side, and the connection status loops on "connecting").
  //
  // We only need the handle for `.send()` — the parent owns the lifecycle.
  useEffect(() => {
    if (mode !== 'draw') return
    channelRef.current = supabase.channel(ephemeralTopic(roomId), {
      config: { private: true },
    })
    return () => {
      // Drop the ref but DO NOT removeChannel — useRoomChannel still owns it.
      channelRef.current = null
    }
  }, [mode, roomId, supabase])

  // Periodic batched persistence of strokes drawn locally since last flush.
  // Writes go to the permanent `lc_slide_annotations` table — strokes
  // survive page reloads, late joiners, and post-class review.
  useEffect(() => {
    if (mode !== 'draw') return
    const interval = setInterval(() => {
      if (pendingPersistRef.current.length === 0) return
      const batch = pendingPersistRef.current.splice(0, MAX_STROKES_PER_BATCH)
      persistStrokes(roomId, deckId, batch).catch((err) => {
        logger.debug('persistStrokes failed (will retry on next batch)', { err: String(err) })
      })
    }, PERSIST_INTERVAL_MS)
    return () => {
      clearInterval(interval)
      // Flush remaining strokes on unmount.
      if (pendingPersistRef.current.length > 0) {
        persistStrokes(roomId, deckId, pendingPersistRef.current).catch(() => {})
        pendingPersistRef.current = []
      }
    }
  }, [mode, roomId, deckId])

  // Render the current stroke set onto the canvas. Re-runs whenever the
  // strokes set, the slide aspect, or the canvas size changes — so strokes
  // stay glued to the slide content through resizes and fullscreen toggles.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    if (canvasSize.w <= 0 || canvasSize.h <= 0) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.floor(canvasSize.w * dpr)
    canvas.height = Math.floor(canvasSize.h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, canvasSize.w, canvasSize.h)

    const slide = computeSlideRect(
      canvasSize.w,
      canvasSize.h,
      slideAspect ?? canvasSize.w / canvasSize.h,
    )

    // Shared renderer: normalized stroke coords → this slide rectangle,
    // eraser-aware. Widths are stored as if the slide were 1000px wide and
    // scaled to the actual width inside drawStrokes.
    drawStrokes(ctx, strokes, slide)
    if (drawingRef.current) drawStrokes(ctx, [drawingRef.current.stroke], slide)
  }, [strokes, slideAspect, canvasSize])

  // Pointer handlers (draw mode only).
  useEffect(() => {
    if (mode !== 'draw') return
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const localPoint = (clientX: number, clientY: number): StrokePoint | null => {
      const rect = canvas.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      const slide = computeSlideRect(
        rect.width,
        rect.height,
        slideAspect ?? rect.width / rect.height,
      )
      const xCanvas = clientX - rect.left
      const yCanvas = clientY - rect.top
      // Normalize to the slide rectangle.
      let x = (xCanvas - slide.x) / slide.width
      let y = (yCanvas - slide.y) / slide.height
      // Clamp so the user can't draw in the letterbox area; strokes that
      // wander off the slide pin to the edge.
      x = Math.max(0, Math.min(1, x))
      y = Math.max(0, Math.min(1, y))
      return {
        x,
        y,
        t: drawingRef.current ? Date.now() - drawingRef.current.startedAt : 0,
      }
    }

    const onDown = (e: PointerEvent) => {
      e.preventDefault()
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
      const startedAt = Date.now()
      const p = localPoint(e.clientX, e.clientY)
      if (!p) return
      const stroke: Stroke = {
        id: generateId(),
        slideIndex,
        points: [p],
        // Sentinel color the renderer recognizes as "use destination-out".
        // Real eraser, not a fake white-paint trick.
        color: erasing ? '__eraser__' : color,
        // Stored width is in "slide units" (assume slide is 1000px wide); the
        // renderer scales it to the actual paint size. This keeps stroke
        // thickness consistent across viewports.
        width: erasing ? width * 4 : width,
        authorId,
      }
      drawingRef.current = { stroke, startedAt }
    }

    const onMove = (e: PointerEvent) => {
      if (!drawingRef.current) return
      const point = localPoint(e.clientX, e.clientY)
      if (!point) return
      drawingRef.current.stroke.points.push(point)
      // Paint the new segment immediately for low-latency feedback.
      requestAnimationFrame(() => {
        const ctx = canvasRef.current?.getContext('2d')
        if (!ctx || !drawingRef.current) return
        const rect = canvasRef.current!.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return
        const slide = computeSlideRect(
          rect.width,
          rect.height,
          slideAspect ?? rect.width / rect.height,
        )
        const widthScale = slide.width / 1000
        const stroke = drawingRef.current.stroke
        if (stroke.points.length < 2) return
        const a = stroke.points[stroke.points.length - 2]
        const b = stroke.points[stroke.points.length - 1]
        // Live segment must respect the eraser sentinel too, otherwise the
        // mid-stroke preview shows white pixels until the next full re-render.
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
        ctx.moveTo(slide.x + a.x * slide.width, slide.y + a.y * slide.height)
        ctx.lineTo(slide.x + b.x * slide.width, slide.y + b.y * slide.height)
        ctx.stroke()
        ctx.globalCompositeOperation = 'source-over'
      })
    }

    const onUp = () => {
      if (!drawingRef.current) return
      const completed = drawingRef.current.stroke
      drawingRef.current = null

      // Per-user broadcast rate limit: insurance against a malicious client
      // spamming many tiny strokes. Typical use is 1-2 strokes/sec.
      const now = Date.now()
      strokeTimestampsRef.current = strokeTimestampsRef.current.filter(
        (t) => now - t < 1000,
      )
      if (strokeTimestampsRef.current.length >= MAX_STROKES_PER_SEC) {
        logger.debug('SlideAnnotationLayer: broadcast rate cap hit, dropping stroke')
        return
      }
      strokeTimestampsRef.current.push(now)

      // Persist the stroke into our own local state immediately. Supabase
      // Broadcast doesn't echo `self` sends, so without this the prof's
      // stroke would only live as bitmap pixels painted by onMove — and
      // any canvas-resetting re-render (fullscreen toggle, window resize)
      // would wipe it locally. Students still see it because they receive
      // the broadcast and store it in their own state.
      addStroke(completed)

      // Send live to every other subscriber.
      if (channelRef.current) {
        sendStroke(channelRef.current, completed).catch((err) => {
          logger.debug('sendStroke failed', { err: String(err) })
        })
      }
      // Queue for periodic batch persistence (catches late joiners).
      pendingPersistRef.current.push(completed)
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    return () => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
    }
  }, [mode, color, width, erasing, slideIndex, authorId, slideAspect, addStroke])

  const toolbar =
    mode === 'draw' ? (
      <AnnotationToolbar
        color={color}
        onColorChange={setColor}
        width={width}
        onWidthChange={setWidth}
        erasing={erasing}
        onEraserToggle={() => setErasing((e) => !e)}
        onClear={() => {
          // Local wipe is immediate; the broadcast tells every other viewer
          // (and our own bus listener, idempotently) to do the same.
          clearStrokes()
          // Cancel any in-progress stroke so it doesn't get persisted.
          drawingRef.current = null
          // Drop pending strokes from the persistence queue so the next
          // batch flush doesn't resurrect what we just cleared.
          pendingPersistRef.current = pendingPersistRef.current.filter(
            (s) => s.slideIndex !== slideIndex,
          )
          if (channelRef.current) {
            sendClear(channelRef.current, slideIndex).catch((err) => {
              logger.debug('sendClear failed', { err: String(err) })
            })
          }
          // Permanent deletion: wipe this slide's annotations from the
          // database so reloads, late joiners, and post-class review
          // also see a clean slate.
          clearSlideAnnotations(roomId, deckId, slideIndex).catch((err) => {
            logger.debug('clearSlideAnnotations failed', { err: String(err) })
          })
        }}
      />
    ) : null

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none"
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={
          mode === 'draw'
            ? 'Annotation canvas — draw with mouse, touch, or pen'
            : 'Slide annotations'
        }
        className={`absolute inset-0 w-full h-full ${
          mode === 'draw' ? 'pointer-events-auto cursor-crosshair' : 'pointer-events-none'
        }`}
      />
      {toolbar &&
        (toolbarSlot ? (
          createPortal(toolbar, toolbarSlot)
        ) : (
          <div className="absolute bottom-5 left-1/2 -translate-x-1/2 pointer-events-auto">
            {toolbar}
          </div>
        ))}
    </div>
  )
}
