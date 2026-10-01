/**
 * Athena ↔ Verbal-assessment adapter: translates the generic authoring ops (from the
 * template registry) into verbal cell mutations, and serializes the config into the
 * generic AuthoringState the panel snapshots each turn.
 *
 * Pure + immutable, so it's unit-testable and the studio stays thin. This is the CLIENT
 * write path for kind='verbal' — nothing persists here; the studio's autosave commits.
 *
 * The op vocabulary exposes MCQ options as a string[] + a 0-based correctOptionIndex
 * (easy for the model); this adapter translates that to the config's {id,text}[] +
 * correctOptionId representation.
 */
import { genId, newVerbalCell, type VerbalAssessmentConfig, type VerbalCell } from './config'
import type { VerbalOp } from '@/lib/ai/assignment-assistant/templates/registry'
import type { AuthoringState } from '@/lib/ai/assignment-assistant/schemas'

const PREVIEW_MAX = 1500

function describeCell(c: VerbalCell): string {
  if (c.type === 'ai_followup') return c.prompt || '(adaptive follow-up)'
  if (c.type === 'mcq') {
    const opts = (c.options ?? [])
      .map((o, i) => `  ${i + 1}. ${o.text}${c.correctOptionId === o.id ? '  ✓' : ''}`)
      .join('\n')
    return `${c.prompt}${opts ? `\n${opts}` : ''}`
  }
  return c.prompt
}

export function serializeVerbalForAthena(config: VerbalAssessmentConfig): AuthoringState {
  return {
    kind: 'verbal',
    meta: { topic: config.topic },
    components: config.cells.map((c) => {
      const content = describeCell(c)
      return {
        id: c.id,
        type: c.type,
        content: content.length > PREVIEW_MAX ? `${content.slice(0, PREVIEW_MAX)}\n…(truncated)` : content,
      }
    }),
  }
}

/** Fields an insert/update op may set on a cell. */
type VerbalFields = {
  prompt?: string
  answerType?: 'short' | 'long'
  options?: string[]
  correctOptionIndex?: number
}

function applyFields(cell: VerbalCell, f: VerbalFields): VerbalCell {
  const next: VerbalCell = { ...cell }
  if (f.prompt !== undefined) next.prompt = f.prompt
  if (f.answerType !== undefined) next.answerType = f.answerType
  if (f.options !== undefined) {
    next.options = f.options.map((text) => ({ id: genId(), text }))
    next.correctOptionId =
      f.correctOptionIndex !== undefined ? next.options[f.correctOptionIndex]?.id : next.correctOptionId
  } else if (f.correctOptionIndex !== undefined) {
    next.correctOptionId = cell.options?.[f.correctOptionIndex]?.id ?? next.correctOptionId
  }
  return next
}

/** Index to insert at so the new cell lands just after `afterId` (append if absent/unknown). */
function insertIndex(cells: VerbalCell[], afterId?: string): number {
  if (!afterId) return cells.length
  const i = cells.findIndex((c) => c.id === afterId)
  return i === -1 ? cells.length : i + 1
}

export function applyVerbalOps(
  config: VerbalAssessmentConfig,
  ops: VerbalOp[],
): { config: VerbalAssessmentConfig; summary: string; changed: number } {
  let cells = [...config.cells]
  let topic = config.topic
  const counts = { inserted: 0, updated: 0, removed: 0, reordered: 0, topic: false }
  // Only fields relevant to a cell (drop op/id/afterId before patching).
  const fieldsOf = (op: VerbalOp): VerbalFields => ({
    prompt: op.prompt,
    answerType: op.answerType,
    options: op.options,
    correctOptionIndex: op.correctOptionIndex,
  })

  for (const op of ops) {
    switch (op.op) {
      case 'insert': {
        if (!op.cellType) break
        const cell = applyFields(newVerbalCell(op.cellType), fieldsOf(op))
        cells.splice(insertIndex(cells, op.afterId), 0, cell)
        counts.inserted++
        break
      }
      case 'update': {
        if (!op.id || !cells.some((c) => c.id === op.id)) break
        cells = cells.map((c) => (c.id === op.id ? applyFields(c, fieldsOf(op)) : c))
        counts.updated++
        break
      }
      case 'remove': {
        if (!op.id) break
        const before = cells.length
        cells = cells.filter((c) => c.id !== op.id)
        if (cells.length < before) counts.removed++
        break
      }
      case 'reorder': {
        const from = op.id ? cells.findIndex((c) => c.id === op.id) : -1
        if (from !== -1) {
          const [moved] = cells.splice(from, 1)
          let to = 0
          if (op.afterId) {
            const a = cells.findIndex((c) => c.id === op.afterId)
            to = a === -1 ? cells.length : a + 1
          }
          cells.splice(to, 0, moved)
          counts.reordered++
        }
        break
      }
      case 'setMeta':
        if (op.topic !== undefined) {
          topic = op.topic
          counts.topic = true
        }
        break
    }
  }

  const parts: string[] = []
  if (counts.inserted) parts.push(`added ${counts.inserted} cell${counts.inserted > 1 ? 's' : ''}`)
  if (counts.updated) parts.push(`edited ${counts.updated} cell${counts.updated > 1 ? 's' : ''}`)
  if (counts.removed) parts.push(`removed ${counts.removed} cell${counts.removed > 1 ? 's' : ''}`)
  if (counts.reordered) parts.push(`reordered ${counts.reordered} cell${counts.reordered > 1 ? 's' : ''}`)
  if (counts.topic) parts.push('set the topic')
  const changed = counts.inserted + counts.updated + counts.removed + counts.reordered + (counts.topic ? 1 : 0)
  const summary = parts.length ? parts.join(', ').replace(/^./, (c) => c.toUpperCase()) : 'No matching cells to change'

  return { config: { ...config, topic, cells }, summary, changed }
}
