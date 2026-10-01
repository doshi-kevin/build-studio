'use client'

import { Bold, Italic, Underline, Strikethrough, Code } from 'lucide-react'
import { EditorBubbleItem, useEditor } from 'novel'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'

type TextButton = {
  name: string
  icon: LucideIcon
  isActive: string
  command: string
}

const items: TextButton[] = [
  { name: 'bold', icon: Bold, isActive: 'bold', command: 'toggleBold' },
  { name: 'italic', icon: Italic, isActive: 'italic', command: 'toggleItalic' },
  { name: 'underline', icon: Underline, isActive: 'underline', command: 'toggleUnderline' },
  { name: 'strike', icon: Strikethrough, isActive: 'strike', command: 'toggleStrike' },
  { name: 'code', icon: Code, isActive: 'code', command: 'toggleCode' },
]

export const TextButtons = () => {
  const { editor } = useEditor()
  if (!editor) return null

  return (
    <div className="flex">
      {items.map((item) => (
        <EditorBubbleItem
          key={item.name}
          onSelect={() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(editor.chain().focus() as any)[item.command]().run()
          }}
        >
          <Button size="sm" className="rounded-none" variant="ghost">
            <item.icon className={cn('h-4 w-4', editor.isActive(item.isActive) && 'text-foreground')} />
          </Button>
        </EditorBubbleItem>
      ))}
    </div>
  )
}
