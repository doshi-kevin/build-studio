// The rich-text pair shared by every block that stores a TiptapDoc.
//
// Why this exists: `text` blocks used the real Tiptap editor, but `faq` answers,
// `callout` and `highlight-box` declared their content as TiptapDoc and then
// edited it through a plain <Textarea>, converting with docToText/textToDoc.
// That round-trip only understands top-level nodes with direct text children, so
// a bulleted list read back as empty strings and the next keystroke replaced the
// whole document with plain paragraphs — deleting the list. The previews for
// those three flattened the same way, so a list Athena wrote (op.html ->
// htmlToDoc) rendered as nothing, and a block with no title vanished entirely.
//
// Both halves now go through Tiptap, so what is stored, what is edited, and what
// a student reads are the same document.

'use client'

import { useState } from 'react'
import {
  EditorRoot,
  EditorContent,
  EditorCommand,
  EditorCommandItem,
  EditorCommandEmpty,
  EditorCommandList,
  EditorBubble,
  handleCommandNavigation,
  type JSONContent,
} from 'novel'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { TiptapDoc } from '@/lib/validations/course-about'
import { defaultExtensions } from './extensions'
import { suggestionItems, slashCommand } from './slash-command'
import { NodeSelector } from './selectors/node-selector'
import { LinkSelector } from './selectors/link-selector'
import { TextButtons } from './selectors/text-buttons'
import { ColorSelector } from './selectors/color-selector'
import { useBlockEditor } from './block-editor'

const extensions = [...defaultExtensions, slashCommand]

interface FieldProps {
  value: TiptapDoc
  onChange: (doc: TiptapDoc) => void
  className?: string
}

/**
 * Editable rich text.
 *
 * The `key` is the important part. Tiptap takes `initialContent` once at mount
 * and never re-reads it, so when the block array is replaced from outside (an
 * Athena fill, an undo, the starter template) a mounted editor still holds the
 * previous document, and the professor's next keystroke writes that stale copy
 * back over the change. Keying on the reducer's externalRev remounts the editor
 * exactly on those external replacements — and never on the professor's own
 * typing, which would drop the caret mid-word.
 */
export function RichTextField({ value, onChange, className }: FieldProps) {
  const { state } = useBlockEditor()
  const [openNode, setOpenNode] = useState(false)
  const [openColor, setOpenColor] = useState(false)
  const [openLink, setOpenLink] = useState(false)

  return (
    <EditorRoot key={state.externalRev}>
      <EditorContent
        className={cn('min-h-[40px]', className)}
        {...(value.content?.length ? { initialContent: value as unknown as JSONContent } : {})}
        extensions={extensions}
        editorProps={{
          handleDOMEvents: {
            keydown: (_view, event) => handleCommandNavigation(event),
          },
          attributes: {
            class: 'prose prose-neutral prose-headings:font-semibold font-default focus:outline-none max-w-full',
          },
        }}
        onUpdate={({ editor }) => onChange(editor.getJSON() as unknown as TiptapDoc)}
      >
        <EditorCommand className="z-50 h-auto max-h-[330px] overflow-y-auto rounded-2xl border border-border bg-background px-1 py-2 shadow-md">
          <EditorCommandEmpty className="px-2 text-muted-foreground">No results</EditorCommandEmpty>
          <EditorCommandList>
            {suggestionItems.map((item) => (
              <EditorCommandItem
                value={item.title}
                onCommand={(val) => item.command?.(val)}
                className="flex w-full items-center space-x-2 rounded-xl px-2 py-1 text-left text-sm hover:bg-accent aria-selected:bg-accent"
                key={item.title}
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-background">
                  {item.icon}
                </div>
                <div>
                  <p className="font-medium">{item.title}</p>
                  <p className="text-xs text-muted-foreground">{item.description}</p>
                </div>
              </EditorCommandItem>
            ))}
          </EditorCommandList>
        </EditorCommand>

        <EditorBubble
          tippyOptions={{ placement: 'top' }}
          className="flex w-fit max-w-[90vw] overflow-hidden rounded-2xl border border-border bg-background shadow-xl"
        >
          <Separator orientation="vertical" />
          <NodeSelector open={openNode} onOpenChange={setOpenNode} />
          <Separator orientation="vertical" />
          <LinkSelector open={openLink} onOpenChange={setOpenLink} />
          <Separator orientation="vertical" />
          <TextButtons />
          <Separator orientation="vertical" />
          <ColorSelector open={openColor} onOpenChange={setOpenColor} />
        </EditorBubble>
      </EditorContent>
    </EditorRoot>
  )
}

/** Read-only rendering of the same document, for previews and the student page. */
export function RichTextView({ value, className }: { value: TiptapDoc; className?: string }) {
  if (!value.content?.length) return null
  return (
    <EditorRoot>
      <EditorContent
        className={className}
        initialContent={value as unknown as JSONContent}
        extensions={defaultExtensions}
        editable={false}
        editorProps={{
          attributes: {
            class: 'prose prose-neutral max-w-full focus:outline-none',
          },
        }}
      />
    </EditorRoot>
  )
}
