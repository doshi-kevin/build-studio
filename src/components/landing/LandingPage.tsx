'use client'

// Scholera landing page — "Modern Clean, amplified".
// Real product screenshots are the imagery (public/landing/*). Sections:
// Nav, Hero (+claim strip), Product tour (scrollytelling), Why switch,
// Roles bento, Security strip, FAQ, Final CTA (blue drench), Footer.
// All motion is framer-motion, transform/opacity only; MotionConfig
// honors prefers-reduced-motion globally.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { MotionConfig, useMotionValueEvent, useReducedMotion, useScroll } from 'framer-motion'
import { BrandMark } from '@/components/shared/BrandMark'
import { DeskFilm } from './DeskFilm'
import { LandingHero } from './LandingHero'
import { OutroFilm } from './OutroFilm'
import { ProductTour } from './ProductTour'
import { WhySwitch, RolesBento, SecurityStrip, LandingFaq, FinalCta } from './LandingSections'

function LandingNav() {
  const [scrolled, setScrolled] = useState(false)
  const { scrollY } = useScroll()
  useMotionValueEvent(scrollY, 'change', (latest) => setScrolled(latest > 16))
  // 'change' never fires for a page restored mid-scroll; sync once on mount.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (window.scrollY > 16) setScrolled(true)
  }, [])

  return (
    <nav
      className={`fixed top-0 inset-x-0 z-40 border-b transition-colors duration-300 ${
        scrolled ? 'bg-background/85 backdrop-blur-md border-border' : 'bg-transparent border-transparent'
      }`}
    >
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/" className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-full flex items-center gap-2.5 transition-opacity hover:opacity-75">
          <BrandMark className="h-7 w-7" />
          <span className="font-serif text-[22px] tracking-tight text-foreground">
            Schol<em className="italic">era</em>
          </span>
        </Link>

        <div className="flex items-center gap-3 sm:gap-7">
          <div className="hidden md:flex items-center gap-7">
            <a href="#tour" className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-full text-sm text-muted-foreground font-medium hover:text-foreground transition-colors">Product</a>
            <a href="#why" className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-full text-sm text-muted-foreground font-medium hover:text-foreground transition-colors">Why Scholera</a>
            <a href="#faq" className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-full text-sm text-muted-foreground font-medium hover:text-foreground transition-colors">FAQ</a>
          </div>
          <div className="hidden md:block w-px h-4 bg-border" />
          <Link href="/login" className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-full max-[400px]:hidden text-sm text-muted-foreground font-medium hover:text-foreground transition-colors">
            Log in
          </Link>
          <Link
            href="/signup"
            className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring px-4 sm:px-5 py-2 rounded-full bg-primary text-primary-foreground text-sm font-semibold transition-[background-color,transform] duration-200 hover:bg-primary/90 active:scale-[0.97]"
          >
            Get started free
          </Link>
        </div>
      </div>
    </nav>
  )
}

function LandingFooter() {
  return (
    <footer className="border-t border-border py-14 px-6 bg-background">
      <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-8">
        <div className="flex items-center gap-2.5">
          <BrandMark className="h-7 w-7" />
          <span className="font-serif text-[24px] tracking-tight text-foreground">
            Schol<em className="italic">era</em>
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-7">
          {/* Terms and Privacy are deliberately absent rather than linked: both routes 404'd,
              and a placeholder policy is worse than none. Restore these links in the same
              change that adds the real documents. */}
          <Link href="/contact" className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-full text-sm text-muted-foreground font-medium hover:text-foreground transition-colors">Contact</Link>
          <a href="https://scholera-inc.com" target="_blank" rel="noopener noreferrer" className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-full text-sm text-muted-foreground font-medium hover:text-foreground transition-colors">Company</a>
        </div>
        <div className="text-[13px] text-muted-foreground">&copy; {new Date().getFullYear()} Scholera Inc.</div>
      </div>
    </footer>
  )
}

export default function LandingPage() {
  const reduceMotion = useReducedMotion()

  // Smooth in-page anchor scrolling (nav links), unless the user prefers reduced motion.
  useEffect(() => {
    if (reduceMotion) return
    document.documentElement.style.scrollBehavior = 'smooth'
    return () => {
      document.documentElement.style.scrollBehavior = ''
    }
  }, [reduceMotion])

  return (
    <MotionConfig reducedMotion="user">
      {/* overflow-x-clip (not -hidden): hidden would make this a scroll
          container and silently break the tour's position:sticky panel. */}
      <div className="min-h-screen bg-background text-foreground overflow-x-clip selection:bg-primary selection:text-primary-foreground">
        <LandingNav />
        <main>
          <LandingHero />
          <DeskFilm />
          {/* Honest claim strip — between the reveal and the tour */}
          <p className="relative max-w-3xl mx-auto text-center text-[15px] text-muted-foreground px-6 pt-12 pb-2 lg:pt-16">
            Launching across the United States in July 2026, built for{' '}
            <span className="text-foreground font-medium">30,000+ students</span>.
          </p>
          <ProductTour />
          <WhySwitch />
          <RolesBento />
          <SecurityStrip />
          <LandingFaq />
          <FinalCta />
          <OutroFilm />
        </main>
        <LandingFooter />
      </div>
    </MotionConfig>
  )
}
