'use client'

// Resizable split panels (shadcn/ui), built on react-resizable-panels.
// Handles are keyboard-accessible; pass `autoSaveId` on the group to persist
// sizes to localStorage.

import { GripVertical } from 'lucide-react'
import * as ResizablePrimitive from 'react-resizable-panels'
import { cn } from '@/lib/utils'

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) {
  return (
    <ResizablePrimitive.PanelGroup
      className={cn('flex h-full w-full data-[panel-group-direction=vertical]:flex-col', className)}
      {...props}
    />
  )
}

const ResizablePanel = ResizablePrimitive.Panel

function ResizableHandle({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle> & {
  withHandle?: boolean
}) {
  return (
    <ResizablePrimitive.PanelResizeHandle
      className={cn(
        'relative flex w-px items-center justify-center bg-border transition-colors hover:bg-ring/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2',
        'data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:after:left-0 data-[panel-group-direction=vertical]:after:h-3 data-[panel-group-direction=vertical]:after:w-full data-[panel-group-direction=vertical]:after:-translate-y-1/2 data-[panel-group-direction=vertical]:after:translate-x-0',
        '[&[data-panel-group-direction=vertical]>div]:rotate-90',
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-4 w-3 items-center justify-center rounded-full border border-border bg-background">
          <GripVertical className="h-2.5 w-2.5 text-muted-foreground" />
        </div>
      )}
    </ResizablePrimitive.PanelResizeHandle>
  )
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
