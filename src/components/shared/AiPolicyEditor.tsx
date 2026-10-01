/**
 * AiPolicyEditor — the AI kill-switch control card, shared by all three
 * surfaces that edit one policy layer:
 *   - /admin/settings                    (institution admin → institution layer)
 *   - /super-admin/institutions/[id]     (super admin → that institution's platform layer)
 *   - /super-admin/ai-controls           (super admin → the global layer, every institution)
 *
 * Switch semantics (uniform across the card, per the UX review: a switch label
 * is a positive statement — ON always means AVAILABLE, never "disable X"):
 *   - master "All AI features" — ON = AI available at this layer. Turning it
 *     off is the sentinel kill: covers every feature, including ones shipped
 *     later; the per-feature switches go inert (state preserved) while off.
 *   - one switch per AI feature, ON = available at this layer.
 *   - `lockedAll`/`lockedFeatures` render rows a HIGHER layer disabled: switch
 *     forced off + disabled + a lock note. This layer's own choices are kept
 *     underneath and resume when the higher layer re-enables.
 *
 * Staged behind an explicit Save (EnrollmentPolicyCard pattern — `saved` is
 * server truth, and the heading line always states the SAVED reality) with an
 * AlertDialog confirm that names exactly what changes. The `save` prop is the
 * surface's server action; on version_conflict it returns { error } and the
 * admin is told to refresh.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Lock, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
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
import { AI_FEATURES, type AiFeatureKey } from '@/lib/ai/ai-features'

export interface AiPolicySavedState {
  allDisabled: boolean
  disabledFeatures: AiFeatureKey[]
  version: number
}

export type AiPolicySaveResult = { success: true; version: number } | { error: string }

export function AiPolicyEditor({
  initial,
  lockedAll = false,
  lockedFeatures = [],
  lockedNote,
  lockedBanner,
  partialLockNote,
  lockedSuffix = 'disabled by Scholera',
  heading,
  description,
  scopeLabel,
  footnote,
  idPrefix = 'ai',
  save,
}: {
  initial: AiPolicySavedState
  /** A HIGHER layer disabled everything — every row locks. */
  lockedAll?: boolean
  /** Individual features a HIGHER layer disabled. */
  lockedFeatures?: AiFeatureKey[]
  /** Short badge text on partially-locked rows, e.g. "Managed by Scholera". */
  lockedNote?: string
  /** Banner when lockedAll — who locked it and that local settings persist. */
  lockedBanner?: string
  /** Note when only SOME rows are locked (recognition beats the tiny chip alone). */
  partialLockNote?: string
  /** How the status line attributes higher-layer locks, e.g. "disabled by Scholera". */
  lockedSuffix?: string
  heading: string
  description: string
  /** Who a change hits, for the confirm dialog: "all professors and students at Stevens". */
  scopeLabel: string
  /** Optional read-only context line, e.g. what the institution has self-disabled. */
  footnote?: string
  /** Keeps switch ids unique when two editors render on one page. */
  idPrefix?: string
  save: (input: {
    allDisabled: boolean
    disabledFeatures: string[]
    expectedVersion: number
  }) => Promise<AiPolicySaveResult>
}) {
  const [saved, setSaved] = useState(initial)
  const [allDisabled, setAllDisabled] = useState(initial.allDisabled)
  const [disabled, setDisabled] = useState<Set<AiFeatureKey>>(new Set(initial.disabledFeatures))
  const [saving, setSaving] = useState(false)

  const lockedSet = new Set(lockedFeatures)
  const sameSet =
    disabled.size === saved.disabledFeatures.length && saved.disabledFeatures.every((k) => disabled.has(k))
  const dirty = allDisabled !== saved.allDisabled || !sameSet

  // Confirm-dialog summary: what actually flips, by feature label — collapsed
  // to "every AI feature" when that's what it is (never nine bolded labels).
  const wasOff = (key: AiFeatureKey) => saved.allDisabled || saved.disabledFeatures.includes(key)
  const isOff = (key: AiFeatureKey) => allDisabled || disabled.has(key)
  const nowOff = AI_FEATURES.filter((f) => isOff(f.key) && !wasOff(f.key)).map((f) => f.label)
  const nowOn = AI_FEATURES.filter((f) => !isOff(f.key) && wasOff(f.key)).map((f) => f.label)
  const offSummary = nowOff.length === AI_FEATURES.length || allDisabled ? 'every AI feature' : nowOff.join(', ')
  const onSummary = nowOn.length === AI_FEATURES.length ? 'every AI feature' : nowOn.join(', ')

  // Saved truth for the always-visible status line (never the pending form).
  // Names THIS layer's state explicitly and appends what higher layers locked —
  // "All AI features are currently available" above a visibly locked row was a
  // QA finding (the line and the lock contradicted each other).
  const savedOffCount = saved.allDisabled ? AI_FEATURES.length : saved.disabledFeatures.length
  const lockedExtra = lockedAll
    ? 0 // the lockedAll banner already carries this
    : lockedFeatures.filter((k) => !saved.allDisabled && !saved.disabledFeatures.includes(k)).length
  const ownTruth = saved.allDisabled
    ? 'You have disabled all AI features here.'
    : savedOffCount > 0
      ? `You have disabled ${savedOffCount} of ${AI_FEATURES.length} AI features here.`
      : "You haven't disabled any AI features here."
  const savedTruth =
    lockedExtra > 0 ? `${ownTruth} ${lockedExtra} more ${lockedExtra === 1 ? 'is' : 'are'} ${lockedSuffix}.` : ownTruth

  const toggleFeature = (key: AiFeatureKey, enabled: boolean) => {
    setDisabled((prev) => {
      const next = new Set(prev)
      if (enabled) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleSave = async () => {
    setSaving(true)
    const result = await save({
      allDisabled,
      disabledFeatures: [...disabled],
      expectedVersion: saved.version,
    })
    setSaving(false)
    if ('error' in result) {
      toast.error(result.error)
      return
    }
    setSaved({ allDisabled, disabledFeatures: [...disabled], version: result.version })
    toast.success(
      allDisabled
        ? 'All AI features are now disabled'
        : nowOff.length && !nowOn.length
          ? `Disabled: ${offSummary}`
          : nowOn.length && !nowOff.length
            ? `Re-enabled: ${onSummary}`
            : 'AI feature settings saved',
    )
  }

  return (
    <section className="bg-card border border-destructive/30 rounded-xl p-6 space-y-5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-destructive-muted shrink-0">
          <ShieldAlert className="h-4 w-4 text-destructive-muted-foreground" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{heading}</h2>
          <p className="text-[13px] text-muted-foreground mt-0.5">{description}</p>
          {/* Saved truth, not the pending form — the switches alone change nothing. */}
          <p className="text-xs text-muted-foreground mt-1.5">{savedTruth}</p>
        </div>
      </div>

      {lockedAll && lockedBanner && (
        <div className="flex items-center gap-2 rounded-xl bg-muted px-4 py-3 text-[13px] text-muted-foreground">
          <Lock className="h-4 w-4 shrink-0" />
          {lockedBanner}
        </div>
      )}
      {!lockedAll && lockedFeatures.length > 0 && partialLockNote && (
        <div className="flex items-center gap-2 rounded-xl bg-muted px-4 py-3 text-[13px] text-muted-foreground">
          <Lock className="h-4 w-4 shrink-0" />
          {partialLockNote}
        </div>
      )}

      {/* Master switch — positive polarity like every row below (ON = available). */}
      <div className="flex items-center justify-between gap-4 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
        <div className="min-w-0">
          <Label htmlFor={`${idPrefix}-master`} className="text-sm font-medium cursor-pointer">
            All AI features
          </Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Turn off to disable everything at once — including AI features added in the future.
          </p>
        </div>
        <Switch
          id={`${idPrefix}-master`}
          checked={!lockedAll && !allDisabled}
          disabled={lockedAll || saving}
          onCheckedChange={(v) => setAllDisabled(!v)}
        />
      </div>

      {/* Per-feature switches */}
      <ul className="divide-y divide-border">
        {AI_FEATURES.map((feature) => {
          const locked = lockedAll || lockedSet.has(feature.key)
          const masterOff = !locked && allDisabled
          const checked = !locked && !allDisabled && !disabled.has(feature.key)
          return (
            <li key={feature.key} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <Label
                  htmlFor={`${idPrefix}-${feature.key}`}
                  className="text-sm font-medium text-foreground cursor-pointer"
                >
                  {feature.label}
                </Label>
                <p className="text-xs text-muted-foreground">{feature.description}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {/* The chip only earns its place on PARTIAL locks — under a
                    full lock the banner above already says it, nine times over. */}
                {locked && !lockedAll && lockedNote && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground whitespace-nowrap">
                    <Lock className="h-3 w-3" /> {lockedNote}
                  </span>
                )}
                {masterOff && (
                  <span className="text-[11px] text-muted-foreground whitespace-nowrap">Off with all AI</span>
                )}
                <Switch
                  id={`${idPrefix}-${feature.key}`}
                  checked={checked}
                  disabled={locked || allDisabled || saving}
                  onCheckedChange={(v) => toggleFeature(feature.key, v)}
                />
              </div>
            </li>
          )
        })}
      </ul>

      {footnote && <p className="text-xs text-muted-foreground">{footnote}</p>}

      <div className="flex items-center justify-end gap-3">
        {dirty && !saving && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" variant={nowOff.length ? 'destructive' : 'default'} disabled={saving || !dirty}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save changes
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Apply these AI changes?</AlertDialogTitle>
              <AlertDialogDescription className="space-y-2">
                {nowOff.length > 0 && (
                  <span className="block">
                    This immediately disables <strong>{offSummary}</strong> for {scopeLabel}.
                  </span>
                )}
                {nowOn.length > 0 && (
                  <span className="block">
                    This re-enables <strong>{onSummary}</strong> — everything works exactly as before.
                  </span>
                )}
                <span className="block">The rest of Scholera is unaffected. You can change this anytime.</span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant={nowOff.length ? 'destructive' : 'default'} onClick={handleSave}>
                {nowOff.length ? 'Disable' : 'Save'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </section>
  )
}
