/**
 * EnrollmentPolicyCard — the institution's self-unenroll policy control.
 *
 * "Allow students to unenroll themselves for N days after being enrolled."
 * OFF (the default) means students never see an Unenroll button — enrollment
 * changes go through the admin. The window is per-enrollment, anchored on
 * enrolled_at (re-enrolling restarts it).
 *
 * Toggle + explicit Save (the NotificationPreferencesPanel pattern). The
 * description always reflects the SAVED policy, never the pending form —
 * flipping the switch shows "Unsaved changes" until Save lands.
 *
 * Type: Client Component (rendered on /admin/students)
 */
'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { AlertCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { updateEnrollmentPolicy } from '@/app/(dashboard)/admin/students/roster-actions'
import { SELF_UNENROLL_MAX_DAYS, type SelfUnenrollPolicy } from '@/lib/validations/institution-settings'

export function EnrollmentPolicyCard({
  initialPolicy,
  initialUpdatedAt,
}: {
  initialPolicy: SelfUnenrollPolicy
  /* The institution row's updated_at as this card was rendered — the optimistic
     guard's witness (#742). Sent back with the save so a stale write matches zero
     rows server-side instead of silently overwriting a newer one. */
  initialUpdatedAt: string | null
}) {
  /* `saved` is the server truth; `enabled`/`days` are the pending form. */
  const [saved, setSaved] = useState(initialPolicy)
  const [savedUpdatedAt, setSavedUpdatedAt] = useState(initialUpdatedAt)
  const [enabled, setEnabled] = useState(initialPolicy.enabled)
  const [days, setDays] = useState(String(initialPolicy.days))
  const [saving, setSaving] = useState(false)
  /* Kept on screen rather than toasted: a conflict delivered as an auto-dismissing
     toast leaves the admin looking at a filled-in form with no visible reason it
     didn't save, and if they glanced away they'll conclude it did. */
  const [conflict, setConflict] = useState<string | null>(null)
  /* Lets Save stay clickable after a conflict even when the winning value happens to
     equal what this admin typed (which makes `dirty` false). */
  const [forceSaveable, setForceSaveable] = useState(false)

  const parsedDays = Number(days)
  const daysInvalid =
    days.trim() === '' || !Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > SELF_UNENROLL_MAX_DAYS
  const dirty = enabled !== saved.enabled || (enabled && !daysInvalid && parsedDays !== saved.days)

  const handleSave = async () => {
    setSaving(true)
    setConflict(null)
    setForceSaveable(false)
    const result = await updateEnrollmentPolicy({ enabled, days: parsedDays }, savedUpdatedAt)
    setSaving(false)

    /* Someone else saved between our render and our write. Show them what actually
       won and re-arm the guard, so a second Save is a deliberate overwrite of a value
       they've now seen rather than a blind one. */
    if ('conflict' in result && result.conflict) {
      /* Name BOTH values. Pointing at "the current setting shown above" asked the admin
         to compare their own rejected value — still sitting at full emphasis in the
         toggle and the number input — against a text-xs muted caption that changed with
         no marker. The winning value is already in hand, so say it. */
      const theirs =
        'current' in result && result.current
          ? result.current.policy.enabled
            ? `${result.current.policy.days} days`
            : 'off'
          : null
      const mine = enabled ? `${parsedDays} days` : 'off'
      setConflict(
        theirs
          ? `Someone else set this to ${theirs} while you were editing. Your change (${mine}) wasn't saved.`
          : (result.error ?? 'Someone else changed this policy while you were editing.')
      )
      if ('current' in result && result.current) {
        setSaved(result.current.policy)
        setSavedUpdatedAt(result.current.updatedAt)
      }
      /* Keep Save reachable. `saved` was just replaced with their value, so if they
         happened to save what this admin was typing, `dirty` goes false and the Save
         button disables — while a role=alert on screen says to save again. */
      setForceSaveable(true)
      return
    }
    if ('error' in result && result.error) {
      toast.error(result.error)
      return
    }
    setSaved({ enabled, days: parsedDays })
    if ('updatedAt' in result) setSavedUpdatedAt(result.updatedAt ?? null)
    toast.success(enabled ? `Students can unenroll themselves for ${parsedDays} days after enrollment` : 'Self-unenroll turned off')
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <h2 className="text-sm font-semibold text-foreground">Enrollment policy</h2>
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <Switch id="self-unenroll" checked={enabled} onCheckedChange={setEnabled} />
          <div className="min-w-0">
            <Label htmlFor="self-unenroll" className="text-sm font-medium cursor-pointer">
              Allow students to unenroll themselves
            </Label>
            {/* Saved truth, not the pending form — the toggle alone changes nothing. */}
            <p className="text-xs text-muted-foreground">
              {saved.enabled
                ? `Students currently get an Unenroll button for ${saved.days} days after being enrolled.`
                : 'Currently only you can remove a student from a course.'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {enabled && (
            <div className="flex items-center gap-2">
              <Label htmlFor="self-unenroll-days" className="text-xs text-muted-foreground whitespace-nowrap">
                for
              </Label>
              <Input
                id="self-unenroll-days"
                type="number"
                min={1}
                max={SELF_UNENROLL_MAX_DAYS}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                aria-invalid={daysInvalid}
                className={cn('w-20', daysInvalid && 'border-destructive')}
              />
              <span className="text-xs text-muted-foreground">days</span>
            </div>
          )}
          {dirty && !saving && (
            <span className="text-xs text-muted-foreground whitespace-nowrap">Unsaved changes</span>
          )}
          <Button size="sm" onClick={handleSave} disabled={saving || (!dirty && !forceSaveable) || (enabled && daysInvalid)}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save
          </Button>
        </div>
      </div>
      {enabled && daysInvalid && (
        <p className="text-xs text-destructive">
          Days must be a whole number between 1 and {SELF_UNENROLL_MAX_DAYS}.
        </p>
      )}
      {conflict && (
        /* Four signals, not just colour: icon, border, tint, text. ui-design.md is
           explicit about never relying on colour alone, and a write conflict is not the
           same class of event as "days must be between 1 and 365" two lines up — they
           were rendering identically. Treatment matches the auth pages' error panel. */
        <div
          role="alert"
          className="flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl bg-destructive/8 border border-destructive/20 text-xs text-destructive"
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-px" />
          <span>{conflict} Save again to replace theirs.</span>
        </div>
      )}
    </div>
  )
}
