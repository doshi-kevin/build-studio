// Sleek vertical activity timeline for the live classroom. Shared between
// the professor's and student's sidebars. Renders a chronological log of
// meaningful lifecycle events (poll opened, question asked, class ended,
// etc.) — high-frequency things like slide changes and stroke broadcasts
// are intentionally excluded so the timeline reads as "what happened in
// this class".

'use client'

import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Activity,
  Play,
  Radio,
  Square,
  BarChart3,
  FileQuestion,
  MessageCircle,
  Check,
  PowerOff,
  ChevronDown,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useRoomTimeline, type TimelineEntry } from '@/lib/live-classroom/broadcast/use-timeline'
import type { EventBus } from '@/lib/live-classroom/broadcast/event-bus'
import type { RoomSnapshot } from '@/lib/live-classroom/snapshot'
import { SPRING, SPRING_SNAPPY } from '@/lib/motion'

interface Props {
  bus: EventBus
  snapshot: RoomSnapshot | null
  /** When true, the panel mounts collapsed; user clicks the header to open. */
  defaultCollapsed?: boolean
}

// Tone drives the per-type color so the timeline reads at a glance instead of
// being a wall of grey. All semantic tokens — no raw colors.
type Tone = 'primary' | 'neutral' | 'success' | 'terminal'

const TONE_STYLES: Record<Tone, { chip: string; dotBorder: string; dotBg: string }> = {
  primary: { chip: 'border-primary/30 bg-primary/10 text-primary', dotBorder: 'border-primary', dotBg: 'bg-primary' },
  neutral: { chip: 'border-border bg-muted/40 text-muted-foreground', dotBorder: 'border-border', dotBg: 'bg-muted-foreground/50' },
  success: { chip: 'border-success/30 bg-success-muted text-success-muted-foreground', dotBorder: 'border-success', dotBg: 'bg-success' },
  terminal: { chip: 'border-foreground bg-foreground text-background', dotBorder: 'border-foreground', dotBg: 'bg-foreground' },
}

interface IconConfig {
  Icon: typeof Activity
  tone: Tone
}

const ICON_BY_TYPE: Record<TimelineEntry['type'], IconConfig> = {
  // Radio, not Play: quiz_opened is already Play on the primary tone, so both
  // rendered as the same blue badge and only the label told them apart. The class
  // start is the anchor row of the timeline and has to stay distinguishable.
  class_started: { Icon: Radio, tone: 'primary' },
  poll_created: { Icon: BarChart3, tone: 'neutral' },
  poll_opened: { Icon: Play, tone: 'neutral' },
  poll_closed: { Icon: Square, tone: 'neutral' },
  quiz_created: { Icon: FileQuestion, tone: 'primary' },
  quiz_opened: { Icon: Play, tone: 'primary' },
  quiz_closed: { Icon: Square, tone: 'primary' },
  question_asked: { Icon: MessageCircle, tone: 'neutral' },
  question_answered: { Icon: Check, tone: 'success' },
  class_ended: { Icon: PowerOff, tone: 'terminal' },
}

export function RoomTimeline({ bus, snapshot, defaultCollapsed = false }: Props) {
  const entries = useRoomTimeline({ bus, snapshot })
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  // Tick every 30s so relative timestamps stay fresh without forcing a render
  // on every tiny event.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  const visibleEntries = useMemo(() => entries, [entries])
  const isLive = snapshot?.room.status === 'live'

  return (
    <TooltipProvider delayDuration={250}>
      <section className="rounded-3xl ring-1 ring-border/50 shadow-sm bg-background overflow-hidden">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="w-full flex items-center justify-between px-5 py-4 border-b border-border hover:bg-muted/30 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-expanded={!collapsed}
        >
          <div className="flex items-center gap-2.5">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
              Timeline
            </h3>
            {isLive && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-success-muted px-2 py-0.5 text-xs font-semibold text-success-muted-foreground">
                <span className="lc-live-dot h-1.5 w-1.5 text-success" aria-hidden />
                Live
              </span>
            )}
            {visibleEntries.length > 0 && (
              <Badge variant="secondary" className="h-5 px-1.5 rounded-full text-xs font-semibold tabular-nums">
                {visibleEntries.length}
              </Badge>
            )}
          </div>
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${
              collapsed ? '-rotate-90' : ''
            }`}
          />
        </button>

        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              key="body"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={SPRING}
            >
              <div className="p-4">
                {visibleEntries.length === 0 ? (
                  <div className="flex flex-col items-center text-center py-8 px-4 rounded-2xl border border-dashed border-border bg-muted/10">
                    <div className="rounded-full bg-background border border-border p-3 mb-3">
                      <Activity className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <p className="text-sm font-medium mb-1">Quiet so far</p>
                    <p className="text-xs text-muted-foreground max-w-[260px] leading-relaxed">
                      Polls, quizzes, and questions will appear here in order
                      as the class unfolds.
                    </p>
                  </div>
                ) : (
                  <ol className="relative pl-5">
                    {/* Vertical rail */}
                    <span
                      className="absolute left-[7px] top-1.5 bottom-1.5 w-px bg-border"
                      aria-hidden
                    />
                    <AnimatePresence initial={false}>
                      {visibleEntries.map((entry) => (
                        <TimelineRow key={entry.id} entry={entry} />
                      ))}
                    </AnimatePresence>
                  </ol>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </TooltipProvider>
  )
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  const cfg = ICON_BY_TYPE[entry.type]
  const Icon = cfg.Icon
  const tone = TONE_STYLES[cfg.tone]
  const ts = useMemo(() => formatRelative(entry.timestamp), [entry.timestamp])
  const absolute = useMemo(() => formatAbsolute(entry.timestamp), [entry.timestamp])

  return (
    <motion.li
      layout
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0 }}
      transition={SPRING_SNAPPY}
      className="relative pb-4 last:pb-0"
    >
      {/* Node on the rail — colored by event tone */}
      <span
        className={`absolute -left-[18px] top-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border bg-background ${tone.dotBorder}`}
        aria-hidden
      >
        <span className={`h-1.5 w-1.5 rounded-full ${tone.dotBg}`} />
      </span>

      <div className="flex items-start gap-2.5">
        <div
          className={`shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-xl border ${tone.chip}`}
          aria-hidden
        >
          <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-medium leading-snug truncate">{entry.title}</p>
            <Tooltip>
              <TooltipTrigger asChild>
                <time
                  dateTime={entry.timestamp}
                  className="shrink-0 text-xs uppercase tracking-widest font-semibold text-muted-foreground tabular-nums"
                >
                  {ts}
                </time>
              </TooltipTrigger>
              <TooltipContent side="left">{absolute}</TooltipContent>
            </Tooltip>
          </div>
          {entry.detail && (
            <p className="text-xs text-muted-foreground leading-snug mt-0.5 break-words line-clamp-2">
              {entry.detail}
            </p>
          )}
        </div>
      </div>
    </motion.li>
  )
}

/** "just now" / "5 min ago" / "2 h ago" — kept short for the timeline rail. */
function formatRelative(ts: string): string {
  const then = new Date(ts).getTime()
  const now = Date.now()
  const diffSec = Math.max(0, Math.round((now - then) / 1000))
  if (diffSec < 30) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  return `${diffDay}d ago`
}

function formatAbsolute(ts: string): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return ts
  }
}
