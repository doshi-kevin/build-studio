/**
 * ViewAsStudentToggle — a compact icon button that toggles the professor's student preview.
 *
 * Renders a shadcn Tooltip wrapping a size="icon" Button with an Eye / EyeOff icon.
 * Tooltip copy: "View as student" (off) / "Exit preview" (on).
 * Uses aria-label + aria-pressed for accessibility.
 *
 * Type: Client Component
 */
'use client'

import { Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface Props {
  previewing: boolean
  onToggle: () => void
}

export function ViewAsStudentToggle({ previewing, onToggle }: Props) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={previewing ? 'default' : 'outline'}
            size="icon"
            onClick={onToggle}
            aria-label={previewing ? 'Exit preview' : 'View as student'}
            aria-pressed={previewing}
          >
            {previewing ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {previewing ? 'Exit preview' : 'View as student'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
