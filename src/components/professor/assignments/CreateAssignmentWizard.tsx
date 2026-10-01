/**
 * Create Assignment Wizard — a 3-step dialog (Details → Submission → Review).
 *
 * Brightspace-inspired: the professor decides what students hand in (which file
 * types, plus an always-optional text box) without a wall of fields. Calls the
 * createAssignment server action; the action is the source of truth for authz
 * and validation.
 *
 * Type: Client Component
 */
'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { FileText, ChevronLeft, ChevronRight, Check, Plus, ChevronDown, CalendarClock } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { FILE_TYPE_KINDS, type FileTypeKind } from '@/lib/validations/assignment'
import { ModulePlacementDialog } from '@/components/professor/roadmap/ModulePlacementDialog'
import { setResourcePlacement } from '@/lib/roadmap/placement-actions'
import {
  createAssignment,
  updateAssignment,
  uploadAssignmentPdf,
} from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'
import {
  useAthenaSurface,
  useAthenaDock,
  type FillResult,
} from '@/components/professor/assignments/athena/AssignmentAthenaDock'
import type { AssignmentFillTool, AssignmentScreen } from '@/lib/ai/assignment-assistant/schemas'
import type { FilesOp } from '@/lib/ai/assignment-assistant/templates/registry'
import { toLocalDateTimeInput } from '@/lib/datetime'

export interface EditAssignmentData {
  id: string
  title: string
  instructions: string
  dueAt: string | null
  points: number
  fileTypes: FileTypeKind[]
  isGraded: boolean
}

/** Seeds a fresh (non-edit) wizard from a template card or legacy import. */
export interface TemplatePrefill {
  title?: string
  instructions?: string
  fileTypes?: FileTypeKind[]
  pdfFile?: File | null
}

interface CreateAssignmentWizardProps {
  sectionId: string
  /** When provided, the wizard runs in edit mode (controlled open). */
  assignment?: EditAssignmentData
  /** Seeds the create form (template / legacy import). Ignored in edit mode. */
  prefill?: TemplatePrefill
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Fires after a successful save (create or edit) — e.g. to leave the chooser. */
  onComplete?: () => void
  /** Roadmap module already chosen upfront (entry-page setup spotlight). When
   *  set, the new assignment is placed there directly and the post-create
   *  placement popup is skipped. */
  placementModuleId?: string
}

const STEPS = ['Details', 'Submission', 'Review'] as const


/** Athena's dueDate (YYYY-MM-DD) + optional dueTime (HH:MM) → datetime-local value. */
function athenaDueToLocal(dueDate?: string, dueTime?: string): string | null {
  if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return null
  const time = dueTime && /^\d{2}:\d{2}$/.test(dueTime) ? dueTime : '23:59'
  return `${dueDate}T${time}`
}

export function CreateAssignmentWizard({
  sectionId,
  assignment,
  prefill,
  open: openProp,
  onOpenChange,
  onComplete,
  placementModuleId,
}: CreateAssignmentWizardProps) {
  const router = useRouter()
  const isEdit = !!assignment
  const isControlled = onOpenChange !== undefined
  const [internalOpen, setInternalOpen] = useState(false)
  const open = isControlled ? !!openProp : internalOpen
  const setOpen = (o: boolean) => (isControlled ? onOpenChange!(o) : setInternalOpen(o))
  const [step, setStep] = useState(0)
  const [isPending, startTransition] = useTransition()

  const [title, setTitle] = useState(assignment?.title ?? prefill?.title ?? '')
  const [instructions, setInstructions] = useState(assignment?.instructions ?? prefill?.instructions ?? '')
  const [dueAt, setDueAt] = useState(toLocalDateTimeInput(assignment?.dueAt))
  const [points, setPoints] = useState(assignment ? String(assignment.points) : '100')
  const [fileTypes, setFileTypes] = useState<FileTypeKind[]>(assignment?.fileTypes ?? prefill?.fileTypes ?? [])
  const [isGraded, setIsGraded] = useState(assignment?.isGraded ?? true)
  const [scheduling, setScheduling] = useState(false)
  const [scheduleAt, setScheduleAt] = useState('')
  const [pdfFile, setPdfFile] = useState<File | null>(prefill?.pdfFile ?? null)
  /** Newly created assignment awaiting its roadmap placement popup. */
  const [placementFor, setPlacementFor] = useState<{ id: string; title: string } | null>(null)

  function reset() {
    setStep(0)
    setTitle(prefill?.title ?? '')
    setInstructions(prefill?.instructions ?? '')
    setDueAt('')
    setPoints('100')
    setFileTypes(prefill?.fileTypes ?? [])
    setIsGraded(true)
    setScheduling(false)
    setScheduleAt('')
    setPdfFile(prefill?.pdfFile ?? null)
  }

  function toggleKind(kind: FileTypeKind) {
    setFileTypes((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind],
    )
  }

  function next() {
    if (step === 0 && !title.trim()) {
      toast.error('Give your assignment a title first.')
      return
    }
    if (step === 1 && fileTypes.length === 0) {
      toast.error('Pick at least one file type students can submit.')
      return
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1))
  }

  function submit(opts: { publish?: boolean; schedule?: string } = {}) {
    const publish = !!opts.publish
    const sched = opts.schedule
    if (sched && new Date(sched).getTime() <= Date.now()) {
      toast.error('Pick a future date and time to schedule.')
      return
    }
    startTransition(async () => {
      const payload = {
        title,
        instructions,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        points: Number(points),
        fileTypes,
        isGraded,
        scheduleAt: sched ? new Date(sched).toISOString() : null,
      }
      const result = isEdit
        ? await updateAssignment(sectionId, assignment!.id, payload)
        : await createAssignment(sectionId, payload, publish)
      if ('error' in result) {
        toast.error(result.error)
        return
      }

      // Upload the assignment PDF (if chosen) once we have the id. Non-fatal: the
      // assignment is already saved, so a PDF failure just warns.
      const newId: string | undefined =
        'assignmentId' in result && typeof result.assignmentId === 'string'
          ? result.assignmentId
          : assignment?.id
      if (pdfFile && newId) {
        const fd = new FormData()
        fd.append('pdf', pdfFile)
        const up = await uploadAssignmentPdf(sectionId, newId, fd)
        if ('error' in up) toast.error(up.error)
      }

      toast.success(
        isEdit ? 'Changes saved' : sched ? 'Assignment scheduled' : publish ? 'Assignment published' : 'Draft saved',
      )
      if (!isEdit && newId) {
        if (placementModuleId) {
          // The module was already chosen upfront (entry-page setup spotlight) —
          // place it directly, no popup. Best-effort: a failure just warns.
          const placed = await setResourcePlacement(sectionId, 'assignment', newId, placementModuleId)
          if (placed.error) toast.error(placed.error)
        } else {
          // A brand-new assignment is now real — ask where it lives on the roadmap
          // (it shows there immediately, marked unpublished until it goes live).
          // Do NOT setOpen(false) yet: controlled hosts unmount this component on
          // close, which would kill the popup. Everything closes after it.
          setPlacementFor({ id: newId, title })
          return
        }
      }
      setOpen(false)
      if (!isEdit) reset()
      router.refresh()
      onComplete?.()
    })
  }

  /** Runs after the placement popup closes (placed or skipped). */
  function finishAfterPlacement() {
    setPlacementFor(null)
    reset()
    router.refresh()
    setOpen(false)
    onComplete?.()
  }

  // Snapshot the current form for Athena (so it edits surgically). Instructions
  // capped to keep per-turn tokens flat; points sent only if it parses.
  const getScreen = useCallback((): AssignmentScreen => {
    const pointsNum = Number(points)
    // The file-upload form is a template with meta fields only (no components).
    return {
      authoring: {
        kind: 'files',
        meta: {
          ...(title ? { title } : {}),
          ...(instructions ? { instructions: instructions.slice(0, 2000) } : {}),
          ...(Number.isFinite(pointsNum) ? { points: pointsNum } : {}),
          ...(dueAt ? { dueAt } : {}),
          ...(fileTypes.length ? { fileTypes } : {}),
          isGraded,
        },
      },
    }
  }, [title, instructions, points, dueAt, fileTypes, isGraded])

  // Apply an apply_edits call (a single setMeta op for this form) — auto-apply. Skips any
  // field the professor is actively editing (never clobber their cursor); lands on the
  // Review step so they see everything at once; returns a summary + undo.
  const onFill = useCallback(
    (tool: AssignmentFillTool, payload: unknown): FillResult => {
      if (tool !== 'apply_edits') return { summary: 'Nothing to apply.', applied: false }
      const { ops } = (payload ?? {}) as { ops?: FilesOp[] }
      const p = ops?.find((o) => o.op === 'setMeta')
      if (!p) return { summary: 'No changes.', applied: false }
      const focused = typeof document !== 'undefined' ? document.activeElement?.id : undefined
      const before = { title, instructions, dueAt, points, fileTypes: [...fileTypes], isGraded }
      const changed: string[] = []
      const skipped: string[] = []

      if (p.title !== undefined) {
        if (focused === 'a-title') skipped.push('title')
        else {
          setTitle(p.title)
          changed.push('title')
        }
      }
      if (p.instructions !== undefined) {
        if (focused === 'a-instructions') skipped.push('instructions')
        else {
          setInstructions(p.instructions)
          changed.push('instructions')
        }
      }
      if (p.points !== undefined) {
        if (focused === 'a-points') skipped.push('points')
        else {
          setPoints(String(p.points))
          changed.push('points')
        }
      }
      if (p.dueDate !== undefined) {
        const local = athenaDueToLocal(p.dueDate, p.dueTime)
        if (focused === 'a-due') skipped.push('due date')
        else if (local) {
          setDueAt(local)
          changed.push('due date')
        }
      }
      if (p.fileTypes !== undefined) {
        const valid = p.fileTypes.filter((k): k is FileTypeKind =>
          FILE_TYPE_KINDS.some((x) => x.kind === k),
        )
        setFileTypes(valid)
        changed.push('file types')
      }
      if (p.isGraded !== undefined) {
        setIsGraded(p.isGraded)
        changed.push(p.isGraded ? 'graded' : 'ungraded')
      }

      if (changed.length) setStep(STEPS.length - 1)

      const summary = changed.length
        ? `Filled ${changed.join(', ')}${skipped.length ? ` · kept your ${skipped.join(', ')}` : ''}`
        : skipped.length
          ? `Kept your ${skipped.join(', ')} — you were editing it`
          : 'Nothing to change'

      const undo = () => {
        setTitle(before.title)
        setInstructions(before.instructions)
        setDueAt(before.dueAt)
        setPoints(before.points)
        setFileTypes(before.fileTypes)
        setIsGraded(before.isGraded)
      }
      return { summary, undo }
    },
    [title, instructions, dueAt, points, fileTypes, isGraded],
  )

  // Register this form as Athena's active surface while the wizard is open, and
  // open the dock so the genie is right there when they start a new assignment.
  useAthenaSurface({ active: open, surface: 'authoring', kind: 'files', getScreen, onFill })
  const { open: dockOpen, setOpen: setDockOpen } = useAthenaDock()
  useEffect(() => {
    if (open && !isEdit) setDockOpen(true)
  }, [open, isEdit, setDockOpen])

  return (
    <>
    {placementFor && (
      <ModulePlacementDialog
        open
        onOpenChange={(o) => { if (!o) finishAfterPlacement() }}
        sectionId={sectionId}
        kind="assignment"
        resourceId={placementFor.id}
        resourceTitle={placementFor.title || 'this assignment'}
      />
    )}
    <Dialog
      open={open}
      // Non-modal in create mode so the Athena side panel stays interactive beside the wizard
      // (no dimming overlay, no focus trap). Edit mode uses a real modal to prevent the
      // dropdown-close race condition.
      modal={!isEdit}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      {!isControlled && (
        <DialogTrigger asChild>
          <Button>
            <Plus className="h-4 w-4" />
            New assignment
          </Button>
        </DialogTrigger>
      )}
      <DialogContent
        className="transition-[left] duration-200 sm:max-w-xl"
        // When the Athena dock is open, shift the centered dialog left by half the
        // panel width so it centers in the free space instead of tucking under the
        // panel. Inline `left` overrides the base `left-[50%]`; translate-x stays.
        style={dockOpen ? { left: 'calc(50% - 12rem)' } : undefined}
        // Keep the wizard open when the professor clicks into the Athena dock
        // (a non-modal dialog otherwise closes on any outside interaction).
        onPointerDownOutside={(e) => {
          if ((e.target as HTMLElement | null)?.closest?.('[data-athena-dock]')) e.preventDefault()
        }}
        onInteractOutside={(e) => {
          if ((e.target as HTMLElement | null)?.closest?.('[data-athena-dock]')) e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit assignment' : 'Create assignment'}</DialogTitle>
        </DialogHeader>

        {/* Stepper */}
        <ol className="flex items-center gap-2" aria-label="Progress">
          {STEPS.map((label, i) => {
            const done = i < step
            const active = i === step
            return (
              <li key={label} className="flex flex-1 items-center gap-2">
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                    active
                      ? 'bg-primary text-primary-foreground'
                      : done
                        ? 'bg-primary/15 text-primary'
                        : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                </span>
                <span
                  className={`text-sm ${active ? 'font-medium text-foreground' : 'text-muted-foreground'}`}
                >
                  {label}
                </span>
                {i < STEPS.length - 1 && <span className="h-px flex-1 bg-border" />}
              </li>
            )
          })}
        </ol>

        {/* Step body */}
        <div className="py-2">
          {step === 0 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="a-title">Title</Label>
                <Input
                  id="a-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Problem Set 3"
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="a-instructions">Instructions</Label>
                <Textarea
                  id="a-instructions"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="What should students do? Add any guidelines here."
                  rows={5}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="a-due">Due date</Label>
                  <Input
                    id="a-due"
                    type="datetime-local"
                    value={dueAt}
                    onChange={(e) => setDueAt(e.target.value)}
                  />
                </div>
                {isGraded && (
                  <div className="space-y-2">
                    <Label htmlFor="a-points">Points</Label>
                    <Input
                      id="a-points"
                      type="number"
                      min={0}
                      max={1000}
                      value={points}
                      onChange={(e) => setPoints(e.target.value)}
                    />
                  </div>
                )}
              </div>
              <label
                htmlFor="a-ungraded"
                className="flex items-center justify-between gap-4 rounded-xl border border-border p-3"
              >
                <span className="text-sm font-medium text-foreground">Ungraded</span>
                <Switch
                  id="a-ungraded"
                  checked={!isGraded}
                  onCheckedChange={(checked) => setIsGraded(!checked)}
                  aria-label="Ungraded assignment"
                />
              </label>
              <div className="space-y-2">
                <Label htmlFor="a-pdf">
                  Assignment PDF <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="a-pdf"
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={(e) => setPdfFile(e.target.files?.[0] ?? null)}
                />
                {pdfFile && <p className="truncate text-xs text-muted-foreground">{pdfFile.name}</p>}
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <p className="text-sm font-medium text-foreground">What can students submit?</p>
              <div className="grid gap-2">
                {FILE_TYPE_KINDS.map((k) => {
                  const checked = fileTypes.includes(k.kind)
                  return (
                    <label
                      key={k.kind}
                      htmlFor={`ft-${k.kind}`}
                      className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors ${
                        checked ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
                      }`}
                    >
                      <Checkbox
                        id={`ft-${k.kind}`}
                        checked={checked}
                        onCheckedChange={() => toggleKind(k.kind)}
                      />
                      <span className="text-sm font-medium text-foreground">{k.label}</span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {k.extensions.map((e) => `.${e}`).join(', ')}
                      </span>
                    </label>
                  )
                })}
              </div>
              <p
                className={`rounded-xl p-3 text-sm ${
                  fileTypes.length === 0
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-muted/50 text-muted-foreground'
                }`}
              >
                {fileTypes.length === 0
                  ? 'Select at least one file type students can submit. A written response is always available alongside it.'
                  : 'Students can upload the selected files and, optionally, write a text response.'}
              </p>
            </div>
          )}

          {step === 2 && (
            <dl className="space-y-3 text-sm">
              <Row label="Title" value={title || '—'} />
              <Row label="Instructions" value={instructions ? instructions : 'None'} />
              <Row
                label="Due"
                value={dueAt ? new Date(dueAt).toLocaleString() : 'No due date'}
              />
              <Row label="Grading" value={isGraded ? `Graded · ${points} points` : 'Ungraded'} />
              <Row
                label="Students submit"
                value={
                  fileTypes.length === 0
                    ? 'Text response only (optional)'
                    : `${fileTypes.map((k) => FILE_TYPE_KINDS.find((x) => x.kind === k)?.label).join(', ')} + optional text`
                }
              />
            </dl>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setStep((s) => Math.max(s - 1, 0))}
            disabled={step === 0 || isPending}
          >
            <ChevronLeft className="h-4 w-4" />
            Back
          </Button>

          {step < STEPS.length - 1 ? (
            <Button type="button" onClick={next}>
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          ) : isEdit ? (
            <Button type="button" onClick={() => submit()} disabled={isPending || fileTypes.length === 0}>
              <FileText className="h-4 w-4" />
              Save changes
            </Button>
          ) : scheduling ? (
            <div className="flex items-center gap-2">
              <Input
                type="datetime-local"
                value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)}
                className="h-9 w-auto"
                aria-label="Publish date and time"
              />
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setScheduling(false)
                  setScheduleAt('')
                }}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => submit({ schedule: scheduleAt })}
                disabled={isPending || !scheduleAt || fileTypes.length === 0}
              >
                <CalendarClock className="h-4 w-4" />
                Schedule
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => submit()}
                disabled={isPending || fileTypes.length === 0}
              >
                Save as draft
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" disabled={isPending || fileTypes.length === 0}>
                    <FileText className="h-4 w-4" />
                    Publish
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => submit({ publish: true })}>
                    <FileText className="h-4 w-4" />
                    Publish now
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setScheduling(true)}>
                    <CalendarClock className="h-4 w-4" />
                    Schedule for later…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
    </>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-4">
      <dt className="w-32 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="whitespace-pre-wrap text-foreground">{value}</dd>
    </div>
  )
}
