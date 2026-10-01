'use client'

/**
 * PreferencesDialog — personal, per-browser UI preferences.
 *
 * Opened from the header avatar dropdown ("Preferences"). Currently holds one
 * setting: whether the course sidebar opens on hover or only on click. The
 * value is persisted in localStorage and shared live with the course rails via
 * useSidebarOpenMode (see use-sidebar-rail).
 */

import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useSidebarOpenMode } from '@/lib/hooks/use-sidebar-rail'

export function PreferencesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [mode, setMode] = useSidebarOpenMode()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Preferences</DialogTitle>
          <DialogDescription>Personal settings saved to this browser.</DialogDescription>
        </DialogHeader>

        <div className="flex items-start justify-between gap-4 py-2">
          <div className="space-y-0.5">
            <Label htmlFor="sidebar-open-on-hover" className="text-sm font-medium cursor-pointer">
              Open sidebar on hover
            </Label>
            <p className="text-xs text-muted-foreground">
              When off, the course sidebar opens only when you click its toggle button.
            </p>
          </div>
          <Switch
            id="sidebar-open-on-hover"
            checked={mode === 'hover'}
            onCheckedChange={(checked) => setMode(checked ? 'hover' : 'click')}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
