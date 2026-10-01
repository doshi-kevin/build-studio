'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CircleAlert, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import type { PluginCard } from '@/lib/studio/plugin-card'
import type { BlockerCode, Issue, WarningCode } from '@/lib/studio/student-visibility'
import type { ValidationSummary } from '@/lib/studio/validator/service'
import { SkillSlotLinks } from './SkillSlotLinks'
import { ValidationChecks } from './ValidationChecks'
import { showToStudentsAction } from '@/app/(dashboard)/professor/courses/[sectionId]/studio/[installationId]/actions'

interface PublicationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
  installationId: string
  card: PluginCard
  /** From the server's publication checks when the page loaded. The server runs them
   * all again when the professor confirms; this is what to read, not what decides. */
  blockers: Issue<BlockerCode>[]
  warnings: Issue<WarningCode>[]
  validation?: ValidationSummary | null
  skillSlots?: { key: string; label: string; skillId: string | null }[]
  /** Null when the course's skills couldn't be read. */
  sectionSkills?: { id: string; name: string }[] | null
}

/** Blockers that aren't a fault in this tool: Scholera or the school isn't ready, or
 * a step is still to do. Shown calmly, not as an error. */
const NOT_YET: ReadonlySet<BlockerCode> = new Set([
  'release_gate',
  'validator_unavailable',
  'validator_review',
  'skill_binding_missing',
  'kill_switch',
  'not_entitled',
])

/** One line per distinct reason. "Not released" already covers "the checks don't exist". */
function readableBlockers(blockers: Issue<BlockerCode>[]): Issue<BlockerCode>[] {
  const released = !blockers.some((b) => b.code === 'release_gate')
  const seen = new Set<string>()
  return blockers.filter((b) => {
    if (!released && b.code === 'validator_unavailable') return false
    if (seen.has(b.message)) return false
    seen.add(b.message)
    return true
  })
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="text-sm text-muted-foreground">{children}</div>
    </section>
  )
}

function Lines({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p>{empty}</p>
  return (
    <ul className="list-disc space-y-1 pl-5">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  )
}

/** The plugin card (rule 8.2), shown before a tool reaches students. */
export function PublicationDialog({
  open,
  onOpenChange,
  sectionId,
  installationId,
  card,
  blockers: initialBlockers,
  warnings: initialWarnings,
  validation = null,
  skillSlots = [],
  sectionSkills = [],
}: PublicationDialogProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [acknowledged, setAcknowledged] = useState(false)
  // The server's answer to a refused attempt. Fresh page data (after binding a skill or
  // running the checks inside this dialog) replaces it.
  const [refused, setRefused] = useState<{ blockers?: Issue<BlockerCode>[]; warnings?: Issue<WarningCode>[] } | null>(null)
  const [pageData, setPageData] = useState(initialBlockers)
  if (pageData !== initialBlockers) {
    setPageData(initialBlockers)
    setRefused(null)
  }
  const blockers = refused?.blockers ?? initialBlockers
  const warnings = refused?.warnings ?? initialWarnings

  const shown = readableBlockers(blockers)
  const blocked = shown.length > 0
  const onlyNotYet = blocked && shown.every((b) => NOT_YET.has(b.code))
  const canShow = !blocked && (warnings.length === 0 || acknowledged) && !pending

  const close = (next: boolean) => {
    if (!next && pending) return
    onOpenChange(next)
  }

  const confirm = () =>
    startTransition(async () => {
      const result = await showToStudentsAction(sectionId, installationId, acknowledged)
      if ('error' in result) {
        setRefused({ blockers: result.blockers, warnings: result.warnings })
        // New warnings need reading again.
        if (result.warnings) setAcknowledged(false)
        toast.error(result.error)
        return
      }
      toast.success(`${card.name} is now visible to students`)
      onOpenChange(false)
      router.refresh()
    })

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{blocked ? `${card.name} can’t be shown to students yet` : `Show ${card.name} to students?`}</DialogTitle>
          <DialogDescription>
            v{card.version}. {card.description}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {blocked && (
            <Alert variant={onlyNotYet ? 'default' : 'destructive'}>
              {onlyNotYet ? <Clock className="h-4 w-4" aria-hidden="true" /> : <CircleAlert className="h-4 w-4" aria-hidden="true" />}
              <AlertTitle>{onlyNotYet ? 'Not ready for students yet' : 'Fix these first'}</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-1 pl-5">
                  {shown.map((b) => (
                    <li key={b.code}>{b.message}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {skillSlots.length > 0 && (
            <Section title="Skills it counts toward">
              <SkillSlotLinks sectionId={sectionId} installationId={installationId} slots={skillSlots} skills={sectionSkills} />
            </Section>
          )}
          <Section title="Studio’s automatic checks">
            <ValidationChecks sectionId={sectionId} installationId={installationId} validation={validation} />
          </Section>

          <Section title="Students can">
            <Lines items={card.students} empty="Use the tool, without saving anything." />
          </Section>
          <Section title="You can">
            <Lines items={card.professors} empty="Use the tool, without saving anything." />
          </Section>
          <Section title="What it saves">
            {card.data.length === 0 ? (
              <p>Nothing.</p>
            ) : (
              <ul className="space-y-2">
                {card.data.map((c) => (
                  <li key={c.name}>
                    <span className="font-medium text-foreground">{c.name}</span>: {c.access}. Includes {c.fields.join(', ')}.
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Storage">
            {card.storage ? (
              <>
                <p>{card.storage.used}.</p>
                <p>{card.storage.perStudent}.</p>
              </>
            ) : (
              <p>Couldn’t check storage just now.</p>
            )}
          </Section>
          <Section title="AI, grading and activity tracking">
            <p>{card.ai}</p>
            <p>{card.grading}</p>
            <p>{card.tracking}</p>
          </Section>

          {warnings.length > 0 && (
            <Alert>
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>Before you continue</AlertTitle>
              <AlertDescription className="space-y-3">
                <ul className="list-disc space-y-1 pl-5">
                  {warnings.map((w) => (
                    <li key={w.code}>{w.message}</li>
                  ))}
                </ul>
                {!blocked && (
                  <div className="flex min-h-11 items-center gap-2">
                    <Checkbox
                      id="publication-acknowledge"
                      checked={acknowledged}
                      onCheckedChange={(v) => setAcknowledged(v === true)}
                    />
                    <Label htmlFor="publication-acknowledge">I’ve read these and want to continue</Label>
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          {blocked ? (
            <Button type="button" className="min-h-11" onClick={() => close(false)}>
              Close
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" className="min-h-11" onClick={() => close(false)} disabled={pending}>
                Cancel
              </Button>
              <Button type="button" className="min-h-11" onClick={confirm} disabled={!canShow}>
                {pending ? 'Showing…' : 'Show to students'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
