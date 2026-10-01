/**
 * TrailingNode — keeps a plain paragraph after any block that's awkward to escape (code block,
 * table, horizontal rule, and the atom blocks: chart / graph / map / wolfram / equation).
 *
 * Without it, when one of those is the last node in the document there's nowhere for the caret to
 * go, so ArrowDown / clicking below can't get you out. With a trailing paragraph always present,
 * StarterKit's code-block `exitOnArrowDown` and the gapcursor let you step past the block cleanly.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

const HARD_TO_EXIT = new Set([
  'codeBlock',
  'table',
  'horizontalRule',
  'chart',
  'graph',
  'map',
  'wolfram',
  'equation',
])

export const TrailingNode = Extension.create({
  name: 'trailingNode',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('trailingNode'),
        appendTransaction(_transactions, _oldState, state) {
          const { doc, tr, schema } = state
          const last = doc.lastChild
          const paragraph = schema.nodes.paragraph
          if (!last || !paragraph) return null
          if (!HARD_TO_EXIT.has(last.type.name)) return null
          // Last node is awkward to exit — append an empty paragraph so the caret has a home.
          return tr.insert(doc.content.size, paragraph.create())
        },
      }),
    ]
  },
})
