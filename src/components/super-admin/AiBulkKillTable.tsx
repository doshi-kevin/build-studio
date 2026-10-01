/**
 * AiBulkKillTable — super-admin bulk master kill across institutions.
 *
 * Checkbox-select institutions (with a select-all header), then one action:
 * disable or re-enable ALL AI for the selection. This flips each selected
 * institution's PLATFORM-layer master while preserving its per-feature list
 * and the institution's own settings — per-feature control lives on each
 * institution's detail page, deliberately (a feature × institution matrix
 * here would be unreadable).
 *
 * Type: Client Component (rendered on /super-admin/ai-controls)
 */
'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { bulkSetInstitutionsAiMaster } from '@/app/(dashboard)/super-admin/institutions/ai-actions'
import { AI_FEATURES } from '@/lib/ai/ai-features'

export interface BulkInstitutionRow {
  id: string
  name: string
  /** Platform-layer state (what THIS surface controls). */
  platformAllDisabled: boolean
  /** How many features the platform layer disables individually. */
  platformFeatureCount: number
  /** The institution's own master, shown for context only. */
  institutionAllDisabled: boolean
}

function rowStatus(row: BulkInstitutionRow): string {
  if (row.platformAllDisabled) return 'All AI disabled by Scholera'
  const parts: string[] = []
  if (row.platformFeatureCount > 0)
    parts.push(`${row.platformFeatureCount} of ${AI_FEATURES.length} features disabled by Scholera`)
  if (row.institutionAllDisabled) parts.push('all AI self-disabled')
  return parts.length ? parts.join(' · ') : 'AI available'
}

export function AiBulkKillTable({ institutions }: { institutions: BulkInstitutionRow[] }) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [working, setWorking] = useState<'disable' | 'enable' | null>(null)

  const allSelected = institutions.length > 0 && selected.size === institutions.length
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(institutions.map((i) => i.id)))
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const run = async (disable: boolean) => {
    setWorking(disable ? 'disable' : 'enable')
    const result = await bulkSetInstitutionsAiMaster([...selected], disable)
    setWorking(null)
    if ('error' in result) {
      toast.error(result.error)
      return
    }
    const verb = disable ? 'disabled' : 're-enabled'
    if (result.failures.length) {
      toast.error(`AI ${verb} for ${result.updated}, but failed for: ${result.failures.join(', ')}`)
    } else {
      toast.success(
        result.updated === 0
          ? `No changes — the selected institutions already had AI ${verb}.`
          : `All AI ${verb} for ${result.updated} institution${result.updated === 1 ? '' : 's'}${result.skipped ? ` (${result.skipped} already there)` : ''}`,
      )
    }
    setSelected(new Set())
    router.refresh()
  }

  const names = institutions.filter((i) => selected.has(i.id)).map((i) => i.name)

  return (
    <section className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="flex items-center justify-between gap-4 px-4 py-3 border-b border-border">
        <label className="flex items-center gap-3 text-sm font-medium cursor-pointer">
          <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Select all institutions" />
          {selected.size ? `${selected.size} selected` : 'Select institutions'}
        </label>
        <div className="flex items-center gap-2">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="destructive" disabled={!selected.size || working !== null}>
                {working === 'disable' && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Disable all AI
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Disable all AI for {selected.size} institution{selected.size === 1 ? '' : 's'}?</AlertDialogTitle>
                <AlertDialogDescription className="space-y-2">
                  <span className="block">
                    Every AI feature is immediately disabled for all professors and students at{' '}
                    <strong>{names.join(', ')}</strong>. Their admins will see the switches locked.
                  </span>
                  <span className="block">
                    Courses, grades, and materials are unaffected. Re-enabling restores everything exactly as it was.
                  </span>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => run(true)}>
                  Disable
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button
            size="sm"
            variant="outline"
            disabled={!selected.size || working !== null}
            onClick={() => run(false)}
          >
            {working === 'enable' && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Re-enable AI
          </Button>
        </div>
      </div>
      <ul className="divide-y divide-border">
        {institutions.map((inst) => (
          <li key={inst.id} className="flex items-center gap-3 px-4 py-3">
            <Checkbox
              checked={selected.has(inst.id)}
              onCheckedChange={() => toggleOne(inst.id)}
              aria-label={`Select ${inst.name}`}
            />
            <div className="min-w-0 flex-1">
              <Link
                href={`/super-admin/institutions/${inst.id}`}
                className="text-sm font-medium text-foreground hover:underline"
              >
                {inst.name}
              </Link>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                {(inst.platformAllDisabled || inst.platformFeatureCount > 0) && <Lock className="h-3 w-3" />}
                {rowStatus(inst)}
              </p>
            </div>
            <Button asChild size="sm" variant="ghost" className="text-xs">
              <Link href={`/super-admin/institutions/${inst.id}`}>Per-feature →</Link>
            </Button>
          </li>
        ))}
      </ul>
      {institutions.length === 0 && (
        <p className="px-4 py-8 text-sm text-muted-foreground text-center">No active institutions.</p>
      )}
    </section>
  )
}
