// Contact & Office Hours editor — the #1 thing students look for. Plain
// labels for every field; no jargon.

'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ContactBlock } from '@/lib/validations/course-about'
import { cn } from '@/lib/utils'
import { CANVAS_FIELD, useBlockEditor } from '../../block-editor'

interface Props {
  block: ContactBlock
}

export function ContactBlockEditor({ block }: Props) {
  const { dispatch } = useBlockEditor()

  const update = (data: Partial<ContactBlock['data']>) => {
    dispatch({ type: 'UPDATE_BLOCK', payload: { blockId: block.id, data } })
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <Label className="text-xs uppercase tracking-[0.15em] font-semibold text-muted-foreground mb-1.5 block">
            Name
          </Label>
          <Input
            value={block.data.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="e.g. Dr. Patricia Williams"
            className={cn(CANVAS_FIELD)}
          />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-[0.15em] font-semibold text-muted-foreground mb-1.5 block">
            Title
          </Label>
          <Input
            value={block.data.title}
            onChange={(e) => update({ title: e.target.value })}
            placeholder="e.g. Associate Professor of CS"
            className={cn(CANVAS_FIELD)}
          />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-[0.15em] font-semibold text-muted-foreground mb-1.5 block">
            Email
          </Label>
          <Input
            type="email"
            value={block.data.email}
            onChange={(e) => update({ email: e.target.value })}
            placeholder="you@school.edu"
            className={cn(CANVAS_FIELD)}
          />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-[0.15em] font-semibold text-muted-foreground mb-1.5 block">
            Office location
          </Label>
          <Input
            value={block.data.officeLocation}
            onChange={(e) => update({ officeLocation: e.target.value })}
            placeholder="e.g. Babbio Center, Room 304"
            className={cn(CANVAS_FIELD)}
          />
        </div>
        <div className="sm:col-span-2">
          <Label className="text-xs uppercase tracking-[0.15em] font-semibold text-muted-foreground mb-1.5 block">
            Office hours
          </Label>
          <Input
            value={block.data.officeHours}
            onChange={(e) => update({ officeHours: e.target.value })}
            placeholder="e.g. Tue & Thu, 2–4 PM · or by appointment"
            className={cn(CANVAS_FIELD)}
          />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-[0.15em] font-semibold text-muted-foreground mb-1.5 block">
            Virtual office (optional)
          </Label>
          <Input
            value={block.data.zoomUrl}
            onChange={(e) => update({ zoomUrl: e.target.value })}
            placeholder="Zoom or Google Meet link"
            className={cn(CANVAS_FIELD)}
          />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-[0.15em] font-semibold text-muted-foreground mb-1.5 block">
            Typical response time
          </Label>
          <Input
            value={block.data.responseTime}
            onChange={(e) => update({ responseTime: e.target.value })}
            placeholder="e.g. Within 24 hours on weekdays"
            className={cn(CANVAS_FIELD)}
          />
        </div>
      </div>
    </div>
  )
}
