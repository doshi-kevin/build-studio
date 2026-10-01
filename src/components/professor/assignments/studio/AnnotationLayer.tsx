/**
 * AnnotationLayer — a freehand markup overlay for the document studio's student preview.
 *
 * The professor toggles the marker on to draw over the previewed assignment (circle a typo, flag
 * a question), then off to scroll/read. Ephemeral by design: it's scratch markup for reviewing the
 * student view, not persisted. Ink colors are read from the theme tokens (no hardcoded colors).
 * When the marker is off the canvas is click-through so the preview stays interactive.
 *
 * Type: Client Component
 */
'use client'

import { useEffect, useRef, useState } from 'react'
import { Pen, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

// Ink palette sourced from theme tokens (read at runtime), so it stays on-theme.
const INK_VARS = ['--destructive', '--primary', '--chart-3'] as const

export function AnnotationLayer() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawingRef = useRef(false)
  const lastRef = useRef<{ x: number; y: number } | null>(null)
  const [penOn, setPenOn] = useState(true)
  // Read ink colors from the theme tokens. This component only mounts client-side (the preview
  // toggle), so a lazy initializer is safe and avoids a setState-in-effect round-trip.
  const [colors] = useState<string[]>(() => {
    if (typeof document === 'undefined') return []
    const cs = getComputedStyle(document.documentElement)
    return INK_VARS.map((v) => cs.getPropertyValue(v).trim()).filter(Boolean)
  })
  const [color, setColor] = useState<string>(() => colors[0] ?? 'currentColor')

  // Keep the canvas sized to its parent (redraws are cleared on resize — scratch markup).
  useEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return
    const resize = () => {
      const rect = parent.getBoundingClientRect()
      canvas.width = rect.width
      canvas.height = rect.height
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(parent)
    // Ink is painted in viewport space; if the preview scrolls, clear it so stale strokes don't
    // float over unrelated content (capture-phase, since scroll doesn't bubble).
    const clearOnScroll = () => {
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
    }
    document.addEventListener('scroll', clearOnScroll, true)
    return () => {
      ro.disconnect()
      document.removeEventListener('scroll', clearOnScroll, true)
    }
  }, [])

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function onDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!penOn) return
    drawingRef.current = true
    lastRef.current = point(e)
    canvasRef.current?.setPointerCapture(e.pointerId)
  }

  function onMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!penOn || !drawingRef.current) return
    const ctx = canvasRef.current?.getContext('2d')
    const last = lastRef.current
    if (!ctx || !last) return
    const p = point(e)
    ctx.strokeStyle = color || 'currentColor'
    ctx.lineWidth = 3
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(last.x, last.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    lastRef.current = p
  }

  function onUp() {
    drawingRef.current = false
    lastRef.current = null
  }

  function clear() {
    const c = canvasRef.current
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height)
  }

  return (
    <>
      <canvas
        ref={canvasRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
        className={cn('absolute inset-0 h-full w-full', penOn ? 'cursor-crosshair touch-none' : 'pointer-events-none')}
      />
      <div className="absolute right-4 top-4 z-10 flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-1.5 shadow-md">
        <Button
          variant={penOn ? 'default' : 'ghost'}
          size="icon"
          className="h-7 w-7"
          onClick={() => setPenOn((v) => !v)}
          aria-pressed={penOn}
          aria-label={penOn ? 'Marker on' : 'Marker off'}
        >
          <Pen className="h-3.5 w-3.5" />
        </Button>
        {colors.map((c, i) => (
          <button
            key={c}
            type="button"
            onClick={() => { setColor(c); setPenOn(true) }}
            aria-label={`Ink color ${i + 1}`}
            aria-pressed={color === c}
            className={cn('h-5 w-5 rounded-full border border-border', color === c && 'ring-2 ring-ring ring-offset-1')}
            style={{ background: c }}
          />
        ))}
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={clear} aria-label="Clear markup">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </>
  )
}
