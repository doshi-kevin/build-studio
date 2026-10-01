/**
 * Auto Roadmap Types — DTOs for the auto-generated module-based roadmap.
 *
 * The auto roadmap derives its structure from modules + module_items.
 * Professors set statuses on each node; students view read-only.
 */

import type { ModuleItemType } from '@/lib/validations/module'

// ── Status Types ────────────────────────────────────────────────

export const ROADMAP_NODE_STATUSES = ['not_started', 'in_progress', 'complete'] as const
export type RoadmapNodeStatus = (typeof ROADMAP_NODE_STATUSES)[number]

/**
 * Any box that can be a professor-drawn link endpoint — an auto module/item OR a
 * course resource (quiz / assignment / live session and its poll/quiz sub-parts).
 * Lets a professor connect, e.g., a quiz to the module it covers. Stored in
 * roadmap_edges with polymorphic (type, id) endpoints; an endpoint that no longer
 * resolves to a live box is filtered out on read, which is what retired the
 * manual module/lecture endpoints.
 */
export const ROADMAP_LINK_ENDPOINT_TYPES = [
  'module',
  'module_item',
  'quiz',
  'assignment',
  'live_session',
  'live_poll',
  'live_quiz',
] as const
export type RoadmapLinkEndpointType = (typeof ROADMAP_LINK_ENDPOINT_TYPES)[number]

export interface RoadmapEdge {
  id: string
  fromType: RoadmapLinkEndpointType
  fromId: string
  toType: RoadmapLinkEndpointType
  toId: string
  /** Semantic edges: 'prerequisite' (from → to must come first) or 'related'.
   *  Placement edges (module ↔ resource) also default to 'prerequisite'; consumers
   *  that want true content links must exclude edges touching a module endpoint. */
  edgeType?: 'prerequisite' | 'related'
  /** Placement edges only: the resource's sort position within its module's canvas band. */
  position?: number | null
}

// ── DTO: A single module item node in the roadmap ───────────────

export interface RoadmapItemNode {
  id: string
  title: string
  description: string
  itemType: ModuleItemType
  position: number
  status: RoadmapNodeStatus
  /** Uploaded lecture format ('pdf'|'ppt'|'docx'|'xlsx'|'notes'|'image') — drives the file-format badge. */
  fileType?: string
  /** Lecture flagged as classroom slides — distinguishes a slide deck from a plain uploaded file. */
  useAsSlides?: boolean
  /** `is_visible = false` — students cannot see this item. Professor-only: the
   *  student loader filters hidden items out, so it is never set there. Drives the
   *  faded + eye-off card, which is how an unshared live-classroom upload stays
   *  findable instead of looking published. */
  hiddenFromStudents?: boolean
  /** Image only: natural pixel size as "W×H" (from the uploaded file). */
  imageDimensions?: string
  /** Video only: length in minutes (read from an uploaded file's metadata). */
  videoDurationMin?: number
  /** External URL to open in new tab, or null (use file/MaterialViewer or non-clickable) */
  href: string | null
  /** File details for MaterialViewer dialog — null if no uploaded file */
  file: {
    url: string
    name: string
    size?: number
  } | null
  /** LLM-extracted topic names from document content */
  topics?: string[]
  /**
   * Maps each topic name to the pages that reference it (ranked). Semantic —
   * embedding-matched at extraction time — so it catches paraphrases, not just
   * verbatim mentions; falls back to a single exact-substring page. Drives the
   * material-viewer reference rail (jump through every referencing page).
   */
  topicPageHits?: Record<string, number[]>
  /** Professor-pinned page reference within the uploaded PDF/PPT */
  pageRef?: { pageNumber: number; heading?: string }
  /** True if the item has a completed document extraction (enables page picker) */
  hasExtraction?: boolean
  /** Total pages/slides from extraction — lets the viewer render Office decks (pptx) slide-by-slide */
  pageCount?: number
  /** One-line AI summary of the lecture content (revealed in the detail panel, never always-on) */
  summary?: string
  /** Material-at-a-glance counts from extraction, for the detail panel. */
  material?: {
    images?: number
    formulas?: number
    tables?: number
    code?: number
  }
}

// ── DTO: A week/module node in the roadmap ──────────────────────

export interface RoadmapWeekNode {
  id: string
  title: string
  description: string
  weekNumber: number | null
  position: number
  status: RoadmapNodeStatus
  /** App-owned container module (`modules.system_kind`) whose files belong in the
   *  roadmap's off-map bench rather than on the canvas. Absent for a professor's
   *  own module. Read INSTEAD of the title, which a professor can rename. */
  systemKind?: 'quiz_uploads' | 'classroom_uploads'
  /** Unpublished — students can't see this module at all. Professor-only: the
   *  student loader filters these out before assembly, so it is never set there.
   *  Drives the "hidden from students" kicker and keeps an unpublished week out
   *  of the delivery headline, which otherwise counts it as work not started. */
  draft?: boolean
  /** Published, but its `unlock_date` hasn't arrived — the class isn't here yet.
   *  Student-only, by the same convention as `draft`: the professor loader never
   *  selects `unlock_date`, so their map is untouched. A locked week keeps only
   *  what it takes to draw the shell — title, description, week, position — while
   *  `items` and `dividers` are emptied and any quiz/assignment/session placed
   *  under it is dropped from the payload, so no unreleased CONTENT (file URLs,
   *  lecture or quiz titles, extraction text) reaches the browser. */
  locked?: boolean
  /** ISO date the week opens — the "Opens Aug 12" label. Set only with `locked`. */
  unlockDate?: string | null
  items: RoadmapItemNode[]
  /** The module's `section_divider` items — labelled breaks between its items.
   *  Kept beside `items` (not inside it) because a divider is never content: no
   *  status, no coverage, no place in any percentage. */
  dividers?: RoadmapItemDivider[]
}

/** An in-module divider: its label and the item it sits after (null = the top). */
export interface RoadmapItemDivider {
  id: string
  title: string
  afterItemId: string | null
}

/** A module-level divider — a labelled break BETWEEN modules (module_dividers).
 *  `position` shares the scale with RoadmapWeekNode.position. */
export interface RoadmapModuleDivider {
  id: string
  title: string
  position: number
}

// ── DTO: Course-resource nodes (quizzes, assignments, live sessions) ──
//
// Resources are assembled READ-ONLY from their own tables at request time — no
// new roadmap table. Status is DERIVED from each resource's real lifecycle state
// (draft/published/live/ended…) and mapped onto the shared three-state visual;
// it is never professor-editable here. Topics come from the resource itself
// (a quiz's topics are the union of its question tags) — nothing is force-fit
// onto uploaded module items.

/** Top-level resource kinds that become their own roadmap boxes. */
export const ROADMAP_RESOURCE_KINDS = ['quiz', 'assignment', 'live_session'] as const
export type RoadmapResourceKind = (typeof ROADMAP_RESOURCE_KINDS)[number]

/** Sub-parts that live inside a live session (rendered as children of it). */
export const ROADMAP_RESOURCE_CHILD_KINDS = ['live_poll', 'live_quiz'] as const
export type RoadmapResourceChildKind = (typeof ROADMAP_RESOURCE_CHILD_KINDS)[number]

/** A poll or pop-quiz that happened inside a live session. */
export interface RoadmapResourceChild {
  id: string
  kind: RoadmapResourceChildKind
  title: string
  /** Derived status (open → in_progress, closed → complete). */
  status: RoadmapNodeStatus
}

/** A quiz, assignment, or live session shown as a roadmap box. */
export interface RoadmapResourceNode {
  id: string
  kind: RoadmapResourceKind
  title: string
  /** Derived status, mapped onto the shared three-state visual. */
  status: RoadmapNodeStatus
  /** The resource's real lifecycle word (e.g. "Published", "Live", "Ended") for tooltips. */
  stateLabel: string
  /** Deep link to the resource's own page (role-aware; built server-side). */
  href: string
  /** Live sessions only: scheduled start (ISO) for a planned room — drives the calendar-tile node. */
  scheduledAt?: string | null
  /** Live sessions only: attendee display names — drives the facepile (both views). */
  attendees?: string[]
  /** Quiz topics only: union of the tags on the quiz's assigned questions. */
  topics?: string[]
  /** One-line "what's this about" (quiz/assignment description) for the node modal. */
  summary?: string
  /** Live-session sub-parts (polls + in-session quizzes). */
  children?: RoadmapResourceChild[]
  /** Quiz/assignment authoring time (ISO). Read only for drafts, so the
   *  publish nudge can say how long one has been sitting there (P11). */
  createdAt?: string | null
}

// ── DTO: Full roadmap data passed to client components ──────────

export interface AutoRoadmapData {
  sectionId: string
  weeks: RoadmapWeekNode[]
  /** Course resources (quizzes, assignments, live sessions) as read-only boxes */
  resources: RoadmapResourceNode[]
  /** Professor-drawn links between any two boxes (orphans already filtered out) */
  edges: RoadmapEdge[]
  /** Module-level dividers, in position order (interleave with `weeks`). */
  moduleDividers?: RoadmapModuleDivider[]
}
