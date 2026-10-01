/**
 * Athena ↔ About page adapter.
 *
 * Pure functions over the block array (no live editor instance — the builder is
 * reducer-driven), so both halves are unit-testable:
 *  - serializeAboutForAthena: blocks → the generic authoring <screen> shape
 *    (id/type/compact-text per block), which also makes the panel's existing
 *    change-diff work here unchanged.
 *  - applyAboutOps: (blocks, ops) → a NEW block array + a one-line summary.
 *    The caller (AboutPageBuilder) dispatches the result and snapshots the prior
 *    array for a one-click whole-fill Undo.
 *
 * Two invariants this file owns:
 *  - THE HERO IS A SINGLETON AND PINNED FIRST: the op schema can't insert one,
 *    and remove/reorder ops targeting it are skipped (counted, so the summary
 *    says so rather than silently no-oping).
 *  - STORAGE-BACKED ASSET FIELDS ARE NEVER WRITTEN: bannerSrc/bannerPath,
 *    ctaUrl/ctaFilePath/ctaFileName, image src/srcPath. The screen only ever
 *    shows short-lived signed URLs for these, so a model echo-back would break
 *    the professor's uploads an hour later. Updates merge field-wise and those
 *    fields are simply not reachable from an op.
 */
import { generateJSON } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import type { AboutOp } from '@/lib/ai/assignment-assistant/templates/registry'
import type { AuthoringState } from '@/lib/ai/assignment-assistant/schemas'
import type {
  AboutBlock,
  CalloutVariant,
  HighlightVariant,
  TiptapDoc,
} from '@/lib/validations/course-about'
import { createBlock } from './block-factory'
import { docToText, textToDoc } from './block-utils'

// A whole About page is a handful of sections; this is a runaway guard, not a real
// limit. It caps the JSONB blob one autosave writes to course_sections.settings and
// keeps the page inside the 300-block screen slice the model can actually see.
const MAX_BLOCKS = 200

// Block types the model may insert. Mirrors ABOUT_INSERT_TYPES in the op schema, and
// is the self-contained hero/image guard: even if that enum drifts, an insert of a
// type absent here is skipped rather than creating a second hero or an unfillable
// image. Kept as a Set so the insert case defends itself without reaching cross-file.
const INSERTABLE = new Set<string>([
  'text', 'table', 'video', 'syllabus', 'learning-outcomes',
  'faq', 'callout', 'quote', 'highlight-box', 'contact', 'divider',
])

/** componentSnapshotSchema caps content at 4000 chars — truncate to fit. */
const CONTENT_MAX = 4000

function trunc(s: string): string {
  const t = s.trim()
  return t.length > CONTENT_MAX ? `${t.slice(0, CONTENT_MAX - 12)}…(truncated)` : t
}

/**
 * Simple semantic HTML → TiptapDoc. StarterKit covers everything the op schema
 * promises the model (headings, paragraphs, lists, bold/italic, blockquote);
 * TipTap normalizes anything else away safely. Falls back to plain-paragraph
 * conversion if parsing throws, so a fill never dies on odd markup.
 */
function htmlToDoc(html: string): TiptapDoc {
  try {
    return generateJSON(html, [StarterKit]) as TiptapDoc
  } catch {
    return textToDoc(html.replace(/<[^>]*>/g, ''))
  }
}

/** One compact, human-readable text rendering per block — what the model reads. */
function blockContent(b: AboutBlock): string {
  switch (b.type) {
    case 'hero': {
      const d = b.data
      const lines = [
        `title: ${d.title || '(empty)'}`,
        d.subtitle && `subtitle: ${d.subtitle}`,
        d.instructor && `instructor: ${d.instructor}`,
        d.semester && `semester: ${d.semester}`,
        d.credits && `credits: ${d.credits}`,
        d.ctaText && `action button: "${d.ctaText}"${d.ctaFileName ? ` (file attached: ${d.ctaFileName})` : ''}`,
        d.bannerPath ? 'banner image: uploaded (professor-managed)' : 'banner image: default',
      ]
      return lines.filter(Boolean).join('\n')
    }
    case 'text':
      return docToText(b.data.content) || '(empty)'
    case 'image':
      return `image (professor-managed upload) — alt: ${b.data.alt || '(none)'}${b.data.caption ? `, caption: ${b.data.caption}` : ''}`
    case 'table': {
      const grid = b.data.rows.map((r) => r.join(' | ')).join('\n') || '(empty table)'
      return b.data.title ? `${b.data.title}\n${grid}` : grid
    }
    case 'video':
      return `video: ${b.data.url || '(no url yet)'}${b.data.caption ? ` — ${b.data.caption}` : ''}`
    case 'syllabus': {
      const weeks = b.data.weeks
        .map((w) => `Week ${w.week}: ${w.topic || '(no topic)'}${w.description ? ` — ${w.description}` : ''}${w.readings ? ` [readings: ${w.readings}]` : ''}`)
        .join('\n')
      return `${b.data.title}${b.data.tba ? ' (marked "coming soon" to students)' : ''}\n${weeks || '(no weeks yet)'}`
    }
    case 'learning-outcomes': {
      const items = b.data.outcomes
        .map((o) => `- ${o.text || '(empty)'}${o.isCore ? '' : ' (optional)'}`)
        .join('\n')
      return `${b.data.title}${b.data.tba ? ' (marked "coming soon" to students)' : ''}\n${items || '(no outcomes yet)'}`
    }
    case 'faq': {
      const items = b.data.items.map((i) => `Q: ${i.question || '(empty)'}\nA: ${docToText(i.answer) || '(empty)'}`).join('\n')
      return `${b.data.title}\n${items || '(no questions yet)'}`
    }
    case 'callout':
      return `[${b.data.variant}] ${b.data.title || '(no title)'}\n${docToText(b.data.content) || '(empty)'}`
    case 'highlight-box':
      return `[${b.data.variant}] ${b.data.title || '(no title)'}\n${docToText(b.data.content) || '(empty)'}`
    case 'quote':
      return `"${b.data.text || '(empty)'}"${b.data.attribution ? ` — ${b.data.attribution}` : ''}`
    case 'contact': {
      const d = b.data
      const lines = [
        d.name && `name: ${d.name}`,
        d.title && `title: ${d.title}`,
        d.email && `email: ${d.email}`,
        d.officeLocation && `office: ${d.officeLocation}`,
        d.officeHours && `office hours: ${d.officeHours}`,
        d.zoomUrl && `zoom: ${d.zoomUrl}`,
        d.responseTime && `response time: ${d.responseTime}`,
      ]
      return lines.filter(Boolean).join('\n') || '(empty contact card)'
    }
    case 'divider':
      return '(divider)'
  }
}

/** The About page as the generic authoring screen shape Athena already reads.
 *  `editing` reports the page-mode gate: in preview, Athena is a discussion
 *  partner only — the client refuses fills, and the prompt tells it to send the
 *  professor to the "Edit page" button instead of attempting one. */
export function serializeAboutForAthena(blocks: AboutBlock[], editing: boolean): AuthoringState {
  return {
    kind: 'about',
    meta: {
      pageMode: editing
        ? 'editing — apply_edits lands on the canvas'
        : 'PREVIEW (read-only) — edits CANNOT land; the professor must click "Edit page" (top right) first',
    },
    components: blocks.slice(0, 300).map((b) => ({
      id: b.id,
      type: b.type,
      content: trunc(blockContent(b)),
    })),
  }
}

const CALLOUT_VARIANTS: readonly CalloutVariant[] = ['info', 'warning', 'success', 'alert']
const HIGHLIGHT_VARIANTS: readonly HighlightVariant[] = ['feature', 'tip', 'important']

/**
 * Merge an op's content fields into a block of the matching type. Returns how
 * many fields actually landed — 0 means the op carried nothing this block type
 * understands (counted as skipped by the caller). Mutates `block`, which the
 * caller has already cloned.
 */
function mergeFields(block: AboutBlock, op: AboutOp): number {
  let applied = 0
  const set = <T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined) => {
    if (value === undefined) return
    obj[key] = value
    applied++
  }
  switch (block.type) {
    case 'hero': {
      const h = op.hero
      if (h) {
        set(block.data, 'title', h.title)
        set(block.data, 'subtitle', h.subtitle)
        set(block.data, 'instructor', h.instructor)
        set(block.data, 'semester', h.semester)
        set(block.data, 'credits', h.credits)
        set(block.data, 'ctaText', h.ctaText)
      }
      break
    }
    case 'text':
      if (op.html !== undefined) {
        block.data.content = htmlToDoc(op.html)
        applied++
      }
      break
    case 'table':
      /* The op schema's `title` is a flat field shared by every block type, so
         `{ op: 'update', id: <table>, title: 'Grading' }` already parsed — it
         just landed nowhere and was counted as skipped. */
      set(block.data, 'title', op.title)
      if (op.rows !== undefined) {
        block.data.rows = op.rows.map((r) => [...r])
        applied++
      }
      set(block.data, 'hasHeaderRow', op.hasHeaderRow)
      break
    case 'video':
      set(block.data, 'url', op.videoUrl)
      set(block.data, 'caption', op.caption)
      break
    case 'syllabus':
      set(block.data, 'title', op.title)
      if (op.weeks !== undefined) {
        block.data.weeks = op.weeks.map((w) => ({
          id: crypto.randomUUID(),
          week: w.week,
          topic: w.topic,
          description: w.description ?? '',
          readings: w.readings ?? '',
        }))
        applied++
      }
      set(block.data, 'tba', op.tba)
      break
    case 'learning-outcomes':
      set(block.data, 'title', op.title)
      if (op.outcomes !== undefined) {
        block.data.outcomes = op.outcomes.map((o) => ({
          id: crypto.randomUUID(),
          text: o.text,
          isCore: o.isCore ?? true,
        }))
        applied++
      }
      set(block.data, 'tba', op.tba)
      break
    case 'faq':
      set(block.data, 'title', op.title)
      if (op.faqItems !== undefined) {
        block.data.items = op.faqItems.map((i) => ({
          id: crypto.randomUUID(),
          question: i.question,
          answer: textToDoc(i.answer),
        }))
        applied++
      }
      break
    case 'callout':
      set(block.data, 'title', op.title)
      if (op.variant !== undefined && (CALLOUT_VARIANTS as readonly string[]).includes(op.variant)) {
        block.data.variant = op.variant as CalloutVariant
        applied++
      }
      if (op.html !== undefined) {
        block.data.content = htmlToDoc(op.html)
        applied++
      }
      break
    case 'highlight-box':
      set(block.data, 'title', op.title)
      if (op.variant !== undefined && (HIGHLIGHT_VARIANTS as readonly string[]).includes(op.variant)) {
        block.data.variant = op.variant as HighlightVariant
        applied++
      }
      if (op.html !== undefined) {
        block.data.content = htmlToDoc(op.html)
        applied++
      }
      break
    case 'quote':
      set(block.data, 'text', op.quoteText)
      set(block.data, 'attribution', op.attribution)
      break
    case 'contact': {
      const c = op.contact
      if (c) {
        set(block.data, 'name', c.name)
        set(block.data, 'title', c.title)
        set(block.data, 'email', c.email)
        set(block.data, 'officeLocation', c.officeLocation)
        set(block.data, 'officeHours', c.officeHours)
        set(block.data, 'zoomUrl', c.zoomUrl)
        set(block.data, 'responseTime', c.responseTime)
      }
      break
    }
    case 'image':
    case 'divider':
      // Nothing model-writable: images are upload-only, dividers have no data.
      break
  }
  return applied
}

/** What a fill changed, in the shape `revertAboutOps` needs to take it back out.
 *  Undo used to restore a whole-page snapshot, which threw away anything the
 *  professor typed AFTER the fill. This records the fill's own footprint instead,
 *  so undo touches only the blocks Athena touched. */
export interface AboutUndoPatch {
  /** Pre-fill copy of each block the fill UPDATED, keyed by id. */
  updated: Record<string, AboutBlock>
  /** Ids the fill INSERTED — undo deletes these. */
  inserted: string[]
  /** Blocks the fill REMOVED, with the index they sat at — undo puts them back. */
  removed: { index: number; block: AboutBlock }[]
  /** Whether any op in this batch moved a block. Undo replays the CONTENT
   *  footprint above first, then fixes position to match `orderSnapshot` — see
   *  `reorderToMatch`. Position and content are independent, so both undo
   *  together even when a batch reorders one block and edits another. */
  reordered: boolean
  /** Block ids in their pre-fill order. Used only when `reordered` is true, to
   *  re-sort the CURRENT (already content-reverted) array back into place —
   *  never to replace blocks with stale content, which is what let a reorder
   *  undo discard an unrelated hand edit made after the fill (any block on the
   *  page, not just ones this fill touched, since the old design replaced the
   *  entire array with a full pre-fill clone). */
  orderSnapshot: string[]
}

export interface ApplyAboutResult {
  blocks: AboutBlock[]
  summary: string
  /** How many ops landed. 0 → the caller reports applied: false. */
  changed: number
  /** Ops dropped (unknown id, hero remove/move, or no usable fields). */
  skipped: number
  /** Ids of blocks this fill inserted or updated, in page order — what the host
   *  marks so the professor can see what moved. Removed ids are not listed:
   *  there is nothing left on screen to mark. */
  changedIds: string[]
  /** Feed this to `revertAboutOps` to undo the fill. */
  undoPatch: AboutUndoPatch
}

/** Re-sort `blocks` to match `orderIds`, without replacing any block's content —
 *  a pure position fix-up. A block from `orderIds` no longer present is skipped
 *  (something else already removed it); a block not in `orderIds` (inserted
 *  since, by this fill or another) keeps its current relative position, appended
 *  after the known ones. The hero always stays first regardless. */
function reorderToMatch(blocks: AboutBlock[], orderIds: string[]): AboutBlock[] {
  const byId = new Map(blocks.map((b) => [b.id, b]))
  const known = orderIds.filter((id) => byId.has(id)).map((id) => byId.get(id) as AboutBlock)
  const knownIds = new Set(known.map((b) => b.id))
  const rest = blocks.filter((b) => !knownIds.has(b.id))
  const merged = [...known, ...rest]

  const heroIdx = merged.findIndex((b) => b.type === 'hero')
  if (heroIdx > 0) {
    const [heroBlock] = merged.splice(heroIdx, 1)
    merged.unshift(heroBlock)
  }
  return merged
}

/** Take a fill back out, against the CURRENT blocks rather than a stale snapshot,
 *  so edits made after the fill survive the undo. Pure — returns a NEW array.
 *
 *  Content and position revert independently: footprint-based content revert
 *  runs first (same as any other fill), then a reorder — if this batch did one —
 *  re-sorts the RESULT into `orderSnapshot`'s order. Neither step replaces a
 *  block with stale content, so a hand edit to ANY block on the page, whether
 *  this fill touched it or not, survives an Undo that includes a reorder. */
export function revertAboutOps(current: AboutBlock[], patch: AboutUndoPatch): AboutBlock[] {
  const insertedIds = new Set(patch.inserted)
  const out = current
    .filter((b) => !insertedIds.has(b.id))
    .map((b) => {
      const before = patch.updated[b.id]
      return before ? (JSON.parse(JSON.stringify(before)) as AboutBlock) : b
    })

  /* Re-insert removals LAST-removed-first, not lowest-index-first. Each saved
     `index` is only valid in the array as it stood immediately before THAT
     removal — for two removals in one fill, the second one's index was
     recorded in an array that had already lost the first. Replaying oldest-
     first re-inserts into an array still missing the newer removal, so
     everything from the second index onward lands one slot short. Undoing in
     reverse chronological order means each reinsertion always faces an array
     missing exactly what it was missing at removal time: nothing removed
     after it (not yet undone) and everything removed before it (already put
     back). Caught by a real repro: remove t-1 then t-3 from
     [hero,t-1,t-2,t-3], undo, and ascending order produced
     [hero,t-1,t-3,t-2] instead of the original order. */
  for (const { index, block } of [...patch.removed].reverse()) {
    const at = Math.min(Math.max(index, out[0]?.type === 'hero' ? 1 : 0), out.length)
    out.splice(at, 0, JSON.parse(JSON.stringify(block)) as AboutBlock)
  }

  return patch.reordered ? reorderToMatch(out, patch.orderSnapshot) : out
}

/** Apply a batch of ops to a block array. Pure — returns a NEW array. */
export function applyAboutOps(blocks: AboutBlock[], ops: AboutOp[]): ApplyAboutResult {
  const next = blocks.map((b) => JSON.parse(JSON.stringify(b)) as AboutBlock)
  const counts = { inserted: 0, updated: 0, removed: 0, reordered: 0 }
  let skipped = 0
  const undoPatch: AboutUndoPatch = {
    updated: {},
    inserted: [],
    removed: [],
    reordered: false,
    orderSnapshot: blocks.map((b) => b.id),
  }
  const touched = new Set<string>()
  // The floor for insert/reorder positions: never above a pinned hero.
  const minIndex = () => (next[0]?.type === 'hero' ? 1 : 0)

  for (const op of ops) {
    switch (op.op) {
      case 'insert': {
        // Self-defending: a missing/unknown/non-insertable type (hero, image) is
        // skipped here, so the singleton doesn't rest solely on the op-schema enum
        // in another file — and createBlock never throws on an unexpected type.
        if (!op.blockType || !INSERTABLE.has(op.blockType) || next.length >= MAX_BLOCKS) {
          skipped++
          break
        }
        const block = createBlock(op.blockType)
        mergeFields(block, op)
        const afterIdx = op.afterId ? next.findIndex((b) => b.id === op.afterId) : -1
        const at = afterIdx >= 0 ? afterIdx + 1 : next.length
        next.splice(Math.max(at, minIndex()), 0, block)
        undoPatch.inserted.push(block.id)
        touched.add(block.id)
        counts.inserted++
        break
      }
      case 'update': {
        const target = op.id ? next.find((b) => b.id === op.id) : undefined
        if (!target) {
          skipped++
          break
        }
        /* Snapshot the pre-fill copy before the first write to this block only —
           a second op on the same block must not overwrite the original with the
           already-half-edited version. A block this fill INSERTED needs no entry:
           undo deletes it outright. */
        const priorKnown = target.id in undoPatch.updated || undoPatch.inserted.includes(target.id)
        const prior = priorKnown ? null : blocks.find((b) => b.id === target.id)
        if (mergeFields(target, op) > 0) {
          if (prior) undoPatch.updated[target.id] = JSON.parse(JSON.stringify(prior)) as AboutBlock
          touched.add(target.id)
          counts.updated++
        } else skipped++
        break
      }
      case 'remove': {
        const idx = op.id ? next.findIndex((b) => b.id === op.id) : -1
        if (idx === -1 || next[idx].type === 'hero') {
          skipped++
          break
        }
        const removedId = next[idx].id
        if (undoPatch.inserted.includes(removedId)) {
          /* This SAME batch inserted removedId earlier — insert-then-remove
             cancels out. It never existed before this fill, so there is
             nothing for undo to restore; recording it in `removed` would have
             undo resurrect a block the professor never had. */
          undoPatch.inserted = undoPatch.inserted.filter((id) => id !== removedId)
        } else {
          /* If an earlier op in this SAME batch already updated this block,
             next[idx] reflects THAT edit, not the true pre-fill content —
             undoPatch.updated holds the real original; fall back to next[idx]
             only when nothing in this batch touched it yet. */
          const original = undoPatch.updated[removedId] ?? next[idx]
          undoPatch.removed.push({ index: idx, block: JSON.parse(JSON.stringify(original)) as AboutBlock })
        }
        touched.delete(removedId)
        next.splice(idx, 1)
        counts.removed++
        break
      }
      case 'reorder': {
        const idx = op.id ? next.findIndex((b) => b.id === op.id) : -1
        if (idx === -1 || next[idx].type === 'hero') {
          skipped++
          break
        }
        const [moved] = next.splice(idx, 1)
        const afterIdx = op.afterId ? next.findIndex((b) => b.id === op.afterId) : -1
        const at = afterIdx >= 0 ? afterIdx + 1 : minIndex()
        next.splice(Math.max(at, minIndex()), 0, moved)
        undoPatch.reordered = true
        counts.reordered++
        break
      }
    }
  }

  const parts: string[] = []
  if (counts.inserted) parts.push(`added ${counts.inserted} section${counts.inserted > 1 ? 's' : ''}`)
  if (counts.updated) parts.push(`updated ${counts.updated} section${counts.updated > 1 ? 's' : ''}`)
  if (counts.removed) parts.push(`removed ${counts.removed} section${counts.removed > 1 ? 's' : ''}`)
  if (counts.reordered) parts.push('reordered the page')
  // Name the drops. Silence here is the phantom-success trap the document
  // adapter documents: a chip that says only "Updated 1 section" over an op that
  // was quietly dropped reads as "everything landed".
  if (skipped) parts.push(`skipped ${skipped} change${skipped > 1 ? 's' : ''} that didn't match the page`)
  const summary = parts.length
    ? parts.join(', ').replace(/^./, (c) => c.toUpperCase())
    : 'Nothing to change'
  const changed = counts.inserted + counts.updated + counts.removed + counts.reordered
  // Page order, not op order: the host scrolls to the first marked block.
  const changedIds = next.filter((b) => touched.has(b.id)).map((b) => b.id)
  return { blocks: next, summary, changed, skipped, changedIds, undoPatch }
}
