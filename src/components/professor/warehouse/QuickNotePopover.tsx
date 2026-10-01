'use client'

import { useState, useEffect } from 'react'
import { StickyNote } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

interface QuickNotePopoverProps {
  note: string
  onSave: (note: string) => void
  children: React.ReactNode
}

export function QuickNotePopover({ note, onSave, children }: QuickNotePopoverProps) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(note)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) setText(note)
  }, [open, note])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-72" align="start">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <StickyNote className="h-4 w-4 text-warning" />
            <span className="text-sm font-medium">Quick Note</span>
          </div>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Your personal note..."
            rows={3}
            className="resize-none"
            maxLength={2000}
          />
          <div className="flex justify-between items-center">
            <span className="text-xs text-muted-foreground">{text.length}/2000</span>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  onSave(text)
                  setOpen(false)
                }}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
