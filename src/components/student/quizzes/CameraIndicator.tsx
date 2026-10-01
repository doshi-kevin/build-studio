// Small fixed-position camera status indicator during quiz.
// Shows a green dot when camera is active, or a red dot when violations are detected.
// No webcam preview — just a minimal status badge.
'use client'

import { Camera, CameraOff } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CameraIndicatorProps {
  isActive: boolean
  isDenied?: boolean
  violationCount?: number
}

export default function CameraIndicator({
  isActive,
  isDenied = false,
  violationCount = 0,
}: CameraIndicatorProps) {
  if (isDenied) {
    return (
      <div className="fixed bottom-4 left-4 z-50 flex items-center gap-1.5 rounded-full border border-destructive/20 bg-destructive-muted/60 px-3 py-1.5 shadow-sm">
        <CameraOff className="h-3.5 w-3.5 text-destructive" />
        <span className="text-xs font-medium text-destructive">Camera denied</span>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'fixed bottom-4 left-4 z-50 flex items-center gap-1.5 rounded-full border px-3 py-1.5 shadow-sm',
        violationCount > 0
          ? 'border-warning/30 bg-warning-muted/60'
          : 'border-success/30 bg-success-muted/60',
      )}
    >
      <div className="relative">
        <Camera
          className={cn(
            'h-3.5 w-3.5',
            violationCount > 0 ? 'text-warning-muted-foreground' : 'text-success-muted-foreground',
          )}
        />
        {isActive && violationCount === 0 && (
          <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-success animate-pulse" />
        )}
      </div>
      <span
        className={cn(
          'text-xs font-medium tabular-nums',
          violationCount > 0
            ? 'text-warning-muted-foreground'
            : 'text-success-muted-foreground',
        )}
      >
        {violationCount > 0 ? `${violationCount} violation${violationCount > 1 ? 's' : ''}` : 'Camera active'}
      </span>
    </div>
  )
}
