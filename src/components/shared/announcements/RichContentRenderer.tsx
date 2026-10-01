/**
 * RichContentRenderer — read-only TipTap content display.
 *
 * Renders TipTap JSONContent in a non-editable editor instance with prose styling.
 * Used in both professor announcement cards and student announcement views.
 *
 * When `sectionId` is provided, mention nodes render as clickable links
 * that route to the referenced course item.
 *
 * Type: Client Component
 */
'use client'

import { useMemo } from 'react'
import { isRichContentEmpty } from '@/lib/announcements/rich-content'
import { EditorRoot, EditorContent, type JSONContent } from 'novel'
import { defaultExtensions } from '@/components/professor/about/extensions'
import { CourseMentionExtension } from '@/lib/tiptap/course-mention-extension'

interface RichContentRendererProps {
  content: JSONContent | null | undefined
  className?: string
  sectionId?: string
  basePath?: string
}

export function RichContentRenderer({ content, className, sectionId, basePath }: RichContentRendererProps) {
  const extensions = useMemo(() => {
    const exts = [...defaultExtensions]
    if (sectionId) {
       
      exts.push(CourseMentionExtension.configure({
        HTMLAttributes: {
          class: 'course-mention',
        },
        sectionId,
        basePath,
      }))
    }
    return exts
  }, [sectionId, basePath])

  if (isRichContentEmpty(content)) return null

  return (
    <div className={className}>
      <EditorRoot>
        <EditorContent
          initialContent={content as unknown as JSONContent}
          extensions={extensions}
          editable={false}
          editorProps={{
            attributes: {
              class: 'prose prose-sm prose-neutral prose-headings:font-semibold font-default max-w-full',
            },
          }}
        />
      </EditorRoot>
    </div>
  )
}

