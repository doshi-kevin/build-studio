/**
 * Adaptive follow-up SEAM - Athena's (Harshil's) territory. TYPES ONLY, inert here.
 *
 * In this slice the runtime simply walks the professor's seed questions in order. Later,
 * Athena implements `DecideFollowUp` to generate the next/follow-up question from the
 * student's spoken answer. We never build the question-deciding brain; we only freeze the
 * contract so it plugs in cleanly. Grading is always the professor's - never the AI's.
 */
import type { VerbalCell } from './config'

export interface FollowUpContext {
  topic: string
  /** The seed question cell the student just answered. */
  question: VerbalCell
  /** The student's spoken answer, transcribed via the shared STT core. */
  answerTranscript: string
  /** How many follow-ups have already been asked on this question. */
  depth: number
  maxDepth: number
}

export type FollowUpDecision =
  | { kind: 'follow_up'; prompt: string } // ask this (Athena-generated) question next
  | { kind: 'advance' } // move on to the next seed question

/** Athena implements this later. */
export type DecideFollowUp = (ctx: FollowUpContext) => Promise<FollowUpDecision>

/** Inert default until Athena plugs in: never follows up, always advances. */
export const inertDecideFollowUp: DecideFollowUp = async () => ({ kind: 'advance' })
