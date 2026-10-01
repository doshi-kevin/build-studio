/**
 * prototype-adapter — maps live AutoRoadmapData onto the shape the roadmap
 * redesign (RoadmapPrototype) renders. Pure: no DB, no React. The professor
 * page calls this server-side; the client component imports only the types.
 *
 * Scope (professor, first slice): auto weeks → module cards; module items →
 * typed material cards (skills coloured by class-mastery tier); placed
 * quizzes/assignments/live-sessions → their columns; unplaced resources → the
 * off-map bench. Manual modules, the live-now node, video duration, and
 * reference venue ids are not mapped yet (they degrade gracefully).
 */

import type {
  AutoRoadmapData,
  RoadmapItemNode,
  RoadmapResourceNode,
  RoadmapNodeStatus,
} from '@/lib/validations/auto-roadmap'
import type { ModuleItemType } from '@/lib/validations/module'
import { detectReferenceType, extractVenue } from '@/lib/modules/url-classify'
import { parseNodeKey } from './node-drawer'
import {
  isExtraItemType,
  isStatefulItemType,
  placementByResource,
  type CoverageResult,
  type NodeCoverage,
} from './coverage'

// ── Prototype data shape (the single source of truth for these types; the
//    RoadmapPrototype component imports them from here) ──────────────────────
export type Tier = 'weak' | 'shaky' | 'strong' | 'none'
export type Kind = 'lecture' | 'video' | 'link' | 'reference' | 'note' | 'quiz' | 'assignment' | 'image'
export type IntKind = 'poll' | 'lquiz' | 'qa'
/** Node emphasis — an effect on the card itself. A property ANY node (resource,
 *  session, live room, module) can carry: shine · breathe · outline · wash are
 *  persistent; wiggle · tada play once when the node scrolls into view. */
export type EmphasisKind = 'shine' | 'breathe' | 'outline' | 'wash' | 'wiggle' | 'tada'
/** Shared tone scale for emphasis + annotations — mellow versions of the LMS
 *  palette convention: struggling = alert · needs-action = warn · good news =
 *  ok · guidance = info (brand blue) · marginalia = slate (pencil). */
export type EmphasisTone = 'alert' | 'warn' | 'ok' | 'info' | 'slate'

// ── Annotation shapes (the layer's data contract) — pure types, colocated
//    here with the other prototype data types so the server-side triage engine
//    can import them without reaching into the client component that renders
//    them. roadmap-annotations.tsx re-exports these for its own consumers. ──
export type AnnotationVariant = 'margin' | 'flag' | 'ring' | 'mark' | 'xref' | 'tally' | 'rule'
export type AnnotationSub =
  | 'ink' | 'big' | 'dots' | 'squiggle' /* margin */
  | 'banner' | 'wave' | 'tab'          /* flag (default = pin) */
  | 'bang' | 'dogear'                  /* mark */

export interface RoadmapAnnotation {
  v: AnnotationVariant
  sub?: AnnotationSub
  tone: EmphasisTone
  /** Target node title (substring match). A 'session:' prefix targets the
   *  lc-room tile explicitly (sessions often share their lecture doc's title). */
  t: string
  /** xref only: the linked node's title — rendered as the clickable link. */
  t2?: string
  /** Note text. `<b>…</b>` marks the emphasised word, `<a>…</a>` the segment
   *  that links to `href` (both rendered safely, never as raw HTML). Optional
   *  for mark·bang. */
  text?: string
  /** Destination for the note's `<a>…</a>` segment. Same-origin app paths only
   *  (`/student/…`); anything else is rendered as plain text instead. */
  href?: string
  /** tally only: the count drawn as five-bar-gate strokes. */
  n?: number
}

/** One node-emphasis assignment: an effect + tone applied to the node whose
 *  title matches `t`. The triage engine emits these; the adapter/layer apply them. */
export interface EmphasisSpec { em: EmphasisKind; tone: EmphasisTone; t: string }

export interface Resource {
  k: Kind
  t: string
  s: string
  st: 'todo' | 'prog' | 'done' | ''
  /** Node key — `module_item:{id}` for material, `quiz:{id}` / `assignment:{id}`
   *  for activities. Material keys join the card to the per-student journey map
   *  from getStudentJourneys (activities carry no mastery signal, so they dim
   *  under the student lens); activity keys let the modal fetch what the node
   *  actually contains. */
  key?: string
  fmt?: 'PDF' | 'PPT' | 'DOC' | 'XLS' | 'ZIP' | 'PNG' | 'JPG' | 'TXT' | 'MP4' | 'MOV' | 'WEBM'
  src?: 'youtube' | 'vimeo'
  dur?: string
  /** image only: the file URL shown inside the polaroid frame (falls back to placeholder art). */
  img?: string
  /** Uploaded file behind this card — the detail modal renders it inline
   *  (MaterialBody). `id` is the module-item id (server-rendered Office slides),
   *  `page` the professor-pinned opening page. */
  file?: { url: string; name: string; size?: number; id: string; page?: number }
  /** Skill label → the pages of `file` that cite it. Drives the modal's citation
   *  rail: click a skill on the right, jump to where it appears on the left. */
  topicPages?: Record<string, number[]>
  /** One-line "what's this about" (AI lecture summary / quiz-assignment description). */
  sum?: string
  /** video/link/reference: the real target to open on click (embed URL, file URL, or external link). */
  href?: string
  /** lecture only: true = classroom slide deck (cover-preview card); else a plain file. */
  slides?: boolean
  /** lecture only: page/slide count — drives the deck cover's "1 / N" badge (format-agnostic). */
  pages?: number
  /** slide-deck lecture only: slides the class actually got through, out of `pages`.
   *  Feeds the "you stopped at slide 18 of 30" / "the rest is on you" signals (P18/S17). */
  covered?: number
  /** Student view only: supplementary material THIS student can tick off. It has
   *  no professor status (`st` is '' until ticked), so every count that would
   *  otherwise filter on `st` must use this to keep the extra in its denominator
   *  — else ticking one would grow the total it belongs to. */
  tickable?: boolean
  /** Student view only: this card's questions are being written right now. Set by
   *  `withMyBaking` from what the open check panel reported — never from the item
   *  DTO, because the server's `node_check_state` is COURSE-level and cannot say
   *  WHO asked (see `withMyBaking`).
   *  Deliberately NOT routed through `em` below — the triage engine overwrites
   *  `em` by title match, so a node that is also flagged "you're stuck here"
   *  would silently lose one of the two signals, and it would be this one that
   *  should lose. Its own flag lets both show. */
  baking?: boolean
  /** PROFESSOR ONLY: `is_visible = false`, so students cannot see this material.
   *  Drawn faded with an eye-off glyph — the state an unshared live-classroom
   *  upload sits in until the professor shares it. */
  hidden?: boolean
  /** quiz/assignment, PROFESSOR ONLY: released and open, but not one student has
   *  begun (signal P21). Never set for a student — it is a class aggregate (§8).
   *  Stated on its own line in the drawer, because the one-annotation-per-node
   *  rule means a due-date flag usually wins the node on the map. */
  openUntouched?: boolean
  skills?: [string, Tier][]
  more?: number
  /** card emphasis (shine/breathe/outline/wash/wiggle/tada) + its tone. */
  em?: EmphasisKind
  emTone?: EmphasisTone
}
export interface Session {
  t: string
  s: string
  /** `live_session:{id}` — the modal parses it to fetch what actually ran. */
  key?: string
  sched?: boolean
  /** Running right now. Distinct from `!sched`, which only says the room is no
   *  longer upcoming: a live class has started but is not delivered yet, so any
   *  "how many are done" tally must not count it. */
  live?: boolean
  mon?: string
  day?: number
  ints?: [IntKind, string][]
  /** One-line "what's this about", shown in the detail modal's right rail. */
  sum?: string
  /** Where the tile's action goes: the room itself while it is live or still
   *  scheduled; its Class Insights write-up once it has ended. */
  href?: string
  /** attendee facepile: up to a few initials + the full head-count (professor view). */
  attendees?: { initials: string[]; total: number }
  /** card emphasis (shine/breathe/outline/wash/wiggle/tada) + its tone. */
  em?: EmphasisKind
  emTone?: EmphasisTone
}
export interface CourseModule {
  /** The modules row id — joins per-module extras (Athena artifacts) to their
   *  band. Absent only for the standalone demo course. */
  id?: string
  title: string
  /** Week number for the "WEEK N" kicker; null → plain "MODULE". */
  weekNumber?: number | null
  pct: number
  /** Spine colour tier from covered-item statuses: all complete → 'done', none started → 'todo', else 'prog'. */
  phase?: 'todo' | 'prog' | 'done'
  /** Excluded from the delivery percentage — professor-skipped, or nothing derivable
   *  inside it (only references/links). Suppresses the progress bar rather than showing 0%. */
  excluded?: boolean
  /** The professor explicitly marked this module "not covering" — the reason to say so. */
  skipped?: boolean
  ongoing?: boolean
  /** true when a room in this module is live right now (drives the pulsing LIVE node). */
  live?: boolean
  /** the room that is live right now (its title + queued interactions + join link). */
  liveRoom?: Session
  draft?: boolean
  /** Student view only: published but not open yet (`modules.unlock_date` is in the
   *  future). Drawn as a dimmed, collapsed shell — the road ahead. It arrives with
   *  no contents at all (the loader strips them), so nothing about it can expand,
   *  count toward a percentage, or carry an annotation. */
  locked?: boolean
  /** ISO date a locked week opens — the "Opens Aug 12" chip. Set only with `locked`. */
  opensAt?: string | null
  materials: Resource[]
  quizzes: Resource[]
  assignments: Resource[]
  sessions?: Session[]
  /** In-module dividers, drawn across the MATERIALS column (the lane that
   *  carries item order). `index` = how many material cards sit above the line. */
  dividers?: { index: number; title: string }[]
  /** card emphasis (shine/breathe/outline/wash/wiggle/tada) + its tone. */
  em?: EmphasisKind
  emTone?: EmphasisTone
}

// ── Helpers ──────────────────────────────────────────────────────
const ST: Record<RoadmapNodeStatus, 'todo' | 'prog' | 'done'> = {
  not_started: 'todo',
  in_progress: 'prog',
  complete: 'done',
}

/**
 * Item types the canvas can open a detail card for.
 *
 * Narrower than "renders as a node": a note draws on the map but has no card
 * (the canvas's detailForNode returns null for it), and legacy `assignment`
 * items / dividers aren't material cards at all. Anything that SENDS a student
 * to a node — Athena's study-focus pick, a deep link — has to rank against this
 * set, or it names material the map then can't show.
 */
export const OPENABLE_ITEM_TYPES: ReadonlySet<string> = new Set([
  'lecture', 'video', 'reference', 'link', 'image',
])

/** Module item type → prototype card kind; null = not a material card (assignment items are legacy; dividers are structural). */
function materialKind(t: ModuleItemType): Kind | null {
  switch (t) {
    case 'lecture': return 'lecture'
    case 'video': return 'video'
    case 'reference': return 'reference'
    case 'note': return 'note'
    case 'link': return 'link'
    case 'image': return 'image'
    default: return null // assignment (legacy), section_divider
  }
}

const FMT_BY_FILETYPE: Record<string, Resource['fmt']> = {
  pdf: 'PDF', ppt: 'PPT', docx: 'DOC', xlsx: 'XLS', notes: 'TXT', image: 'PNG',
}
const FMT_BY_EXT: Record<string, Resource['fmt']> = {
  pdf: 'PDF', ppt: 'PPT', pptx: 'PPT', doc: 'DOC', docx: 'DOC', xls: 'XLS', xlsx: 'XLS',
  zip: 'ZIP', png: 'PNG', jpg: 'JPG', jpeg: 'JPG', gif: 'PNG', webp: 'PNG', svg: 'PNG', txt: 'TXT',
  mp4: 'MP4', mov: 'MOV', webm: 'WEBM', avi: 'MP4', mkv: 'MP4',
}
function fmtOf(fileType?: string, fileName?: string): Resource['fmt'] | undefined {
  if (fileType && FMT_BY_FILETYPE[fileType]) return FMT_BY_FILETYPE[fileType]
  const ext = fileName?.split('.').pop()?.toLowerCase()
  return ext ? FMT_BY_EXT[ext] : undefined
}

/** Bare hostname from an external URL, for link/reference subtitles. */
function hostOf(href?: string | null): string {
  if (!href) return ''
  try { return new URL(href).hostname.replace(/^www\./, '') } catch { return href }
}

/** Classify a video URL by its real hostname (not a substring — a substring
 *  match brands `evil.tld/?x=youtube.com` with the YouTube logo). */
function videoProvider(href: string): 'youtube' | 'vimeo' | undefined {
  try {
    const h = new URL(href).hostname.toLowerCase()
    if (h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtu.be') return 'youtube'
    if (h === 'vimeo.com' || h.endsWith('.vimeo.com')) return 'vimeo'
  } catch { /* not an absolute URL (e.g. an uploaded file) → no provider */ }
  return undefined
}

const norm = (s: string) => s.trim().toLowerCase()

/** minutes → a compact duration badge ("48 min" / "2h 6m"). */
function formatDuration(min: number | undefined): string | undefined {
  if (!min || min <= 0) return undefined
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60), m = min % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

/** "Marcus Johnson" → "MJ"; single word → its first two letters; empty → "?". */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}
/** attendee names → the facepile shape (≤4 initials + full head-count); undefined when none. */
function facesOf(names: string[] | undefined): Session['attendees'] {
  if (!names || names.length === 0) return undefined
  return { initials: names.slice(0, 4).map(initialsOf), total: names.length }
}

/** topics → coloured skill chips (tier only; the % is intentionally not shown). */
function skillsOf(topics: string[] | undefined, tierOf: (t: string) => Tier): [string, Tier][] | undefined {
  if (!topics || topics.length === 0) return undefined
  return topics.map((t) => [t, tierOf(t)] as [string, Tier])
}

/** One module item → its material card. */
function itemToResource(
  it: RoadmapItemNode,
  tierOf: (t: string) => Tier,
  coverage?: CoverageResult,
  studentView?: boolean,
): Resource | null {
  const k = materialKind(it.itemType)
  if (!k) return null
  const t = it.title || '(untitled)'
  // Supplementary material a STUDENT can tick. Carried explicitly because `st`
  // is '' until they do, and every other tally filters on `st` truthiness.
  const tickable = studentView && isExtraItemType(it.itemType) ? true : undefined
  // With coverage on, a stateless item (video/image/reference/link) shows no
  // status dot at all — nothing ever contributed to it, so the state it used to
  // display was borrowed from elsewhere and read as fake progress (§11 dec. 7).
  const cov = coverage?.items.get(it.id)
  // Stateless extras carry no professor status. For a STUDENT they carry their
  // own: they're the one who went through the paper, so a tick is real
  // completion (§11 decision 8) — but it is never mastery (decision 7).
  const st: Resource['st'] = coverage
    ? isStatefulItemType(it.itemType) && cov
      ? ST[cov.status]
      : coverage.studentDone.has(it.id)
        ? 'done'
        : ''
    : ST[it.status]
  const key = `module_item:${it.id}`
  const skills = skillsOf(it.topics, tierOf)
  // The uploaded file + its citation map, so the detail modal can render the
  // real document instead of a stand-in preview.
  const file: Resource['file'] = it.file
    ? { url: it.file.url, name: it.file.name, size: it.file.size, id: it.id, page: it.pageRef?.pageNumber }
    : undefined
  const sum = it.summary || undefined

  if (k === 'lecture') {
    const fmt = fmtOf(it.fileType, it.file?.name) || 'PDF'
    const s = it.pageCount ? `${fmt} · ${it.pageCount} pages` : fmt
    // The honest fraction for a part-covered deck ("18 of 30") is the escape
    // hatch for a class that overran, which is why there's no manual override
    // (§13.2, §13.4). It ships as a NUMBER, not as prose in the subtitle: the
    // card renders it in the cover badge, and `s` is parsed by regex in several
    // places, so copy changes there are never cosmetic.
    const deck = cov?.coverage
    return {
      k, t, s, st, key, fmt,
      slides: it.useAsSlides === true,
      pages: it.pageCount || deck?.total || undefined,
      /* Forward the fraction whenever the engine derived one — not only while
         in_progress. A fully covered deck returns {covered: 30, total: 30}, and
         gating on in_progress threw that away, so the badge fell back to its
         `?? 1` default and a finished deck read "1 / 30" under a module header
         saying 100%. */
      covered: deck?.covered,
      skills, file, sum, topicPages: it.topicPageHits,
    }
  }
  if (k === 'image') {
    const fmt = fmtOf(it.fileType, it.file?.name) || 'PNG'
    // Subtitle carries the pixel size so NodeImage renders the "W×H" corner badge.
    const s = it.imageDimensions ? `${fmt} · ${it.imageDimensions}` : fmt
    return { k, t, s, st, key, fmt, img: it.file?.url, skills, tickable, file, sum }
  }
  if (k === 'video') {
    const href = it.href ?? ''
    const src = videoProvider(href)
    // Uploaded file (no embed URL) → format ribbon from its extension.
    const fmt = !src ? (fmtOf(undefined, it.file?.name) ?? 'MP4') : undefined
    // Subtitle names the source (the card already tags the "video" kind).
    const s = src === 'vimeo' ? 'Vimeo' : src === 'youtube' ? 'YouTube' : 'upload'
    // Click opens the embed URL (youtube/vimeo) or the uploaded file.
    // An uploaded video (no embed URL) plays inline in the detail modal; an
    // embed only ever opens in a new tab, so it carries no `file`.
    return { k, t, s, st, key, src, fmt, dur: formatDuration(it.videoDurationMin), href: it.href ?? it.file?.url, skills, tickable, file: src ? undefined : file, sum }
  }
  if (k === 'reference') {
    // A reference is added through the Reference modal, but many are just a
    // title + plain link. Only papers / known reading sites earn the richer
    // reference card; a plain link falls back to the lightweight link node
    // (classified from the URL — the stored referenceType is unreliable).
    if (detectReferenceType(it.href ?? '') === 'link') {
      return { k: 'link', t, s: hostOf(it.href) || 'link', st, key, href: it.href ?? undefined, tickable }
    }
    // Subtitle → the venue chip: a recognised venue name ("arXiv", "JMLR"), else
    // the bare hostname. NodeReference renders "arXiv" as its red badge. The
    // venue id (arXiv number / DOI) is intentionally omitted — it's just noise.
    const venue = extractVenue(it.href ?? '')
    const s = venue ? venue.venue : hostOf(it.href) || 'reference'
    return { k, t, s, st, key, href: it.href ?? undefined, skills, tickable, sum }
  }
  if (k === 'link') return { k, t, s: hostOf(it.href) || 'link', st, key, href: it.href ?? undefined, tickable }
  return { k, t, s: 'Note', st, key } // note
}

/** A quiz/assignment resource → its card. */
function resourceToCard(
  r: RoadmapResourceNode,
  tierOf: (t: string) => Tier,
  cov?: NodeCoverage,
  audience: 'prof' | 'stu' = 'prof',
): Resource {
  const k = r.kind === 'assignment' ? 'assignment' : 'quiz'
  return {
    k,
    t: r.title,
    // Same `type:id` form the old roadmap's node keys use — the modal needs it
    // to fetch the quiz's real questions.
    key: `${k}:${r.id}`,
    // Deliberately still the plain lifecycle word — never "nobody has started
    // this", which on a student's card would hand them a class aggregate (§8).
    s: r.stateLabel,
    st: ST[cov?.status ?? r.status],
    skills: skillsOf(r.topics, tierOf),
    sum: r.summary || undefined,
    /* Professor-facing signal P21, and PROFESSOR-ONLY for the same §8 reason.
       It reaches the client because the annotation channel allows one note per
       node, so a due-date flag routinely wins the node and this never gets said
       anywhere — least of all on an assignment, whose drawer suppresses SUMMARY
       to avoid double-rendering its description. The drawer states it on its own
       line instead. */
    openUntouched: audience === 'prof' && cov?.openUntouched ? true : undefined,
  }
}

/** Where a session tile's ACTION goes.
 *
 *  An ENDED room cannot be reopened — its presenter/viewer page is an empty
 *  classroom. What exists for it is the post-session write-up, which both roles
 *  already call "Class Insights" (professor: /report, student: /insights). A
 *  scheduled room links to the room itself. `r.href` is role-correct already
 *  (auto-roadmap-helpers builds it from the viewer's role). */
function sessionHref(r: RoadmapResourceNode, audience: 'prof' | 'stu'): string | undefined {
  if (!r.href) return undefined
  if (r.status === 'not_started') return r.href
  return `${r.href}${audience === 'prof' ? '/report' : '/insights'}`
}

/** A live-session resource → a session tile (polls/pop-quizzes summarised as chips).
 *  A scheduled (not-yet-held) room with a date renders the calendar-tile variant. */
function sessionToTile(r: RoadmapResourceNode, audience: 'prof' | 'stu'): Session {
  const kids = r.children ?? []
  const polls = kids.filter((c) => c.kind === 'live_poll').length
  const lq = kids.filter((c) => c.kind === 'live_quiz').length
  const ints: [IntKind, string][] = []
  if (polls) ints.push(['poll', `${polls} poll${polls > 1 ? 's' : ''}`])
  if (lq) ints.push(['lquiz', `${lq} live ${lq > 1 ? 'quizzes' : 'quiz'}`])
  const base = { t: r.title, s: r.stateLabel, key: `live_session:${r.id}`, href: sessionHref(r, audience), ints: ints.length ? ints : undefined, attendees: facesOf(r.attendees), sum: r.summary || undefined }

  // Scheduled/upcoming room (not yet held) with a date → calendar-tile node.
  if (r.status === 'not_started' && r.scheduledAt) {
    const d = new Date(r.scheduledAt)
    if (!isNaN(d.getTime())) {
      return {
        ...base,
        sched: true,
        mon: d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
        day: d.getDate(),
      }
    }
  }
  return base
}

/* Hidden/aux container modules that live in the off-map bench, not on the canvas.
   Identified by `modules.system_kind` (migration 20260729044216) — a marker only
   the server sets, so a professor can rename the container and its uploads still
   route correctly, and the find-or-create + unique index both key on it now.

   The exact-title match below is a FALLBACK for a row that somehow carries no
   marker (an incomplete backfill). Known residual, deliberately accepted: a
   professor who names their own week exactly "Quiz Uploads" or "Classroom Uploads"
   still has that week's material pulled off the canvas into the bench, on both
   roles' maps. It is availability-only — their own content, their own section,
   still reachable from Modules — and the alternative (dropping the fallback) trades
   it for silently stranding a genuinely unmarked container. Drop this once you're
   confident every container row is marked. */
const QUIZ_UPLOADS_TITLE = 'quiz uploads'
const CLASSROOM_UPLOADS_TITLE = 'classroom uploads'
function uploadBucket(w: { title: string; systemKind?: string }): 'quiz' | 'classroom' | null {
  if (w.systemKind === 'quiz_uploads') return 'quiz'
  if (w.systemKind === 'classroom_uploads') return 'classroom'
  const n = w.title.trim().toLowerCase()
  if (n === QUIZ_UPLOADS_TITLE) return 'quiz'
  if (n === CLASSROOM_UPLOADS_TITLE) return 'classroom'
  return null
}

export interface PrototypeData {
  course: CourseModule[]
  /** Module-level dividers: `index` = how many module bands sit above the line
   *  (course.length = below the last one). */
  moduleDividers: { index: number; title: string }[]
  /** Off-map bench — hidden "Quiz Uploads" module files (AI-quiz source uploads). */
  quizUploads: Resource[]
  /** Off-map bench — "Classroom Uploads" module files (live-classroom decks). */
  classroomUploads: Resource[]
  /** Off-map bench — course activities (quizzes/assignments) not placed on any module. */
  unplaced: Resource[]
  /** Band gap the today-line belongs in: `index` = how many module bands sit
   *  above it (same convention as moduleDividers). Derived from the calendar —
   *  the module hosting the next scheduled class. null = nothing scheduled. */
  todayIndex: number | null
}

/**
 * Map AutoRoadmapData → the prototype's course + off-map bench.
 * `tierOf` turns a topic name into its class-mastery tier (score → weak/shaky/strong/none).
 */
export function toPrototypeCourse(
  data: AutoRoadmapData,
  opts: { tierOf: (topic: string) => Tier; coverage?: CoverageResult; audience?: 'prof' | 'stu' },
): PrototypeData {
  const { tierOf, coverage, audience = 'prof' } = opts

  // Resource → owning module, from professor placement edges (module ↔ resource).
  const placedModuleByResource = placementByResource(data.edges)
  const resourcesFor = (moduleId: string, kind: RoadmapResourceNode['kind']) =>
    data.resources.filter((r) => r.kind === kind && placedModuleByResource.get(r.id) === moduleId)
  // A student layer present anywhere means we're rendering the student's view.
  const studentView = !!coverage && [...coverage.modules.values()].some((m) => m.studentPct !== undefined)
  const itemsToCards = (items: RoadmapItemNode[]) =>
    items
      .map((it) => {
        const card = itemToResource(it, tierOf, coverage, studentView)
        /* Attached here rather than in each of itemToResource's per-kind returns —
           hidden-ness is a property of the row, not of the card's shape. Only the
           professor loader selects is_visible, so this is never set for a student
           (whose loader filters hidden items out entirely). */
        return card && it.hiddenFromStudents ? { ...card, hidden: true } : card
      })
      .filter((r): r is Resource => r !== null)
  /** Derived status when coverage is on, else the assembled (stored) one. */
  const statusOf = (r: RoadmapResourceNode) => coverage?.resources.get(r.id)?.status ?? r.status

  /** True for the item types that land in the RIGHT (materials) column — the lane
   *  an in-module divider is drawn across. Notes hang on the spine instead. */
  const inRightColumn = (it: RoadmapItemNode) => {
    const k = materialKind(it.itemType)
    return k !== null && k !== 'note'
  }

  const course: CourseModule[] = []
  // Position of each RENDERED module, parallel to `course` — module-level
  // dividers interleave by position, and the upload buckets below never render.
  const renderedPositions: number[] = []
  const quizUploads: Resource[] = []
  const classroomUploads: Resource[] = []
  // Per rendered module (parallel to `course`): the earliest upcoming scheduled
  // live-class start, used to place the "ongoing" frontier highlight below.
  const nextSchedByModule: number[] = []
  const now = Date.now()

  for (const w of data.weeks) {
    // The hidden "Quiz Uploads" / "Classroom Uploads" container modules never sit
    // on the canvas — their files go to the off-map bench.
    const bucket = uploadBucket(w)
    if (bucket === 'quiz') { quizUploads.push(...itemsToCards(w.items)); continue }
    if (bucket === 'classroom') { classroomUploads.push(...itemsToCards(w.items)); continue }

    const quizzes = resourcesFor(w.id, 'quiz').map((r) =>
      resourceToCard(r, tierOf, coverage?.resources.get(r.id), audience),
    )
    const assignments = resourcesFor(w.id, 'assignment').map((r) =>
      resourceToCard(r, tierOf, coverage?.resources.get(r.id), audience),
    )
    // A room that is live right now (status → in_progress) becomes the pulsing
    // LIVE node, not a regular session tile; the rest (ended/scheduled) are tiles.
    const sessionRes = resourcesFor(w.id, 'live_session')
    const liveRes = sessionRes.find((r) => r.status === 'in_progress')
    const sessions = sessionRes.filter((r) => r.id !== liveRes?.id).map((r) => sessionToTile(r, audience))
    const liveRoom: Session | undefined = liveRes
      ? { ...sessionToTile(liveRes, audience), sched: false, live: true, href: liveRes.href ?? undefined }
      : undefined

    // Earliest upcoming scheduled room in this module (drives the "ongoing" frontier).
    let nextSched = Infinity
    for (const r of sessionRes) {
      if (r.status !== 'not_started' || !r.scheduledAt) continue
      const ms = new Date(r.scheduledAt).getTime()
      if (!Number.isNaN(ms) && ms >= now && ms < nextSched) nextSched = ms
    }

    // Completion % over everything that counts. With coverage on this is the
    // DELIVERY percentage: only nodes a professor actually delivers (lectures +
    // placed quizzes/assignments/sessions) count, so a week's supplementary
    // papers and links no longer drag it down (§13.1, §13.3).
    const mod = coverage?.modules.get(w.id)
    const statefulItems = w.items.filter((it) =>
      coverage ? isStatefulItemType(it.itemType) : it.itemType !== 'note' && materialKind(it.itemType),
    )
    const covered: RoadmapNodeStatus[] = [
      ...statefulItems.map((it) => coverage?.items.get(it.id)?.status ?? it.status),
      ...resourcesFor(w.id, 'quiz').map(statusOf),
      ...resourcesFor(w.id, 'assignment').map(statusOf),
      ...resourcesFor(w.id, 'live_session').map(statusOf),
    ]
    const done = covered.filter((s) => s === 'complete').length
    const started = covered.filter((s) => s !== 'not_started').length
    // A student sees THEIR coverage (delivered work + the extras they finished);
    // the professor sees delivery. Same engine, two denominators (§10).
    const pct = mod
      ? (mod.studentPct ?? mod.pct)
      : covered.length ? Math.round((100 * done) / covered.length) : 0
    // A week of nothing but extras has no delivery, so it's excluded from the
    // professor's percentage — but the STUDENT still has things to go through
    // there, so it keeps a real number for them rather than reading "—".
    const hasStudentPct = mod?.studentPct !== undefined
    const excluded = mod ? mod.skipped || (mod.excluded && !hasStudentPct) : undefined

    // Spine tier: green only when everything is complete; grey when nothing's
    // begun; blue for anything in between (some done and/or some in progress).
    // A skipped or nothing-to-derive module stays grey rather than claiming a
    // completion it never earned.
    const phase: CourseModule['phase'] = mod
      ? excluded
        ? 'todo'
        : hasStudentPct
          // Keep the delivery status in play: a module the class has STARTED is
          // blue for the student too, even before they've finished anything of
          // their own. Only pct decides the two ends.
          ? pct === 100 ? 'done' : pct === 0 && mod.status === 'not_started' ? 'todo' : 'prog'
          : ST[mod.status]
      : covered.length > 0 && done === covered.length
        ? 'done'
        : started === 0
          ? 'todo'
          : 'prog'

    // In-module dividers → an index in the materials column. Walking the items
    // in order gives, for each item, how many material cards end at or above it;
    // that count IS the divider's slot (a divider after a note or a legacy item
    // lands on the same line as the material before it, which is what it means).
    let rightCount = 0
    const rightCountThrough = new Map<string, number>()
    for (const it of w.items) {
      if (inRightColumn(it)) rightCount++
      rightCountThrough.set(it.id, rightCount)
    }
    const dividers = (w.dividers ?? []).map((d) => ({
      index: d.afterItemId ? rightCountThrough.get(d.afterItemId) ?? 0 : 0,
      title: d.title,
    }))

    course.push({
      id: w.id,
      title: w.title,
      weekNumber: w.weekNumber,
      pct,
      phase,
      excluded: excluded || undefined,
      skipped: mod?.skipped || undefined,
      /* Unpublished: drives the "hidden from students" kicker, and progressOf
         skips it so a week the class can't see yet stays out of the headline
         denominator instead of reading as work not started. */
      draft: w.draft || undefined,
      /* Not open yet. Unlike `draft` it stays on the canvas: the point is to show
         the student there IS more course ahead. It carries no honest percentage
         (its contents never arrived), so the card shows the open date instead. */
      locked: w.locked || undefined,
      opensAt: w.locked ? w.unlockDate ?? null : undefined,
      live: !!liveRoom,
      liveRoom,
      materials: itemsToCards(w.items),
      quizzes,
      assignments,
      sessions: sessions.length ? sessions : undefined,
      dividers: dividers.length ? dividers : undefined,
    })
    renderedPositions.push(w.position)
    nextSchedByModule.push(nextSched)
  }

  // "Ongoing" (the shiny frontier) = the module right before the one that hosts
  // the next scheduled live class — that's where the class currently is. No
  // scheduled class, or it's in the very first module → no highlight.
  let nextIdx = -1
  let best = Infinity
  nextSchedByModule.forEach((ms, i) => { if (ms < best) { best = ms; nextIdx = i } })
  if (nextIdx > 0) course[nextIdx - 1].ongoing = true

  /* Where "now" falls on the map: immediately ABOVE the module hosting the next
     scheduled class, since everything below that line is still to come. This is
     the calendar's own answer, taken from real room dates rather than from how
     much has been delivered — a course whose every week has some delivery would
     otherwise put today at the very bottom of the map. `null` when no class is
     on the calendar at all; the canvas then falls back to the delivery frontier. */
  const todayIndex = nextIdx >= 0 ? nextIdx : null

  // Off-map bench: course activities (quizzes/assignments) not placed on any module.
  const unplaced: Resource[] = data.resources
    .filter((r) => (r.kind === 'quiz' || r.kind === 'assignment') && !placedModuleByResource.has(r.id))
    .map((r) => resourceToCard(r, tierOf, coverage?.resources.get(r.id), audience))

  // Module-level dividers → the band gap they sit in. `<=` matches the Modules
  // page tie-break (a module and a divider on the same position render module
  // first), which happens until the next drag rewrites both onto 0..n-1.
  const moduleDividers = (data.moduleDividers ?? []).map((d) => ({
    index: renderedPositions.filter((p) => p <= d.position).length,
    title: d.title,
  }))

  return { course, moduleDividers, quizUploads, classroomUploads, unplaced, todayIndex }
}

/**
 * Mark the nodes whose questions THIS session is waiting on.
 *
 * The state is client-held on purpose. `module_items.node_check_state` — the only
 * server record that a pool job is running — is COURSE-level: the first student to
 * open a node flips it to 'pending' and the generated pool is shared by the whole
 * section (getNodeCheckForStudent). So it can answer "is this still being
 * written", but never "did YOU ask for it". Reading it into the roadmap DTO put
 * "writing you a few questions on this…" on every classmate's map for a click they
 * never made, so the DTO doesn't carry it at all: the open check panel reports the
 * ids it started (its `onBaking` callback) and the map polls a targeted action to
 * learn when each one lands.
 *
 * `mine` is keyed by the BARE module-item id — what the panel knows itself by —
 * while a card's `key` is `module_item:{id}`, hence `parseNodeKey`. Get that bridge
 * wrong and no node ever shows the state, which looks exactly like the feature
 * being broken.
 *
 * The cost is that a reload forgets: the note doesn't come back. That is the right
 * way round — the job takes seconds, so after a reload the questions are simply
 * there, and a stale note claiming work nobody started is the failure worth
 * avoiding.
 */
export function withMyBaking(
  course: CourseModule[],
  mine: Readonly<Record<string, true>>,
): CourseModule[] {
  const ids = Object.keys(mine)
  if (ids.length === 0) return course
  return course.map((m) => ({
    ...m,
    materials: m.materials.map((r) =>
      r.key && mine[parseNodeKey(r.key).id] ? { ...r, baking: true as const } : r,
    ),
  }))
}

/** Build a topic→tier resolver from class mastery scores keyed by (normalised) name. */
export function tierResolver(
  scoreByName: Map<string, number | null>,
  masteryTier: (score: number | null | undefined) => Tier,
): (topic: string) => Tier {
  return (topic: string) => masteryTier(scoreByName.get(norm(topic)) ?? null)
}
