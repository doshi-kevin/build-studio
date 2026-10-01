'use client'

// Hero — clean white opening: serif statement + CTAs, nothing else on
// desktop. The intro film (DeskFilm) pins directly below and ends by
// resolving the real student dashboard out of its blue finale, so the
// product reveal belongs to the film, not the hero.
//
// Mobile / prefers-reduced-motion never load the film, so THIS component
// shows the static dashboard screenshot below the text instead.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { ArrowRight } from 'lucide-react'
import { motion, useReducedMotion, type Variants } from 'framer-motion'

const rise: Variants = {
  hidden: { opacity: 0, y: 18, filter: 'blur(8px)' },
  visible: (i: number = 0) => ({
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { duration: 0.7, delay: i * 0.1, ease: [0.16, 1, 0.3, 1] },
  }),
}

export function LandingHero() {
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
  // When the film plays (desktop + motion), the dashboard reveal happens there.
  const film = desktop && !reduce

  return (
    <section className={`relative px-6 pt-36 ${film ? 'pb-24 lg:min-h-[82vh] flex flex-col justify-center' : 'pb-10'}`}>
      <div className="relative z-10 max-w-[880px] mx-auto text-center">
        <motion.h1
          initial="hidden"
          animate="visible"
          variants={rise}
          className="font-serif text-[clamp(40px,6.5vw,80px)] font-normal tracking-[-0.025em] leading-[1.04] text-foreground [text-wrap:balance]"
        >
          Your entire course.
          <br />
          <em className="italic text-primary">One coherent platform.</em>
        </motion.h1>

        <motion.p
          initial="hidden"
          animate="visible"
          custom={1}
          variants={rise}
          className="mt-6 text-[16px] sm:text-[18px] text-muted-foreground leading-relaxed max-w-[560px] mx-auto [text-wrap:pretty]"
        >
          Courses, quizzes, live sessions, analytics, and an AI that teaches
          instead of telling. One fast system everyone actually enjoys.
        </motion.p>

        <motion.div
          initial="hidden"
          animate="visible"
          custom={2}
          variants={rise}
          className="flex flex-col sm:flex-row items-center justify-center gap-3.5 mt-9"
        >
          <Link
            href="/signup"
            className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring group inline-flex items-center justify-center gap-2.5 px-7 py-3.5 rounded-full bg-primary text-primary-foreground text-[15px] font-semibold shadow-lg shadow-primary/20 transition-[background-color,transform,box-shadow] duration-200 hover:bg-primary/90 active:scale-[0.97]"
          >
            Get started free
            <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          </Link>
          <a
            href="#tour"
            className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring inline-flex items-center justify-center px-7 py-3.5 rounded-full border border-border bg-card text-foreground text-[15px] font-semibold transition-[background-color,transform] duration-200 hover:bg-accent active:scale-[0.97]"
          >
            See how it works
          </a>
        </motion.div>
      </div>

      {/* Static product shot for surfaces that never load the film */}
      {!film && (
        <motion.div
          initial="hidden"
          animate="visible"
          custom={3}
          variants={rise}
          className="relative max-w-[1060px] mx-auto mt-12 sm:mt-14"
        >
          <div
            aria-hidden
            className="absolute left-1/2 top-6 -translate-x-1/2 w-[82%] h-[76%] bg-primary/15 blur-[110px] rounded-full pointer-events-none"
          />
          <div className="relative rounded-2xl border border-border bg-card shadow-2xl shadow-primary/15 overflow-hidden">
            <Image
              src="/landing/student-dashboard.png"
              alt="The Scholera student dashboard: courses, to-dos, and grades in one view"
              width={1440}
              height={900}
              priority
              quality={90}
              sizes="96vw"
              className="w-full h-auto"
            />
          </div>
        </motion.div>
      )}
    </section>
  )
}
