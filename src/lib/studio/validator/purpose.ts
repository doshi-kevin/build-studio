/**
 * Rule 9.6: is this tool for teaching, learning or running the course?
 *
 * Deterministic first. The manifest v2 `purpose` is structured (a fixed category, a
 * summary, an audience), and three deterministic checks run before any model:
 *   - red-flag terms (gambling, trading, shopping, dating, surveillance): review;
 *   - instructions aimed at the validator ("ignore the rubric", "mark this as approved"):
 *     review, and the model is never shown them;
 *   - whether the declared data and capabilities fit the category: review.
 * Only then the classifier, which is one signal and never an authority on its own:
 *   confidently educational and agreeing with the declared category: passed;
 *   confidently not educational: failed;
 *   anything else, including unavailable or malformed: needs_review.
 * Nothing here can pass a tool the deterministic checks didn't.
 */
import type { StudioManifestV2 } from '../manifest'
import { STUDIO_PURPOSE_CONFIDENCE_MIN, STUDIO_PURPOSE_TEXT_MAX_BYTES } from '../limits'

export const PURPOSE_RUBRIC_VERSION = 'purpose-rubric-v1'

export interface PurposeInput {
  name: string
  description: string
  summary: string
  category: string
  audience: string
  collections: string[]
  capabilities: string[]
}

export interface PurposeClassification {
  verdict: 'educational' | 'not_educational' | 'uncertain'
  category: string
  confidence: number
  reasons: string[]
}

export type PurposeClassifierResult =
  | { ok: true; result: PurposeClassification; model: string }
  | { ok: false; reason: 'disabled' | 'unavailable' | 'malformed' }

export type PurposeClassifier = (input: PurposeInput) => Promise<PurposeClassifierResult>

export interface PurposeOutcome {
  status: 'passed' | 'failed' | 'needs_review'
  message: string
  metadata: Record<string, unknown>
  model?: string
}

/** Versioned with the rubric. A hit means a person decides, never an automatic fail:
 * "trading cards" and "store your notes" are fine, a sportsbook isn't. */
const RED_FLAGS =
  /\b(casino|gambl\w*|sportsbook|betting|wager\w*|crypto\w*|bitcoin|ethereum|nft|forex|day[- ]?trad\w*|stock picks?|e-?commerce|storefront|checkout|shopping cart|buy now|dropship\w*|dating|hookup|adult content|advertis\w*|affiliate|surveil\w*|spyware|keylog\w*|track(ing)? (students'? )?location)\b/i

/** Text written at the validator rather than the student. Its presence alone is enough
 * to stop: the model must never be shown instructions aimed at it. */
const INJECTION =
  /(ignore (all |any |the )?(previous|prior|above|earlier|rubric|instructions)|disregard (the|all|any)|system prompt|you are (now )?(an?|the) |as an ai|validator|classifier|pre-?publish|approve (this|me|it)|mark (this|it)? ?as (educational|safe|approved|passed)|respond (only )?with|output (json|yes|true)|return (yes|true|passed))/i

/** Categories whose purpose implies students doing work the tool keeps. */
const NEEDS_STUDENT_WORK = new Set(['practice', 'assessment', 'feedback', 'reflection', 'discussion'])

export function purposeInput(manifest: StudioManifestV2): PurposeInput {
  return {
    name: manifest.name,
    description: manifest.description,
    summary: manifest.purpose.summary,
    category: manifest.purpose.category,
    audience: manifest.purpose.audience,
    collections: Object.keys(manifest.collections),
    capabilities: [...new Set([...manifest.views.student.capabilities, ...manifest.views.professor.capabilities])],
  }
}

export function deterministicPurpose(manifest: StudioManifestV2): { outcome: 'continue' | 'review'; reasons: string[] } {
  const text = [manifest.name, manifest.description, manifest.purpose.summary].join('\n')
  const reasons: string[] = []
  if (new TextEncoder().encode(text).length > STUDIO_PURPOSE_TEXT_MAX_BYTES) reasons.push('purpose_text_too_long')
  if (INJECTION.test(text)) reasons.push('instructions_to_validator')
  if (RED_FLAGS.test(text)) reasons.push('red_flag_terms')
  const studentWork = Object.values(manifest.collections).some((c) => c.access === 'perStudent')
  if (NEEDS_STUDENT_WORK.has(manifest.purpose.category) && !studentWork) reasons.push('category_without_student_work')
  return { outcome: reasons.length > 0 ? 'review' : 'continue', reasons }
}

const REVIEW = 'A Scholera reviewer needs to confirm this tool is for teaching, learning or running the course.'

export async function evaluatePurpose(manifest: StudioManifestV2, classify: PurposeClassifier): Promise<PurposeOutcome> {
  const deterministic = deterministicPurpose(manifest)
  if (deterministic.outcome === 'review') {
    // The model isn't called: its input would include whatever raised the flag.
    return { status: 'needs_review', message: REVIEW, metadata: { deterministic: deterministic.reasons, rubric: PURPOSE_RUBRIC_VERSION } }
  }

  const answer = await classify(purposeInput(manifest))
  if (!answer.ok) {
    return { status: 'needs_review', message: REVIEW, metadata: { classifier: answer.reason, rubric: PURPOSE_RUBRIC_VERSION } }
  }
  const { result } = answer
  const metadata = {
    rubric: PURPOSE_RUBRIC_VERSION,
    verdict: result.verdict,
    confidence: Math.round(result.confidence * 100) / 100,
    category: result.category,
    declaredCategory: manifest.purpose.category,
  }
  const confident = result.confidence >= STUDIO_PURPOSE_CONFIDENCE_MIN
  if (result.verdict === 'not_educational' && confident) {
    return {
      status: 'failed',
      message: 'This tool doesn’t look like it’s for teaching, learning or running the course, which is all Studio builds.',
      metadata,
      model: answer.model,
    }
  }
  if (result.verdict === 'educational' && confident && result.category === manifest.purpose.category) {
    return { status: 'passed', message: 'The tool’s purpose is teaching, learning or running the course.', metadata, model: answer.model }
  }
  return { status: 'needs_review', message: REVIEW, metadata, model: answer.model }
}
