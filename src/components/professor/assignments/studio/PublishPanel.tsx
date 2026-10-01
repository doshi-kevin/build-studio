/**
 * Publish panel for a studio assignment — the final "Publish" step, rendered inline as its own
 * full-screen page in the studio canvas (not a modal). Collects what publishing needs: a name,
 * a submission deadline, points/graded, roadmap placement, the allowed file submissions, and
 * optional assessment/proctoring — then publishes now or schedules for later via the vetted
 * publishStudioAssignment action.
 *
 * Type: Client Component
 */
'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Send, CalendarClock, ShieldCheck, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  FILE_TYPE_KINDS,
  type FileTypeKind,
  type AssessmentConfig,
  DEFAULT_ASSESSMENT_WORK_MINUTES,
  DEFAULT_ASSESSMENT_UPLOAD_MINUTES,
} from '@/lib/validations/assignment'
import { publishStudioAssignment, renameAssignment, savePublishSettings, getAssignmentSkillTagging } from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'
import { getPlacementModules, getResourcePlacement, setResourcePlacement } from '@/lib/roadmap/placement-actions'
import { SaveStatus, type SaveState } from './shared/StudioChrome'

interface Props {
  sectionId: string
  assignmentId: string
  /** Current assignment name — shown as a required field so it's never published untitled. */
  defaultTitle?: string
  defaultDueAt?: string | null
  defaultFileTypes?: FileTypeKind[]
  /** Verbal assessments submit a recorded video, not files, so hide the file-type picker. */
  hideFileTypes?: boolean
  /** Saved assessment config, so the panel reflects it. */
  defaultAssessment?: AssessmentConfig
  /** Starting points value for the points field. */
  defaultPoints?: number
  /** Starting graded state (true = graded, false = ungraded). */
  defaultIsGraded?: boolean
  /** When true, publishing requires at least one file type to be selected. */
  requireFileTypes?: boolean
  /** When true, show an empty-content warning and require confirmation before publishing. */
  contentEmpty?: boolean
  /** True when the assignment is already live. Autosave is suppressed (it would push changes to
   *  students silently); edits persist via the explicit Publish button instead. */
  published?: boolean
  /** Called with the new name once a rename has actually persisted. The studios own the title state
   *  that feeds `defaultTitle`, and this panel unmounts on every step change — without this the
   *  owner keeps the pre-rename value, so stepping away and back re-seeds the field with the OLD
   *  name (and the studio header stays stale) even though the DB is correct. */
  onNameSaved?: (name: string) => void
  /** Where the roadmap module comes from. 'skillModules' (default): the modules tagged on the
   *  "Add files & rubrics" step (settings.skillModules; the first one is the placement) — this
   *  panel only summarizes them. 'picker': the legacy single-module picker, for studios with no
   *  rubrics step (verbal assessments). */
  placement?: 'skillModules' | 'picker'
}

/** ISO timestamp → value for a datetime-local input (local time). */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * A datetime-local value → ISO, or a sentinel for a half-typed/invalid value.
 * Guards new Date(x).toISOString() from throwing RangeError on partial input
 * (which would leave the autosave indicator stuck on "Saving…").
 */
function localToIso(local: string): string | null | 'invalid' {
  if (!local) return null
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? 'invalid' : d.toISOString()
}

export function PublishPanel({ sectionId, assignmentId, defaultTitle, defaultDueAt, defaultFileTypes, hideFileTypes, defaultAssessment, defaultPoints, defaultIsGraded, requireFileTypes, contentEmpty, published, onNameSaved, placement = 'skillModules' }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [name, setName] = useState(defaultTitle ?? '')
  const [dueAt, setDueAt] = useState(toLocalInput(defaultDueAt))
  const [fileTypes, setFileTypes] = useState<FileTypeKind[]>(defaultFileTypes ?? [])
  const [isGraded, setIsGraded] = useState(defaultIsGraded !== undefined ? defaultIsGraded : true)
  // The Ungraded/points block only renders when the caller supplies its defaults (see below). Where
  // it doesn't render, `isGraded` above is a local placeholder with no control behind it, so it must
  // never be sent — otherwise an unrelated edit on this step silently flips the assignment back to
  // graded. Both the autosave and the publish payload omit it in that case.
  const ownsGradedFlag = defaultPoints !== undefined || defaultIsGraded !== undefined
  const [scheduling, setScheduling] = useState(false)
  const [scheduleAt, setScheduleAt] = useState('')
  // Assessment mode — timed + proctored. Off by default; enabling reveals the options.
  const [assessOn, setAssessOn] = useState(defaultAssessment?.enabled ?? false)
  // Held as strings so the fields can be cleared/edited naturally (a numeric value can't
  // be empty, which caused typing to start from a stuck leading 0). Parsed on submit.
  const [workMinutes, setWorkMinutes] = useState(
    defaultAssessment ? (defaultAssessment.workMinutes == null ? '' : String(defaultAssessment.workMinutes)) : String(DEFAULT_ASSESSMENT_WORK_MINUTES),
  )
  const [uploadMinutes, setUploadMinutes] = useState(String(defaultAssessment?.uploadMinutes ?? DEFAULT_ASSESSMENT_UPLOAD_MINUTES))
  const [proctActivity, setProctActivity] = useState(defaultAssessment?.proctoring.activity ?? true)
  const [proctFullscreen, setProctFullscreen] = useState(defaultAssessment?.proctoring.fullscreen ?? true)
  const [proctVideo, setProctVideo] = useState(defaultAssessment?.proctoring.video ?? false)
  // When contentEmpty is true, the publish buttons require a confirmation step before proceeding.
  const [emptyConfirmPending, setEmptyConfirmPending] = useState<{ publish?: boolean; schedule?: string } | null>(null)
  // Local save status for the autosave indicator on this panel.
  const [saveState, setSaveState] = useState<SaveState>('idle')
  // Serialize autosaves: each write waits for the previous to resolve, so a slow earlier
  // save can't land after a later one and resurrect stale values (both patch the same
  // settings keys, so the merge RPC alone can't order them).
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  // Monotonic id of the most recently ENQUEUED save. A save only writes the terminal indicator
  // state (saved/error) if it's still the latest — so an earlier save finishing while a newer one
  // is still queued won't briefly flash "Saved" with a write pending.
  const saveSeqRef = useRef(0)
  // The pending debounce timer, so a Publish click can cancel a not-yet-fired autosave.
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Scroll container for the panel body, so turning the assessment toggle ON can reveal its options.
  const bodyRef = useRef<HTMLDivElement>(null)
  // Tracks first mount so debounced autosave doesn't fire on initial render (which would
  // overwrite DB defaults before the professor has changed anything).
  const firstRender = useRef(true)
  // The name last persisted by the rename autosave (or publish). Seeded from the incoming title.
  const lastSavedNameRef = useRef(defaultTitle ?? '')

  // Inline validation for the assessment clocks, mirroring the submit() guards and the server
  // schema. Previously these fields accepted 0 / 61 / 481 with no feedback and Publish stayed
  // enabled — and worse, the autosave payload carrying the invalid value failed server validation,
  // so the pill flipped to "Couldn't save" without naming the field, taking the other valid edits
  // in that payload down with it.
  const workMinutesValue = workMinutes.trim() === '' ? null : Number(workMinutes)
  const workMinutesError =
    assessOn && workMinutesValue !== null && (!Number.isInteger(workMinutesValue) || workMinutesValue < 1 || workMinutesValue > 480)
      ? 'Enter 1–480 minutes, or leave blank for no limit.'
      : null
  const uploadMinutesValue = Number(uploadMinutes)
  const uploadMinutesError =
    assessOn && (!Number.isInteger(uploadMinutesValue) || uploadMinutesValue < 1 || uploadMinutesValue > 60)
      ? 'Enter 1–60 minutes.'
      : null
  const assessmentClocksInvalid = !!workMinutesError || !!uploadMinutesError
  // While a clock is invalid the autosave deliberately skips the write (see the effect below), so
  // the stored `saveState` would keep advertising the last successful save. Derived, not stored, so
  // it can never drift from the fields it describes.
  const shownSaveState: SaveState = assessmentClocksInvalid ? 'unsaved' : saveState

  function toggleAssessment(on: boolean) {
    setAssessOn(on)
    // Let the revealed options mount, then scroll them into view.
    if (on) setTimeout(() => bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' }), 60)
  }
  // Roadmap placement — required whenever the section has modules, so the roadmap can show
  // the assignment under the module it belongs to. Default source: the modules tagged on the
  // "Add files & rubrics" step (first tagged = placement); 'picker' keeps the legacy select.
  const usePicker = placement === 'picker'
  const [modules, setModules] = useState<{ id: string; title: string; weekNumber: number | null }[] | null>(null)
  const [moduleId, setModuleId] = useState('')
  // Track the moduleId that was last persisted to avoid re-saving on the load-from-DB assignment.
  const lastPersistedModuleId = useRef<string | null>(null)
  const [taggedIds, setTaggedIds] = useState<string[]>([])

  // The panel mounts when the professor reaches the Publish step, so load placement once on mount.
  useEffect(() => {
    let alive = true
    if (usePicker) {
      Promise.all([
        getPlacementModules(sectionId),
        getResourcePlacement(sectionId, 'assignment', assignmentId),
      ]).then(([mods, current]) => {
        if (!alive) return
        setModules(mods.data ?? [])
        if (current.data) {
          setModuleId(current.data)
          lastPersistedModuleId.current = current.data
        }
      })
    } else {
      getAssignmentSkillTagging(sectionId, assignmentId).then((res) => {
        if (!alive) return
        if ('error' in res) {
          setModules([])
          return
        }
        setModules(res.modules)
        setTaggedIds(res.taggedIds)
      })
    }
    return () => { alive = false }
  }, [sectionId, assignmentId, usePicker])

  // Debounced autosave of deadline/fileTypes/assessment/isGraded — skips the first mount
  // so we never overwrite DB state with stale local defaults before the professor edits.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    // A live assignment never autosaves — that would push deadline/graded/file-type changes to
    // students silently (no notification, gradebook drop on ungraded). Edits go through Publish.
    if (published) return
    // Don't autosave an empty file-type set on an assignment that requires one (mirrors the Publish
    // guard): persisting fileTypes:[] would remove the student upload UI on a live assignment.
    if (requireFileTypes && fileTypes.length === 0) return
    // Skip the write while a clock field is invalid — the server would reject the whole payload
    // (taking the valid edits with it) and the pill would just read "Couldn't save". This effect
    // re-runs on ANY dep change, so an unrelated edit (deadline, file type) gets dropped here too;
    // `shownSaveState` below therefore reports "Not saved yet" for as long as a clock is invalid,
    // rather than leaving the reassuring "All changes saved" from an earlier write standing.
    if (assessmentClocksInvalid) return
    const wm = workMinutes.trim() === '' ? null : Number(workMinutes)
    const um = Number(uploadMinutes)
    const assessment: AssessmentConfig = {
      enabled: assessOn,
      workMinutes: wm,
      uploadMinutes: Number.isFinite(um) ? um : DEFAULT_ASSESSMENT_UPLOAD_MINUTES,
      proctoring: { activity: proctActivity, fullscreen: proctFullscreen, video: proctVideo },
    }
    const dueIso = localToIso(dueAt)
    // Don't autosave a half-typed deadline — writing null would silently clear the date.
    if (dueIso === 'invalid') return
    const t = setTimeout(() => {
      setSaveState('saving')
      const mySeq = ++saveSeqRef.current
      saveChainRef.current = saveChainRef.current.then(async () => {
        try {
          const res = await savePublishSettings(sectionId, assignmentId, {
            dueAt: dueIso,
            fileTypes,
            assessment,
            ...(ownsGradedFlag ? { isGraded } : {}),
          })
          // Only the latest enqueued save owns the indicator — an earlier one finishing while a
          // newer save is still queued must not flash "Saved" with a write pending.
          if (mySeq === saveSeqRef.current) setSaveState('error' in res ? 'error' : 'saved')
        } catch {
          // A network failure REJECTS the server action (not an {error} result). Swallow it so the
          // stored chain always resolves — otherwise every later autosave chains onto a rejected
          // promise, silently never runs, and the indicator sticks on "Saving…" for the session.
          if (mySeq === saveSeqRef.current) setSaveState('error')
        }
      })
    }, 800)
    autosaveTimerRef.current = t
    return () => clearTimeout(t)
  }, [dueAt, fileTypes, isGraded, ownsGradedFlag, assessmentClocksInvalid, assessOn, workMinutes, uploadMinutes, proctActivity, proctFullscreen, proctVideo, sectionId, assignmentId, published, requireFileTypes])

  // Debounced autosave of the assignment name. It used to persist only inside submit(), so a name
  // typed here was lost on step navigation (this panel unmounts when you go back to Build) and on
  // reload, with no indicator ever moving. Same published/first-mount guards as the settings
  // autosave, and renameAssignment is a no-op when the name matches what's stored.
  useEffect(() => {
    if (firstRender.current) return
    if (published) return
    const trimmed = name.trim()
    // Compare against the last name actually persisted, not the original prop: `defaultTitle` is
    // stale after the first rename, so typing back to it would re-fire a rename every keystroke.
    if (!trimmed || trimmed === lastSavedNameRef.current) return
    const t = setTimeout(() => {
      setSaveState('saving')
      const mySeq = ++saveSeqRef.current
      saveChainRef.current = saveChainRef.current.then(async () => {
        try {
          const res = await renameAssignment(sectionId, assignmentId, trimmed)
          if ('error' in res) {
            if (mySeq === saveSeqRef.current) setSaveState('error')
            return
          }
          lastSavedNameRef.current = trimmed
          onNameSaved?.(trimmed)
          if (mySeq === saveSeqRef.current) setSaveState('saved')
        } catch {
          if (mySeq === saveSeqRef.current) setSaveState('error')
        }
      })
    }, 800)
    // Shared with the settings autosave so submit() cancels a pending rename too — otherwise a
    // rename could land after the publish write, against the fencing this panel is built on.
    autosaveTimerRef.current = t
    return () => clearTimeout(t)
  }, [name, sectionId, assignmentId, published, onNameSaved])

  // Persist module placement when moduleId changes (debounced). Skips if it matches
  // the last value loaded from the DB to avoid a no-op write on first selection.
  useEffect(() => {
    if (!moduleId || moduleId === lastPersistedModuleId.current) return
    const t = setTimeout(async () => {
      const placed = await setResourcePlacement(sectionId, 'assignment', assignmentId, moduleId)
      if (!placed.error) lastPersistedModuleId.current = moduleId
    }, 800)
    return () => clearTimeout(t)
  }, [moduleId, sectionId, assignmentId])

  const placementModuleId = usePicker ? moduleId : (taggedIds[0] ?? '')
  // Loading is NOT missing: the red "choose/tag a module" banner must never flash while the
  // modules fetch is still in flight (#553). Buttons stay disabled during the load instead.
  const moduleLoading = modules === null
  const moduleMissing = !moduleLoading && modules.length > 0 && !placementModuleId

  function toggleKind(kind: FileTypeKind) {
    setFileTypes((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]))
  }

  function submit(opts: { publish?: boolean; schedule?: string }) {
    const trimmedName = name.trim()
    if (!trimmedName) {
      toast.error('Give the assignment a name before publishing.')
      return
    }
    const dueIso = localToIso(dueAt)
    if (dueIso === 'invalid') {
      toast.error('That deadline is not a valid date and time.')
      return
    }
    const sched = opts.schedule
    if (sched && new Date(sched).getTime() <= Date.now()) {
      toast.error('Pick a future date and time to schedule.')
      return
    }
    // File-upload assignments require at least one accepted file type.
    if (requireFileTypes && fileTypes.length === 0) {
      toast.error('Pick at least one file type students can submit.')
      return
    }
    // Blank work time => untimed (null): students aren't limited by a work clock.
    const wm = workMinutes.trim() === '' ? null : Number(workMinutes)
    const um = Number(uploadMinutes)
    if (assessOn) {
      // An assessment's deliverable is an uploaded file, so at least one type is required.
      if (fileTypes.length === 0) {
        toast.error('Pick at least one file type students can submit.')
        return
      }
      if (wm !== null && (!Number.isInteger(wm) || wm < 1 || wm > 480)) {
        toast.error('Work time must be 1–480 minutes, or blank for no limit.')
        return
      }
      if (!Number.isInteger(um) || um < 1 || um > 60) {
        toast.error('Upload time must be between 1 and 60 minutes.')
        return
      }
    }
    const assessment: AssessmentConfig = {
      enabled: assessOn,
      workMinutes: wm,
      uploadMinutes: Number.isFinite(um) ? um : DEFAULT_ASSESSMENT_UPLOAD_MINUTES,
      proctoring: { activity: proctActivity, fullscreen: proctFullscreen, video: proctVideo },
    }
    // Cancel any not-yet-fired autosave so it can't write over the publish we're about to do.
    // Deliberately AFTER every validation above: cancelling first meant a rejected Publish threw
    // away the pending autosave, and since the effect only re-fires on a dep change, the edit was
    // silently lost until the professor touched another field.
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    startTransition(async () => {
      // Fence any in-flight autosave: it carries PRE-publish values, and if it resolved after the
      // publish write it would revert due_at/is_graded/accepts/assessment on the now-live row. We
      // already cancelled the un-fired debounce above; await the chain so a running one lands first.
      await saveChainRef.current
      if (trimmedName !== lastSavedNameRef.current) {
        const renamed = await renameAssignment(sectionId, assignmentId, trimmedName)
        if ('error' in renamed) {
          toast.error(renamed.error)
          return
        }
        lastSavedNameRef.current = trimmedName
        onNameSaved?.(trimmedName)
      }
      // Placement happens INSIDE the publish action, from the tags as they are at publish
      // time (not this panel's mount snapshot) and in the same server round trip — a stale
      // tab can no longer place under the wrong module, and a TA's publish places too.
      // Picker mode sends its explicit choice along.
      const res = await publishStudioAssignment(
        sectionId,
        assignmentId,
        {
          dueAt: dueIso,
          fileTypes,
          scheduleAt: sched ? new Date(sched).toISOString() : null,
          assessment,
          ...(ownsGradedFlag ? { isGraded } : {}),
          pickerModuleId: usePicker && moduleId ? moduleId : null,
        },
        !!opts.publish,
      )
      if ('error' in res) {
        toast.error(res.error)
        return
      }
      if (res.placed === false) {
        toast.warning('Published, but it could not be placed on the roadmap. You can place it from the roadmap.')
      }
      toast.success(sched ? 'Assignment scheduled' : 'Assignment published')
      // Leave the editor and return to the assignments list rather than staying in the build view.
      router.push(`/professor/courses/${sectionId}/assignments`)
    })
  }

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-start justify-between gap-3 border-b border-border px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Publish assignment</h2>
          <p className="text-sm text-muted-foreground">
            {hideFileTypes
              ? 'Set the deadline, then publish or schedule.'
              : 'Set the deadline and what students can submit, then publish or schedule.'}
          </p>
        </div>
        <span className="mt-1 shrink-0">
          <SaveStatus state={shownSaveState} />
        </span>
      </div>

      <div ref={bodyRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
        <div className="space-y-2">
          <Label htmlFor="pub-name">Assignment name <span className="text-destructive">*</span></Label>
          <Input
            id="pub-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Problem Set 3: Gradient Descent"
            required
            aria-required="true"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="pub-due">Submission deadline</Label>
          <Input id="pub-due" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </div>

        {/* Points and graded toggle — shown when the caller supplies defaults (file-upload + future callers). */}
        {(defaultPoints !== undefined || defaultIsGraded !== undefined) && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
              <div className="space-y-0.5">
                <span className="text-sm font-medium text-foreground">Ungraded</span>
                <span className="block text-xs text-muted-foreground">Excluded from the gradebook; no score or auto-zero.</span>
              </div>
              <Switch checked={!isGraded} onCheckedChange={(v) => setIsGraded(!v)} aria-label="Mark as ungraded" className="shrink-0" />
            </div>
            {isGraded && (
              <p className="text-xs text-muted-foreground">
                Total points come from the rubric (100 when there is no rubric). Set them on the Rubrics tab.
              </p>
            )}
          </div>
        )}

        {/* Roadmap placement — required whenever the section has modules. Default mode
            summarizes the modules tagged on the rubrics step (tagging happens THERE, not
            here); 'picker' mode keeps the legacy select for studios with no rubrics step. */}
        <div className="space-y-2">
          <Label htmlFor="pub-module">
            {usePicker ? 'Module this assignment belongs to' : 'Tagged modules'} <span className="text-destructive">*</span>
          </Label>
          {modules === null ? (
            <p className="text-xs text-muted-foreground">Loading modules…</p>
          ) : modules.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No modules in this section yet — it will appear under &ldquo;Course activities&rdquo; on the roadmap.
            </p>
          ) : usePicker ? (
            <Select value={moduleId} onValueChange={setModuleId}>
              <SelectTrigger id="pub-module" className="w-full">
                <SelectValue placeholder="Pick a module…" />
              </SelectTrigger>
              <SelectContent>
                {modules.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.weekNumber ? `Week ${m.weekNumber} · ` : ''}{m.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : taggedIds.length === 0 ? (
            <p className="text-xs text-destructive">
              No modules tagged yet. Go back to the Add files &amp; rubrics step to tag the modules this
              assignment draws on.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {taggedIds
                .map((id) => modules.find((m) => m.id === id)?.title)
                .filter(Boolean)
                .join(', ')}
              {/* No named module here: this panel's tags are a mount-time snapshot, and the
                  server places under the first tagged module AS OF publish, so naming one
                  from stale state could promise the wrong placement. */}
              . It will appear under the first tagged module on the roadmap.
            </p>
          )}
        </div>

        {!hideFileTypes && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">What students can submit</p>
            <div className="grid gap-2">
              {FILE_TYPE_KINDS.map((k) => {
                const checked = fileTypes.includes(k.kind)
                return (
                  <label
                    key={k.kind}
                    htmlFor={`pub-ft-${k.kind}`}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors ${
                      checked ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
                    }`}
                  >
                    <Checkbox id={`pub-ft-${k.kind}`} checked={checked} onCheckedChange={() => toggleKind(k.kind)} />
                    <span className="text-sm font-medium text-foreground">{k.label}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{k.extensions.map((e) => `.${e}`).join(', ')}</span>
                  </label>
                )
              })}
            </div>
          </div>
        )}

        {/* Assessment mode — timed + proctored. Verbal assessments record video and
            are already their own supervised flow, so this is offered only for file
            submissions. */}
        {!hideFileTypes && (
          <div className="space-y-3">
            <div
              className={`flex items-start justify-between gap-3 rounded-xl border p-3 transition-colors ${
                assessOn ? 'border-primary bg-primary/5' : 'border-border'
              }`}
            >
              <div className="space-y-1">
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <ShieldCheck className="h-4 w-4 text-primary" />
                  Run as an assessment
                </span>
                <span className="block text-xs text-muted-foreground">
                  Timed exam: students get a work window, then a short handout window to upload. The brief is hidden until they start and again while they upload. Add proctoring below.
                </span>
              </div>
              <Switch checked={assessOn} onCheckedChange={toggleAssessment} aria-label="Run as an assessment" className="mt-0.5 shrink-0" />
            </div>

            {assessOn && (
              <div className="space-y-4 rounded-xl border border-border p-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="pub-work">
                      Work time (minutes) <span className="font-normal text-muted-foreground">optional</span>
                    </Label>
                    <Input
                      id="pub-work"
                      type="number"
                      min={1}
                      max={480}
                      placeholder="No limit"
                      value={workMinutes}
                      onChange={(e) => setWorkMinutes(e.target.value)}
                      aria-invalid={!!workMinutesError}
                      aria-describedby="pub-work-hint"
                    />
                    <p
                      id="pub-work-hint"
                      className={`text-xs ${workMinutesError ? 'text-destructive' : 'text-muted-foreground'}`}
                    >
                      {workMinutesError ?? 'Leave blank for no time limit.'}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pub-upload">Upload time (minutes)</Label>
                    <Input
                      id="pub-upload"
                      type="number"
                      min={1}
                      max={60}
                      value={uploadMinutes}
                      onChange={(e) => setUploadMinutes(e.target.value)}
                      aria-invalid={!!uploadMinutesError}
                      aria-describedby={uploadMinutesError ? 'pub-upload-error' : undefined}
                    />
                    {uploadMinutesError && (
                      <p id="pub-upload-error" className="text-xs text-destructive">
                        {uploadMinutesError}
                      </p>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium text-foreground">Proctoring</p>
                  {[
                    { id: 'activity', label: 'Activity monitoring', hint: 'Keyboard, clipboard and tab switches', checked: proctActivity, set: setProctActivity },
                    { id: 'fullscreen', label: 'Fullscreen', hint: 'Open in fullscreen and flag exits', checked: proctFullscreen, set: setProctFullscreen },
                    { id: 'video', label: 'Webcam checks', hint: 'Flag extra faces or a phone in view', checked: proctVideo, set: setProctVideo },
                  ].map((o) => (
                    <label
                      key={o.id}
                      htmlFor={`pub-proct-${o.id}`}
                      className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors ${
                        o.checked ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
                      }`}
                    >
                      <Checkbox id={`pub-proct-${o.id}`} checked={o.checked} onCheckedChange={(v) => o.set(v === true)} />
                      <span className="text-sm font-medium text-foreground">{o.label}</span>
                      <span className="ml-auto text-xs text-muted-foreground">{o.hint}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {contentEmpty && (
        <div className="mx-6 mb-2 flex items-start gap-2 rounded-xl border border-warning/30 bg-warning-muted px-3 py-2.5 text-sm text-warning-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>This assignment has no content yet. Students would see an empty assignment.</span>
        </div>
      )}

      {/* Why Publish is disabled, stated next to the button. The field-level errors live inside the
          scrollable body above, so they can be scrolled out of view while the button row — a sibling
          of that scroll container — stays put; a greyed-out primary action with its reason off-screen
          is a dead end. Same treatment for the module requirement, which had the same problem. */}
      {(assessmentClocksInvalid || moduleMissing) && (
        <div className="mx-6 mb-2 flex items-start gap-2 rounded-xl border border-border bg-muted px-3 py-2.5 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {/* In tagged (non-picker) mode the module field on THIS step is read-only, so
                "choose the module" would name a control that is not on the screen: point
                at the step that owns it instead. */}
            {assessmentClocksInvalid
              ? 'Fix the assessment time limits above before publishing.'
              : usePicker
                ? 'Choose the module this assignment belongs to before publishing.'
                : 'Go back to the Add files and rubrics step and tag at least one module before publishing.'}
          </span>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
        {!scheduling ? (
          <>
            <Button type="button" variant="outline" onClick={() => setScheduling(true)} disabled={isPending}>
              <CalendarClock className="h-4 w-4" />
              Schedule for later
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (contentEmpty) { setEmptyConfirmPending({ publish: true }); return }
                submit({ publish: true })
              }}
              disabled={isPending || moduleLoading || moduleMissing || assessmentClocksInvalid}
            >
              <Send className="h-4 w-4" />
              Publish now
            </Button>
          </>
        ) : (
          <>
            <Input
              type="datetime-local"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
              className="h-9 w-auto"
              aria-label="Publish date and time"
            />
            <Button type="button" variant="ghost" onClick={() => { setScheduling(false); setScheduleAt('') }} disabled={isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (contentEmpty) { setEmptyConfirmPending({ schedule: scheduleAt }); return }
                submit({ schedule: scheduleAt })
              }}
              disabled={isPending || !scheduleAt || moduleLoading || moduleMissing || assessmentClocksInvalid}
            >
              <CalendarClock className="h-4 w-4" />
              Schedule
            </Button>
          </>
        )}
      </div>

      <AlertDialog open={emptyConfirmPending !== null} onOpenChange={(open) => { if (!open) setEmptyConfirmPending(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish an empty assignment?</AlertDialogTitle>
            <AlertDialogDescription>
              This assignment has no content. Students will be able to open and submit it, but the brief will be blank. You can add content and republish at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Go back</AlertDialogCancel>
            <AlertDialogAction
            variant="destructive"
              onClick={() => {
                if (emptyConfirmPending) submit(emptyConfirmPending)
                setEmptyConfirmPending(null)
              }}
            >
              Publish anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}
