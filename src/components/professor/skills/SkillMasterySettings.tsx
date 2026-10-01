'use client'

/**
 * SkillMasterySettings — the professor's knobs for how mastery is scored
 * (per-section, stored in settings.topicMastery). Research-backed defaults;
 * this lets a course tune them. Wired to updateSkillMasteryConfig.
 *
 * Renders as a card INSIDE the tracked-skills drawer (roadmap-prototype.css
 * §17 .tsset), not a portaled dialog: the old body-portal Dialog stacked at
 * z-50 UNDER the z-61 drawer — its grey overlay covered the whole app while
 * the dialog itself sat behind the drawer. Everything here stays in the
 * drawer's own stacking context (and its design language), so nothing can
 * land behind it. Same reason there are no portaled Select/Popover controls —
 * their dropdowns had the identical bug.
 */

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Check, ChevronDown, Loader2, SlidersHorizontal, X } from 'lucide-react'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'
import { trapTab } from './focus-trap'
import { updateSkillMasteryConfig } from '@/app/(dashboard)/professor/courses/[sectionId]/skills/actions'
import type { SkillMasteryConfig, ClassMetricKind } from '@/lib/skills/config'

const NUM = (v: string, fallback: number) => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

// The scoring math, shown behind a disclosure so it's there for the curious
// without overwhelming a non-technical professor. String.raw keeps LaTeX
// backslashes literal; the blank lines make each $$…$$ a block for remark-math.
const SCORING_FORMULA = String.raw`Each graded result nudges a skill's score toward that result — **newer, higher-stakes** work moves it more.

$$\text{new} = \text{prior} + (\text{evidence} - \text{prior})\,\alpha$$

$$\alpha = \operatorname{clamp}\!\left(\alpha_{\text{base}}\cdot\frac{w}{W_{\text{ref}}},\ 0.05,\ 0.95\right),\quad w = \text{stake} \times \text{points}$$

A skill's score is the evidence-weighted roll-up of its subtopics:

$$\text{skill} = \frac{\sum_i s_i\,n_i}{\sum_i n_i}$$
`

const METRICS: { v: ClassMetricKind; l: string }[] = [
  { v: 'median', l: 'Median' },
  { v: 'mean', l: 'Mean' },
  { v: 'percent_proficient', l: '% proficient' },
]

export function SkillMasterySettings({
  sectionId,
  config,
}: {
  sectionId: string
  config: SkillMasteryConfig
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [showMath, setShowMath] = useState(false)
  const [pending, startTransition] = useTransition()
  const [cfg, setCfg] = useState<SkillMasteryConfig>(config)

  /* The panel isn't a Radix Dialog (portals stack under the z-61 drawer), so
     the focus contract is hand-rolled: the card takes focus on open, the gear
     gets it back on close. */
  const gearRef = useRef<HTMLButtonElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)

  // Discard any in-progress edits when the panel closes without saving, so
  // reopening shows the last saved values, not an abandoned draft.
  const close = useCallback(() => {
    setCfg(config)
    setShowMath(false)
    setOpen(false)
    gearRef.current?.focus()
  }, [config])

  /* Escape closes THIS panel only. Captured on document so it runs before the
     drawer's own bubble-phase Escape handler, and stopPropagation keeps that
     handler from also closing the whole drawer underneath. */
  useEffect(() => {
    if (!open) return
    cardRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, close])

  function save() {
    // Validate client-side with a clear, visible message — an out-of-range value
    // must never look like a silent no-op (the server would reject it too).
    const problem =
      cfg.proficientThreshold < 0 || cfg.proficientThreshold > 100
        ? 'Proficient must be between 0 and 100.'
        : cfg.atRiskThreshold < 0 || cfg.atRiskThreshold > 100
          ? 'At risk must be between 0 and 100.'
          : cfg.atRiskThreshold >= cfg.proficientThreshold
            ? 'At risk must be below Proficient.'
            : cfg.baseAlpha < 0.05 || cfg.baseAlpha > 0.95
              ? 'Recency weight must be between 0.05 and 0.95.'
              : (['exam', 'assignment', 'quiz'] as const)
                  .filter((k) => cfg.stakeMultipliers[k] < 0.5 || cfg.stakeMultipliers[k] > 10)
                  .map((k) => `${k[0].toUpperCase() + k.slice(1)} weight must be between 0.5 and 10.`)[0]
    if (problem) {
      toast.error(problem)
      return
    }

    startTransition(async () => {
      const res = await updateSkillMasteryConfig({ sectionId, config: cfg })
      if ('error' in res) {
        toast.error(res.error)
        return
      }
      toast.success('Mastery settings saved')
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      <button ref={gearRef} type="button" className="tsgear" aria-label="Mastery settings" aria-expanded={open} onClick={() => setOpen(true)}>
        <SlidersHorizontal aria-hidden />
      </button>

      {open && (
        <div className="tsset">
          {/* transparent click-catcher — dismisses the panel, never the drawer */}
          <div className="catch" aria-hidden onClick={close} />
          <div ref={cardRef} tabIndex={-1} className="card" role="dialog" aria-modal="true" aria-label="Mastery settings" onKeyDown={trapTab}>
            <button type="button" className="tsgear x" aria-label="Close" onClick={close}><X aria-hidden /></button>
            <span className="akick">SKILL MASTERY</span>
            <span className="atitle">Mastery settings</span>
            <p className="intro">
              The concepts tracked for mastery this semester are auto-suggested from your materials,
              quizzes and assignments, and nested under the best-fitting topic. Edit the list freely —
              mastery shows on the roadmap. Below is how this course turns graded work into those scores.
            </p>
            <button type="button" className="mathtoggle" aria-expanded={showMath} onClick={() => setShowMath((o) => !o)}>
              <ChevronDown aria-hidden />How mastery is scored
            </button>
            {showMath && (
              <div className="math">
                <MarkdownLatex content={SCORING_FORMULA} className="text-sm [&_.katex-display]:my-2" />
                <ul>
                  <li><b>α<sub>base</sub></b> — the <b>Recency weight</b> below (now {cfg.baseAlpha})</li>
                  <li><b>stake</b> — the <b>Activity weights</b> below (exam {cfg.stakeMultipliers.exam} · assignment {cfg.stakeMultipliers.assignment} · quiz {cfg.stakeMultipliers.quiz})</li>
                  <li><b>prior</b> starts at <b>50</b> for an untested skill — never 0</li>
                  <li><b>evidence</b> = a quiz / exam / assignment / live-quiz score (0–100)</li>
                </ul>
              </div>
            )}

            <span className="fl">CLASS NUMBER</span>
            <div className="vtog" role="group" aria-label="Class number">
              {METRICS.map((m) => (
                <button key={m.v} type="button" aria-pressed={cfg.classMetric === m.v} onClick={() => setCfg({ ...cfg, classMetric: m.v })}>{m.l}</button>
              ))}
            </div>
            <p className="hint">The single per-skill number you see — median is the typical student.</p>

            <div className="frow">
              <label className="fcell">
                <span className="fl">PROFICIENT ≥</span>
                <input type="number" min={0} max={100} value={cfg.proficientThreshold}
                  onChange={(e) => setCfg({ ...cfg, proficientThreshold: NUM(e.target.value, cfg.proficientThreshold) })} />
                <span className="fh">Counts as proficient.</span>
              </label>
              <label className="fcell">
                <span className="fl">AT RISK &lt;</span>
                <input type="number" min={0} max={100} value={cfg.atRiskThreshold}
                  onChange={(e) => setCfg({ ...cfg, atRiskThreshold: NUM(e.target.value, cfg.atRiskThreshold) })} />
                <span className="fh">Flags a student at risk.</span>
              </label>
            </div>
            {/* Recency is a 0–1 coefficient, not a percentage — its own row so
                it never reads as a third threshold. */}
            <div className="frow">
              <label className="fcell">
                <span className="fl">RECENCY WEIGHT (α)</span>
                <input type="number" min={0.05} max={0.95} step={0.05} value={cfg.baseAlpha}
                  onChange={(e) => setCfg({ ...cfg, baseAlpha: NUM(e.target.value, cfg.baseAlpha) })} />
                <span className="fh">Higher = newer work counts more (0.05–0.95).</span>
              </label>
            </div>

            <span className="fl">ACTIVITY WEIGHTS</span>
            <div className="frow">
              {(['exam', 'assignment', 'quiz'] as const).map((k) => (
                <label key={k} className="fcell">
                  <span className="fl sub">{k.toUpperCase()}</span>
                  <input type="number" min={0.5} max={10} step={0.5} value={cfg.stakeMultipliers[k]}
                    onChange={(e) =>
                      setCfg({ ...cfg, stakeMultipliers: { ...cfg.stakeMultipliers, [k]: NUM(e.target.value, cfg.stakeMultipliers[k]) } })
                    } />
                </label>
              ))}
            </div>

            <label className="trow">
              <input type="checkbox" className="tsck" checked={cfg.includeLiveQuiz}
                onChange={(e) => setCfg({ ...cfg, includeLiveQuiz: e.target.checked })} />
              <span>
                <span className="tt">Live-classroom quizzes</span>
                <span className="ss">Fold live quiz results into mastery.</span>
              </span>
            </label>

            <div className="foot">
              <button type="button" className="tsbtn ghost" onClick={close} disabled={pending}>Cancel</button>
              <button type="button" className="tsbtn" onClick={save} disabled={pending}>
                {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
                Save settings
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
