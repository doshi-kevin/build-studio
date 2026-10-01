'use client'

// Desk film — the scroll-scrubbed intro film, pinned directly below the
// hero (desktop + motion-allowed only). The user's scroll drives the
// playhead: a desk drowning in the tools of a messy semester clears itself,
// the camera swings to face the laptop as its lid opens on a glowing blue
// screen, and dives in until pure cobalt fills the frame. Out of that blue,
// the REAL student dashboard resolves (blur + blue wash → sharp, settling
// flat with a sheen sweep) while the film dissolves to the page background;
// the section then releases into the claim strip and product tour.
//
// Mobile / prefers-reduced-motion render nothing here (the hero shows the
// static dashboard instead, and the film's megabytes are never downloaded).
//
// The film is encoded all-intra (every frame a keyframe) so seeking is
// frame-exact. Scrubbed opacities use FUNCTION-form transforms on purpose:
// keyframe-form opacity gets compiled by framer-motion into a native
// ViewTimeline (WAAPI) animation whose progress tracks element visibility,
// not this pinned section — it finishes early inside a sticky stage and
// snaps values back. Function transforms stay on the JS thread.

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import {
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useTransform,
} from 'framer-motion'

// Films are served from Supabase Storage (public landing-assets bucket) so
// multi-megabyte binaries stay out of git; the poster stays in the repo.
const FILM_SRC =
  'https://ywdqaoahfmmzcsczxvxn.supabase.co/storage/v1/object/public/landing-assets/hero-film.mp4'

// Scroll band (of section progress) that maps onto the film's 10 seconds.
const FILM_START = 0.03
const FILM_END = 0.6

const fade = (from: number, to: number, a: number, b: number) => (p: number) =>
  p <= from ? a : p >= to ? b : a + ((p - from) / (to - from)) * (b - a)

export function DeskFilm() {
  const reduce = useReducedMotion()
  const [desktop, setDesktop] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (mq.matches) setDesktop(true)
    const update = () => setDesktop(mq.matches)
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  const film = desktop && !reduce

  const stageRef = useRef<HTMLElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const { scrollYProgress } = useScroll({ target: stageRef, offset: ['start start', 'end end'] })

  // Scroll position IS the playhead; the video never plays on its own.
  useMotionValueEvent(scrollYProgress, 'change', (p) => {
    const v = videoRef.current
    if (!film || !v || !v.duration) return
    const t = Math.min(Math.max((p - FILM_START) / (FILM_END - FILM_START), 0), 1)
    v.currentTime = t * v.duration
  })

  // Film dissolves to the page background once the dashboard has emerged
  const filmOpacity = useTransform(scrollYProgress, fade(0.68, 0.8, 1, 0))

  // Entry: the film begins as an inset, rounded cinema card floating in the
  // hero's white, then expands to swallow the viewport as the pin engages
  // (scale + clip-path round, both GPU-composited — no hard white/footage seam).
  const frameScale = useTransform(scrollYProgress, fade(0, 0.16, 0.84, 1))
  const frameClip = useTransform(scrollYProgress, (p) => {
    const t = fade(0, 0.16, 1, 0)(p) // 1 → 0 as it expands
    return `inset(0px round ${(28 * t).toFixed(1)}px)`
  })

  // The real dashboard resolves out of the film's all-blue ending
  const dashOpacity = useTransform(scrollYProgress, fade(0.58, 0.68, 0, 1))
  const dashBlur = useTransform(scrollYProgress, (p) => `blur(${fade(0.58, 0.74, 16, 0)(p)}px)`)
  const washOpacity = useTransform(scrollYProgress, fade(0.6, 0.76, 0.55, 0))
  const dashRotateX = useTransform(scrollYProgress, [0.6, 0.9], [14, 0])
  const dashScale = useTransform(scrollYProgress, [0.6, 1], [1.05, 1])
  const sheenX = useTransform(scrollYProgress, [0.74, 0.9], ['-130%', '130%'])
  const glowOpacity = useTransform(scrollYProgress, fade(0.6, 0.78, 0, 0.7))

  return (
    <section ref={stageRef} className={film ? 'relative h-[300vh]' : 'hidden'}>
      {film && (
        <div className="sticky top-0 h-screen overflow-hidden">
          {/* The film — an inset cinema card that expands to full-bleed */}
          <motion.div
            aria-hidden
            style={{ opacity: filmOpacity, scale: frameScale, clipPath: frameClip }}
            className="absolute inset-0"
          >
            <video
              ref={videoRef}
              muted
              playsInline
              preload="metadata"
              src={FILM_SRC}
              poster="/landing/hero-film-poster.jpg"
              className="absolute inset-0 h-full w-full object-cover"
            />
          </motion.div>

          {/* The real dashboard, resolving out of the blue */}
          <div className="absolute inset-x-6 top-1/2 -translate-y-1/2 z-10">
            <div className="relative max-w-[1020px] mx-auto">
              <motion.div
                aria-hidden
                style={{ opacity: glowOpacity }}
                className="absolute left-1/2 top-6 -translate-x-1/2 w-[82%] h-[76%] bg-primary/25 blur-[110px] rounded-full pointer-events-none"
              />
              <motion.div
                style={{
                  opacity: dashOpacity,
                  filter: dashBlur,
                  rotateX: dashRotateX,
                  scale: dashScale,
                  transformPerspective: 1300,
                  transformOrigin: 'center bottom',
                }}
                className="relative rounded-2xl border border-border bg-card shadow-2xl shadow-primary/15 overflow-hidden"
              >
                <Image
                  src="/landing/professor-dashboard.png"
                  alt="The Scholera professor dashboard: to-dos, quick actions, and course metrics in one view"
                  width={1440}
                  height={900}
                  quality={90}
                  sizes="(max-width: 1200px) 96vw, 1020px"
                  className="w-full h-auto"
                />
                {/* Blue wash carried over from the film, fading as it sharpens */}
                <motion.div
                  aria-hidden
                  style={{ opacity: washOpacity }}
                  className="absolute inset-0 pointer-events-none bg-primary"
                />
                {/* Sheen sweeping the glass as it settles */}
                <motion.div
                  aria-hidden
                  style={{ x: sheenX }}
                  className="absolute inset-0 pointer-events-none bg-gradient-to-r from-transparent via-primary-foreground/25 to-transparent w-[60%]"
                />
              </motion.div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
