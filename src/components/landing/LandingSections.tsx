'use client'

// Mid-page sections: Why switch (typographic statement), Roles bento
// (asymmetric, real screenshot tiles), Security strip, FAQ accordion,
// and the Final CTA blue drench.

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { ArrowRight, ChevronDown } from 'lucide-react'
import { motion, type Variants } from 'framer-motion'

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 18 },
  visible: (i: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] },
  }),
}

/* ── Why switch ─────────────────────────────────────────────────────────── */

const PROOFS = [
  {
    lead: 'Live in 10 minutes.',
    rest: 'Create a course, invite students, and teach the same day. No IT tickets, no onboarding calls.',
  },
  {
    lead: 'One login, everything inside.',
    rest: 'Courses, grades, live sessions, and AI guidance all live in one place, with nothing to stitch together.',
  },
  {
    lead: 'Fast enough to forget about.',
    rest: 'No spinners, no page reloads between tools. It feels like an app, not a portal.',
  },
]

export function WhySwitch() {
  return (
    <section id="why" className="scroll-mt-20 px-6 py-28 sm:py-36 bg-secondary/60 border-y border-border">
      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount: 0.3 }}
        variants={fadeUp}
        className="max-w-3xl mx-auto"
      >
        <h2 className="font-serif text-[clamp(34px,4.5vw,56px)] font-normal tracking-tight leading-[1.08] text-foreground [text-wrap:balance]">
          Legacy systems weren&apos;t <em className="italic text-muted-foreground">built for this.</em>
        </h2>
        <p className="mt-6 text-[17px] text-muted-foreground leading-relaxed max-w-[62ch] [text-wrap:pretty]">
          Most platforms in higher education bolt new features onto decade-old foundations.
          Scholera was built from scratch as one system, so everything simply works
          together: one login, one place, one experience for everyone on campus.
        </p>

        <div className="mt-12">
          {PROOFS.map((item, i) => (
            <motion.div
              key={item.lead}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, amount: 0.6 }}
              custom={i}
              variants={fadeUp}
              className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4 py-6 border-t border-border first:border-t-0"
            >
              <span className="font-serif text-[22px] text-foreground shrink-0 sm:w-[290px]">{item.lead}</span>
              <span className="text-[15.5px] text-muted-foreground leading-relaxed">{item.rest}</span>
            </motion.div>
          ))}
        </div>
      </motion.div>
    </section>
  )
}

/* ── Roles bento ────────────────────────────────────────────────────────── */

export function RolesBento() {
  return (
    <section className="px-6 py-28 sm:py-36">
      <div className="max-w-6xl mx-auto">
        <motion.h2
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.5 }}
          variants={fadeUp}
          className="font-serif text-[clamp(34px,4.5vw,56px)] font-normal tracking-tight leading-[1.08] text-foreground [text-wrap:balance] max-w-2xl"
        >
          Every role gets <em className="italic text-muted-foreground">a real home.</em>
        </motion.h2>

        <div className="grid lg:grid-cols-5 gap-5 mt-12">
          {/* Professors — large tile with dashboard screenshot */}
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.25 }}
            variants={fadeUp}
            className="group lg:col-span-3 rounded-3xl border border-border bg-card overflow-hidden flex flex-col"
          >
            <div className="p-8 pb-6">
              <h3 className="font-serif text-[26px] text-foreground">Professors</h3>
              <p className="mt-2 text-[15px] text-muted-foreground leading-relaxed max-w-[52ch]">
                A dashboard that surfaces what needs attention: ungraded work, dropping quiz
                averages, enrollment caps. Build courses, run live sessions, and grade without
                leaving one screen.
              </p>
            </div>
            <div className="relative flex-1 min-h-[260px] ml-8 rounded-tl-xl border-t border-l border-border overflow-hidden">
              <Image
                src="/landing/professor-dashboard.png"
                alt="Professor dashboard with to-dos, quick actions, and course metrics"
                fill
                sizes="(max-width: 1024px) 96vw, 58vw"
                className="object-cover object-left-top transition-transform duration-500 ease-out group-hover:scale-[1.015]"
              />
            </div>
          </motion.div>

          {/* Students — tile with student dashboard screenshot */}
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.25 }}
            custom={1}
            variants={fadeUp}
            className="group lg:col-span-2 rounded-3xl border border-border bg-card overflow-hidden flex flex-col"
          >
            <div className="p-8 pb-6">
              <h3 className="font-serif text-[26px] text-foreground">Students</h3>
              <p className="mt-2 text-[15px] text-muted-foreground leading-relaxed">
                Every deadline, quiz, and announcement in one feed. Auto-saving attempts,
                visual progress, and AI help that teaches, not tells.
              </p>
            </div>
            <div className="relative flex-1 min-h-[260px] ml-8 rounded-tl-xl border-t border-l border-border overflow-hidden">
              <Image
                src="/landing/student-dashboard.png"
                alt="Student dashboard with prioritized to-dos and enrolled courses"
                fill
                sizes="(max-width: 1024px) 96vw, 38vw"
                className="object-cover object-left-top transition-transform duration-500 ease-out group-hover:scale-[1.015]"
              />
            </div>
          </motion.div>

          {/* Administrators — wide tinted text tile */}
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.4 }}
            custom={2}
            variants={fadeUp}
            className="lg:col-span-5 rounded-3xl bg-accent border border-border p-8 sm:p-10 flex flex-col lg:flex-row lg:items-center gap-6 lg:gap-14"
          >
            <div className="max-w-md shrink-0">
              <h3 className="font-serif text-[26px] text-accent-foreground">Administrators</h3>
              <p className="mt-2 text-[15px] text-muted-foreground leading-relaxed">
                Run the whole institution from one place, with the audit trail to prove it.
              </p>
            </div>
            <div className="grid sm:grid-cols-3 gap-6 lg:gap-10 flex-1">
              {[
                ['Departments & faculty', 'Manage programs, professors, and staff in one view.'],
                ['One-click enrollment', 'Approve requests and manage caps without spreadsheets.'],
                ['Institution analytics', 'Adoption, outcomes, and activity across every course.'],
              ].map(([t, d]) => (
                <div key={t}>
                  <p className="text-[14.5px] font-semibold text-foreground">{t}</p>
                  <p className="mt-1 text-[14px] text-muted-foreground leading-relaxed">{d}</p>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  )
}

/* ── Security strip ─────────────────────────────────────────────────────── */

const SECURITY = [
  ['Your data stays yours', 'Each institution\'s data is fully isolated, and student data is never shared or sold.'],
  ['Grades no one can game', 'Answers and scoring stay locked away from students\' devices, so results stay honest.'],
  ['A complete paper trail', 'Every grade, submission, and change is recorded, so audits and disputes take minutes, not weeks.'],
  ['The right access for everyone', 'Professors, students, and staff each see exactly what they should, and nothing more.'],
]

export function SecurityStrip() {
  return (
    <section className="px-6 py-20 border-y border-border bg-secondary/60">
      <div className="max-w-6xl mx-auto">
        <motion.p
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.6 }}
          variants={fadeUp}
          className="font-serif text-[24px] text-foreground mb-10"
        >
          Security is the foundation, <em className="italic text-muted-foreground">not a feature.</em>
        </motion.p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-x-10 gap-y-8">
          {SECURITY.map(([title, desc], i) => (
            <motion.div
              key={title}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, amount: 0.6 }}
              custom={i}
              variants={fadeUp}
            >
              <p className="text-[14.5px] font-semibold text-foreground">{title}</p>
              <p className="mt-1.5 text-[14px] text-muted-foreground leading-relaxed">{desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ── FAQ ────────────────────────────────────────────────────────────────── */

const FAQS = [
  {
    q: 'How quickly can we go live?',
    a: 'Most educators publish their first course in under 10 minutes. Sign up, build, and teach the same day. There are no IT tickets or multi-week onboarding programs.',
  },
  {
    q: 'Can we migrate from Canvas, Blackboard, or Moodle?',
    a: 'Yes. Course content, student rosters, and gradebooks can be imported in bulk from the major platforms, and we work directly with your team through the transition.',
  },
  {
    q: 'How is student data protected?',
    a: 'Each institution\'s data is fully isolated and encrypted, both in transit and at rest. Every action is checked against the person\'s role before it happens, and a complete audit log records what changed and who changed it. Student data is never shared or sold.',
  },
  {
    q: 'Does it work on phones and tablets?',
    a: 'Fully. Students take quizzes, join live sessions, and check grades from any device in the browser. There is no separate app to install.',
  },
  {
    q: 'How is Scholera different from other LMS platforms?',
    a: 'Most platforms were assembled from acquisitions and plugins, so each tool feels different and nothing quite connects. Scholera was designed as a single system: courses, assessments, analytics, live sessions, and AI guidance built together and working together, in one experience.',
  },
]

function FaqItem({ index, q, a }: { index: number; q: string; a: string }) {
  const [open, setOpen] = useState(false)
  const buttonId = `faq-q-${index}`
  const panelId = `faq-a-${index}`
  return (
    <div className="border-b border-border">
      <button
        id={buttonId}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={panelId}
        className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring w-full flex items-center justify-between gap-6 py-6 text-left group"
      >
        <span className="font-serif text-[20px] sm:text-[22px] text-foreground transition-colors group-hover:text-primary">
          {q}
        </span>
        <ChevronDown
          aria-hidden
          className={`w-5 h-5 text-muted-foreground shrink-0 transition-transform duration-300 ease-out ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <div
        id={panelId}
        role="region"
        aria-labelledby={buttonId}
        className={`grid transition-[grid-template-rows] duration-300 ease-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
      >
        <div className="overflow-hidden">
          <p className="pb-6 text-[15.5px] text-muted-foreground leading-relaxed max-w-[70ch]">{a}</p>
        </div>
      </div>
    </div>
  )
}

export function LandingFaq() {
  return (
    <section id="faq" className="scroll-mt-20 px-6 py-28 sm:py-36">
      <div className="max-w-3xl mx-auto">
        <motion.h2
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.5 }}
          variants={fadeUp}
          className="font-serif text-[clamp(32px,4vw,48px)] font-normal tracking-tight text-foreground [text-wrap:balance]"
        >
          Questions, <em className="italic text-muted-foreground">answered.</em>
        </motion.h2>
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.15 }}
          custom={1}
          variants={fadeUp}
          className="mt-10 border-t border-border"
        >
          {FAQS.map((faq, i) => (
            <FaqItem key={faq.q} index={i} {...faq} />
          ))}
        </motion.div>
      </div>
    </section>
  )
}

/* ── Final CTA — blue drench ────────────────────────────────────────────── */

export function FinalCta() {
  return (
    <section className="relative text-primary-foreground">
      {/* The drench rises out of the page as a dome (arc divider) */}
      <svg
        aria-hidden
        viewBox="0 0 1440 240"
        preserveAspectRatio="none"
        className="relative block w-full h-[110px] sm:h-[190px] -mb-0.5 text-primary"
      >
        <path d="M0,240 Q720,-160 1440,240 Z" fill="currentColor" />
      </svg>
      <div className="relative -mt-px bg-primary px-6 pb-32 sm:pb-40 overflow-hidden">

      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount: 0.4 }}
        variants={fadeUp}
        className="relative max-w-3xl mx-auto text-center"
      >
        {/* De-emphasis on the drench uses the accent token (a light tint of the
            primary's own hue), not reduced-opacity white (ui-design.md rule). */}
        <h2 className="font-serif text-[clamp(40px,6vw,76px)] font-normal tracking-[-0.02em] leading-[1.05] [text-wrap:balance]">
          Bring Scholera <em className="italic text-accent">to your campus.</em>
        </h2>
        <p className="mt-6 text-[17px] sm:text-[18px] leading-relaxed text-primary-foreground max-w-[46ch] mx-auto">
          Launching July 2026. Get your courses in before the semester does.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3.5 mt-10">
          <Link
            href="/signup"
            className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-foreground group inline-flex items-center justify-center gap-2.5 px-8 py-4 rounded-full bg-primary-foreground text-primary text-[15px] font-semibold shadow-xl transition-transform duration-200 hover:scale-[1.02] active:scale-[0.97]"
          >
            Get started free
            <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          </Link>
          <Link
            href="/contact"
            className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-foreground inline-flex items-center justify-center px-8 py-4 rounded-full border border-primary-foreground/35 text-primary-foreground text-[15px] font-semibold transition-colors duration-200 hover:bg-primary-foreground/10 active:scale-[0.97]"
          >
            Talk to us
          </Link>
        </div>
      </motion.div>
      </div>
    </section>
  )
}
