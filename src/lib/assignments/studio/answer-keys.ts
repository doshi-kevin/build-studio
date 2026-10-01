/**
 * Collect the professor-only answer keys from a studio notebook, for the grading view.
 *
 * Each cell can carry an `answerKey` in its authoring metadata (set manually or by the Solver).
 * This assembles them, labelled by the cell's first heading (falling back to its position), so the
 * grader can see every expected answer in one place. Pure + server-safe.
 */
import { getAuthoring } from './authoring'
import type { StudioNotebook } from './notebook-model'

export interface AnswerKeyEntry {
  label: string
  points?: number
  answerKey: string
}

export function collectAnswerKeys(nb: StudioNotebook): AnswerKeyEntry[] {
  const entries: AnswerKeyEntry[] = []
  nb.cells.forEach((cell, i) => {
    const authoring = getAuthoring(cell.metadata)
    const key = authoring.answerKey?.trim()
    if (!key) return
    const heading = cell.source.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim()
    entries.push({ label: heading || `Cell ${i + 1}`, points: authoring.points, answerKey: key })
  })
  return entries
}
