/**
 * AnnouncementEditor — rich text editor for announcements.
 *
 * Wraps Novel (TipTap) editor, reusing the existing extensions, slash command,
 * and bubble menu selectors from the About page builder.
 *
 * Supports optional @-mention autocomplete for course items when `courseItems` prop is provided.
 *
 * Type: Client Component
 */
'use client'

import { useState, useMemo } from 'react'
import {
  EditorRoot,
  EditorContent,
  EditorCommand,
  EditorCommandItem,
  EditorCommandEmpty,
  EditorCommandList,
  EditorBubble,
  type JSONContent,
} from 'novel'
import { handleCommandNavigation } from 'novel'
import { Separator } from '@/components/ui/separator'
import { defaultExtensions } from '@/components/professor/about/extensions'
import { suggestionItems, slashCommand } from '@/components/professor/about/slash-command'
import { NodeSelector } from '@/components/professor/about/selectors/node-selector'
import { LinkSelector } from '@/components/professor/about/selectors/link-selector'
import { TextButtons } from '@/components/professor/about/selectors/text-buttons'
import { ColorSelector } from '@/components/professor/about/selectors/color-selector'
import { CourseMentionExtension, type CourseItem } from '@/lib/tiptap/course-mention-extension'
import { courseMentionSuggestion } from '@/lib/tiptap/course-mention-suggestion'

interface AnnouncementEditorProps {
  initialContent?: JSONContent | null
  onChange: (json: JSONContent) => void
  placeholder?: string
  courseItems?: CourseItem[]
  sectionId?: string
  basePath?: string
}

export function AnnouncementEditor({
  initialContent,
  onChange,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  placeholder = 'Write your announcement... (use "/" for formatting options, "@" to mention course items)',
  courseItems,
  sectionId,
  basePath,
}: AnnouncementEditorProps) {
  const [openNode, setOpenNode] = useState(false)
  const [openColor, setOpenColor] = useState(false)
  const [openLink, setOpenLink] = useState(false)

  const extensions = useMemo(() => {
    const exts = [...defaultExtensions, slashCommand]
    if (courseItems && courseItems.length > 0) {
      // Configure the static extension with dynamic options
       
      exts.push(CourseMentionExtension.configure({
        HTMLAttributes: {
          class: 'course-mention',
        },
        suggestion: courseMentionSuggestion(courseItems),
        courseItems,
        sectionId,
        basePath,
      }))
    }
    return exts
  }, [courseItems, sectionId, basePath])

  return (
    <div className="min-h-[120px] rounded-xl border border-input bg-background">
      <EditorRoot>
        <EditorContent
          immediatelyRender={false}
          className="p-3"
          {...(initialContent && initialContent.content?.length
            ? { initialContent: initialContent as unknown as JSONContent }
            : {})}
          extensions={extensions}
          editorProps={{
            handleDOMEvents: {
              keydown: (_view, event) => handleCommandNavigation(event),
            },
            attributes: {
              class: 'prose prose-sm prose-neutral prose-headings:font-semibold font-default focus:outline-none max-w-full min-h-[80px]',
            },
          }}
          onUpdate={({ editor }) => onChange(editor.getJSON())}
        >
          {/* Slash Command Menu */}
          <EditorCommand className="z-50 h-auto max-h-[330px] overflow-y-auto rounded-xl border border-muted bg-background px-1 py-2 shadow-md">
            <EditorCommandEmpty className="px-2 text-muted-foreground">No results</EditorCommandEmpty>
            <EditorCommandList>
              {suggestionItems.map((item) => (
                <EditorCommandItem
                  value={item.title}
                  onCommand={(val) => item.command?.(val)}
                  className="flex w-full items-center space-x-2 rounded-xl px-2 py-1 text-left text-sm hover:bg-accent aria-selected:bg-accent"
                  key={item.title}
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-muted bg-background">
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

          {/* Bubble Menu (appears on text selection) */}
          <EditorBubble
            tippyOptions={{ placement: 'top' }}
            className="flex w-fit max-w-[90vw] overflow-hidden rounded-xl border border-muted bg-background shadow-xl"
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
    </div>
  )
}

