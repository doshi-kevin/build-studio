// Validation schemas and types for the quiz proctoring system.
// Defines compact event format for JSONB storage, modifier bitmask constants,
// and the computed summary interface stored on quiz_attempts.

import { z } from 'zod'

// ── Event Type Enum ─────────────────────────────────────────────

export const PROCTORING_EVENT_TYPES = ['kd', 'cp', 'ps', 'ct', 'fc', 'bl', 'vs', 'mf', 'ph', 'fx'] as const
export type ProctoringEventType = (typeof PROCTORING_EVENT_TYPES)[number]

export const PROCTORING_EVENT_TYPE_LABELS: Record<ProctoringEventType, string> = {
  kd: 'Keydown',
  cp: 'Copy',
  ps: 'Paste',
  ct: 'Cut',
  fc: 'Focus (returned)',
  bl: 'Blur (left tab)',
  vs: 'Visibility Change',
  mf: 'Multiple Faces',
  ph: 'Phone Detected',
  fx: 'Fullscreen Exit',
}

// ── Modifier Bitmask Constants ──────────────────────────────────

export const MOD_CTRL = 1
export const MOD_SHIFT = 2
export const MOD_ALT = 4
export const MOD_META = 8

// ── Event Schema ────────────────────────────────────────────────

export const proctoringEventSchema = z.object({
  t: z.number().int().min(0),                     // ms offset from attempt start
  type: z.enum(PROCTORING_EVENT_TYPES),            // event type (short key)
  key: z.string().max(30).optional(),              // key name (for keydown events)
  mod: z.number().int().min(0).max(15).optional(), // modifier bitmask
  qi: z.number().int().min(0).optional(),          // question index
  fc: z.number().int().min(0).optional(),          // face count (for video proctoring events)
})

export type ProctoringEvent = z.infer<typeof proctoringEventSchema>

// ── Batch Schema (for server action input) ──────────────────────

export const proctoringBatchSchema = z.object({
  attemptId: z.string().uuid(),
  events: z.array(proctoringEventSchema).max(500),
  batchIndex: z.number().int().min(0),
  keystrokeCount: z.number().int().min(0).default(0), // plain typing count (not stored as events)
})

export type ProctoringBatch = z.infer<typeof proctoringBatchSchema>

// ── Proctoring Summary (computed at submission, stored on quiz_attempts) ──

export interface ProctoringSummary {
  totalKeystrokes: number
  copyCount: number
  pasteCount: number
  cutCount: number
  tabSwitchCount: number
  suspiciousFlags: string[]
  eventCount: number
  firstEventAt: string | null
  lastEventAt: string | null
  // Video proctoring fields
  multipleFaceCount: number
  phoneDetectedCount: number
  snapshotCount: number
  webcamDenied: boolean
  // Fullscreen proctoring fields
  fullscreenExitCount: number
}

// ── Proctoring Snapshot (stored in proctoring_snapshots table) ──

export interface ProctoringSnapshot {
  id: string
  attemptId: string
  studentId: string
  quizId: string
  sectionId: string
  violationType: 'mf' | 'ph'
  storagePath: string
  snapshotUrl: string
  timestampOffset: number
  questionIndex: number | null
  faceCount: number
  createdAt: string
}

// ── Video Proctoring Suspicious Flags ──

export const VIDEO_SUSPICIOUS_FLAGS = {
  multiple_faces_detected: 'multiple_faces_detected',
  camera_denied: 'camera_denied',
  phone_detected: 'phone_detected',
} as const
