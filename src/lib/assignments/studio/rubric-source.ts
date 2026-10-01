/**
 * Assemble a studio notebook into plain text for AI rubric generation.
 *
 * A studio (notebook/STEM) assignment has no PDF — its questions live in the cells and its
 * expected answers in each cell's authoring metadata. This flattens both into the same kind of
 * "assignment text" the PDF path feeds `generateRubricFromText`, so the AI can draft a rubric
 * from studio content. Pure + server-safe. The answer keys are professor-authored (never student
 * work), so including them is safe and sharpens the drafted criteria.
 */
import { getAuthoring } from './authoring'
import type { StudioNotebook } from './notebook-model'

export function studioNotebookToRubricText(nb: StudioNotebook): string {
  const parts: string[] = []
  nb.cells.forEach((cell, i) => {
    const src = cell.source.trim()
    const a = getAuthoring(cell.metadata)
    const answerKey = a.answerKey?.trim()
    if (!src && !answerKey) return

    const heading = src.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim()
    const label = heading || `Cell ${i + 1}`
    const points = a.points != null ? ` (${a.points} points)` : ''

    let block = `## ${label}${points}`
    if (src) block += `\n${cell.cell_type === 'code' ? '```\n' + src + '\n```' : src}`

    // Fold in the professor-authored pedagogy so the drafted criteria reflect the intended
    // depth, concepts, and expectations — all instructor-authored, never student work.
    const tags: string[] = []
    if (a.difficulty) tags.push(`Difficulty: ${a.difficulty}`)
    if (a.bloom) tags.push(`Bloom level: ${a.bloom}`)
    if (a.conceptTags?.length) tags.push(`Concepts: ${a.conceptTags.join(', ')}`)
    if (tags.length) block += `\n\n${tags.join(' · ')}`
    if (a.explanation?.trim()) block += `\n\nExplanation: ${a.explanation.trim()}`
    if (a.hints?.length) block += `\n\nHints:\n${a.hints.map((h) => `- ${h}`).join('\n')}`
    if (answerKey) block += `\n\nExpected answer: ${answerKey}`
    parts.push(block)
  })
  return parts.join('\n\n')
}

/**
 * Flatten a Studio (Notion-style) document's TipTap JSON into plain text for rubric drafting.
 * Walks the node tree collecting text and inserting a break after each block, so the AI sees the
 * questions/prose the way a reader would. Pure + server-safe.
 */
export function studioDocumentToRubricText(doc: unknown): string {
  const out: string[] = []
  const BLOCK = new Set(['paragraph', 'heading', 'listItem', 'taskItem', 'blockquote', 'codeBlock'])
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (typeof n.text === 'string') out.push(n.text)
    if (Array.isArray(n.content)) {
      n.content.forEach(walk)
      if (typeof n.type === 'string' && BLOCK.has(n.type)) out.push('\n')
    }
  }
  walk(doc)
  return out.join('').replace(/\n{3,}/g, '\n\n').trim()
}
