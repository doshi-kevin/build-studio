/**
 * Course Feature Registry — single source of truth for all toggleable
 * course features. Features are categorized as:
 *   - basic: always visible to students (core course features)
 *   - additional: professor can toggle on/off for students via Settings
 *   - professor: only visible in professor sidebar (never shown to students)
 *
 * Adding a new feature: append an entry here + create the route page.
 */

import {
  Megaphone,
  Layers,
  FileText,
  GraduationCap,
  UserCheck,
  // Aliased: the bare `Map` icon shadows the global Map constructor in this module.
  Map as MapIcon,
  ClipboardCheck,
  FolderKanban,
  Brain,
  Settings,
  Radio,
  Trophy,
  Bot,
  MessageCircle,
  UsersRound,
  Headphones,
  Blocks,
  Puzzle,
  type LucideIcon,
} from 'lucide-react'

export type FeatureCategory = 'basic' | 'additional' | 'professor'

export interface CourseFeature {
  key: string
  label: string
  icon: LucideIcon
  route: string // relative to basePath, e.g. '/announcements'
  description: string
  category: FeatureCategory
  /** If true, professor sidebar won't show this as a navigable link (student-only page). */
  studentOnly?: boolean
  /** If true, student sidebar won't show this (professor-only page). */
  professorOnly?: boolean
  /** If true, this feature is switched on automatically for newly created
   *  sections (professors can still turn it off via Manage Features). */
  enabledByDefault?: boolean
  /** If true, the feature has no dedicated page — it's toggled in Manage Features
   *  but surfaced inline elsewhere (e.g. primers live on lecture rows in Modules),
   *  so it must NOT appear as a navigable link in either sidebar. */
  inlineOnly?: boolean
  /** Set on a Studio plugin's tab (studioToolFeature). Not in COURSE_FEATURES: plugin
   *  tabs come from the section's installations, not this registry. */
  studioTool?: { hiddenFromStudents: boolean }
}

export const COURSE_FEATURES: CourseFeature[] = [
  // ── Basic features (always visible to students) ────────────
  {
    key: 'modules',
    label: 'Modules',
    icon: Layers,
    route: '/modules',
    description: 'Organize course content and lessons',
    category: 'basic',
  },
  {
    key: 'announcements',
    label: 'Announcements',
    icon: Megaphone,
    route: '/announcements',
    description: 'Post updates for your students',
    category: 'basic',
  },
  {
    key: 'grades',
    label: 'Grades',
    icon: GraduationCap,
    route: '/grades',
    description: 'View and manage student grades',
    category: 'basic',
  },

  // ── Additional features (professor toggles for students) ───
  {
    key: 'assignments',
    label: 'Assignments',
    icon: FileText,
    route: '/assignments',
    description: 'Create and manage coursework',
    category: 'additional',
    enabledByDefault: true,
  },
  {
    key: 'roadmap',
    label: 'Roadmap',
    icon: MapIcon,
    route: '/roadmap',
    description: 'Build a knowledge roadmap for your students',
    category: 'additional',
  },
  {
    key: 'quizzes',
    label: 'Quizzes',
    icon: ClipboardCheck,
    route: '/quizzes',
    description: 'Create and manage quizzes for your students',
    category: 'additional',
  },
  {
    key: 'projects',
    label: 'Projects',
    icon: FolderKanban,
    route: '/projects',
    description: 'Collaborative project workspaces with team management',
    category: 'additional',
  },
  {
    key: 'discussions',
    label: 'Discussions',
    icon: MessageCircle,
    route: '/discussions',
    description: 'Course-wide and team discussion channels',
    category: 'additional',
  },
  {
    key: 'live-classroom',
    label: 'Classroom',
    icon: Radio,
    route: '/live-classroom',
    description:
      'Live lecture: slide sync, polls, quizzes, Q&A, drawing, presence',
    category: 'additional',
  },
  {
    key: 'challenges',
    label: 'Challenges',
    icon: Trophy,
    route: '/challenges',
    description: 'Optional challenges, puzzles, and coding katas',
    category: 'additional',
  },
  {
    key: 'intel',
    label: 'Course Intel',
    icon: Brain,
    route: '/intel',
    description: 'Alumni reviews, Q&A, and course intelligence',
    category: 'additional',
    studentOnly: true,
  },
  {
    key: 'athena',
    label: 'Athena',
    icon: Bot,
    // No dedicated page: Athena floats over every course page as the shell
    // (orb → docked zone). The toggle stays the section master switch. Renamed
    // from the retired tutor's 'ai-tutor' key with athena-core; sections that
    // already had it on were carried over by
    // supabase/migrations/20260806023200_athena_feature_key_rename.sql.
    route: '/modules',
    description: 'Athena — the AI course assistant students open from any course page',
    category: 'additional',
    studentOnly: true,
    enabledByDefault: true,
    inlineOnly: true,
  },
  {
    key: 'pre-class-audio',
    label: 'Class Primers',
    icon: Headphones,
    // No dedicated page: professors toggle a primer per lecture in Modules, and
    // students listen inline on the lecture row. Kept as a Manage Features
    // toggle (the section master switch) but hidden from both sidebars.
    route: '/modules',
    description: 'Let students listen to a short audio primer before each lecture (managed per lecture in Modules)',
    category: 'additional',
    studentOnly: true,
    inlineOnly: true,
  },

  // ── Professor-only features ────────────────────────────────
  {
    key: 'studio',
    label: 'Studio',
    icon: Blocks,
    route: '/studio',
    description: 'Build tools for this course from a plain-language description',
    category: 'professor',
    professorOnly: true,
  },
  {
    key: 'enrollment',
    label: 'Roster',
    icon: UserCheck,
    route: '/enrollment',
    description: 'View the students enrolled in this section',
    category: 'professor',
    professorOnly: true,
  },
  {
    key: 'staff',
    label: 'Course Assistants',
    icon: UsersRound,
    route: '/staff',
    description: 'Request course assistants (TAs and graders) for this section',
    category: 'professor',
    professorOnly: true,
  },
  {
    key: 'settings',
    label: 'Settings',
    icon: Settings,
    route: '/settings',
    description: 'Course dates, capacity, and configuration',
    category: 'professor',
    professorOnly: true,
  },
]

/** Features that always appear in the student sidebar. */
export const BASIC_FEATURES = COURSE_FEATURES.filter((f) => f.category === 'basic')

/** Features the professor can toggle on/off for students. */
export const ADDITIONAL_FEATURES = COURSE_FEATURES.filter((f) => f.category === 'additional')

/** Keys switched on automatically for a newly created section. Basics are always
 *  visible regardless; this is for `additional` features we want on out of the box
 *  (e.g. AI Tutor). Professors can still disable them via Manage Features. */
export const DEFAULT_ENABLED_FEATURES = COURSE_FEATURES.filter((f) => f.enabledByDefault).map((f) => f.key)

/** Features that only appear in the professor sidebar. */
export const PROFESSOR_FEATURES = COURSE_FEATURES.filter((f) => f.category === 'professor')

/** Every feature that can appear as a link in the professor sidebar. These all
 *  show by default — `settings.sidebarHidden` is what removes one. Excludes
 *  student-only pages and inline-only toggles, which have no professor route. */
export const PROFESSOR_SIDEBAR_FEATURES = COURSE_FEATURES.filter(
  (f) => !f.studentOnly && !f.inlineOnly
)

/**
 * Sorts features by a saved order (`settings.sidebarOrder`), which may be
 * partial or stale. Keys present in `order` come first in that sequence;
 * anything absent — a feature added to the registry after the professor last
 * dragged, or one they never touched — appends afterwards in registry order.
 * That's what keeps new features visible by default instead of frozen out.
 */
export function orderFeatures(features: CourseFeature[], order: string[]): CourseFeature[] {
  if (order.length === 0) return features
  /* First occurrence wins. `order` can legitimately contain a key twice — the
   * student fallback below prefixes the basics onto `enabledFeatures`, which on
   * sections dragged before `sidebarOrder` existed already has basics embedded.
   * `new Map(pairs)` is last-wins, which would hand those basics their stale
   * dragged rank and demote them below the extras. */
  const rank = new Map<string, number>()
  order.forEach((key, i) => {
    if (!rank.has(key)) rank.set(key, i)
  })
  // Array.prototype.sort is stable, so equal-rank (unlisted) items hold registry
  // order. Infinity - Infinity is NaN, which the spec coerces to +0 — i.e. "equal"
  // — so unlisted items keep their input order. Don't "simplify" this comparator.
  return [...features].sort(
    (a, b) => (rank.get(a.key) ?? Infinity) - (rank.get(b.key) ?? Infinity)
  )
}

/** A Studio plugin installation shown as a course tab. Display only: whether a student
 * may open it is decided by the server (src/lib/studio/context.ts), never by the nav. */
export interface StudioTool {
  installationId: string
  name: string
  hiddenFromStudents: boolean
}

/** The `sidebarOrder` key for a plugin tab. Ordering only; it grants nothing. */
export const STUDIO_TOOL_KEY = /^studio:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function studioToolFeature(tool: StudioTool, audience: 'student' | 'professor'): CourseFeature {
  return {
    key: `studio:${tool.installationId}`,
    label: tool.name,
    // Not Blocks: that's the Studio builder, and both sit in the professor's sidebar.
    icon: Puzzle,
    route: audience === 'student' ? `/tools/${tool.installationId}` : `/studio/${tool.installationId}`,
    description: tool.name,
    category: 'additional',
    studioTool: { hiddenFromStudents: tool.hiddenFromStudents },
  }
}

/**
 * The professor's features plus plugin tabs, in their order. A tool the professor
 * hasn't placed yet goes right after Studio, where they just built it, rather than
 * under the admin features at the bottom. Once dragged, their order wins.
 */
export function orderWithTools(features: CourseFeature[], tools: CourseFeature[], order: string[]): CourseFeature[] {
  const ordered = orderFeatures([...features, ...tools], order)
  const ranked = new Set(order)
  const unplaced = ordered.filter((f) => f.studioTool && !ranked.has(f.key))
  if (unplaced.length === 0) return ordered
  const rest = ordered.filter((f) => !unplaced.includes(f))
  const studio = rest.findIndex((f) => f.key === 'studio')
  rest.splice(studio === -1 ? rest.length : studio + 1, 0, ...unplaced)
  return rest
}

/**
 * The one sidebar tab to highlight: the longest route the URL is at or inside. Plugin
 * pages live under /studio/<id>, so a plain prefix test would light up Studio too.
 */
export function activeFeatureKey(features: CourseFeature[], basePath: string, pathname: string): string | undefined {
  return features
    .filter((f) => {
      const href = `${basePath}${f.route}`
      return pathname === href || pathname.startsWith(`${href}/`)
    })
    .sort((a, b) => b.route.length - a.route.length)[0]?.key
}

/**
 * The student sidebar's feature list: basics, then whatever the professor
 * published, in the professor's display order. Plugin tabs (`tools`, already
 * filtered to what students may see) sort by the same order, after anything
 * unlisted.
 *
 * Extracted from the component so the backwards-compatibility rule is testable.
 * Sections predating `sidebarOrder` fall back to basics-then-`enabledFeatures`,
 * which is exactly how this list used to be built — so no existing course's nav
 * silently reshuffles when this ships.
 */
export function studentSidebarFeatures(
  enabledFeatures: string[],
  sidebarOrder: string[],
  tools: StudioTool[] = [],
): CourseFeature[] {
  const studentBasic = BASIC_FEATURES.filter((f) => !f.professorOnly)
  const enabled = new Set(enabledFeatures)
  const enabledAdditional = ADDITIONAL_FEATURES.filter(
    (f) => enabled.has(f.key) && !f.professorOnly && !f.inlineOnly
  )
  const order = sidebarOrder.length > 0
    ? sidebarOrder
    : [...studentBasic.map((f) => f.key), ...enabledFeatures]
  const toolTabs = tools.map((t) => studioToolFeature(t, 'student'))
  return orderFeatures([...studentBasic, ...enabledAdditional, ...toolTabs], order)
}

/** Feature keys a course assistant (TA/grader) is allowed to see and access on
 * a section. Basics (Announcements, Grades) and allowlisted professor tools
 * (Studio) surface whenever the role has section access; the additional
 * features appear only when the professor has enabled them via Manage
 * Features. Everything else — Modules, Enrollment, Roadmap, Challenges,
 * Classroom, Assignments, Settings, Course Assistants — is hidden from
 * non-professor callers. */
export const COURSE_ASSISTANT_ALLOWED_FEATURES = new Set([
  'studio',
  'announcements',
  'grades',
  'quizzes',
  'projects',
  'discussions',
])

/** Whether a course assistant sees this feature in the course sidebar:
 * allowlisted, and either always-on for the role (basics, professor tools) or
 * published to students — so a TA never sees a feature still in draft. */
export function courseAssistantCanSee(
  feature: Pick<CourseFeature, 'key' | 'category'>,
  enabledFeatures: string[],
): boolean {
  if (!COURSE_ASSISTANT_ALLOWED_FEATURES.has(feature.key)) return false
  return feature.category !== 'additional' || enabledFeatures.includes(feature.key)
}

/**
 * What a Manage Features checkbox MEANS for a given row. One rule, three
 * consumers — the optimistic reducer, the server call, and the confirmation
 * toast — so they cannot drift into disagreeing about the same click.
 *  - 'sidebar'  professor-only tool: the checkbox is "keep it in my sidebar"
 *  - 'restore'  a hidden row returns to draft, WITHOUT publishing to students
 *  - 'publish'  everything else publishes/unpublishes to students
 */
export function classifyFeatureToggle(
  feature: Pick<CourseFeature, 'key' | 'professorOnly'>,
  hidden: string[],
): 'sidebar' | 'restore' | 'publish' {
  if (feature.professorOnly) return 'sidebar'
  if (hidden.includes(feature.key)) return 'restore'
  return 'publish'
}
