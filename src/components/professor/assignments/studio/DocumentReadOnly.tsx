/**
 * Read-only render of a document assignment (TipTap JSON) with math rendering — used by the
 * student view and the studio's "View as student" preview. Same content the professor authored,
 * with `$…$` / `\ce{…}` rendered via the document extensions (KaTeX).
 *
 * Type: Client Component
 */
'use client'

import { EditorRoot, EditorContent, type JSONContent } from 'novel'
import { documentExtensions } from './documentExtensions'

export function DocumentReadOnly({ content, className }: { content: JSONContent | null | undefined; className?: string }) {
  if (!content || !content.content?.length) return null
  return (
    <div className={className}>
      <EditorRoot>
        <EditorContent
          initialContent={content}
          extensions={documentExtensions}
          editable={false}
          editorProps={{
            attributes: {
              class: 'studio-doc prose prose-neutral prose-headings:font-semibold font-default max-w-full',
            },
          }}
        />
      </EditorRoot>
    </div>
  )
}
