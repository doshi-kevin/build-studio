// Live Classroom M1 Validation Schemas — Zod schemas for room management,
// slide advancement, and deck rendering. Shared constants used by both
// route handlers and upload dialogs for consistent validation.

import { z } from 'zod'
import type { ExtractionResultData } from '@/lib/validations/document-extraction'

// ── Shared Constants ──────────────────────────────────────────────

/** Maximum deck file size in bytes (250 MB). Sized to fit a ~200-page
 *  image-heavy lecture deck (~1.25 MB / page average). Must stay under
 *  `middlewareClientMaxBodySize` in next.config.ts. */
export const MAX_DECK_BYTES = 250 * 1024 * 1024

/** Maximum number of pages allowed in a deck */
export const MAX_DECK_PAGES = 200

/** Maximum PowerPoint upload size (30 MB). Deliberately tighter than
 *  MAX_DECK_BYTES: the app→Gotenberg converter POST and the converted-PDF
 *  response both transit a fresh Cloud Run request, which caps at 32 MB.
 *  Larger presentations must be exported to PDF (which uses the 250 MB
 *  direct-to-storage path and skips conversion entirely). */
export const MAX_PPTX_BYTES = 30 * 1024 * 1024

/** Source file extensions the deck upload + render pipeline accepts. */
export const DECK_SOURCE_EXTENSIONS = ['pdf', 'pptx', 'ppt'] as const
export type DeckSourceExtension = (typeof DECK_SOURCE_EXTENSIONS)[number]

/** Stale room threshold in milliseconds (12 hours) */
export const STALE_ROOM_THRESHOLD_MS = 12 * 60 * 60 * 1000

/** Client-side throttle for slide advances in milliseconds */
export const SLIDE_ADVANCE_THROTTLE_MS = 300

// ── Room Statuses ─────────────────────────────────────────────────

export const ROOM_STATUSES = ['scheduled', 'live', 'ended'] as const
export type RoomStatus = (typeof ROOM_STATUSES)[number]

// ── Schemas ───────────────────────────────────────────────────────

export const createRoomDraftSchema = z.object({
  sectionId: z.string().uuid('Section ID must be a valid UUID'),
})
export type CreateRoomDraftInput = z.infer<typeof createRoomDraftSchema>

export const advanceSlideSchema = z.object({
  roomId: z.string().uuid('Room ID must be a valid UUID'),
  slideIndex: z.number().int('Slide index must be an integer').min(0, 'Slide index must be non-negative'),
})
export type AdvanceSlideInput = z.infer<typeof advanceSlideSchema>

export const setScreenBlankSchema = z.object({
  roomId: z.string().uuid('Room ID must be a valid UUID'),
  isBlanked: z.boolean(),
})
export type SetScreenBlankInput = z.infer<typeof setScreenBlankSchema>

export const endRoomSchema = z.object({
  roomId: z.string().uuid('Room ID must be a valid UUID'),
})
export type EndRoomInput = z.infer<typeof endRoomSchema>

export const renderDeckJsonBodySchema = z.object({
  roomId: z.string().uuid('Room ID must be a valid UUID'),
  deckId: z.string().uuid('Deck ID must be a valid UUID'),
  // NOTE: no client-supplied source path. The render core derives it server-side
  // from the deck row's server-authored source_file_path (IDOR-safe).
  /** Whether to activate the rendered deck on lc_rooms immediately. True for
   *  the mid-class "Add a deck" flow (the presenter swaps to it at once).
   *  False during the pre-class setup step — the deck is rendered but only
   *  activated when the professor clicks "Start class" (startLiveClass), so
   *  students/projector don't see slides before the class begins. */
  activate: z.boolean().default(true),
})
export type RenderDeckJsonBodyInput = z.infer<typeof renderDeckJsonBodySchema>

export const createDeckUploadUrlSchema = z.object({
  roomId: z.string().uuid('Room ID must be a valid UUID'),
  /** Source format being uploaded. Drives the storage path extension
   *  ({roomId}/{deckId}/source.{extension}). Defaults to pdf for back-compat. */
  extension: z.enum(['pdf', 'pptx', 'ppt']).default('pdf'),
  /** Display name for the deck in the switcher (the source filename). */
  title: z.string().trim().min(1).max(200).optional(),
})
export type CreateDeckUploadUrlInput = z.infer<typeof createDeckUploadUrlSchema>

export const applyModuleItemAsDeckSchema = z.object({
  roomId: z.string().uuid('Room ID must be a valid UUID'),
  moduleItemId: z.string().uuid('Module item ID must be a valid UUID'),
})
export type ApplyModuleItemAsDeckInput = z.infer<typeof applyModuleItemAsDeckSchema>

export const switchDeckSchema = z.object({
  roomId: z.string().uuid('Room ID must be a valid UUID'),
  deckId: z.string().uuid('Deck ID must be a valid UUID'),
})
export type SwitchDeckInput = z.infer<typeof switchDeckSchema>

export const removeDeckSchema = z.object({
  roomId: z.string().uuid('Room ID must be a valid UUID'),
  deckId: z.string().uuid('Deck ID must be a valid UUID'),
})
export type RemoveDeckInput = z.infer<typeof removeDeckSchema>

/** Max length for a professor-given live-session name. */
export const MAX_ROOM_NAME_LENGTH = 80

export const startLiveClassSchema = z.object({
  roomId: z.string().uuid('Room ID must be a valid UUID'),
  /** The rendered deck to present. Validated server-side to belong to the room. */
  deckId: z.string().uuid('Deck ID must be a valid UUID'),
  /** Optional session title. Empty/whitespace falls back to a default server-side. */
  name: z.string().trim().max(MAX_ROOM_NAME_LENGTH, `Name must be ${MAX_ROOM_NAME_LENGTH} characters or fewer`).optional(),
  /** Whether students can use "Catch me up" (AI lecture summary) this session. */
  lectureSummaryEnabled: z.boolean(),
})
export type StartLiveClassInput = z.infer<typeof startLiveClassSchema>

// ── Scheduling Schemas ────────────────────────────────────────────

/** Max occurrences a single weekly series can create. Re-exported from the
 *  recurrence helper so schema + expansion share one source of truth. */
export { MAX_SCHEDULE_OCCURRENCES } from '@/lib/live-classroom/recurrence'
import { MAX_SCHEDULE_OCCURRENCES as MAX_OCC } from '@/lib/live-classroom/recurrence'

export const scheduleLiveClassSchema = z.object({
  sectionId: z.string().uuid('Section ID must be a valid UUID'),
  /** Optional session title, shared by all occurrences of a series. */
  name: z
    .string()
    .trim()
    .max(MAX_ROOM_NAME_LENGTH, `Name must be ${MAX_ROOM_NAME_LENGTH} characters or fewer`)
    .optional(),
  /** One ISO instant per occurrence. The client expands weekly recurrence in the
   *  professor's timezone (expandWeeklyOccurrences) and submits the instants; the
   *  server validates they are in the future and within the cap. */
  occurrences: z
    .array(z.string().datetime({ offset: true, message: 'Each occurrence must be an ISO datetime' }))
    .min(1, 'Pick at least one date/time')
    .max(MAX_OCC, `A series can have at most ${MAX_OCC} occurrences`),
  /** True for a weekly series (occurrences share a recurrence_group_id). */
  recurring: z.boolean().default(false),
})
export type ScheduleLiveClassInput = z.infer<typeof scheduleLiveClassSchema>

export const enqueueScheduledDeckRenderSchema = z.object({
  roomId: z.string().uuid('Room ID must be a valid UUID'),
  deckId: z.string().uuid('Deck ID must be a valid UUID'),
})
export type EnqueueScheduledDeckRenderInput = z.infer<typeof enqueueScheduledDeckRenderSchema>

export const cancelScheduledSessionSchema = z.object({
  roomId: z.string().uuid('Room ID must be a valid UUID'),
  /** 'one' cancels this occurrence; 'series' cancels all still-scheduled
   *  occurrences sharing its recurrence_group_id. */
  scope: z.enum(['one', 'series']).default('one'),
})
export type CancelScheduledSessionInput = z.infer<typeof cancelScheduledSessionSchema>

// ── Room Type ─────────────────────────────────────────────────────

export interface LcRoom {
  id: string
  section_id: string
  prof_id: string
  status: RoomStatus
  /** These three mirror the ACTIVE deck (source of truth is lc_decks). */
  deck_url: string | null
  deck_page_count: number | null
  current_slide: number
  /** Which lc_decks row is currently presented; null until a deck renders. */
  active_deck_id: string | null
  /** Projector blank toggle (presenter-remote "."). Live state, not config —
   *  only the Projector View reacts; students are unaffected by design. */
  is_blanked: boolean
  module_item_id: string | null
  source_file_path: string | null
  /** Professor-given session title; null until set in the pre-class setup step. */
  name: string | null
  /** Per-session "Catch me up" (AI lecture summary) toggle. Default true. */
  lecture_summary_enabled: boolean
  /** False while the professor is on the pre-class setup screen; true once the
   *  class has been started (deck activated + config saved). */
  setup_completed: boolean
  /** When a scheduled session should start; null for start-now rooms. */
  scheduled_at: string | null
  /** Shared id across occurrences of one weekly series; null for one-offs. */
  recurrence_group_id: string | null
  created_at: string
  ended_at: string | null
  // Index signature required by useRealtimeSubscription's generic constraint
  // `T extends Record<string, unknown>`. Realtime payloads arrive as JSON rows
  // which may include fields we haven't modeled here yet.
  [key: string]: unknown
}

// ── Deck Type ─────────────────────────────────────────────────────
// A room holds many decks (multi-deck switching, #8). lc_decks is the
// source of truth per deck; lc_rooms mirrors the active one.

export interface LcDeck {
  id: string
  room_id: string
  position: number
  title: string | null
  deck_url: string | null
  page_count: number | null
  current_slide: number
  extraction: ExtractionResultData | null
  module_item_id: string | null
  source_file_path: string | null
  created_at: string
}

/** Lightweight deck summary surfaced in the room snapshot for the switcher. */
export interface DeckSummary {
  id: string
  title: string | null
  position: number
  pageCount: number | null
  currentSlide: number
  /** True once the deck has finished rendering (has a deck_url). */
  ready: boolean
}

// ── Transcription Schemas ────────────────────────────────────────

export const appendTranscriptionSchema = z.object({
  roomId: z.string().uuid('Room ID must be a valid UUID'),
  /** The deck active when this chunk was captured — NOT necessarily the
   *  room's current active deck (a chunk buffered on deck A may flush just
   *  after a switch to B; it must still land on A). Server authorizes
   *  "deck belongs to room". */
  deckId: z.string().uuid('Deck ID must be a valid UUID'),
  pageNumber: z.number().int('Page number must be an integer').min(0, 'Page number must be non-negative'),
  text: z.string().min(1, 'Transcription text must not be empty').max(10000, 'Transcription text too long'),
})
export type AppendTranscriptionInput = z.infer<typeof appendTranscriptionSchema>

export const generateLiveQuizSchema = z.object({
  roomId: z.string().uuid('Room ID must be a valid UUID'),
  // Time limit the professor picked for the generated quiz (matches
  // quizPayloadSchema's 10–600 range). Defaults to 120s for back-compat.
  timeLimitSeconds: z.number().int().min(10).max(600).default(120),
  // Show students the correct answers immediately on submit (vs. on close).
  revealAnswers: z.boolean().default(false),
})
export type GenerateLiveQuizInput = z.infer<typeof generateLiveQuizSchema>

export const roomIdSchema = z.string().uuid('Room ID must be a valid UUID')

export const interactionIdSchema = z.string().uuid('Interaction ID must be a valid UUID')
