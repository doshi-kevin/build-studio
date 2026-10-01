/**
 * The fixed lists manifest v2 draws from. Client-safe: the plugin card renders them.
 * Each list is versioned with the manifest: changing an entry's meaning needs a new
 * manifest version, and removing one would break published versions (rule 8.7).
 */

/** Rule 3.4: the shared signal list. Plugins track only these, so dashboards add up
 * across every plugin in a course. */
export const SIGNALS = {
  completed: 'Whether a student finished it',
  score: 'A score',
  timeSpent: 'Time spent',
  attended: 'Attendance',
  submitted: 'Whether a student submitted work',
} as const

export type SignalName = keyof typeof SIGNALS
export const SIGNAL_NAMES = Object.keys(SIGNALS) as [SignalName, ...SignalName[]]

/** Rule 9.6: what a Studio tool may be for. Teaching, learning, or running the course. */
export const PURPOSE_CATEGORIES = {
  practice: 'Practice and retrieval',
  assessment: 'Checking understanding',
  feedback: 'Feedback on work',
  reflection: 'Reflection',
  discussion: 'Discussion and peer learning',
  'content-exploration': 'Exploring course material',
  'course-logistics': 'Running the course',
} as const

export type PurposeCategory = keyof typeof PURPOSE_CATEGORIES
export const PURPOSE_CATEGORY_NAMES = Object.keys(PURPOSE_CATEGORIES) as [PurposeCategory, ...PurposeCategory[]]

/** Rule 6.2: what a tool does when the AI kill switch turns its AI off. */
export const AI_FALLBACKS = {
  'not-applicable': 'Uses no AI',
  'works-without-ai': 'Keeps working without AI',
  'explains-unavailable': 'Tells people plainly what’s unavailable',
} as const

export type AiFallback = keyof typeof AI_FALLBACKS
export const AI_FALLBACK_NAMES = Object.keys(AI_FALLBACKS) as [AiFallback, ...AiFallback[]]
