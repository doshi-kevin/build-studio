/**
 * Auto Roadmap Helpers — shared data assembly logic for the auto-generated roadmap.
 *
 * Used by both professor and student server actions. Merges modules + items into
 * the AutoRoadmapData DTO. Also builds topic-to-page maps by searching extraction
 * pages so topic chips can deep-link into the correct PDF page.
 *
 * Module and item status is NOT stored (§11 decision 2) — nothing writes it since
 * the hand-ticking canvas retired, so it assembles as 'not_started' and the real
 * value comes from the coverage layer (`loadRoadmapCoverage`) on read.
 */

import type { ModuleItemType } from '@/lib/validations/module'
import type {
  AutoRoadmapData,
  RoadmapEdge,
  RoadmapLinkEndpointType,
  RoadmapNodeStatus,
  RoadmapResourceChild,
  RoadmapResourceNode,
  RoadmapWeekNode,
  RoadmapItemNode,
  RoadmapItemDivider,
} from '@/lib/validations/auto-roadmap'
import { placementByResource } from '@/lib/roadmap/coverage'
import { lockedModuleIds } from '@/lib/modules/unlock'

// ── URL Computation ─────────────────────────────────────────────

/**
 * Compute the click target for a module item.
 * Matches the logic in components/shared/modules/module-item-display.ts.
 *
 * Returns:
 * - href: external URL to open in new tab (null if file-based or non-clickable)
 * - file: file details for MaterialViewer (null if no uploaded file)
 */
export function computeItemHref(
  itemType: ModuleItemType,
  content: Record<string, unknown>,
): { href: string | null; file: RoadmapItemNode['file'] } {
  const fileUrl = content.fileUrl as string | undefined
  const fileName = (content.fileName as string) || 'file'
  const fileSize = content.fileSize ? Number(content.fileSize) : undefined

  // Item has an uploaded file → open via MaterialViewer
  if (fileUrl) {
    return {
      href: null,
      file: { url: fileUrl, name: fileName, size: fileSize },
    }
  }

  // Video with external embed URL (YouTube, Vimeo)
  const videoUrl = content.videoUrl as string | undefined
  if (itemType === 'video' && videoUrl) {
    return { href: videoUrl, file: null }
  }

  // Link or reference with external URL
  const itemUrl = content.url as string | undefined
  if ((itemType === 'link' || itemType === 'reference') && itemUrl) {
    return { href: itemUrl, file: null }
  }

  // Non-clickable items (notes, assignments, etc.)
  return { href: null, file: null }
}

// ── Topic Page Search ────────────────────────────────────────────

interface ExtractionPage {
  pageNumber: number
  text: string
  headings: string[]
}

/* Headings that mark a page as a signpost rather than the teaching itself: the
   term is listed there, never explained. This is why first-mention was the wrong
   anchor — a deck's "Learning Objectives" slide names every concept in the
   lecture, so it won every topic. */
const SIGNPOST_HEADING =
  /learning objective|objectives|overview|outline|agenda|table of contents|contents|topics covered|what we.{0,3}ll cover|roadmap|recap|in this (lecture|chapter|module|section)|references|bibliography|further reading|acknowledg/i

/* Phrases that follow a term when the page is DEFINING it, matched in a short
   window after each mention — "Perplexity is a measure of…" scores, a bullet
   that merely names it does not. */
const DEFINITION_CUE =
  /\b(is|are)\s+(a|an|the|defined|used|computed|calculated|given|measured|simply)\b|\b(defined as|refers to|denotes|we define|definition of|means that|formally|intuitively|in other words)\b/i
const CUE_WINDOW = 120

/* Weights. A heading naming the topic is the strongest available "this page is
   about it" signal, so it outranks any amount of passing mention; the signpost
   penalty outranks both so an objectives slide can never win on density alone. */
const HEADING_SCORE = 3
const DEFINITION_SCORE = 2
const MAX_DENSITY_SCORE = 3
const SIGNPOST_PENALTY = 4

/** Non-overlapping occurrences of `needle` in `haystack` (both already lowercased).
 *  indexOf, not a regex — topic names carry regex metacharacters ("C++", "O(n)"). */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return count
    count++
    from = at + needle.length
  }
}

/** True when any mention of `needle` is followed by definition-ish phrasing. */
function hasDefinitionCue(text: string, needle: string): boolean {
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at === -1) return false
    const end = at + needle.length
    if (DEFINITION_CUE.test(text.slice(end, end + CUE_WINDOW))) return true
    from = end
  }
}

/** How strongly this page reads as the page that EXPLAINS the topic.
 *  `null` = the page never names it at all, so it isn't a candidate. */
function scoreTopicPage(needle: string, page: ExtractionPage): number | null {
  const text = page.text.toLowerCase()
  const inHeading = page.headings.some((h) => h.toLowerCase().includes(needle))
  const mentions = countOccurrences(text, needle)
  if (!inHeading && mentions === 0) return null

  let score = inHeading ? HEADING_SCORE : 0
  score += Math.min(MAX_DENSITY_SCORE, Math.max(0, mentions - 1))
  if (mentions > 0 && hasDefinitionCue(text, needle)) score += DEFINITION_SCORE
  /* Skipped when the page's own heading names the topic — then the page IS about
     it ("Overview of Perplexity"), signpost wording or not. */
  if (!inHeading && page.headings.some((h) => SIGNPOST_HEADING.test(h))) score -= SIGNPOST_PENALTY
  return score
}

/**
 * Find the page that best EXPLAINS a topic, not the first that mentions it
 * (issue #112: a term listed in "Learning Objectives" on page 2 but taught on
 * page 36 used to anchor to page 2, which teaches a student nothing).
 *
 * LAST RESORT, and both halves of that matter. It can only find a topic whose
 * name appears VERBATIM, and the concept extractor names things the way a
 * professor would, not the way the slide does ("Maximum Path Length" vs a table
 * header reading "Max path"). Better sources are tried ahead of it in
 * readItemTopicPages; this is for items that predate them.
 *
 * When it IS reached, it ranks rather than taking the first hit. Deliberately
 * deterministic — no extra model call. The three signals available from
 * extraction (topic in a heading, mention density, definition phrasing next to a
 * mention, minus a signpost-page penalty) separate a teaching page from an index
 * entry, and a page that only mentions the topic still wins over no page at all.
 * Ties keep the earliest page, so a document with no distinguishing signal
 * behaves exactly as before.
 */
function findTopicPage(topicName: string, pages: ExtractionPage[]): number | undefined {
  const needle = topicName.trim().toLowerCase()
  if (!needle) return undefined
  let best: { pageNumber: number; score: number } | undefined
  for (const page of pages) {
    const score = scoreTopicPage(needle, page)
    if (score === null) continue
    if (!best || score > best.score) best = { pageNumber: page.pageNumber, score }
  }
  return best?.pageNumber
}

/**
 * The pages the CONCEPT EXTRACTOR itself cited for each concept, off
 * `module_items.content.concepts` (written at upload by the concept pass, shape
 * validated there by storedQuizConceptSchema).
 *
 * This is the best source there is and it was being ignored: the model that named
 * the concept had just read the page and quoted its marker, so there is no
 * matching step left to get wrong. `content.topics` is literally
 * `concepts.slice(0, 7).map(c => c.name)` (extraction/worker.ts), so the names
 * line up exactly with the chips the rail renders.
 *
 * Validated rather than cast: this is JSONB that predates the current shape, and
 * a malformed entry would reach the viewer as a page number to scroll to.
 */
function readConceptPages(raw: unknown): Record<string, number[]> {
  if (!Array.isArray(raw)) return {}
  const out: Record<string, number[]> = {}
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const { name, pages } = entry as { name?: unknown; pages?: unknown }
    if (typeof name !== 'string' || !name.trim() || !Array.isArray(pages)) continue
    const clean = pages.filter((p): p is number => Number.isInteger(p) && (p as number) >= 1)
    if (clean.length > 0) out[name] = clean
  }
  return out
}

/**
 * Which pages cover each of an item's topics, best source first:
 *
 * Three tiers, in this order. Citations stay FIRST: they are exact, while a
 * semantic anchor is a similarity guess. Dropping that tier is what left 5 of 7
 * skills on a real deck with no page at all.
 *
 *   1. the extractor's own citations (`content.concepts[].pages`) — grounded
 *   2. semantic anchors the caller matched against the stored embeddings
 *   3. verbatim search (findTopicPage) — legacy items only
 *
 * Resolved PER TOPIC, not per item: a professor-added skill that extraction never
 * saw still gets the semantic anchor, while every extracted concept keeps its
 * exact citation. Before this, one non-empty semantic map suppressed the others
 * for the whole item — and where nothing produced semantic hits (PPTX decks are
 * never page-embedded), every topic fell through to the verbatim search, which
 * left 5 of 7 with no page at all on a measured 4-slide deck.
 */
function readItemTopicPages(
  content: { concepts?: unknown },
  topics: string[] | undefined,
  pages: ExtractionPage[] | undefined,
  semantic: Record<string, number[]> = {},
): Record<string, number[]> | undefined {
  if (!topics || topics.length === 0) return undefined
  const cited = readConceptPages(content.concepts)
  const out: Record<string, number[]> = {}

  for (const topic of topics) {
    const hit = cited[topic] ?? semantic[topic]
    if (hit && hit.length > 0) {
      out[topic] = hit
      continue
    }
    if (pages && pages.length > 0) {
      const page = findTopicPage(topic, pages)
      if (page !== undefined) out[topic] = [page]
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Read the stored topic→page anchors off a material's `content`.
 *
 * Written at index time by roadmap-rail-v1 (src/lib/pinecone/topic-pages.ts).
 * Validated rather than cast: this is JSONB that predates the current shape —
 * an item indexed by the retired pgvector path, or by the JS-cosine cache
 * before it, can hold anything, and a malformed entry would reach the viewer as
 * a page number to scroll to.
 */
function readTopicPages(raw: unknown): Record<string, number[]> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, number[]> = {}
  for (const [topic, pages] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(pages)) continue
    const clean = pages.filter((p): p is number => Number.isInteger(p) && (p as number) >= 1)
    if (clean.length > 0) out[topic] = clean
  }
  return Object.keys(out).length > 0 ? out : undefined
}

// ── Course-Resource Nodes ────────────────────────────────────────
//
// Quizzes, assignments, and live sessions become read-only roadmap boxes. Their
// status is DERIVED from each resource's real lifecycle state and mapped onto the
// shared not_started / in_progress / complete visual — never professor-editable.
// Topics attach to the resource that owns them (a quiz's topics = the union of its
// question tags); nothing is force-fit onto uploaded module items.

export interface RawQuiz {
  id: string
  title: string | null
  status: string | null
  description?: string | null
  /** quizzes.due_date (ISO) — a published quiz past its due date reads as complete. */
  due_date?: string | null
  /** When it was authored — only read for drafts, to age the publish nudge (P11). */
  created_at?: string | null
}

export interface RawAssignment {
  id: string
  title: string | null
  status: string | null
  description?: string | null
  /** When it was authored — only read for drafts, to age the publish nudge (P11). */
  created_at?: string | null
}

export interface RawSession {
  id: string
  title: string | null
  status: string | null
  /** lc_rooms.scheduled_at — when a planned room is due to start (ISO). */
  scheduledAt?: string | null
  /** lc_attendance roster (display names, professor view only) — drives the facepile. */
  attendees?: string[]
}

export interface RawSessionChild {
  id: string
  session_id: string
  /** Poll question or live-quiz title. */
  label: string | null
  is_active: boolean | null
  closed_at: string | null
}

/** Map a resource's real lifecycle word onto the shared three-state visual.
 *  `dueDate` (quiz only) promotes a published quiz to complete once it's past. */
function deriveResourceStatus(kind: 'quiz' | 'assignment' | 'session', raw: string | null, dueDate?: string | null): RoadmapNodeStatus {
  const s = (raw || '').toLowerCase()
  if (kind === 'quiz') {
    if (s !== 'published') return 'not_started'
    // A published quiz is in progress while open, and complete once its due date
    // has passed (students can no longer submit → the quiz is done).
    if (dueDate && new Date(dueDate).getTime() < Date.now()) return 'complete'
    return 'in_progress'
  }
  if (kind === 'assignment') {
    if (s === 'closed' || s === 'archived') return 'complete'
    if (s === 'published') return 'in_progress'
    return 'not_started'
  }
  // session
  if (s === 'ended') return 'complete'
  if (s === 'live') return 'in_progress'
  return 'not_started' // scheduled | cancelled
}

/** Coerce a stored duration (number OR numeric string — legacy data has both) to positive minutes. */
function durationMin(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Human-readable lifecycle word for tooltips. */
function stateLabelOf(raw: string | null): string {
  const s = (raw || '').trim()
  if (!s) return 'Draft'
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** A poll/live-quiz child: open → in_progress, closed → complete, else not_started. */
function deriveChildStatus(is_active: boolean | null, closed_at: string | null): RoadmapNodeStatus {
  if (is_active) return 'in_progress'
  if (closed_at) return 'complete'
  return 'not_started'
}

/** Distinct, trimmed skill names — used for a quiz node's skill chips. */
function distinctNames(names: string[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of names ?? []) {
    if (typeof n !== 'string') continue
    const trimmed = n.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * Shape raw resource rows into roadmap resource nodes. Pure and role-aware:
 * `role` only picks the deep-link URL prefix (professor vs student route).
 * Callers are responsible for having already filtered to what the viewer may see
 * (e.g. students get only published quizzes/assignments).
 */
export function buildResourceNodes(
  role: 'professor' | 'student',
  sectionId: string,
  input: {
    quizzes: RawQuiz[]
    /** quizId → canonical skill names mapped to it via activity_skills. */
    quizSkillNames: Map<string, string[]>
    assignments: RawAssignment[]
    sessions: RawSession[]
    polls: RawSessionChild[]
    liveQuizzes: RawSessionChild[]
  },
): RoadmapResourceNode[] {
  const base = `/${role}/courses/${sectionId}`
  const nodes: RoadmapResourceNode[] = []

  for (const q of input.quizzes) {
    // Skip unnamed quizzes — an "Untitled quiz" is a placeholder draft (a
    // "Create quiz" click eagerly makes one, and its module placement may be
    // set from the setup spotlight before it's named). It shouldn't appear as a
    // roadmap node until it has a real name, even if it's already placed.
    const quizName = q.title?.trim()
    if (!quizName || quizName === 'Untitled quiz') continue
    // A quiz node's chips are its canonical skills (activity_skills → skills),
    // not free-text quiz_questions.tags.
    const skills = distinctNames(input.quizSkillNames.get(q.id))
    nodes.push({
      id: q.id,
      kind: 'quiz',
      title: q.title || 'Untitled quiz',
      status: deriveResourceStatus('quiz', q.status, q.due_date),
      stateLabel: stateLabelOf(q.status),
      href: `${base}/quizzes/${q.id}`,
      topics: skills.length > 0 ? skills : undefined,
      summary: q.description?.trim() || undefined,
      createdAt: q.created_at ?? null,
    })
  }

  for (const a of input.assignments) {
    // Same rule for assignments: an unnamed/placeholder assignment doesn't
    // belong on the roadmap until it has a real name, placed or not.
    const assignmentName = a.title?.trim()
    if (!assignmentName || assignmentName === 'Untitled assignment') continue
    nodes.push({
      id: a.id,
      kind: 'assignment',
      title: a.title || 'Untitled assignment',
      status: deriveResourceStatus('assignment', a.status),
      stateLabel: stateLabelOf(a.status),
      href: `${base}/assignments/${a.id}`,
      summary: a.description?.trim() || undefined,
      createdAt: a.created_at ?? null,
    })
  }

  // Group session children so each session box carries its polls + pop-quizzes.
  const childrenBySession = new Map<string, RoadmapResourceChild[]>()
  const addChild = (rows: RawSessionChild[], kind: RoadmapResourceChild['kind'], fallback: string) => {
    for (const r of rows) {
      const list = childrenBySession.get(r.session_id) || []
      list.push({
        id: r.id,
        kind,
        title: r.label?.trim() || fallback,
        status: deriveChildStatus(r.is_active, r.closed_at),
      })
      childrenBySession.set(r.session_id, list)
    }
  }
  addChild(input.polls, 'live_poll', 'Poll')
  addChild(input.liveQuizzes, 'live_quiz', 'Pop quiz')

  for (const s of input.sessions) {
    const children = childrenBySession.get(s.id)
    nodes.push({
      id: s.id,
      kind: 'live_session',
      title: s.title || 'Live session',
      status: deriveResourceStatus('session', s.status),
      stateLabel: stateLabelOf(s.status),
      href: `${base}/live-classroom/${s.id}`,
      scheduledAt: s.scheduledAt ?? null,
      attendees: s.attendees && s.attendees.length > 0 ? s.attendees : undefined,
      children: children && children.length > 0 ? children : undefined,
    })
  }

  return nodes
}

// ── Data Assembly ───────────────────────────────────────────────

interface RawModule {
  id: string
  title: string
  description: string
  week_number: number | null
  position: number
  /** Professor loader only — the student loader never fetches unpublished
   *  modules, so its absence there correctly means "nothing is a draft". */
  is_published?: boolean
  /** Student loader only — a future date means the week is published but not open
   *  yet, so it is assembled as a locked shell (see RoadmapWeekNode.locked). The
   *  professor loader doesn't select it, so their map never locks. */
  unlock_date?: string | null
  /** App-owned container marker; see RoadmapWeekNode.systemKind. */
  system_kind?: string | null
}

interface RawItem {
  id: string
  module_id: string
  item_type: string
  title: string
  description: string
  position: number
  content: unknown
  /** Professor loader only — the student loader never fetches hidden items. */
  is_visible?: boolean
}

interface RawEdge {
  id: string
  from_node_type: string
  from_node_id: string
  to_node_type: string
  to_node_id: string
  edge_type?: string | null
  position?: number | null
}

interface RawModuleDivider {
  id: string
  title: string
  position: number
}

/**
 * Merge modules + items and professor-drawn links into AutoRoadmapData. Runs in
 * memory — no extra queries.
 *
 * Edges connect any two boxes (auto module/item or a course resource); an edge is
 * kept only when BOTH endpoints resolve to a live box passed here, so deleted or
 * student-hidden boxes drop their links automatically — which is also what
 * retired the manual module/lecture endpoints.
 */
export function assembleRoadmapData(
  sectionId: string,
  modules: RawModule[],
  items: RawItem[],
  edges: RawEdge[] = [],
  resources: RoadmapResourceNode[] = [],
  moduleDividers: RawModuleDivider[] = [],
): AutoRoadmapData {
  // Group items by module_id. section_dividers stay OUT of `items` — they are
  // structural, not content — and are collected separately with the item they
  // follow, so the roadmap can draw them between the right two cards. `items`
  // arrives in position order, so "the last item seen in this module" is it.
  const itemsByModule: Record<string, RawItem[]> = {}
  const dividersByModule: Record<string, RoadmapItemDivider[]> = {}
  const lastItemByModule: Record<string, string | null> = {}
  for (const item of items) {
    if (item.item_type === 'section_divider') {
      const label = ((item.content || {}) as { label?: unknown }).label
      const title = (typeof label === 'string' && label.trim()) || item.title?.trim() || 'Section'
      if (!dividersByModule[item.module_id]) dividersByModule[item.module_id] = []
      dividersByModule[item.module_id].push({
        id: item.id,
        title,
        afterItemId: lastItemByModule[item.module_id] ?? null,
      })
      continue
    }
    if (!itemsByModule[item.module_id]) itemsByModule[item.module_id] = []
    itemsByModule[item.module_id].push(item)
    lastItemByModule[item.module_id] = item.id
  }

  const lockedIds = lockedModuleIds(modules)

  // Assemble weeks
  const weeks: RoadmapWeekNode[] = modules.map((m) => {
    const locked = lockedIds.has(m.id)
    const moduleItems = locked ? [] : itemsByModule[m.id] || []
    return {
      ...(locked ? { locked: true, unlockDate: m.unlock_date ?? null } : {}),
      id: m.id,
      title: m.title,
      description: m.description || '',
      weekNumber: m.week_number,
      position: m.position,
      status: 'not_started', // derived on read (coverage layer), never stored
      /* Only when the loader actually selected it — `undefined` (student path)
         must not read as "published", and `false` must not be lost. */
      ...(m.is_published === undefined ? {} : { draft: !m.is_published }),
      ...(m.system_kind === 'quiz_uploads' || m.system_kind === 'classroom_uploads'
        ? { systemKind: m.system_kind }
        : {}),
      items: moduleItems.map((item): RoadmapItemNode => {
        const content = (item.content || {}) as Record<string, unknown>
        const { href, file } = computeItemHref(item.item_type as ModuleItemType, content)
        const rawTopics = content.topics
        const topics = Array.isArray(rawTopics)
          ? (rawTopics as string[]).filter((t) => typeof t === 'string' && t.trim())
          : undefined

        // Read page reference and extraction data from content
        const rawPageRef = content.pageRef as { pageNumber: number; heading?: string } | undefined
        const extraction = content.extraction as {
          status?: string
          pages?: ExtractionPage[]
          metadata?: { pageCount?: number }
          images?: unknown[]
          formulas?: unknown[]
          tables?: unknown[]
          code?: unknown[]
        } | undefined
        const hasExtraction = extraction?.status === 'completed'
        const pageCount = hasExtraction
          ? (extraction?.metadata?.pageCount || extraction?.pages?.length || undefined)
          : undefined

        // One-line AI summary (best-effort; absent on older/failed extractions).
        const rawSummary = content.summary
        const summary = typeof rawSummary === 'string' && rawSummary.trim()
          ? rawSummary.trim()
          : undefined

        // Material-at-a-glance counts — only the positive ones, for the detail panel.
        let material: RoadmapItemNode['material']
        if (hasExtraction && extraction) {
          const m: NonNullable<RoadmapItemNode['material']> = {}
          if (extraction.images?.length) m.images = extraction.images.length
          if (extraction.formulas?.length) m.formulas = extraction.formulas.length
          if (extraction.tables?.length) m.tables = extraction.tables.length
          if (extraction.code?.length) m.code = extraction.code.length
          if (Object.keys(m).length > 0) material = m
        }

        /* topicPageHits: the pages that cover each topic, for the material-viewer
           reference rail. Resolved per topic through the three-tier precedence in
           readItemTopicPages — citations first, then semantic, then verbatim.
           The semantic tier used to be a caller-supplied map backed by pgvector
           (`getTopicPageHits`). That store is retired (#435), so the anchors now
           come from `content.topicPages`, computed against Pinecone when the
           material was indexed and stored on the item — same tier, same
           precedence, no query at render. */
        const topicPageHits = readItemTopicPages(
          content,
          topics,
          hasExtraction ? extraction?.pages : undefined,
          readTopicPages(content.topicPages) ?? {},
        )

        return {
          id: item.id,
          title: item.title || '',
          description: item.description || '',
          itemType: item.item_type as ModuleItemType,
          position: item.position,
          status: 'not_started', // derived on read (coverage layer), never stored
          fileType: typeof content.fileType === 'string' ? content.fileType : undefined,
          useAsSlides: content.useAsSlides === true || undefined,
          /* Only when the loader selected it — `undefined` (student path, where
             hidden items are filtered out) must not read as "hidden". */
          hiddenFromStudents: item.is_visible === false || undefined,
          imageDimensions:
            typeof content.width === 'number' && typeof content.height === 'number' && content.width > 0 && content.height > 0
              ? `${content.width}×${content.height}`
              : undefined,
          videoDurationMin: durationMin(content.duration),
          href,
          file,
          topics: topics && topics.length > 0 ? topics : undefined,
          topicPageHits,
          pageRef: rawPageRef?.pageNumber ? rawPageRef : undefined,
          hasExtraction: hasExtraction || undefined,
          pageCount,
          summary,
          material,
        }
      }),
      dividers: locked ? [] : dividersByModule[m.id] || [],
    }
  })

  // ── Professor-drawn links (any two boxes) ─────────────────────
  const mappedEdges: RoadmapEdge[] = edges.map((e) => ({
    id: e.id,
    fromType: e.from_node_type as RoadmapLinkEndpointType,
    fromId: e.from_node_id,
    toType: e.to_node_type as RoadmapLinkEndpointType,
    toId: e.to_node_id,
    edgeType: e.edge_type === 'related' ? 'related' : 'prerequisite',
    position: e.position ?? null,
  }))

  /* A quiz, assignment or live class pinned under a locked week is unopened
     content too, so it leaves with the week's items. Its placement edge then
     fails the liveKeys check below and drops itself. */
  const placedModule = lockedIds.size > 0 ? placementByResource(mappedEdges) : null
  const openResources = placedModule
    ? resources.filter((r) => !lockedIds.has(placedModule.get(r.id) ?? ''))
    : resources

  // Live endpoint keys across every rendered box kind.
  const liveKeys = new Set<string>()
  for (const m of modules) liveKeys.add(`module:${m.id}`)
  for (const week of weeks) for (const item of week.items) liveKeys.add(`module_item:${item.id}`)
  for (const r of openResources) {
    const type = r.kind // 'quiz' | 'assignment' | 'live_session'
    liveKeys.add(`${type}:${r.id}`)
    for (const child of r.children || []) liveKeys.add(`${child.kind}:${child.id}`)
  }

  const resolvedEdges: RoadmapEdge[] = []
  const seenPair = new Set<string>()
  for (const e of mappedEdges) {
    const fromKey = `${e.fromType}:${e.fromId}`
    const toKey = `${e.toType}:${e.toId}`
    if (!liveKeys.has(fromKey) || !liveKeys.has(toKey)) continue // orphan — drop
    const pairKey = `${fromKey}->${toKey}`
    if (seenPair.has(pairKey)) continue // defensive de-dupe
    seenPair.add(pairKey)
    resolvedEdges.push(e)
  }

  return {
    sectionId,
    weeks,
    resources: openResources,
    edges: resolvedEdges,
    moduleDividers: [...moduleDividers]
      .sort((a, b) => a.position - b.position)
      .map((d) => ({ id: d.id, title: d.title, position: d.position })),
  }
}
