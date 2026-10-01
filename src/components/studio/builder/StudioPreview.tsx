'use client'

import { Monitor, Smartphone } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import type { Device, StudioBuild, ViewMode } from './types'

const WAITING = {
  professor: 'The screens you use to run and manage this feature appear here once Athena builds them.',
  student: 'What your students see and do appears here, built alongside your view.',
}

function Frame({ label, device, children }: { label: string; device: Device; children: React.ReactNode }) {
  return (
    <section aria-label={label} className={cn('flex min-w-0 flex-col', device === 'phone' ? 'w-full max-w-sm' : 'w-full')}>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto bg-background p-6 shadow-md',
          device === 'phone' ? 'rounded-3xl border-8 border-muted' : 'rounded-2xl',
        )}
      >
        {children}
      </div>
    </section>
  )
}

interface StudioPreviewProps {
  build: StudioBuild
  mode: ViewMode
  device: Device
  onModeChange: (mode: ViewMode) => void
  onDeviceChange: (device: Device) => void
}

export function StudioPreview({ build, mode, device, onModeChange, onDeviceChange }: StudioPreviewProps) {
  const views: ('professor' | 'student')[] = mode === 'split' ? ['professor', 'student'] : [mode]

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/40">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-background px-4 py-2">
        <ToggleGroup
          type="single"
          variant="outline"
          value={mode}
          onValueChange={(v) => v && onModeChange(v as ViewMode)}
          aria-label="Which view to preview"
        >
          <ToggleGroupItem value="professor">Professor</ToggleGroupItem>
          <ToggleGroupItem value="student">Student</ToggleGroupItem>
          <ToggleGroupItem value="split" className="hidden md:inline-flex">
            Side by side
          </ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup
          type="single"
          variant="outline"
          value={device}
          onValueChange={(v) => v && onDeviceChange(v as Device)}
          aria-label="Preview size"
        >
          <ToggleGroupItem value="desktop" aria-label="Desktop size">
            <Monitor className="h-4 w-4" aria-hidden="true" />
          </ToggleGroupItem>
          <ToggleGroupItem value="phone" aria-label="Phone size">
            <Smartphone className="h-4 w-4" aria-hidden="true" />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-8">
        <div className={cn('mx-auto flex h-full gap-6', views.length === 2 ? 'max-w-6xl' : 'max-w-3xl', device === 'phone' && 'justify-center')}>
          {views.map((v) => (
            <Frame key={v} label={v === 'professor' ? 'Professor view' : 'Student view'} device={device}>
              <h2 className="mb-4 font-[family-name:var(--font-instrument-serif)] text-2xl">{build.title}</h2>
              <div className="flex min-h-64 items-center justify-center rounded-2xl border border-dashed border-border p-6 text-center">
                <p className="max-w-xs text-sm text-muted-foreground">{WAITING[v]}</p>
              </div>
            </Frame>
          ))}
        </div>
      </div>
    </div>
  )
}
