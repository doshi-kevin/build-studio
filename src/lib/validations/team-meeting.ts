/**
 * Team Meeting Hub validation schemas. Scholera stores only URLs the
 * student chooses to share (a Meet link, a notes link) plus availability
 * slots — no recordings, no credentials.
 */

import { z } from 'zod'

const httpsUrl = z
  .string()
  .trim()
  .url('Enter a valid link')
  .max(500, 'Link is too long')
  .refine((u) => u.startsWith('https://'), 'Link must start with https://')

// Reusable team room link. We nudge Google Meet in the UI but accept any
// https link (Zoom/Teams/etc.) so teams aren't boxed in.
export const meetRoomSchema = z.object({
  meetUrl: httpsUrl,
})

export const logMeetingSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Add a title')
    .max(120, 'Title must be at most 120 characters'),
  // ISO datetime (with offset) for a scheduled meeting; omit for an ad-hoc log.
  scheduledStart: z.string().datetime({ offset: true }).optional(),
  // Optional per-session link override; else the room link is used.
  meetUrl: httpsUrl.optional(),
})

export const attachNotesSchema = z.object({
  notesUrl: httpsUrl,
  notesLabel: z.string().trim().max(80, 'Label is too long').optional(),
})

export const availabilitySchema = z.object({
  // The caller's full set of free slot-starts (UTC ISO) for the team; the
  // action replaces their prior selection with this set.
  slotStarts: z
    .array(z.string().datetime({ offset: true }))
    .max(1000, 'Too many slots selected'),
})

export type MeetRoomInput = z.infer<typeof meetRoomSchema>
export type LogMeetingInput = z.infer<typeof logMeetingSchema>
export type AttachNotesInput = z.infer<typeof attachNotesSchema>
export type AvailabilityInput = z.infer<typeof availabilitySchema>
