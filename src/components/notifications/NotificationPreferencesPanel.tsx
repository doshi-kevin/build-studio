/**
 * NotificationPreferencesPanel — toggles for which optional notifications a user receives,
 * plus their daily-digest hour. Role-agnostic: the page passes the kinds to show, their
 * groups, the save action, and the must-have note, so students and professors share one panel.
 *
 * Toggles reflect ENABLED state (on = receive); on save we send the inverse as `mutedTypes`.
 * Critical (must-have) alerts aren't shown here — they always send.
 *
 * Type: Client Component
 */
'use client'

import { useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Bell, Loader2, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DIGEST_FREQUENCIES,
  DIGEST_FREQUENCY_LABELS,
  type DigestFrequency,
  type NotificationKind,
  type NotificationPreferences,
  type NotificationPreferencesInput,
} from '@/lib/validations/notification-preferences'

const HOURS = Array.from({ length: 24 }, (_, h) => h)

function hourLabel(h: number): string {
  const period = h < 12 ? 'AM' : 'PM'
  const hr = h % 12 === 0 ? 12 : h % 12
  return `${hr}:00 ${period}`
}

export function NotificationPreferencesPanel({
  initialPrefs,
  kinds,
  groups,
  saveAction,
  mustHaveNote,
}: {
  initialPrefs: NotificationPreferences
  kinds: NotificationKind[]
  groups: readonly string[]
  saveAction: (
    input: NotificationPreferencesInput,
  ) => Promise<{ success?: boolean; error?: string }>
  mustHaveNote: string
}) {
  const initialEnabled = useMemo(() => {
    const muted = new Set(initialPrefs.mutedTypes)
    const map: Record<string, boolean> = {}
    for (const k of kinds) map[k.type] = !muted.has(k.type)
    return map
  }, [initialPrefs.mutedTypes, kinds])

  const [enabled, setEnabled] = useState<Record<string, boolean>>(initialEnabled)
  const [digestHour, setDigestHour] = useState<number | null>(initialPrefs.digestHour)
  const [digestFrequency, setDigestFrequency] = useState<DigestFrequency>(
    initialPrefs.digestFrequency,
  )
  const [hasChanges, setHasChanges] = useState(false)
  const [isPending, startTransition] = useTransition()

  const toggle = (type: string, on: boolean) => {
    setEnabled((prev) => ({ ...prev, [type]: on }))
    setHasChanges(true)
  }

  const changeHour = (value: string) => {
    setDigestHour(value === 'default' ? null : Number(value))
    setHasChanges(true)
  }

  const changeFrequency = (value: string) => {
    setDigestFrequency(value as DigestFrequency)
    setHasChanges(true)
  }

  const handleSave = () => {
    // Only the kinds shown in this panel are considered; the rest of the user's muted set
    // is role-disjoint, so replacing it with these is correct.
    const mutedTypes = kinds.filter((k) => !enabled[k.type]).map((k) => k.type)
    startTransition(async () => {
      const result = await saveAction({ mutedTypes, digestHour, digestFrequency })
      if (result.error) {
        toast.error(result.error)
        return
      }
      setHasChanges(false)
      toast.success('Notification preferences saved')
    })
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-4 border-b border-border">
        <Bell className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Notification Preferences</h2>
      </div>

      <div className="space-y-6 p-5">
        {groups.map((group) => {
          const groupKinds = kinds.filter((k) => k.group === group)
          if (groupKinds.length === 0) return null
          return (
            <div key={group} className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group}
              </h3>
              {groupKinds.map((k) => (
                <div key={k.type} className="flex items-center justify-between">
                  <div className="pr-4">
                    <Label htmlFor={`pref-${k.type}`} className="text-sm font-medium">
                      {k.label}
                    </Label>
                    {k.description && (
                      <p className="text-xs text-muted-foreground mt-0.5">{k.description}</p>
                    )}
                  </div>
                  <Switch
                    id={`pref-${k.type}`}
                    checked={enabled[k.type] ?? true}
                    onCheckedChange={(c) => toggle(k.type, c)}
                  />
                </div>
              ))}
            </div>
          )
        })}

        {/* Email digest — how often + what time */}
        <div className="border-t border-border pt-5 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="digest-frequency" className="text-sm font-medium">
                Email digest
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                How often your summary email arrives.
              </p>
            </div>
            <Select value={digestFrequency} onValueChange={changeFrequency}>
              <SelectTrigger id="digest-frequency" className="w-44 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIGEST_FREQUENCIES.map((f) => (
                  <SelectItem key={f} value={f}>
                    {DIGEST_FREQUENCY_LABELS[f]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="digest-hour" className="text-sm font-medium">
                Digest time
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                When it arrives, in your school&apos;s time zone.
              </p>
            </div>
            <Select
              value={digestHour === null ? 'default' : String(digestHour)}
              onValueChange={changeHour}
            >
              <SelectTrigger id="digest-hour" className="w-44 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default (7:00 AM)</SelectItem>
                {HOURS.map((h) => (
                  <SelectItem key={h} value={String(h)}>
                    {hourLabel(h)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Must-have note */}
        <div className="rounded-xl bg-muted/40 px-4 py-3">
          <p className="text-xs text-muted-foreground">{mustHaveNote}</p>
        </div>

        <div className="flex justify-end pt-2">
          <Button onClick={handleSave} disabled={isPending || !hasChanges}>
            {isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save preferences
          </Button>
        </div>
      </div>
    </div>
  )
}
