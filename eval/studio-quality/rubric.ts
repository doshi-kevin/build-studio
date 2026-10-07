/**
 * studio-generation-quality-v1: the product-quality rubric for plugins the Studio builder
 * makes (docs/designs/studio/studio-generation-quality.md). Pure, and the single source of
 * the criteria: the judge prompt and the scores both come from here.
 *
 * The judge picks one of four levels per dimension and never a number. A level is worth a
 * fixed share of the dimension's points, so the same judgement always scores the same.
 * Correctness and security are hard gates outside these 100 points (gates.ts).
 */

export const RUBRIC_VERSION = 'studio-generation-quality-v1'

export const LEVELS = ['none', 'weak', 'acceptable', 'excellent'] as const
export type Level = (typeof LEVELS)[number]

/** Share of a dimension's points each level is worth. */
export const LEVEL_FRACTION: Record<Level, number> = { none: 0, weak: 0.4, acceptable: 0.7, excellent: 1 }

export interface Dimension {
  key: DimensionKey
  title: string
  points: number
  /** What the dimension asks, in one sentence. */
  question: string
  levels: Record<Level, string>
  evidence: string
  mustNotReward: string
  /** Visual quality: needs a screenshot behind it, and isn't assessed in a code-only evaluation. */
  visualOnly?: true
}

export const DIMENSION_KEYS = [
  'problem_understanding',
  'workflow_completeness',
  'professor_experience',
  'student_experience',
  'interaction_design',
  'visual_quality',
  'information_design',
  'edge_states',
  'responsiveness_accessibility',
] as const
export type DimensionKey = (typeof DIMENSION_KEYS)[number]

export const DIMENSIONS: readonly Dimension[] = [
  {
    key: 'problem_understanding',
    title: 'Problem understanding',
    points: 15,
    question: 'Does the tool solve the professor’s actual problem, with the right people owning the right data?',
    levels: {
      none: 'The wrong tool, or a refusal of something the platform supports.',
      weak: 'The literal minimum; the wrong owner of the data (for example students marking their own attendance when the professor clearly should); or an obvious implied need missing.',
      acceptable: 'The right roles, data ownership and core loop; one notable implied need missed.',
      excellent: 'Infers what a domain expert would expect, with the right ownership, and says plainly when part of the request is beyond the platform.',
    },
    evidence: 'The request, the manifest (collections, access modes, capabilities), both views’ source.',
    mustNotReward: 'Extra features unrelated to the request; anything the code doesn’t back up; restating the request.',
  },
  {
    key: 'workflow_completeness',
    title: 'Workflow completeness',
    points: 20,
    question: 'Can each role complete the whole loop: act, see the result, and fix a mistake?',
    levels: {
      none: 'The core action is missing or does nothing.',
      weak: 'The core action exists but the loop breaks: the result isn’t shown, a mistake can’t be fixed, or data is written and never read.',
      acceptable: 'The full main loop for both roles; secondary needs such as history or editing only partly there.',
      excellent: 'The full loop including correction and history across sessions, with an efficient way to repeat the action.',
    },
    evidence: 'Code traced from control to handler to collection write to the read that displays it; screenshots confirm the control is there.',
    mustNotReward: 'Buttons with no handler, tabs with nothing in them, the number of components.',
  },
  {
    key: 'professor_experience',
    title: 'Professor experience',
    points: 15,
    question: 'Is the professor view a good product for running the class?',
    levels: {
      none: 'The professor view is empty or unusable.',
      weak: 'The task is possible but buried, needs many steps per student, or has no overview.',
      acceptable: 'The primary action is on the first screen, there is an overview, and it works for the sample class and plausibly for 30 to 200 students.',
      excellent: 'It cuts repeated work (bulk actions, sensible defaults), surfaces what needs attention, and makes the next step obvious.',
    },
    evidence: 'Professor screenshots at desktop and phone width, and the professor view’s source.',
    mustNotReward: 'Stat cards that repeat one number, decorative charts, more tabs.',
  },
  {
    key: 'student_experience',
    title: 'Student experience',
    points: 15,
    question: 'Does a student know what to do and where they stand, with little effort?',
    levels: {
      none: 'The student view is empty or broken.',
      weak: 'It isn’t clear what to do, or the student can’t see their own status.',
      acceptable: 'A clear task, and the student’s own status and history.',
      excellent: 'Says what’s next and where they stand, confirms after an action, guides a first visit, and offers nothing a student shouldn’t do.',
    },
    evidence: 'Student screenshots at desktop and phone width, and the student view’s source.',
    mustNotReward: 'Numbers that don’t matter to a student; features that depend on data students can’t read.',
  },
  {
    key: 'interaction_design',
    title: 'Interaction design',
    points: 10,
    question: 'Do the controls fit the task, give feedback, and prevent mistakes? (Judged from code and screenshots; nothing is clicked in v1.)',
    levels: {
      none: 'The controls are unusable or don’t fit the task.',
      weak: 'Free text where the choices are fixed, no feedback after an action, or destructive actions without confirmation.',
      acceptable: 'Controls that fit, feedback after actions, and confirmation where it’s needed.',
      excellent: 'Sensible defaults, invalid input prevented, fast repetition, and undo where it helps.',
    },
    evidence: 'Source (control types, validation, confirmation, feedback) and screenshots.',
    mustNotReward: 'The number or novelty of controls.',
  },
  {
    key: 'visual_quality',
    title: 'Visual quality',
    points: 10,
    question: 'Does it look like a designed product: hierarchy, spacing, alignment, consistency?',
    levels: {
      none: 'A broken layout.',
      weak: 'Cramped, misaligned, large empty areas, or no hierarchy.',
      acceptable: 'Clean and consistent, with clear grouping.',
      excellent: 'Strong hierarchy and calm density; it reads as a designed product.',
    },
    evidence: 'Screenshots only.',
    mustNotReward: 'Variety of colours or tones, more cards.',
    visualOnly: true,
  },
  {
    key: 'information_design',
    title: 'Information design',
    points: 5,
    question: 'Is the right information shown, labelled, formatted and ordered?',
    levels: {
      none: 'Wrong or unlabelled data.',
      weak: 'Raw values, no useful order, developer words, or handles on screen.',
      acceptable: 'Labelled values, formatted dates, a sensible order.',
      excellent: 'The numbers that matter come first, with units, comparisons and status at a glance.',
    },
    evidence: 'Screenshots and source.',
    mustNotReward: 'Showing more numbers.',
  },
  {
    key: 'edge_states',
    title: 'Edge states',
    points: 5,
    question: 'Are first use, empty, loading, error and large-data states handled usefully?',
    levels: {
      none: 'Crashes or shows a blank screen.',
      weak: 'The required loading, empty and error states exist but say nothing useful.',
      acceptable: 'Useful empty and error wording.',
      excellent: 'First use guides the setup; no data, a long list and an error are each handled well.',
    },
    evidence: 'The empty, slow and failing screenshots, the Stage 2 states check, and source.',
    mustNotReward: 'Merely having the three states, which the draft gate already requires.',
  },
  {
    key: 'responsiveness_accessibility',
    title: 'Responsiveness and accessibility',
    points: 5,
    question: 'Does it work at phone width and for keyboard and screen-reader users?',
    levels: {
      none: 'A Stage 2 mobile layout, touch target or accessibility check fails.',
      weak: 'Usable at phone width but cramped or clipped.',
      acceptable: 'Clean at phone width with labelled controls.',
      excellent: 'A phone layout designed for the task, and meaning never carried by colour alone.',
    },
    evidence: 'Stage 2 runtime.mobile_layout, runtime.touch_targets and runtime.accessibility, and the phone screenshots.',
    mustNotReward: 'Desktop polish.',
  },
]

export const MAX_SCORE = DIMENSIONS.reduce((sum, d) => sum + d.points, 0)

export const dimension = (key: DimensionKey): Dimension => DIMENSIONS.find((d) => d.key === key)!

/** Points for one level of one dimension, to a tenth of a point. */
export function pointsFor(key: DimensionKey, level: Level): number {
  return Math.round(dimension(key).points * LEVEL_FRACTION[level] * 10) / 10
}

/** The total over every dimension, or null when any isn't assessed: a partial total isn't
 * comparable with a complete one, so none is made up. */
export function totalScore(levels: Partial<Record<DimensionKey, Level | null>>): number | null {
  let sum = 0
  for (const d of DIMENSIONS) {
    const level = levels[d.key]
    if (!level) return null
    sum += pointsFor(d.key, level)
  }
  return Math.round(sum * 10) / 10
}

const rank = (level: Level) => LEVELS.indexOf(level)

/** The median level of several judge runs. With an even count it is the lower of the middle
 * two, so a split between judges never rounds up. */
export function medianLevel(levels: readonly Level[]): Level | null {
  if (levels.length === 0) return null
  const sorted = [...levels].sort((a, b) => rank(a) - rank(b))
  return sorted[Math.floor((sorted.length - 1) / 2)]
}

/** How many levels apart the judge runs were: 0 when they all agree. */
export function levelSpread(levels: readonly Level[]): number {
  if (levels.length === 0) return 0
  const ranks = levels.map(rank)
  return Math.max(...ranks) - Math.min(...ranks)
}
