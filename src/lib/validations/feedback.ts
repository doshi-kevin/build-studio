/**
 * Feedback Validation Schemas — Zod schemas for the feedback system.
 *
 * Used in:
 * 1. Client-side: react-hook-form resolver for the feedback widget
 * 2. Server-side: server actions validate input as defense in depth
 */

import { z } from 'zod'

export const feedbackCategoryEnum = z.enum([
  'bug',
  'feature_request',
  'content_issue',
  'ux',
  'general',
])

export const feedbackStatusEnum = z.enum([
  'new',
  'reviewed',
  'resolved',
  'dismissed',
])

export const feedbackRatingEnum = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
])

export const pageContextSchema = z.object({
  pagePath: z.string(),
  pageTitle: z.string(),
  role: z.string(),
  sectionId: z.string().nullable().optional(),
  featureName: z.string().nullable().optional(),
  browser: z.string(),
  timestamp: z.string(),
})

export const submitFeedbackSchema = z.object({
  rating: feedbackRatingEnum,
  category: feedbackCategoryEnum,
  message: z
    .string()
    .max(5000, 'Message must be at most 5,000 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  page_url: z.string().min(1),
  page_context: pageContextSchema,
})

export const updateFeedbackStatusSchema = z.object({
  id: z.string().uuid(),
  status: feedbackStatusEnum,
  admin_notes: z
    .string()
    .max(2000, 'Notes must be at most 2,000 characters')
    .trim()
    .optional()
    .or(z.literal('')),
})

export type FeedbackCategory = z.infer<typeof feedbackCategoryEnum>
export type FeedbackStatus = z.infer<typeof feedbackStatusEnum>
export type PageContext = z.infer<typeof pageContextSchema>
export type SubmitFeedbackInput = z.infer<typeof submitFeedbackSchema>
export type UpdateFeedbackStatusInput = z.infer<typeof updateFeedbackStatusSchema>
