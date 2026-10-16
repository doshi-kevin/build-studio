/**
 * The Step 11 builder, frozen for the Step 12A baseline. The baseline is honest only if
 * the builder runs exactly as it did at Step 11 acceptance (2026-10-06, f54ad745), so a
 * live build refuses to start, and a test fails, when any of this changes.
 *
 * The hashes are of the instruction strings the model receives, which are the same on
 * every platform (template literals normalise line endings).
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUILDER_INSTRUCTIONS, BUILDER_INSTRUCTIONS_VERSION } from '../../src/lib/studio/builder/instructions'
import { REVIEW_INSTRUCTIONS, REVIEW_INSTRUCTIONS_VERSION } from '../../src/lib/studio/builder/review'
import { STUDIO_BUILDER_MODEL } from '../../src/lib/ai/config'
import { STUDIO_BUILDER_MAX_OUTPUT_TOKENS } from '../../src/lib/studio/limits'

export const ACCEPTED = {
  instructionsVersion: 'studio-builder-l1-v12',
  instructionsSha256: 'aff3d51f37a4056fcdc3974d542d57397a4eec45d31244e3b8b628d134743b9e',
  reviewVersion: 'studio-review-v2',
  reviewSha256: '89749bc4bda366ea4b752016d1be1ec0d0bccadc503459ae9c3296a124dfcb44',
  model: 'gemini-3.1-pro-preview',
  thinkingLevel: 'low',
} as const

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** The builder's thinking level, read from the Gemini adapter itself rather than restated here. */
export function builderThinkingLevel(root = process.cwd()): string | null {
  const source = readFileSync(join(root, 'src', 'lib', 'studio', 'builder', 'model.ts'), 'utf8')
  return /thinkingConfig:\s*\{\s*thinkingLevel:\s*'([a-z]+)'/.exec(source)?.[1] ?? null
}

export interface BuilderIdentity {
  model: string
  thinkingLevel: string | null
  maxOutputTokens: number
  instructionsVersion: string
  instructionsSha256: string
  reviewVersion: string
  reviewSha256: string
}

export function builderIdentity(root?: string): BuilderIdentity {
  return {
    model: STUDIO_BUILDER_MODEL,
    thinkingLevel: builderThinkingLevel(root),
    maxOutputTokens: STUDIO_BUILDER_MAX_OUTPUT_TOKENS,
    instructionsVersion: BUILDER_INSTRUCTIONS_VERSION,
    instructionsSha256: sha256(BUILDER_INSTRUCTIONS),
    reviewVersion: REVIEW_INSTRUCTIONS_VERSION,
    reviewSha256: sha256(REVIEW_INSTRUCTIONS),
  }
}

/** Every way the builder differs from the one accepted at Step 11; empty when frozen. */
export function freezeDrift(identity: BuilderIdentity = builderIdentity()): string[] {
  const drift: string[] = []
  if (identity.instructionsVersion !== ACCEPTED.instructionsVersion) drift.push(`instructions version ${identity.instructionsVersion}`)
  if (identity.instructionsSha256 !== ACCEPTED.instructionsSha256) drift.push('builder instructions changed')
  if (identity.reviewVersion !== ACCEPTED.reviewVersion) drift.push(`review version ${identity.reviewVersion}`)
  if (identity.reviewSha256 !== ACCEPTED.reviewSha256) drift.push('review instructions changed')
  if (identity.model !== ACCEPTED.model) drift.push(`builder model ${identity.model}`)
  if (identity.thinkingLevel !== ACCEPTED.thinkingLevel) drift.push(`builder thinking level ${identity.thinkingLevel ?? 'unreadable'}`)
  return drift
}
