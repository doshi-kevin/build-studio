'use client'

// Outro — the closing film, scrubbed by scroll (desktop + motion-allowed
// only). It opens on the same pure cobalt blue as the CTA drench section
// directly above it, so the section boundary is invisible; scrolling pulls
// the camera back out of the screen, the laptop lid closes on its own, and
// the story ends on a tidy desk in warm evening light, right before the
// footer. Mobile / reduced-motion render nothing (CTA flows straight to
// the footer). Encoded all-intra for frame-exact seeking.

import { useEffect, useRef, useState } from 'react'
import { motion, useMotionValueEvent, useReducedMotion, useScroll, useTransform } from 'framer-motion'

// Served from Supabase Storage (public landing-assets bucket); see DeskFilm.
const FILM_SRC =
  'https://ywdqaoahfmmzcsczxvxn.supabase.co/storage/v1/object/public/landing-assets/outro-film.mp4'

const FILM_START = 0.05
const FILM_END = 0.92

export function OutroFilm() {
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

  useMotionValueEvent(scrollYProgress, 'change', (p) => {
    const v = videoRef.current
    if (!film || !v || !v.duration) return
    const t = Math.min(Math.max((p - FILM_START) / (FILM_END - FILM_START), 0), 1)
    v.currentTime = t * v.duration
  })

  // Bridges the flat --primary of the CTA section above into the footage's
  // lighter blue, then dissolves as the camera pulls back from the screen.
  // Function-form transform (not keyframes) per the WAAPI note above.
  const bridgeOpacity = useTransform(scrollYProgress, (p) =>
    p <= 0.06 ? 1 : p >= 0.3 ? 0 : 1 - (p - 0.06) / 0.24
  )

  // Exit: mirrors the intro film's entry — as the lid closes, the footage
  // contracts back into an inset rounded cinema card floating on the page
  // background, so it hands off softly to the footer instead of a hard cut.
  const frameT = (p: number) => (p <= 0.86 ? 0 : p >= 1 ? 1 : (p - 0.86) / 0.14)
  const frameScale = useTransform(scrollYProgress, (p) => 1 - frameT(p) * 0.16)
  const frameClip = useTransform(scrollYProgress, (p) => `inset(0px round ${(28 * frameT(p)).toFixed(1)}px)`)

  return (
    <section ref={stageRef} aria-hidden className={film ? 'relative h-[200vh] bg-primary' : 'hidden'}>
      {film && (
        <div className="sticky top-0 h-screen overflow-hidden bg-background">
          <motion.div style={{ scale: frameScale, clipPath: frameClip }} className="absolute inset-0">
            <video
              ref={videoRef}
              muted
              playsInline
              preload="metadata"
              src={FILM_SRC}
              className="absolute inset-0 h-full w-full object-cover"
            />
            <motion.div
              style={{ opacity: bridgeOpacity }}
              className="absolute inset-x-0 top-0 h-[45vh] bg-gradient-to-b from-primary via-primary/50 to-transparent pointer-events-none"
            />
          </motion.div>
        </div>
      )}
    </section>
  )
}
