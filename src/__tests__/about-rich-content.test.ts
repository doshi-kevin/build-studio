// The About page used to lose professor content on three separate paths. These
// tests pin each one shut. Every case below FAILED before this change.
//
//  1. Rich content inside a callout / highlight-box / faq answer was flattened.
//     Those three stored a TiptapDoc but edited it through a plain textarea, and
//     both the editor and the preview read it by joining the direct text children
//     of each top-level node. A bulletList's children are listItems, which have no
//     `.text`, so a list read back as empty — the preview rendered nothing (and
//     dropped the whole block when it had no title), and the next keystroke in the
//     editor replaced the document with plain paragraphs. Athena can write exactly
//     that content: the adapter's callout/highlight case runs htmlToDoc(op.html).
//
//  2. Athena's Undo restored a whole-page snapshot, so anything the professor
//     typed AFTER the fill was thrown away along with the fill.
//
//  3. A `table` had no title, so a grading breakdown rendered as an unlabelled
//     grid. The op schema's flat `title` already parsed for tables and was then
//     silently dropped by the adapter.

import { describe, it, expect, vi } from 'vitest'
import {
  aboutContentV2Schema,
  type AboutBlock,
  type TiptapDoc,
} from '@/lib/validations/course-about'
import { isDocEmpty, docToText } from '@/components/professor/about/block-editor/block-utils'
import {
  applyAboutOps,
  revertAboutOps,
  serializeAboutForAthena,
} from '@/components/professor/about/block-editor/athena-about-adapter'
import type { AboutOp } from '@/lib/ai/assignment-assistant/templates/registry'

// ── helpers ──────────────────────────────────────────────────

const BULLET_LIST: TiptapDoc = {
  type: 'doc',
  content: [
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bring a laptop' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Install Python 3.11' }] }] },
      ],
    },
  ],
}

/** How the three editors and previews used to read a document. Kept here as the
 *  thing the new behaviour is measured against. */
function legacyFlatten(doc: TiptapDoc): string {
  return (doc.content ?? [])
    .map((n) => n.content?.map((c) => (c as { text?: string }).text ?? '').join('') ?? '')
    .join('\n')
}

function hero(): AboutBlock {
  return {
    id: 'hero-1',
    type: 'hero',
    data: {
      bannerSrc: '', bannerPath: '', bannerAlt: '', title: 'NLP', subtitle: '',
      instructor: '', semester: '', credits: '', introVideoUrl: '',
      ctaText: '', ctaUrl: '', ctaFilePath: '', ctaFileName: '',
    },
  } as AboutBlock
}

function callout(content: TiptapDoc, title = ''): AboutBlock {
  return { id: 'callout-1', type: 'callout', data: { variant: 'info', title, content } } as AboutBlock
}

function text(id: string, body: string): AboutBlock {
  return {
    id,
    type: 'text',
    data: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] } },
  } as AboutBlock
}

// ── 1. nested content survives ───────────────────────────────

describe('rich content in callout / highlight-box / faq answers', () => {
  it('a bulleted list is NOT empty — the old flatten said it was', () => {
    // This single assertion is the whole bug: the flatten returned '\n', so an
    // untitled callout holding a list failed `if (!title && !text) return null`
    // and vanished from the student's page.
    expect(legacyFlatten(BULLET_LIST).trim()).toBe('')
    expect(isDocEmpty(BULLET_LIST)).toBe(false)
  })

  it('still reports a genuinely empty document as empty', () => {
    expect(isDocEmpty({ type: 'doc', content: [] })).toBe(true)
    expect(isDocEmpty({ type: 'doc', content: [{ type: 'paragraph', content: [] }] })).toBe(true)
    expect(isDocEmpty({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '   ' }] }] })).toBe(true)
  })

  it('Athena is told the list is there — it used to be shown an empty block', () => {
    // serializeAboutForAthena renders each block to text via docToText. With the
    // old direct-children-only version, a callout holding a list serialized as
    // "[info] (no title)\n(empty)", so the model believed the block was empty and
    // could confidently overwrite the professor's content.
    expect(docToText(BULLET_LIST)).toContain('Bring a laptop')
    expect(docToText(BULLET_LIST)).toContain('Install Python 3.11')

    const screen = serializeAboutForAthena([hero(), callout(BULLET_LIST)], true)
    const rendered = screen.components?.find((c) => c.id === 'callout-1')?.content ?? ''
    expect(rendered).toContain('Bring a laptop')
    expect(rendered).not.toContain('(empty)')
  })

  it('a list Athena writes into a callout survives an edit to the block title', () => {
    // The real sequence: Athena writes the list, then the professor renames the
    // callout. Editing one field must not rewrite the document.
    const before = [hero(), callout(BULLET_LIST)]
    const ops: AboutOp[] = [{ op: 'update', id: 'callout-1', title: 'Before the first class' }]
    const res = applyAboutOps(before, ops)

    const after = res.blocks.find((b) => b.id === 'callout-1')
    expect(after?.type).toBe('callout')
    if (after?.type !== 'callout') throw new Error('unreachable')
    expect(after.data.title).toBe('Before the first class')
    expect(after.data.content).toEqual(BULLET_LIST)
    expect(isDocEmpty(after.data.content)).toBe(false)
  })
})

// ── 2. undo keeps later edits ────────────────────────────────

describe('undoing an Athena fill', () => {
  it('keeps an edit the professor made to a DIFFERENT block after the fill', () => {
    const original = [hero(), text('t-1', 'Old description'), text('t-2', 'Week notes')]

    // Athena rewrites the description.
    const fill = applyAboutOps(original, [
      { op: 'update', id: 't-1', html: '<p>New description</p>' },
    ] as AboutOp[])
    expect(fill.changed).toBe(1)

    // The professor then fixes a typo in an unrelated block.
    const afterHumanEdit = fill.blocks.map((b) =>
      b.id === 't-2' ? text('t-2', 'Week notes (corrected)') : b,
    )

    // Undo. The fill goes back; the typo fix stays.
    const reverted = revertAboutOps(afterHumanEdit, fill.undoPatch)
    expect(reverted.find((b) => b.id === 't-1')).toEqual(original[1])
    expect(reverted.find((b) => b.id === 't-2')).toEqual(afterHumanEdit[2])
  })

  it('removes a block the fill inserted', () => {
    const original = [hero(), text('t-1', 'Body')]
    const fill = applyAboutOps(original, [
      { op: 'insert', blockType: 'quote', quoteText: 'Language is the dress of thought' },
    ] as AboutOp[])
    expect(fill.blocks).toHaveLength(3)

    expect(revertAboutOps(fill.blocks, fill.undoPatch)).toEqual(original)
  })

  it('puts back a block the fill removed, at its original position', () => {
    const original = [hero(), text('t-1', 'First'), text('t-2', 'Second')]
    const fill = applyAboutOps(original, [{ op: 'remove', id: 't-1' }] as AboutOp[])
    expect(fill.blocks.map((b) => b.id)).toEqual(['hero-1', 't-2'])

    expect(revertAboutOps(fill.blocks, fill.undoPatch).map((b) => b.id))
      .toEqual(['hero-1', 't-1', 't-2'])
  })

  it('puts back TWO removed blocks, each at its own original position', () => {
    // Each removal's saved index is only valid in the array as it stood right
    // before THAT removal. Replaying reinsertions oldest-first landed
    // [hero,t-1,t-3,t-2] instead of the original order — undoing must go in
    // reverse of removal order, last-removed-first, or later indices drift.
    const original = [hero(), text('t-1', 'First'), text('t-2', 'Second'), text('t-3', 'Third')]
    const fill = applyAboutOps(original, [
      { op: 'remove', id: 't-1' },
      { op: 'remove', id: 't-3' },
    ] as AboutOp[])
    expect(fill.blocks.map((b) => b.id)).toEqual(['hero-1', 't-2'])

    expect(revertAboutOps(fill.blocks, fill.undoPatch).map((b) => b.id))
      .toEqual(['hero-1', 't-1', 't-2', 't-3'])
  })

  it('does not re-apply a stale copy when two ops touch the same block', () => {
    // The pre-fill snapshot must be taken on the FIRST write only — otherwise the
    // second op's "before" is the already-half-edited block, and undo restores
    // that half-edit instead of the original.
    const original = [hero(), callout(BULLET_LIST, 'Original title')]
    const fill = applyAboutOps(original, [
      { op: 'update', id: 'callout-1', title: 'First rename' },
      { op: 'update', id: 'callout-1', title: 'Second rename' },
    ] as AboutOp[])

    const reverted = revertAboutOps(fill.blocks, fill.undoPatch)
    const back = reverted.find((b) => b.id === 'callout-1')
    if (back?.type !== 'callout') throw new Error('unreachable')
    expect(back.data.title).toBe('Original title')
  })

  it('a block the fill inserted and then removed leaves nothing behind to mark', () => {
    // Nothing is left on screen to review, so it must not be reported as changed —
    // the canvas would mark an id that no longer exists.
    const original = [hero(), text('t-1', 'Body')]
    const inserted = applyAboutOps(original, [
      { op: 'insert', blockType: 'quote', quoteText: 'Placeholder' },
    ] as AboutOp[])
    const newId = inserted.blocks[2].id

    const fill = applyAboutOps(inserted.blocks, [{ op: 'remove', id: newId }] as AboutOp[])
    expect(fill.changedIds).toEqual([])
  })

  it('undoing a REORDER restores the pre-fill order', () => {
    // A reorder moves blocks rather than editing their fields — undo replays
    // the position change by re-sorting to the pre-fill id order, not by
    // restoring stale content.
    const original = [hero(), text('t-1', 'First'), text('t-2', 'Second'), text('t-3', 'Third')]
    const fill = applyAboutOps(original, [{ op: 'reorder', id: 't-3', afterId: 'hero-1' }] as AboutOp[])
    expect(fill.blocks.map((b) => b.id)).toEqual(['hero-1', 't-3', 't-1', 't-2'])
    expect(fill.undoPatch.reordered).toBe(true)

    expect(revertAboutOps(fill.blocks, fill.undoPatch)).toEqual(original)
  })

  it('undoing a REORDER keeps a hand edit made to an UNRELATED block afterward', () => {
    // The old design undid a reorder by replacing the whole array with a full
    // pre-fill clone — safe for the reordered block, but it also discarded any
    // edit to ANY OTHER block made between the fill and the undo, even one the
    // fill never touched. Repro: reorder t-3, then hand-edit t-1 (untouched by
    // the fill), then Undo — t-1's edit must survive.
    const original = [hero(), text('t-1', 'First'), text('t-2', 'Second'), text('t-3', 'Third')]
    const fill = applyAboutOps(original, [{ op: 'reorder', id: 't-3', afterId: 'hero-1' }] as AboutOp[])

    const afterHandEdit = fill.blocks.map((b) => (b.id === 't-1' ? text('t-1', 'First (edited)') : b))
    const reverted = revertAboutOps(afterHandEdit, fill.undoPatch)

    expect(reverted.map((b) => b.id)).toEqual(['hero-1', 't-1', 't-2', 't-3'])
    expect(reverted.find((b) => b.id === 't-1')).toEqual(text('t-1', 'First (edited)'))
  })

  it('undoing a MIXED reorder+update batch reverts both, and still refuses if unsafe', () => {
    // One batch, two kinds of change: t-3 moves, t-1's text changes. Undo must
    // put t-3 back AND restore t-1's original text — not just one half.
    const original = [hero(), text('t-1', 'Old'), text('t-2', 'Second'), text('t-3', 'Third')]
    const fill = applyAboutOps(original, [
      { op: 'reorder', id: 't-3', afterId: 'hero-1' },
      { op: 'update', id: 't-1', html: '<p>New</p>' },
    ] as AboutOp[])
    expect(fill.undoPatch.reordered).toBe(true)
    expect(fill.undoPatch.updated['t-1']).toBeTruthy()

    expect(revertAboutOps(fill.blocks, fill.undoPatch)).toEqual(original)
  })

  it('a block inserted-then-removed in the SAME batch is not resurrected by Undo', () => {
    // Insert X, remove X, both ops in ONE batch: X never existed before this
    // fill, so undoing the whole batch must not bring it back. The insert mints
    // a fresh random id, so it can't be named in the SAME ops array ahead of
    // time — stub crypto.randomUUID (same pattern as block-reducer.test.ts) to
    // make it deterministic and referenceable.
    vi.stubGlobal('crypto', { randomUUID: () => 'minted-id' })
    try {
      const original = [hero(), text('t-1', 'Body')]
      const fill = applyAboutOps(original, [
        { op: 'insert', blockType: 'quote', quoteText: 'Placeholder' },
        { op: 'remove', id: 'minted-id' },
      ] as AboutOp[])

      expect(fill.blocks.map((b) => b.id)).toEqual(['hero-1', 't-1'])
      expect(fill.undoPatch.inserted).toEqual([])
      expect(fill.undoPatch.removed).toEqual([])

      expect(revertAboutOps(fill.blocks, fill.undoPatch).map((b) => b.id))
        .toEqual(['hero-1', 't-1'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('removing a block the SAME batch already updated restores the TRUE original, not the edit', () => {
    // update t-1, then remove t-1, in one batch: the removed snapshot must be
    // t-1 as it stood before the fill, not the just-applied edit — otherwise
    // undo resurrects Athena's version instead of the professor's.
    const original = [hero(), text('t-1', 'Original')]
    const fill = applyAboutOps(original, [
      { op: 'update', id: 't-1', html: '<p>Edited</p>' },
      { op: 'remove', id: 't-1' },
    ] as AboutOp[])
    expect(fill.blocks.map((b) => b.id)).toEqual(['hero-1'])

    const reverted = revertAboutOps(fill.blocks, fill.undoPatch)
    expect(reverted).toEqual(original)
  })

  it('reports which blocks it changed, so the host can mark them', () => {
    const original = [hero(), text('t-1', 'a'), text('t-2', 'b')]
    const fill = applyAboutOps(original, [
      { op: 'update', id: 't-2', html: '<p>changed</p>' },
      { op: 'update', id: 't-1', html: '<p>changed too</p>' },
    ] as AboutOp[])
    // Page order, not op order — the host scrolls to the first one.
    expect(fill.changedIds).toEqual(['t-1', 't-2'])
  })
})

// ── 3. the table title ───────────────────────────────────────

describe('table title', () => {
  it('a table stored before the field existed still parses, and defaults to empty', () => {
    const stored = {
      version: 2,
      blocks: [
        { id: 'tbl-1', type: 'table', data: { hasHeaderRow: true, rows: [['Item', 'Weight'], ['Final', '30%']] } },
      ],
    }
    const parsed = aboutContentV2Schema.safeParse(stored)
    expect(parsed.success).toBe(true)
    if (!parsed.success) throw new Error('unreachable')
    const block = parsed.data.blocks[0]
    if (block.type !== 'table') throw new Error('unreachable')
    expect(block.data.title).toBe('')
    expect(block.data.rows).toHaveLength(2)
  })

  it('Athena can now set it — the op parsed before but landed nowhere', () => {
    const blocks = [
      hero(),
      { id: 'tbl-1', type: 'table', data: { title: '', hasHeaderRow: true, rows: [['Item', 'Weight']] } } as AboutBlock,
    ]
    const res = applyAboutOps(blocks, [{ op: 'update', id: 'tbl-1', title: 'Grading' }] as AboutOp[])

    expect(res.changed).toBe(1)
    expect(res.skipped).toBe(0) // it used to land here
    const table = res.blocks.find((b) => b.id === 'tbl-1')
    if (table?.type !== 'table') throw new Error('unreachable')
    expect(table.data.title).toBe('Grading')
  })

  it('the result still round-trips through the save-time schema', () => {
    const res = applyAboutOps(
      [hero(), { id: 'tbl-1', type: 'table', data: { title: '', hasHeaderRow: true, rows: [['a']] } } as AboutBlock],
      [{ op: 'update', id: 'tbl-1', title: 'Grading' }] as AboutOp[],
    )
    // saveAboutContent parses before writing; a shape it rejects is a silent
    // "your page stopped saving" for the professor.
    expect(aboutContentV2Schema.safeParse({ version: 2, blocks: res.blocks }).success).toBe(true)
  })
})
