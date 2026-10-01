import { z } from 'zod'
import {
  CHUNKER_VERSION,
  CONTENT_CLASS_COURSE_MATERIAL,
  CONTENT_CLASS_LECTURE_TRANSCRIPT,
  CONTENT_CLASS_RUBRIC_REFERENCE,
  EMBEDDING_MODEL,
  METADATA_SCHEMA_VERSION,
  RUBRIC_CHUNKER_VERSION,
  TRANSCRIPT_CHUNKER_VERSION,
} from './config'

// Closed metadata whitelist, validated inside the wrapper on every upsert.
// Pinecone has no server-side schema — a typo'd key silently never matches a
// filter — and metadata must stay lean (opaque ids + locators + provenance).
// NO PII, NO page text (text hydrates from Postgres so RLS stays the last
// line of defense). .strict() rejects any extra key.

// Postgres uuid columns accept any hex-shaped uuid — zod's .uuid() is
// RFC-variant-strict and rejects hand-crafted ids that really exist in prod
// (e.g. the Scholera Dev institution 00000000-…-000000000002).
const uuidish = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid UUID')

export const materialPageMetadataSchema = z
  .object({
    institution_id: uuidish,
    section_id: uuidish,
    module_id: uuidish,
    module_item_id: uuidish,
    page_number: z.number().int().min(1),
    content_class: z.literal(CONTENT_CLASS_COURSE_MATERIAL),
    schema_version: z.literal(METADATA_SCHEMA_VERSION),
    // Provenance — what produced this vector (makes migrations auditable).
    embedding_model: z.literal(EMBEDDING_MODEL),
    chunker_version: z.literal(CHUNKER_VERSION),
  })
  .strict()

export type MaterialPageMetadata = z.infer<typeof materialPageMetadataSchema>

/** One (deck, slide)'s spoken text from an ended live class (content class
 *  `lecture_transcript`, N1). `page_number` is 0-based — it joins straight back
 *  to `lc_transcriptions.page_number` at hydration, and hydration is also where
 *  visibility is enforced (room ended + "Catch me up" on), since Pinecone
 *  metadata can't track a live toggle. */
export const transcriptSlideMetadataSchema = z
  .object({
    institution_id: uuidish,
    section_id: uuidish,
    room_id: uuidish,
    deck_id: uuidish,
    page_number: z.number().int().min(0),
    content_class: z.literal(CONTENT_CLASS_LECTURE_TRANSCRIPT),
    schema_version: z.literal(METADATA_SCHEMA_VERSION),
    embedding_model: z.literal(EMBEDDING_MODEL),
    chunker_version: z.literal(TRANSCRIPT_CHUNKER_VERSION),
  })
  .strict()

export type TranscriptSlideMetadata = z.infer<typeof transcriptSlideMetadataSchema>

/** Every vector in the index is one of the allowlisted classes; queries that
 *  span classes parse results through this and narrow on `content_class`. */
export const vectorMetadataSchema = z.discriminatedUnion('content_class', [
  materialPageMetadataSchema,
  transcriptSlideMetadataSchema,
])

export type VectorMetadata = z.infer<typeof vectorMetadataSchema>
export const rubricReferenceMetadataSchema = z
  .object({
    institution_id: uuidish,
    section_id: uuidish,
    assignment_id: uuidish,
    question_index: z.number().int().min(0).max(199),
    criterion_index: z.number().int().min(0).max(199),
    content_class: z.literal(CONTENT_CLASS_RUBRIC_REFERENCE),
    schema_version: z.literal(METADATA_SCHEMA_VERSION),
    embedding_model: z.literal(EMBEDDING_MODEL),
    chunker_version: z.literal(RUBRIC_CHUNKER_VERSION),
  })
  .strict()

export type RubricReferenceMetadata = z.infer<typeof rubricReferenceMetadataSchema>
