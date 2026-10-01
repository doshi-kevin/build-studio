'use client'

import { useState } from 'react'
import { X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { StudioChat } from './StudioChat'
import { StudioPreview } from './StudioPreview'
import type { ChatMessage, Device, StudioBuild, ViewMode } from './types'

interface StudioBuilderProps {
  build: StudioBuild | null
  messages: ChatMessage[]
  busy: boolean
  onClose: () => void
  onSend: (text: string) => void
  onRename: (title: string) => void
}

export function StudioBuilder({ build, messages, busy, onClose, onSend, onRename }: StudioBuilderProps) {
  const [mode, setMode] = useState<ViewMode>('split')
  const [device, setDevice] = useState<Device>('desktop')
  const [pane, setPane] = useState<'chat' | 'preview'>('chat')

  return (
    <Dialog open={build !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="top-0 left-0 flex h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:max-w-none"
      >
        {build && (
          <>
            <DialogTitle className="sr-only">Studio builder: {build.title}</DialogTitle>
            <DialogDescription className="sr-only">
              Chat with Athena on one side and use the feature you are building on the other.
            </DialogDescription>
            <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3">
              <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close builder">
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Input
                aria-label="Feature name"
                value={build.title}
                onChange={(e) => onRename(e.target.value)}
                className="h-9 w-full max-w-xs border-transparent font-medium shadow-none hover:border-border"
              />
              <Badge variant="secondary">Draft · not saved yet</Badge>
              <ToggleGroup
                type="single"
                variant="outline"
                value={pane}
                onValueChange={(v) => v && setPane(v as 'chat' | 'preview')}
                aria-label="Show chat or preview"
                className="ml-auto lg:hidden"
              >
                <ToggleGroupItem value="chat">Chat</ToggleGroupItem>
                <ToggleGroupItem value="preview">Preview</ToggleGroupItem>
              </ToggleGroup>
            </header>
            <div className="flex min-h-0 flex-1">
              <aside
                aria-label="Athena"
                className={cn('min-h-0 w-full shrink-0 border-r border-border lg:block lg:w-96', pane === 'chat' ? 'block' : 'hidden')}
              >
                <StudioChat messages={messages} busy={busy} onSend={onSend} />
              </aside>
              <main className={cn('min-h-0 min-w-0 flex-1 lg:block', pane === 'preview' ? 'block' : 'hidden')}>
                <StudioPreview build={build} mode={mode} device={device} onModeChange={setMode} onDeviceChange={setDevice} />
              </main>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
