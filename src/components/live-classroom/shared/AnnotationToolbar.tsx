// Pill toolbar for annotation controls — pen vs eraser, ink color, stroke
// width, and clear-all. Position-agnostic: parent decides whether it sits
// in normal flow (below the slide) or as an overlay (fullscreen). Every
// icon-only control is wrapped in a Tooltip so non-tech-savvy professors
// can discover what each does.

'use client'

import { Eraser, Trash2, Pen } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

export type DrawColor = 'red' | 'blue' | 'green' | 'yellow'

const COLOR_CSS: Record<DrawColor, string> = {
  red: '#ef4444',
  blue: '#3b82f6',
  green: '#22c55e',
  yellow: '#eab308',
}

const COLOR_LABEL: Record<DrawColor, string> = {
  red: 'Red ink',
  blue: 'Blue ink',
  green: 'Green ink',
  yellow: 'Yellow ink',
}

const COLORS: DrawColor[] = ['red', 'blue', 'green', 'yellow']
const WIDTHS = [2, 4, 8]
const WIDTH_LABEL: Record<number, string> = {
  2: 'Thin',
  4: 'Medium',
  8: 'Thick',
}

interface Props {
  color: DrawColor
  onColorChange: (c: DrawColor) => void
  width: number
  onWidthChange: (w: number) => void
  erasing: boolean
  onEraserToggle: () => void
  onClear: () => void
}

/* These were eleven `isDark ? … : …` pairs behind a `theme` prop. Every one of
   them is now a single token expression, because the `.lc-stage` scope on the
   fullscreen stage re-points the tokens themselves (see globals.css). The
   "active" state inverts against whichever ground it lands on for the same
   reason: `bg-foreground text-background` is the pen that is currently
   selected, not a surface, so it reads as a solid dark pill either way. */
const SURFACE = 'bg-card border-border text-foreground'
const DIVIDER = 'border-border'
const SUBTLE = 'text-muted-foreground'
const HOVER = 'hover:bg-accent'
const HOVER_SOFT = 'hover:bg-accent/60'
const ACTIVE_BG = 'bg-foreground text-background'
const WIDTH_BG = 'bg-accent'
const WIDTH_DOT = 'bg-foreground'
const RING = 'ring-foreground'
const RING_OFFSET = 'ring-offset-card'

export function AnnotationToolbar({
  color,
  onColorChange,
  width,
  onWidthChange,
  erasing,
  onEraserToggle,
  onClear,
}: Props) {
  return (
    <TooltipProvider delayDuration={250}>
      {/* Wraps below a 420px container. The toolbar is ~373px of tools and it is
          portaled into the control bar, which on a phone has ~262px to give —
          so as a single unwrappable pill its Pen fell off the left edge and
          Clear-all off the right, with no way to reach either. It keeps the
          pill shape at every width that can actually seat it on one line, and
          relaxes to a rounded block only where it has to occupy two.
          `@min-` works here because the portal target is a DOM child of the
          control bar's `@container`. */}
      <div
        className={`pointer-events-auto border rounded-2xl @min-[420px]:rounded-full max-w-full px-1.5 py-1 flex flex-wrap items-center justify-center gap-0.5 shadow-sm ${SURFACE}`}
        role="toolbar"
        aria-label="Annotation tools"
      >
        {/* Pen toggle (active when not erasing) */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => {
                if (erasing) onEraserToggle()
              }}
              className={`h-8 w-8 rounded-full flex items-center justify-center transition-colors ${
                !erasing ? ACTIVE_BG : `${SUBTLE} ${HOVER}`
              }`}
              aria-pressed={!erasing}
              aria-label="Pen"
            >
              <Pen className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Pen</TooltipContent>
        </Tooltip>

        {/* Color swatches */}
        <div className={`flex items-center gap-1.5 px-1.5 border-l ml-1 pl-2.5 ${DIVIDER}`}>
          {COLORS.map((c) => {
            const active = color === c && !erasing
            return (
              <Tooltip key={c}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => {
                      onColorChange(c)
                      if (erasing) onEraserToggle()
                    }}
                    className={`relative h-6 w-6 rounded-full transition-transform hover:scale-110 active:scale-95 ${
                      active ? `ring-2 ${RING} ring-offset-2 ${RING_OFFSET}` : ''
                    }`}
                    style={{ backgroundColor: COLOR_CSS[c] }}
                    aria-label={COLOR_LABEL[c]}
                    aria-pressed={active}
                  />
                </TooltipTrigger>
                <TooltipContent side="top">{COLOR_LABEL[c]}</TooltipContent>
              </Tooltip>
            )
          })}
        </div>

        {/* Width */}
        <div className={`flex items-center gap-0.5 border-l pl-2 ${DIVIDER}`}>
          {WIDTHS.map((w) => {
            const active = width === w
            return (
              <Tooltip key={w}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onWidthChange(w)}
                    className={`flex items-center justify-center w-8 h-8 rounded-full transition-colors ${
                      active ? WIDTH_BG : HOVER_SOFT
                    }`}
                    aria-label={`${WIDTH_LABEL[w]} stroke`}
                    aria-pressed={active}
                  >
                    <span
                      className={`rounded-full ${WIDTH_DOT}`}
                      style={{ width: w + 1, height: w + 1 }}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{WIDTH_LABEL[w]} stroke</TooltipContent>
              </Tooltip>
            )
          })}
        </div>

        {/* Eraser + Clear */}
        <div className={`flex items-center gap-0.5 border-l pl-2 ml-0.5 ${DIVIDER}`}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onEraserToggle}
                className={`h-8 w-8 rounded-full flex items-center justify-center transition-colors ${
                  erasing ? ACTIVE_BG : `${SUBTLE} ${HOVER}`
                }`}
                aria-pressed={erasing}
                aria-label="Eraser"
              >
                <Eraser className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Eraser</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onClear}
                className={`h-8 w-8 rounded-full flex items-center justify-center transition-colors ${SUBTLE} ${HOVER}`}
                aria-label="Clear all annotations"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Clear all annotations</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  )
}
