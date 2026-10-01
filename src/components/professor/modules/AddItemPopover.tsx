/**
 * AddItemPopover — the "what kind of material?" picker.
 *
 * Wraps whatever trigger it's given so the menu anchors to the button the
 * professor actually clicked (the "+" on a section header, or the CTA in an
 * empty section) rather than to a detached element.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { MODULE_ITEM_TYPE_INFO, type ModuleItemType } from '@/lib/validations/module'

export function AddItemPopover({
  children,
  onSelect,
}: {
  children: React.ReactNode
  onSelect: (type: ModuleItemType) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <p className="px-2 py-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Add material
        </p>
        {MODULE_ITEM_TYPE_INFO.map((info) => (
          <button
            key={info.key}
            type="button"
            onClick={() => {
              setOpen(false)
              onSelect(info.key)
            }}
            className="flex w-full flex-col items-start gap-0.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <span className="text-sm font-medium">{info.label}</span>
            <span className="text-xs text-muted-foreground">{info.description}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
