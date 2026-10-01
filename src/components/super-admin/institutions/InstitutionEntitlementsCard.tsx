/**
 * InstitutionEntitlementsCard — what one institution has bought, and the only
 * screen that changes it.
 *
 * Switch semantics keep AiPolicyEditor's positive polarity — no label is ever
 * phrased as "disable X" — but the switch answers "is this institution KEEPING
 * this product?", not "is it available this second". Turning it off does not
 * revoke immediately, because a mid-term downgrade breaks live syllabi: it
 * schedules the revocation for a date the admin picks, and the switch stays
 * OFF with a row underneath naming the date. Rendering the switch as ON while a
 * revocation was scheduled (the feature IS still available until then) made it
 * spring back the instant it was clicked, and made a saved schedule impossible
 * to cancel. "Turn off now instead" covers what the calendar cannot, e.g.
 * non-payment.
 *
 * Staged behind an explicit Save (EnrollmentPolicyCard pattern): `saved` is
 * server truth and the heading always states the saved reality, never the
 * pending edit.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Loader2, CalendarClock, PackageCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  ENTITLED_FEATURES,
  evaluateEntitlement,
  isSchedulableRevocationDate,
  type EntitledFeatureKey,
  type EntitlementConfig,
} from '@/lib/entitlements/entitled-features'

export type EntitlementSaveResult = { success: true; version: number } | { error: string }

interface Props {
  /** Server truth, as parsed from institutions.settings.entitlements. */
  initial: EntitlementConfig
  /** The suggested revocation date, the latest end_date across running sections. */
  suggestedRevocationDate: string | null
  save: (input: {
    granted: string[]
    revoked: string[]
    pendingRevocation: Record<string, string>
    expectedVersion: number
  }) => Promise<EntitlementSaveResult>
}

/** A date input wants YYYY-MM-DD; the stored value is a full ISO timestamp. */
const toDateInput = (iso: string) => iso.slice(0, 10)

/**
 * Returns null for anything we should not store.
 *
 * Two separate hazards, both from the same source: a <input type="date"> reports
 * its value on EVERY keystroke, so a year mid-typing arrives half-formed.
 *
 *  1. Unparseable, e.g. "12252-12-01". `.toISOString()` throws RangeError on it
 *     and takes the whole card down to the error boundary.
 *  2. Parseable but absurd, e.g. "6789-12-01" or "0001-12-01". These survive a
 *     NaN check. The year-1 case is the dangerous one: it is in the PAST, so
 *     storing it would revoke the feature immediately, which is the opposite of
 *     what someone scheduling a future cutoff intended.
 *
 * A scheduled revocation is a contract date, so a sane window is the right
 * bound: not in the past (there is an explicit "Turn off now instead" for that)
 * and not more than ten years out.
 */
function fromDateInput(d: string): string | null {
  const parsed = new Date(`${d}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return null
  // The SAME rule the server action enforces, imported rather than restated, so
  // the two cannot drift into disagreeing about which dates are acceptable.
  return isSchedulableRevocationDate(parsed.toISOString()) ? parsed.toISOString() : null
}

/**
 * A scheduled revocation is stored as UTC midnight on the chosen day, so it
 * must be READ back as UTC too. Formatting it in the viewer's local zone shows
 * the previous day anywhere west of Greenwich, which made the date input and
 * the confirm dialog disagree by one day.
 */
function formatRevocationDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}


export function InstitutionEntitlementsCard({ initial, suggestedRevocationDate, save }: Props) {
  const [saved, setSaved] = useState<EntitlementConfig>(initial)
  const [draft, setDraft] = useState<EntitlementConfig>(initial)
  const [saving, setSaving] = useState(false)

  const now = new Date()
  const fallbackDate = toDateInput(
    new Date(now.getFullYear(), now.getMonth() + 3, 1).toISOString(),
  )
  const suggested = suggestedRevocationDate ? toDateInput(suggestedRevocationDate) : fallbackDate
  // A section with a mistyped end_date (year 2999) makes fromDateInput reject
  // the suggestion. Without falling back, `toggle` would store no date at all,
  // the switch would report ON, and every product on that institution's card
  // would be silently inert.
  const defaultDate = fromDateInput(suggested) ? suggested : fallbackDate

  const isOn = (key: EntitledFeatureKey, config: EntitlementConfig) =>
    evaluateEntitlement(config, key, now).entitled

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)

  // Saved truth, never the pending edit — the same line AiPolicyEditor carries,
  // so the card states what is actually in force above switches that may be mid-edit.
  const savedOn = ENTITLED_FEATURES.filter((f) => isOn(f.key, saved)).length
  const savedScheduled = ENTITLED_FEATURES.filter(
    (f) => isOn(f.key, saved) && saved.pendingRevocation[f.key],
  ).length

  function toggle(key: EntitledFeatureKey, on: boolean) {
    setDraft((d) => {
      const granted = new Set(d.granted)
      const revoked = new Set(d.revoked)
      const pendingRevocation = { ...d.pendingRevocation }
      if (on) {
        // Switching on clears every reason it could be off. Leaving a stale
        // revoke behind would make the switch lie.
        granted.add(key)
        revoked.delete(key)
        delete pendingRevocation[key]
      } else {
        granted.delete(key)
        const iso = fromDateInput(defaultDate)
        if (iso) pendingRevocation[key] = iso
      }
      return { ...d, granted: [...granted], revoked: [...revoked], pendingRevocation }
    })
  }

  function setDate(key: EntitledFeatureKey, value: string) {
    if (!value) return
    // Mid-typing the browser hands us partial values. Ignore them and keep the
    // last good date rather than storing junk or throwing.
    const iso = fromDateInput(value)
    if (!iso) return
    setDraft((d) => ({
      ...d,
      pendingRevocation: { ...d.pendingRevocation, [key]: iso },
    }))
  }

  function revokeNow(key: EntitledFeatureKey) {
    setDraft((d) => {
      const pendingRevocation = { ...d.pendingRevocation }
      delete pendingRevocation[key]
      return {
        ...d,
        granted: d.granted.filter((k) => k !== key),
        revoked: [...new Set([...d.revoked, key])],
        pendingRevocation,
      }
    })
  }

  async function onSave() {
    setSaving(true)
    const result = await save({
      granted: draft.granted,
      revoked: draft.revoked,
      pendingRevocation: draft.pendingRevocation,
      expectedVersion: saved.version,
    })
    setSaving(false)
    if ('error' in result) {
      toast.error(result.error)
      return
    }
    const next = { ...draft, version: result.version }
    setSaved(next)
    setDraft(next)
    toast.success('Plan updated')
  }

  const changes = ENTITLED_FEATURES.filter(
    (f) => isOn(f.key, draft) !== isOn(f.key, saved) || draft.pendingRevocation[f.key] !== saved.pendingRevocation[f.key],
  )

  return (
    <section className="rounded-xl border bg-card p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted">
          <PackageCheck className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">Plan</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            What this institution has bought. Turning something on takes effect straight away.
            Turning it off is scheduled, so nobody loses a feature in the middle of a term.
          </p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {savedOn} of {ENTITLED_FEATURES.length} products are on
            {savedScheduled > 0
              ? `, ${savedScheduled} scheduled to turn off.`
              : '.'}
          </p>
        </div>
      </div>

      <div className="mt-6 space-y-1">
        {ENTITLED_FEATURES.map((feature) => {
          const on = isOn(feature.key, draft)
          const pendingAt = draft.pendingRevocation[feature.key]
          const hardRevoked = draft.revoked.includes(feature.key)
          // The switch answers "is this institution keeping this product?", so a
          // scheduled revocation reads as OFF even though the feature is still
          // available until the date. Rendering `on` here made the switch spring
          // back to the ON position the instant it was clicked, which reads as
          // the control refusing the click — and it left no way to CLEAR a
          // schedule, because a switch that never reports `false` can never fire
          // the ON branch of `toggle`, the only code that deletes the pending
          // date. The date row below carries the "still on until then" nuance.
          const switchOn = on && !pendingAt
          const scheduleId = `ent-${feature.key}-schedule`
          return (
            <div key={feature.key} className="rounded-xl px-3 py-3 hover:bg-muted/40">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <Label htmlFor={`ent-${feature.key}`} className="cursor-pointer text-sm font-medium">
                    {feature.label}
                  </Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">{feature.description}</p>
                </div>
                <Switch
                  id={`ent-${feature.key}`}
                  checked={switchOn}
                  aria-describedby={pendingAt ? scheduleId : undefined}
                  onCheckedChange={(checked) => toggle(feature.key, checked)}
                />
              </div>

              {pendingAt && (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-muted/60 px-3 py-2 text-sm">
                  <CalendarClock className="size-4 shrink-0 text-muted-foreground" />
                  <span className="text-muted-foreground">Stays on until</span>
                  <Input
                    type="date"
                    aria-label={`Date ${feature.label} turns off`}
                    className="h-8 w-auto"
                    value={toDateInput(pendingAt)}
                    onChange={(e) => setDate(feature.key, e.target.value)}
                  />
                  {/* Announced when the row appears, and read out whenever the
                      switch takes focus — a screen-reader user who toggles the
                      switch otherwise hears only "off" and never learns that a
                      date was scheduled three months out. */}
                  <span id={scheduleId} className="sr-only" aria-live="polite">
                    {feature.label} stays on until {formatRevocationDate(pendingAt)}, then turns
                    off. Past work stays visible; nothing new can be created after that.
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => revokeNow(feature.key)}
                  >
                    Turn off now instead
                  </Button>
                </div>
              )}

              {hardRevoked && (
                <p className="mt-2 text-sm text-destructive">
                  Off. Past work stays visible to students; nothing new can be created.
                </p>
              )}
            </div>
          )
        })}
      </div>

      <div className="mt-6 flex items-center justify-end gap-3">
        {dirty && !saving && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
        {dirty && (
          <Button variant="ghost" size="sm" onClick={() => setDraft(saved)} disabled={saving}>
            Cancel
          </Button>
        )}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" disabled={!dirty || saving}>
              {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
              Save plan
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Change this institution&apos;s plan?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 text-sm">
                  <p>This is what changes:</p>
                  <ul className="list-disc space-y-1 pl-5">
                    {changes.map((f) => {
                      const pendingAt = draft.pendingRevocation[f.key]
                      if (isOn(f.key, draft) && pendingAt) {
                        return (
                          <li key={f.key}>
                            {f.label} turns off on{' '}
                            {formatRevocationDate(pendingAt)}
                          </li>
                        )
                      }
                      return (
                        <li key={f.key}>
                          {f.label} is {isOn(f.key, draft) ? 'on' : 'off, starting now'}
                        </li>
                      )
                    })}
                  </ul>
                  <p>Nothing is deleted. Past work and grades stay visible either way.</p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onSave}>Save plan</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </section>
  )
}
