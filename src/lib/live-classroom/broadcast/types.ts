// Broadcast event payload types for the Live Classroom realtime channel.
// Every event flowing on the room:<roomId> (or :ephem) topic conforms to
// the LcEnvelope shape; the discriminated `type` field selects the data
// payload. Authoritative events (trigger-emitted) carry a non-null `seq`;
// ephemeral events (client-emitted on the :ephem topic) carry seq=null.

/** Wire envelope every broadcast event uses. Mirrors lc_send_event() output. */
export interface LcEnvelope<T extends LcEventType = LcEventType> {
  /** Monotonic per-`lc_events.seq`; null for ephemeral (client-emitted) events. */
  seq: number | null
  /** Server timestamp at emission (ISO 8601). */
  ts: string
  /** Event type discriminator. */
  type: T
  /** Event-specific data payload. */
  data: LcEventDataMap[T]
}

// ── Authoritative event data shapes ──────────────────────────────────

export interface SlideChangedData {
  slideIndex: number
}

/** Projector blank toggle (presenter-remote "."). Only the Projector View
 *  reacts visually; students are unaffected by design. */
export interface ScreenBlankChangedData {
  isBlanked: boolean
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type RoomEndedData = {
  // Empty payload — the type alone is the signal.
}

export interface DeckReadyData {
  deckUrl: string
  deckPageCount: number
}

export interface DeckRenderProgressData {
  pagesRendered: number
  totalPages: number
}

export interface DeckFailedData {
  /** Stable error key the client can render — `convert` (PPT→PDF step),
   *  `render`, `upload`, or `unknown`. Never include raw error messages
   *  (could leak internals). */
  reason: 'convert' | 'render' | 'upload' | 'unknown'
  /** 1-based page index that failed (when known). */
  page?: number
}

export interface RoomStartedData {
  roomId: string
  sectionId: string
  profId: string
  createdAt: string
}

// Phase 2 (interactions) — shapes declared here so the union is stable
// even though the trigger is added in a later migration.
export interface InteractionCreatedData {
  id: string
  kind: 'poll' | 'quiz' | 'question'
  payload: Record<string, unknown>
  status: 'draft' | 'open' | 'closed'
}

export interface InteractionOpenedData {
  id: string
  kind: 'poll' | 'quiz' | 'question'
  status: 'open'
}

export interface InteractionClosedData {
  id: string
  kind: 'poll' | 'quiz' | 'question'
  status: 'closed'
}

export interface InteractionUpdatedData {
  id: string
  kind: 'poll' | 'quiz' | 'question'
  status: 'draft' | 'open' | 'closed'
  payload?: Record<string, unknown>
}

export interface AggregateUpdatedData {
  interactionId: string
  aggregate: Record<string, unknown>
}

// Phase 4 (drawings) ephemeral event
export interface DrawingStrokeData {
  id: string
  slideIndex: number
  points: Array<{ x: number; y: number; t: number }>
  color: string
  width: number
  authorId: string
}

// drawing_stroke_batch is the persisted form (lc_events) of N strokes,
// surfaced via replay so late joiners catch up to existing drawings on the
// current slide. Live strokes use `drawing_stroke` on the ephemeral topic;
// the batch is broadcast=false but persists, so the replay path receives it.
export interface DrawingStrokeBatchData {
  strokes: DrawingStrokeData[]
}

// drawing_clear is sent on the ephemeral topic when the professor clicks
// "Clear all". Every viewer (including the prof) wipes their local
// strokes for that slide. Persisted batches in lc_events are also
// best-effort deleted server-side so late joiners don't see ghosts.
export interface DrawingClearData {
  slideIndex: number
}

// reaction is sent on the ephemeral topic when a student taps a pacing
// reaction button. Ephemeral by design (like strokes/cursors): the professor
// sees a live, time-decaying aggregate count per kind; nothing is persisted.
export type ReactionKind = 'confused' | 'slow_down' | 'got_it' | 'speed_up'

export interface ReactionData {
  kind: ReactionKind
  userId: string
}

// ── Type map + union ─────────────────────────────────────────────────

export interface LcEventDataMap {
  slide_changed: SlideChangedData
  screen_blank_changed: ScreenBlankChangedData
  room_ended: RoomEndedData
  deck_ready: DeckReadyData
  deck_render_progress: DeckRenderProgressData
  deck_failed: DeckFailedData
  room_started: RoomStartedData
  interaction_created: InteractionCreatedData
  interaction_opened: InteractionOpenedData
  interaction_closed: InteractionClosedData
  interaction_updated: InteractionUpdatedData
  aggregate_updated: AggregateUpdatedData
  drawing_stroke: DrawingStrokeData
  drawing_stroke_batch: DrawingStrokeBatchData
  drawing_clear: DrawingClearData
  reaction: ReactionData
}

export type LcEventType = keyof LcEventDataMap

export type LcEvent =
  | LcEnvelope<'slide_changed'>
  | LcEnvelope<'screen_blank_changed'>
  | LcEnvelope<'room_ended'>
  | LcEnvelope<'deck_ready'>
  | LcEnvelope<'deck_render_progress'>
  | LcEnvelope<'deck_failed'>
  | LcEnvelope<'room_started'>
  | LcEnvelope<'interaction_created'>
  | LcEnvelope<'interaction_opened'>
  | LcEnvelope<'interaction_closed'>
  | LcEnvelope<'interaction_updated'>
  | LcEnvelope<'aggregate_updated'>
  | LcEnvelope<'drawing_stroke'>
  | LcEnvelope<'drawing_stroke_batch'>
  | LcEnvelope<'drawing_clear'>
  | LcEnvelope<'reaction'>

// ── Topic helpers ────────────────────────────────────────────────────

/** Authoritative topic — server-only writes via SECURITY DEFINER triggers. */
export function authoritativeTopic(roomId: string): string {
  return `room:${roomId}`
}

/** Ephemeral topic — client-emitted events (drawings, cursors, reactions). */
export function ephemeralTopic(roomId: string): string {
  return `room:${roomId}:ephem`
}

/** Presence topic — the live roster of who's in the room (for the "N students
 *  present" count). Deliberately its OWN topic: realtime-js dedups channels by
 *  topic, so presence on the authoritative/ephemeral topic would collide with
 *  the shared broadcast channel's config. Authorized by the `:presence` RLS
 *  policies on realtime.messages. */
export function presenceTopic(roomId: string): string {
  return `room:${roomId}:presence`
}

/** Set of event types that are valid on the authoritative topic. */
export const AUTHORITATIVE_EVENT_TYPES = new Set<LcEventType>([
  'slide_changed',
  'screen_blank_changed',
  'room_ended',
  'deck_ready',
  // deck_render_progress + deck_failed are emitted by the render-deck
  // route via lc_send_event(persist=false). They have seq=null but are
  // legit on the authoritative topic — the route is server-side and
  // SECURITY DEFINER, so no spoof risk.
  'deck_render_progress',
  'deck_failed',
  'interaction_created',
  'interaction_opened',
  'interaction_closed',
  'interaction_updated',
  'aggregate_updated',
  // drawing_stroke_batch flows through replay (persist=true, broadcast=false)
  // so late joiners catch up. Live strokes use `drawing_stroke` on the
  // ephemeral topic and don't have a seq.
  'drawing_stroke_batch',
])

/** Event types that legitimately have seq=null on the authoritative topic
 *  (server-emitted but persist=false, so no monotonic sequence). The
 *  spoof filter exempts these from the "drop seq=null on room:%" rule. */
export const NULL_SEQ_AUTHORITATIVE_TYPES = new Set<LcEventType>([
  'deck_render_progress',
  'deck_failed',
])

/** Section-wide topic — broadcasts room_started when a prof creates a
 *  new lc_rooms row. RLS allows enrolled students + the section's
 *  professor to read. */
export function sectionTopic(sectionId: string): string {
  return `section:${sectionId}:lc`
}

/** Set of event types that are valid on the ephemeral topic. */
export const EPHEMERAL_EVENT_TYPES = new Set<LcEventType>([
  'drawing_stroke',
  'drawing_clear',
  'reaction',
])
