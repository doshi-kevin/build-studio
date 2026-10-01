/**
 * Coverage pieces for the unified "Tracked skills" view: the per-skill coverage
 * badges (which quizzes assess / lectures teach each), the class-mastery dot,
 * and the read-only coverage matrix (gap audit). The editable skill list
 * (SkillsManager) composes the badges + dot per row; the matrix is an alternate
 * read-only mode. Clicking a skill opens the shared ConceptDetail modal.
 *
 * Skinned in the roadmap drawer's design language (roadmap-prototype.css §17):
 * badges wear the node kinds' own hues (quiz indigo, assignment orange, live
 * red, lecture sky), matrix cells tint by count.
 *
 * Type: Client Component.
 */
'use client'

import { ListChecks, FileText, ClipboardList, Radio, Layers, TrendingUp, TrendingDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SkillIndexNode } from '@/lib/skills/index-view'
import { MASTERY_THRESHOLDS, scoreLabel } from '@/lib/skills/mastery'

/**
 * The three tones this view scores with — strong / mid / weak — plus "nothing to
 * score". Held as the semantic tokens, not hexes: `globals.css` exists so a
 * contrast retune lands in one place, and a literal here would sit outside it.
 * The canvas paints the same tiers from its own `--c-*` kind hues; these are the
 * scoring scale, which is a different axis and follows the global tokens.
 */
const TONE = {
  strong: 'var(--success)',
  mid: 'var(--warning)',
  weak: 'var(--destructive)',
  /** Lightened so an unscored row stays quieter than a scored one — the token
   *  at full strength reads as louder than the red it sits beside. */
  none: 'color-mix(in oklab, var(--muted-foreground) 50%, var(--card))',
} as const

/** The readable ink for text sitting ON a tone's tint — the pairing
 *  `globals.css` ships for exactly this. Mixing the tint's own hue up to text
 *  strength can't reach AA on amber at 10.5px/700, so the matrix takes its
 *  colour from here rather than from `--cc`. */
const TONE_INK = {
  strong: 'var(--success-muted-foreground)',
  mid: 'var(--warning-muted-foreground)',
  weak: 'var(--destructive-muted-foreground)',
} as const

/**
 * Which way a skill is moving, next to how high it is.
 *
 * A class sitting at 70% that climbed there from 50% and one that slid there
 * from 90% are the same number and completely different situations, and level
 * alone cannot tell them apart. Renders nothing below a 1-point change, so a
 * dashboard is not littered with noise that means nothing.
 */
export function MasteryDelta({ delta }: { delta: number | null | undefined }) {
  if (delta == null || Math.abs(delta) < 1) return null
  const up = delta > 0
  return (
    <span
      className="tsdelta"
      style={{ '--t': up ? TONE.strong : TONE.weak } as React.CSSProperties}
      title={`${up ? 'Up' : 'Down'} ${Math.abs(delta)} points since the start of this stretch`}
      aria-label={`${up ? 'Up' : 'Down'} ${Math.abs(delta)} points.`}
    >
      {up ? <TrendingUp aria-hidden /> : <TrendingDown aria-hidden />}
      {up ? '+' : '−'}{Math.abs(delta)}
    </span>
  )
}

/**
 * The class mastery number itself, beside the colour cue.
 *
 * The dot alone could not carry it. It is `aria-hidden`, it is not focusable, it
 * has no hover on touch, and — the part that matters — two values inside the same
 * tier band render an IDENTICAL colour. So 69% and 72% on two different skills
 * were pixel-identical dots, and the per-skill differences the engine computes
 * were unreachable without a mouse. Tabular figures so a column of them lines up.
 */
export function MasteryValue({ pct }: { pct: number | null }) {
  /* Coloured by tier, which is what the separate dot used to carry. One element
     now gives both readings: the exact value (which a dot never could) and the
     band at a glance (which a bare number doesn't). The dot alongside it was
     redundant — same fact, character-identical tooltip — and two variable-width
     items before the name made its left edge jitter by up to ~57px per row.

     TONE_INK, not TONE: the tint's own hue at text strength cannot reach AA on
     amber at this size, which is why this file keeps a separate ink palette.
     A fixed min-width right-aligns "—" / "8%" / "100%" into one column so the
     name starts at the same x on every row. */
  const tone = pct === null ? 'none' : pct >= MASTERY_THRESHOLDS.strong ? 'strong' : pct >= MASTERY_THRESHOLDS.shaky ? 'mid' : 'weak'
  return (
    <span
      className="tsval"
      style={tone === 'none' ? undefined : ({ '--t': TONE_INK[tone] } as React.CSSProperties)}
      title={pct !== null ? `${pct}% class mastery` : 'Not assessed yet'}
      /* dnd-kit makes the whole row a tab stop, and a row's accessible name is its
         concatenated text — so without these the value, the trend and the coverage
         counts ran together as "72%+12Integrated rate laws7602". */
      aria-label={pct !== null ? `Class mastery ${pct} percent.` : 'Not assessed yet.'}
    >
      {scoreLabel(pct)}
    </span>
  )
}

export function CoverageBadges({ node }: { node: SkillIndexNode }) {
  const q = node.coverage.quizzes.length
  const l = node.coverage.lectures.length
  const a = node.coverage.assignments.length
  const v = node.coverage.live.length
  return (
    <>
      <Badge icon={<ListChecks aria-hidden />} n={q} hue="var(--c-quiz)" title={`${q} quiz/exam${q === 1 ? '' : 's'} assess this`} />
      <Badge icon={<ClipboardList aria-hidden />} n={a} hue="var(--c-assignment)" title={`${a} assignment${a === 1 ? '' : 's'} assess this`} />
      <Badge icon={<Radio aria-hidden />} n={v} hue="var(--c-live)" title={`${v} live quiz${v === 1 ? '' : 'zes'} assess this`} />
      <Badge icon={<FileText aria-hidden />} n={l} hue="var(--c-lecture)" title={`${l} lecture${l === 1 ? '' : 's'} teach this`} />
    </>
  )
}

function Badge({ icon, n, hue, title }: { icon: React.ReactNode; n: number; hue: string; title: string }) {
  return (
    <span title={title} className={n === 0 ? 'z' : undefined} style={{ '--bc': hue } as React.CSSProperties}>
      {icon}{n}
    </span>
  )
}

/** Count → the matrix cell's tone: none weak, thin mid, covered strong. */
const cellTone = (n: number): keyof typeof TONE_INK => (n === 0 ? 'weak' : n === 1 ? 'mid' : 'strong')

/** Read-only coverage matrix — the gap audit. Rows are pre-sorted by the caller. */
export function CoverageMatrix({ nodes, onOpen }: { nodes: SkillIndexNode[]; onOpen: (name: string) => void }) {
  const cell = (n: number) => {
    const t = cellTone(n)
    return { '--cc': TONE[t], '--cf': TONE_INK[t] } as React.CSSProperties
  }
  return (
    <div className="tsmatrix">
      <div className="tsmin">
        <div className="tsmxhead">
          <span className="cskill">Skill</span>
          <span className="cnum">Quizzes</span>
          <span className="cnum">Assign.</span>
          <span className="cnum">Live</span>
          <span className="cnum">Lectures</span>
        </div>
        {/* The matrix is the full skill index — hundreds of rows on a well-covered
            section. content-visibility lets the browser skip layout+paint for the
            rows out of view; they stay in the DOM, so find-in-page and the
            accessibility tree are unaffected (no virtualization needed at this
            size, and there's no drag here to fight with). */}
        {nodes.map((n) => (
          <button key={n.id} type="button" onClick={() => onOpen(n.name)} className="tsmxrow [contain-intrinsic-size:auto_30px] [content-visibility:auto]">
            <span className={cn('cskill', n.parentId && 'sub')}>
              {n.parentId && <Layers aria-hidden />}
              <span className="nm">{n.name}</span>
            </span>
            <b className="cnum" style={cell(n.coverage.quizzes.length)}>{n.coverage.quizzes.length}</b>
            <b className="cnum" style={cell(n.coverage.assignments.length)}>{n.coverage.assignments.length}</b>
            <b className="cnum" style={cell(n.coverage.live.length)}>{n.coverage.live.length}</b>
            <b className="cnum" style={cell(n.coverage.lectures.length)}>{n.coverage.lectures.length}</b>
          </button>
        ))}
      </div>
    </div>
  )
}
