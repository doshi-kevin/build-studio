/**
 * Athena study artifacts — the shared kind registry.
 *
 * One artifact = one interactive study element Athena generated in chat and
 * left on the student's roadmap, anchored to a module. This file is the single
 * place a kind exists: its payload/state shapes, its display metadata, and its
 * node key. Adding a kind means adding it HERE plus a widget in
 * ArtifactWidgets.tsx — nothing else in the pipeline is kind-specific.
 *
 * Client-safe on purpose (no zod, no server imports): the roadmap canvas and
 * the modal widgets import these types and metadata. The server-side content
 * validation for the same shapes lives with the tool
 * (src/lib/ai/student-tutor/study-artifact.ts).
 */

export const ARTIFACT_KINDS = [
  'flashcards',
  'practice',
  'checklist',
  'study_guide',
  'knowledge_map',
] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

/**
 * Where a generated item came from — a page in THIS turn's retrieved context.
 * `material` is the lecture/document title as shown in the `[Title, p.N]` marker;
 * `page` is that page number. The tool validates every cite against the pages it
 * was actually handed and drops items it can't match (design doc §15.4), so a
 * stored cite always points at a real course page. Optional at the type level
 * only for legacy rows and for checklist steps (study actions, not page facts).
 */
export interface Cite {
  material: string
  page: number
}

// ── Payloads (what Athena generated) ─────────────────────────────

export interface FlashcardsPayload {
  cards: { front: string; back: string; cite?: Cite }[]
}
export interface PracticePayload {
  questions: {
    prompt: string
    options: { text: string; correct?: boolean }[]
    explanation?: string
    cite?: Cite
  }[]
}
export interface ChecklistPayload {
  steps: { label: string; minutes?: number; cite?: Cite }[]
}
export interface StudyGuidePayload {
  sections: { heading: string; points: { text: string; cite?: Cite }[] }[]
}
/**
 * A prerequisite path through the roadmap, answering "what do I need to
 * understand X?". `stops` are ordered foundational → focus and every `nodeKey`
 * is a REAL roadmap node key the tool resolved server-side (the model proposes
 * concept titles; only ones matching actual nodes survive — §16 of the design
 * doc). `masteryPct` is the student's mastery when they asked (a snapshot, not
 * live). The roadmap renders this as the knowledge-path lens; the modal widget
 * lists the same stops off-map.
 */
export interface KnowledgeMapPayload {
  question: string
  stops: { nodeKey: string; title: string; why: string; masteryPct?: number | null }[]
  /** The queried concept's own node — highlighted as the destination, not a stop. */
  focus: { nodeKey: string; title: string }
}
export type ArtifactPayload =
  | FlashcardsPayload
  | PracticePayload
  | ChecklistPayload
  | StudyGuidePayload
  | KnowledgeMapPayload

// ── State (what the student did with it) ─────────────────────────

/** Per-kind interaction state, stored as the row's `state` jsonb. Widgets
 *  read/write only their own kind's shape; unknown fields are preserved. */
export interface ArtifactState {
  /** checklist: indexes of ticked steps. */
  done?: number[]
  /** practice: question index → chosen option index (locked once answered). */
  answers?: Record<string, number>
}

// ── The row as surfaces see it ───────────────────────────────────

export interface AthenaArtifactView {
  id: string
  kind: ArtifactKind
  title: string
  moduleId: string
  payload: ArtifactPayload
  state: ArtifactState
  createdAt: string
  /** Set when the student parked the note in the roadmap's Archive tray —
   *  archived notes leave the lane but survive until deleted from there. */
  archivedAt?: string | null
}

// ── Node identity on the roadmap ─────────────────────────────────

/** Canvas/?node= key — same `type:id` convention as every other node kind. */
export const ATHENA_NODE_TYPE = 'athena_artifact'
export const athenaNodeKey = (id: string) => `${ATHENA_NODE_TYPE}:${id}`

// ── Display metadata ─────────────────────────────────────────────

export const ARTIFACT_KIND_META: Record<
  ArtifactKind,
  {
    /** Kicker/label the card and modal show ("FLASHCARDS"). */
    label: string
    /** One-line summary for the node card. Takes the student's `state` so the
     *  note on the map shows where they left off ("3 of 5 done · ≈12 min
     *  left"), not the same size line forever. */
    summary: (payload: ArtifactPayload, state?: ArtifactState) => string
  }
> = {
  flashcards: {
    label: 'Flashcards',
    summary: (p) => {
      const n = (p as FlashcardsPayload).cards?.length ?? 0
      return `${n} card${n === 1 ? '' : 's'}`
    },
  },
  practice: {
    label: 'Practice',
    summary: (p, state) => {
      const qs = (p as PracticePayload).questions ?? []
      const answers = state?.answers ?? {}
      const answered = qs.filter((_, qi) => answers[String(qi)] !== undefined).length
      if (answered === 0) return `${qs.length} question${qs.length === 1 ? '' : 's'}`
      const right = qs.filter((q, qi) => q.options[answers[String(qi)]]?.correct).length
      return `${answered} of ${qs.length} answered · ${right} right`
    },
  },
  checklist: {
    label: 'Study plan',
    summary: (p, state) => {
      const steps = (p as ChecklistPayload).steps ?? []
      const done = new Set(state?.done ?? [])
      const doneCount = steps.filter((_, i) => done.has(i)).length
      if (doneCount === 0) {
        const mins = steps.reduce((t, s) => t + (s.minutes ?? 0), 0)
        const n = `${steps.length} step${steps.length === 1 ? '' : 's'}`
        return mins > 0 ? `${n} · ≈${mins} min` : n
      }
      if (doneCount === steps.length) return `all ${steps.length} done ✓`
      const minsLeft = steps.reduce((t, s, i) => t + (done.has(i) ? 0 : s.minutes ?? 0), 0)
      return `${doneCount} of ${steps.length} done${minsLeft > 0 ? ` · ≈${minsLeft} min left` : ''}`
    },
  },
  knowledge_map: {
    label: 'Knowledge map',
    summary: (p) => {
      const km = p as KnowledgeMapPayload
      const n = km.stops?.length ?? 0
      return `${n} stop${n === 1 ? '' : 's'} → ${km.focus?.title ?? 'the concept'}`
    },
  },
  study_guide: {
    label: 'Study guide',
    summary: (p) => {
      const sections = (p as StudyGuidePayload).sections ?? []
      const points = sections.reduce((t, s) => t + (s.points?.length ?? 0), 0)
      const n = `${sections.length} section${sections.length === 1 ? '' : 's'}`
      return points > 0 ? `${n} · ${points} point${points === 1 ? '' : 's'}` : n
    },
  },
}

export const isArtifactKind = (k: string): k is ArtifactKind =>
  (ARTIFACT_KINDS as readonly string[]).includes(k)
