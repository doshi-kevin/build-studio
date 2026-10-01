'use client'

import { Check, Trash } from 'lucide-react'
import { useEditor } from 'novel'
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

function getUrlFromString(str: string) {
  if (str.match(/^https?:\/\//)) return str
  try {
    new URL(str)
    return str
  } catch {
    return `https://${str}`
  }
}

interface LinkSelectorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export const LinkSelector = ({ open, onOpenChange }: LinkSelectorProps) => {
  const { editor } = useEditor()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      inputRef.current?.focus()
    }
  }, [open])

  if (!editor) return null

  return (
    <Popover modal={true} open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className={cn('gap-2 rounded-none border-none', editor.isActive('link') && 'text-foreground font-semibold')}
        >
          <span className="text-sm">↗ Link</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-0" sideOffset={10}>
        <form
          onSubmit={(e) => {
            const target = e.currentTarget
            e.preventDefault()
            const input = target[0] as HTMLInputElement
            const url = getUrlFromString(input.value)
            if (url) {
              editor.chain().focus().setLink({ href: url }).run()
              onOpenChange(false)
            }
          }}
          className="flex p-1"
        >
          <input
            ref={inputRef}
            type="text"
            placeholder="Paste a link"
            className="flex-1 bg-background p-1 text-sm outline-none"
            defaultValue={editor.getAttributes('link').href || ''}
          />
          {editor.getAttributes('link').href ? (
            <Button
              size="icon"
              variant="outline"
              type="button"
              className="flex h-8 items-center rounded-sm p-1 text-destructive transition-[color,background-color,box-shadow] hover:bg-destructive/10"
              onClick={() => {
                editor.chain().focus().unsetLink().run()
                onOpenChange(false)
              }}
            >
              <Trash className="h-4 w-4" />
            </Button>
          ) : (
            <Button size="icon" className="h-8" type="submit">
              <Check className="h-4 w-4" />
            </Button>
          )}
        </form>
      </PopoverContent>
    </Popover>
  )
}
