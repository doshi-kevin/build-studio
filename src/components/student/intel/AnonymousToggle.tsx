'use client'

import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { EyeOff } from 'lucide-react'

interface AnonymousToggleProps {
  value: boolean
  onChange: (value: boolean) => void
}

export function AnonymousToggle({ value, onChange }: AnonymousToggleProps) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Switch checked={value} onCheckedChange={onChange} />
        <Label className="flex items-center gap-1.5 cursor-pointer text-sm">
          <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
          Post anonymously
        </Label>
      </div>
      <p className="text-xs text-muted-foreground ml-11">
        Your identity is verified internally but hidden from others
      </p>
    </div>
  )
}
