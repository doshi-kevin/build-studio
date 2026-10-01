/**
 * The pre-publish validator's answer for one version, as the publication gate reads it
 * (student-visibility.ts, and activating a version while students can see the tool).
 *
 * `passed` only when, for the version's exact stored artifact hash, both stages passed
 * at a ruleset at or above the minimum, and every review was approved
 * (validator/verdict.ts). Everything else blocks:
 *   failed        a check failed, a review was rejected, or the artifact doesn't match
 *   needs_review  a Scholera reviewer has to decide; the professor can't
 *   unavailable   not checked yet, checking, the validator errored, the browser checks
 *                 haven't run, the verdict predates the minimum ruleset, or anything
 *                 couldn't be read
 * Professor preview never reads this.
 */
import 'server-only'
import { currentVerdict } from './validator/service'

export type PrePublishVerdict =
  | { status: 'passed' }
  | { status: 'failed'; reason: string }
  | { status: 'needs_review' }
  | { status: 'unavailable'; reason: string }

export async function prePublishVerdict(versionId: string): Promise<PrePublishVerdict> {
  try {
    const verdict = await currentVerdict(versionId)
    if (verdict.status === 'passed') return { status: 'passed' }
    if (verdict.status === 'failed') return { status: 'failed', reason: verdict.reason }
    if (verdict.status === 'needs_review') return { status: 'needs_review' }
    return { status: 'unavailable', reason: verdict.reason }
  } catch {
    // Fail closed: a gate that can't read its verdict stays shut.
    return { status: 'unavailable', reason: 'validator_error' }
  }
}
