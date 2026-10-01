/**
 * Athena ↔ Document (TipTap) adapter.
 *
 * A rich-text doc is a nested ProseMirror tree with no stable per-block ids, so — unlike
 * the cell editors — this adapter works at DOCUMENT / SECTION granularity (content as HTML
 * the editor parses into schema-valid nodes). That is corruption-proof: TipTap normalises
 * the HTML and we never do fragile per-node index surgery.
 *
 * Imperative (it drives a live Editor instance), so it lives beside the studio rather than
 * being a pure module. The studio syncs React state + autosave from editor.getJSON() after
 * applying, exactly as a manual edit does; nothing here persists directly.
 */
import type { Editor } from '@tiptap/core'
import type { DocumentOp } from '@/lib/ai/assignment-assistant/templates/registry'
import type { AuthoringState } from '@/lib/ai/assignment-assistant/schemas'
import { buildBlockNode } from './athena-document-blocks'

const SECTION_PREVIEW_MAX = 800

interface SectionBoundary {
  id: string
  /** ProseMirror position just before the section's heading node. */
  from: number
  level: number
}

/** Walk top-level nodes and split the doc into heading-delimited sections. */
function sectionBoundaries(editor: Editor): { boundaries: SectionBoundary[]; introFrom: number | null } {
  const doc = editor.state.doc
  const boundaries: SectionBoundary[] = []
  let sawHeading = false
  let introFrom: number | null = null
  doc.forEach((node, offset) => {
    if (node.type.name === 'heading') {
      sawHeading = true
      boundaries.push({ id: `s${boundaries.length}`, from: offset, level: (node.attrs.level as number) ?? 1 })
    } else if (!sawHeading && introFrom === null && node.textContent.trim()) {
      introFrom = offset
    }
  })
  return { boundaries, introFrom }
}

function trunc(s: string): string {
  const t = s.trim()
  return t.length > SECTION_PREVIEW_MAX ? `${t.slice(0, SECTION_PREVIEW_MAX)}…(truncated)` : t
}

export function serializeDocumentForAthena(editor: Editor | null, title: string): AuthoringState {
  if (!editor) return { kind: 'document', meta: { title }, components: [] }
  const doc = editor.state.doc
  const { boundaries, introFrom } = sectionBoundaries(editor)
  const components: { id: string; type: string; content: string }[] = []

  // Content before the first heading is an "intro" section.
  const firstHeadingFrom = boundaries.length ? boundaries[0].from : doc.content.size
  if (introFrom !== null) {
    components.push({ id: 'intro', type: 'intro', content: trunc(doc.textBetween(introFrom, firstHeadingFrom, '\n', ' ')) })
  }
  boundaries.forEach((b, i) => {
    const end = i + 1 < boundaries.length ? boundaries[i + 1].from : doc.content.size
    components.push({ id: b.id, type: `h${b.level}`, content: trunc(doc.textBetween(b.from, end, '\n', ' ')) })
  })
  return { kind: 'document', meta: { title }, components }
}

/** Resolve a section id ('intro' | 's{n}') to its [from, to] top-level range. */
function sectionRange(editor: Editor, headingId: string): { from: number; to: number } | null {
  const doc = editor.state.doc
  const { boundaries, introFrom } = sectionBoundaries(editor)
  const firstHeadingFrom = boundaries.length ? boundaries[0].from : doc.content.size
  if (headingId === 'intro') {
    if (introFrom === null) return null
    return { from: introFrom, to: firstHeadingFrom }
  }
  const idx = boundaries.findIndex((b) => b.id === headingId)
  if (idx === -1) return null
  const to = idx + 1 < boundaries.length ? boundaries[idx + 1].from : doc.content.size
  return { from: boundaries[idx].from, to }
}

/**
 * Apply document ops to the live editor (mutates the canvas). Returns a one-line summary
 * and an optional new title (setMeta). The studio syncs state/autosave + undo afterward.
 */
/**
 * `skipped` counts ops that were DROPPED: either they named a content operation but carried no
 * content, or they were a block whose config the builder rejected (e.g. a YouTube link that is
 * not an embeddable YouTube link).
 *
 * This matters more than it looks. The op schema is deliberately a FLAT object with an `op`
 * enum — Gemini mishandles discriminated unions — so `text` (which belongs to insertBlock) is
 * a valid sibling field on a `setDocument` call, and Zod accepts it. When the model filled
 * `text` instead of `html`, the old `if (!op.html) break` swallowed the whole rewrite as an
 * UNCOUNTED no-op: the summary reported only the rename, the chip said success, and the
 * professor's authored document was silently discarded. QA reproduced exactly that.
 * Counting it is what lets the caller report `applied: false` and show the amber chip.
 */
export function applyDocumentOps(
  editor: Editor,
  ops: DocumentOp[],
): { summary: string; title: string | null; changed: number; skipped: number } {
  let title: string | null = null
  const counts = { set: false, appended: 0, replaced: 0, blocks: 0, renamed: false }
  let skipped = 0
  // Tracked separately from `skipped` so the summary can say something ACTIONABLE. "Skipped a
  // change with no content" is wrong for a block whose config was rejected — the professor
  // needs to know a link was unusable, which is the thing they'd otherwise go hunting for.
  let unusable = 0

  for (const op of ops) {
    switch (op.op) {
      case 'setDocument':
        if (!op.html) {
          skipped += 1
          break
        }
        editor.commands.setContent(op.html)
        counts.set = true
        break
      case 'appendSection': {
        if (!op.html) {
          skipped += 1
          break
        }
        // Insert at the explicit TOP-LEVEL end position, never the live cursor: focus('end')
        // can land inside a trailing container node (e.g. a callout), which would nest the
        // new content inside it. doc.content.size is always the top level after the last node.
        editor.chain().insertContentAt(editor.state.doc.content.size, op.html).run()
        counts.appended++
        break
      }
      case 'replaceSection': {
        if (!op.html || !op.headingId) {
          skipped += 1
          break
        }
        const range = sectionRange(editor, op.headingId)
        if (range) {
          editor.chain().deleteRange(range).insertContentAt(range.from, op.html).run()
          counts.replaced++
        }
        break
      }
      case 'insertBlock': {
        if (!op.blockType) break
        const node = buildBlockNode(op.blockType, op.config, op.text)
        if (!node) {
          // COUNT it. This was the last silent-discard hole: an unusable config broke out
          // without touching either counter, so an insert that produced nothing never
          // surfaced. That is exactly how a Frontier turn reported "Added 3 blocks" over a
          // video the professor could not see — buildBlockNode now rejects a YouTube link
          // the renderer can't embed, and this makes the rejection visible instead of
          // turning it into a phantom success.
          unusable += 1
          break
        }
        // Insert at a TOP-LEVEL position (after the target section, else at the document end)
        // using an explicit pos — NOT the live selection — so blocks never nest inside a
        // preceding container or overwrite the previous NodeSelection. insertContent parses
        // the node JSON directly into the schema, so the block lands fully configured.
        const afterPos = op.afterId ? sectionRange(editor, op.afterId)?.to : undefined
        const pos = typeof afterPos === 'number' ? afterPos : editor.state.doc.content.size
        editor.chain().insertContentAt(pos, node).run()
        counts.blocks++
        break
      }
      case 'setMeta':
        if (op.title) {
          title = op.title
          counts.renamed = true
        }
        break
    }
  }

  const parts: string[] = []
  if (counts.set) parts.push('rewrote the document')
  if (counts.appended) parts.push(`added ${counts.appended} section${counts.appended > 1 ? 's' : ''}`)
  if (counts.replaced) parts.push(`rewrote ${counts.replaced} section${counts.replaced > 1 ? 's' : ''}`)
  if (counts.blocks) parts.push(`added ${counts.blocks} block${counts.blocks > 1 ? 's' : ''}`)
  if (counts.renamed) parts.push('renamed the assignment')
  const changed =
    (counts.set ? 1 : 0) + counts.appended + counts.replaced + counts.blocks + (counts.renamed ? 1 : 0)
  // Name the skipped ops in the summary. Silence here is what made the discarded document
  // invisible: the rename counted, so the call "succeeded" and the omission never surfaced.
  if (skipped) parts.push(`skipped ${skipped} change${skipped > 1 ? 's' : ''} with no content`)
  if (unusable) parts.push(`skipped ${unusable} block${unusable > 1 ? 's' : ''} with an unusable link`)
  const summary = parts.length ? parts.join(', ').replace(/^./, (c) => c.toUpperCase()) : 'Nothing to change'
  // Both counters roll up into `skipped`: the caller's only question is "did anything get
  // silently dropped", and it must answer yes for either kind.
  return { summary, title, changed, skipped: skipped + unusable }
}
