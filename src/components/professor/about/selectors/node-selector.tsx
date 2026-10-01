'use client'

import {
  Check,
  ChevronDown,
  Heading1,
  Heading2,
  Heading3,
  TextQuote,
  ListOrdered,
  TextIcon,
  Code,
  CheckSquare,
  type LucideIcon,
} from 'lucide-react'
import { EditorBubbleItem, useEditor } from 'novel'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

export type SelectorItem = {
  name: string
  icon: LucideIcon
  command: (editor: ReturnType<typeof useEditor>['editor']) => void
  isActive: (editor: ReturnType<typeof useEditor>['editor']) => boolean
}

/* Headings inside a text block start at level 2, never level 1. The course
   title in the masthead is the page's only <h1>; a "Heading 1" in body copy
   produced a second one on both the professor preview and the student page.
   The labels stay Heading 1/2/3 because that is how a professor thinks about
   size — only the level they emit changed. */
const items: SelectorItem[] = [
  {
    name: 'Text',
    icon: TextIcon,
    command: (editor) => editor?.chain().focus().clearNodes().run(),
    isActive: (editor) =>
      (editor?.isActive('paragraph') && !editor?.isActive('bulletList') && !editor?.isActive('orderedList')) ?? false,
  },
  {
    name: 'Heading 1',
    icon: Heading1,
    command: (editor) => editor?.chain().focus().clearNodes().toggleHeading({ level: 2 }).run(),
    isActive: (editor) => editor?.isActive('heading', { level: 2 }) ?? false,
  },
  {
    name: 'Heading 2',
    icon: Heading2,
    command: (editor) => editor?.chain().focus().clearNodes().toggleHeading({ level: 3 }).run(),
    isActive: (editor) => editor?.isActive('heading', { level: 3 }) ?? false,
  },
  {
    name: 'Heading 3',
    icon: Heading3,
    command: (editor) => editor?.chain().focus().clearNodes().toggleHeading({ level: 4 }).run(),
    isActive: (editor) => editor?.isActive('heading', { level: 4 }) ?? false,
  },
  {
    name: 'To-do List',
    icon: CheckSquare,
    command: (editor) => editor?.chain().focus().clearNodes().toggleTaskList().run(),
    isActive: (editor) => editor?.isActive('taskItem') ?? false,
  },
  {
    name: 'Bullet List',
    icon: ListOrdered,
    command: (editor) => editor?.chain().focus().clearNodes().toggleBulletList().run(),
    isActive: (editor) => editor?.isActive('bulletList') ?? false,
  },
  {
    name: 'Numbered List',
    icon: ListOrdered,
    command: (editor) => editor?.chain().focus().clearNodes().toggleOrderedList().run(),
    isActive: (editor) => editor?.isActive('orderedList') ?? false,
  },
  {
    name: 'Quote',
    icon: TextQuote,
    command: (editor) => editor?.chain().focus().clearNodes().toggleBlockquote().run(),
    isActive: (editor) => editor?.isActive('blockquote') ?? false,
  },
  {
    name: 'Code Block',
    icon: Code,
    command: (editor) => editor?.chain().focus().clearNodes().toggleCodeBlock().run(),
    isActive: (editor) => editor?.isActive('codeBlock') ?? false,
  },
]

interface NodeSelectorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export const NodeSelector = ({ open, onOpenChange }: NodeSelectorProps) => {
  const { editor } = useEditor()
  if (!editor) return null

  const activeItem = items.filter((item) => item.isActive(editor)).pop() ?? { name: 'Multiple' }

  return (
    <Popover modal={true} open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild className="gap-2 rounded-none border-none hover:bg-accent focus:ring-0">
        <Button size="sm" variant="ghost" className="gap-2">
          <span className="whitespace-nowrap text-sm">{activeItem.name}</span>
          <ChevronDown className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent sideOffset={5} align="start" className="w-48 p-1">
        {items.map((item) => (
          <EditorBubbleItem
            key={item.name}
            onSelect={() => {
              item.command(editor)
              onOpenChange(false)
            }}
            className="flex cursor-pointer items-center justify-between rounded-sm px-2 py-1 text-sm hover:bg-accent"
          >
            <div className="flex items-center gap-2">
              <item.icon className="h-3.5 w-3.5" />
              <span>{item.name}</span>
            </div>
            {activeItem.name === item.name && <Check className="h-4 w-4" />}
          </EditorBubbleItem>
        ))}
      </PopoverContent>
    </Popover>
  )
}
