'use client'

// Product tour — scrollytelling. On desktop a sticky panel of real product
// screenshots crossfades (opacity + slight scale + blur, GPU-cheap) while the
// narrative steps scroll past on the left; each step's visibility drives the
// active image via useInView. On mobile the panel is hidden and each step
// shows its own screenshot inline. Static-friendly: every element is visible
// by default; motion only enhances.

import { useRef, useState, useEffect } from 'react'
import Image from 'next/image'
import { motion, useInView, useMotionValueEvent, useReducedMotion, useScroll, useTransform } from 'framer-motion'

// ── Snake path geometry (the criss-cross thread between the steps) ─────────
// Numbered nodes alternate left/right of the step column; one continuous
// S-curve sweeps smoothly between them. Geometry is computed in PIXELS from
// the measured column (a stretched viewBox + non-scaling-stroke breaks
// pathLength-normalized dash patterns in Chromium, painting ghost segments).
const STEP_VH = 78
const PAD_VH = 22
const NODE_INSET = 30 // px — node-circle centers sit this far inside the column edges

function nodeY(i: number, count: number, h: number): number {
  return ((i * STEP_VH + STEP_VH / 2) / (count * STEP_VH + PAD_VH)) * h
}

function nodeX(i: number, w: number): number {
  return i % 2 === 1 ? w - NODE_INSET : NODE_INSET
}

// Point on the snake at draw-fraction f (same cubic controls as snakePath,
// so the comet tip rides the carved curve)
function pointAt(f: number, count: number, w: number, h: number): { x: number; y: number } {
  const seg = count - 1
  const k = Math.min(Math.floor(f * seg), seg - 1)
  const t = f * seg - k
  const x0 = nodeX(k, w)
  const x1 = nodeX(k + 1, w)
  const y0 = nodeY(k, count, h)
  const y1 = nodeY(k + 1, count, h)
  const ym = (y0 + y1) / 2
  const u = 1 - t
  const x = u * u * u * x0 + 3 * u * u * t * x0 + 3 * u * t * t * x1 + t * t * t * x1
  const y = u * u * u * y0 + 3 * u * u * t * ym + 3 * u * t * t * ym + t * t * t * y1
  return { x, y }
}

function snakePath(count: number, w: number, h: number): string {
  let d = `M ${nodeX(0, w)} ${nodeY(0, count, h).toFixed(1)}`
  for (let i = 1; i < count; i++) {
    const ym = ((nodeY(i - 1, count, h) + nodeY(i, count, h)) / 2).toFixed(1)
    d += ` C ${nodeX(i - 1, w)} ${ym}, ${nodeX(i, w)} ${ym}, ${nodeX(i, w)} ${nodeY(i, count, h).toFixed(1)}`
  }
  return d
}

const STEPS = [
  {
    id: 'roadmap',
    img: '/landing/roadmap.png',
    alt: 'Course roadmap: an interactive map of modules, lectures, and topics with completion states',
    title: 'See the whole course as a map',
    body: 'Interactive roadmaps connect every module, lecture, and topic, so students always know where they are and what comes next.',
  },
  {
    id: 'quizzes',
    img: '/landing/quizzes.png',
    alt: 'Quiz manager: published quizzes with question counts, pass thresholds, and submissions',
    title: 'Assessments that run themselves',
    body: 'Reusable question banks, AI-assisted question writing, and automatic grading no student can tamper with. Publish a quiz in minutes and move on.',
  },
  {
    id: 'live',
    img: '/landing/live-classroom.png',
    alt: 'Live classroom: a live slide session with recent sessions and attendance',
    title: 'Lectures students take part in',
    body: 'Present slides in real time while students follow along on their own devices, with polls, quizzes, and attendance built in.',
  },
  {
    id: 'ai',
    img: '/landing/ai-tutor.png',
    alt: 'AI study guide walking a student through course topics with references to specific lecture pages',
    title: 'AI help that teaches, not tells',
    body: 'Instead of handing over answers, Scholera guides students through the reasoning step by step, grounded in your actual lecture materials with page-level citations.',
  },
]

function TourStep({
  index,
  title,
  body,
  img,
  alt,
  active,
  reached,
  onActive,
}: {
  index: number
  title: string
  body: string
  img: string
  alt: string
  active: boolean
  reached: boolean
  onActive: (i: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { margin: '-45% 0px -45% 0px' })

  useEffect(() => {
    if (inView) onActive(index)
  }, [inView, index, onActive])

  return (
    <div ref={ref} className="relative lg:min-h-[78vh] flex flex-col justify-center py-12 lg:py-0">
      {/* Numbered path node — alternates sides; ignites when the carve
          reaches it, and glows while its step holds the stage */}
      <span
        aria-hidden
        className={`hidden lg:flex items-center justify-center absolute top-1/2 -translate-y-1/2 w-7 h-7 rounded-full border-2 text-[12px] font-semibold transition-[background-color,border-color,color,box-shadow,transform] duration-300 ${
          index % 2 === 1 ? '-right-10' : '-left-10'
        } ${
          reached
            ? 'bg-primary border-primary text-primary-foreground'
            : 'bg-background border-border text-muted-foreground'
        } ${active && reached ? 'shadow-[0_0_14px_2px] shadow-primary/40 scale-110' : ''}`}
      >
        {index + 1}
      </span>
      <motion.div
        animate={{ opacity: active ? 1 : 0.45 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        // Desktop dims inactive steps; on mobile every step stays fully opaque.
        className="max-lg:!opacity-100"
      >
        <h3 className="font-serif text-[28px] sm:text-[34px] font-normal tracking-tight leading-snug text-foreground [text-wrap:balance]">
          {title}
        </h3>
        <p className="mt-4 text-[16px] text-muted-foreground leading-relaxed max-w-[46ch]">{body}</p>
      </motion.div>

      {/* Inline screenshot for small screens */}
      <div className="lg:hidden mt-8 rounded-xl border border-border overflow-hidden shadow-lg shadow-primary/5">
        <Image src={img} alt={alt} width={1440} height={900} sizes="96vw" className="w-full h-auto" />
      </div>
    </div>
  )
}

export function ProductTour() {
  const [active, setActive] = useState(0)
  const reduce = useReducedMotion()

  // The thread carves itself from node 1 → 2 → 3 → 4, synced to the steps:
  // scroll progress is piecewise-remapped so the tip ARRIVES at node i exactly
  // when step i centers in the viewport (with offset 'start/end center', a
  // step's center crosses the viewport center at p = nodeY/100). Function-form
  // transforms keep everything on the JS thread (see WAAPI note elsewhere).
  const stepsRef = useRef<HTMLDivElement>(null)
  const { scrollYProgress: pathProgress } = useScroll({
    target: stepsRef,
    offset: ['start center', 'end center'],
  })
  const SEG = STEPS.length - 1
  const carve = (p: number) => {
    const pts = STEPS.map((_, i) => nodeY(i, STEPS.length, 1))
    if (p <= pts[0]) return 0
    for (let i = 0; i < SEG; i++) {
      if (p <= pts[i + 1]) return (i + (p - pts[i]) / (pts[i + 1] - pts[i])) / SEG
    }
    return 1
  }
  const carveProgress = useTransform(pathProgress, carve)
  // Exact visible window [0, f] via dasharray (dashoffset wraps the pattern
  // and paints ghost segments ahead of the comet; this can't).
  const pathDash = useTransform(carveProgress, (f) => `${Math.max(f, 0.0001)} 1`)
  // The column is measured so the path lives in pixel space (see geometry note)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = stepsRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // The comet riding the tip of the carve
  const cometPoint = useTransform(carveProgress, (f) => pointAt(f, STEPS.length, size.w, size.h))
  const cometLeft = useTransform(cometPoint, (pt) => `${pt.x}px`)
  const cometTop = useTransform(cometPoint, (pt) => `${pt.y}px`)
  const cometOpacity = useTransform(carveProgress, (f) => (f <= 0.005 || f >= 0.995 ? 0 : 1))
  // Nodes ignite as the carve reaches them (not on a separate trigger)
  const [reached, setReached] = useState(0)
  useMotionValueEvent(carveProgress, 'change', (f) => {
    const r = Math.min(SEG, Math.floor(f * SEG + 0.02))
    setReached((prev) => (prev === r ? prev : r))
  })

  return (
    <section id="tour" className="scroll-mt-20 px-6 py-28 sm:py-36">
      <div className="max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="max-w-2xl"
        >
          <h2 className="font-serif text-[clamp(34px,4.5vw,56px)] font-normal tracking-tight leading-[1.08] text-foreground [text-wrap:balance]">
            Four tools your LMS bolts on.
            <br />
            <em className="italic text-muted-foreground">Scholera builds them in.</em>
          </h2>
        </motion.div>

        <div className="lg:grid lg:grid-cols-5 lg:gap-12 mt-6 lg:mt-2">
          {/* Narrative steps. The bottom padding extends the column so the
              sticky panel stays alongside the last step instead of exiting
              before its text passes center. */}
          <div ref={stepsRef} className="relative lg:col-span-2 lg:px-14 lg:pb-[22vh]">
            {/* The criss-cross thread: no track ahead — the path exists only
                where the comet has already carved it. */}
            {size.w > 0 && (
              <svg
                aria-hidden
                className="hidden lg:block absolute inset-0 w-full h-full"
                viewBox={`0 0 ${size.w} ${size.h}`}
                fill="none"
              >
                <motion.path
                  d={snakePath(STEPS.length, size.w, size.h)}
                  pathLength={1}
                  style={reduce ? undefined : { strokeDasharray: pathDash }}
                  className="stroke-primary"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            )}
            {/* The comet riding the carve's tip */}
            {!reduce && (
              <motion.span
                aria-hidden
                style={{ left: cometLeft, top: cometTop, opacity: cometOpacity }}
                className="hidden lg:block absolute w-2.5 h-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow-[0_0_16px_5px] shadow-primary/50 pointer-events-none"
              />
            )}
            {STEPS.map((step, i) => (
              <TourStep
                key={step.id}
                index={i}
                title={step.title}
                body={step.body}
                img={step.img}
                alt={step.alt}
                active={active === i}
                reached={i <= reached}
                onActive={setActive}
              />
            ))}
          </div>

          {/* Sticky screenshot panel (desktop) */}
          <div className="hidden lg:block lg:col-span-3">
            <div className="sticky top-0 h-screen flex items-center">
              <div className="relative w-full aspect-[16/10] rounded-2xl border border-border bg-card shadow-2xl shadow-primary/10 overflow-hidden">
                {STEPS.map((step, i) => (
                  <motion.div
                    key={step.id}
                    initial={false}
                    animate={{
                      opacity: active === i ? 1 : 0,
                      scale: active === i ? 1 : 0.985,
                      filter: active === i ? 'blur(0px)' : 'blur(6px)',
                    }}
                    transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                    className="absolute inset-0"
                    aria-hidden={active !== i}
                  >
                    <Image
                      src={step.img}
                      alt={step.alt}
                      fill
                      sizes="(max-width: 1024px) 0px, 45vw"
                      className="object-cover object-top"
                    />
                  </motion.div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
