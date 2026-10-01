/**
 * Verbal Assessment studio: the cell-document authoring surface, sharing the notebook
 * studio's shell exactly — a step-indicator header (Build / Preview / Publish), a left
 * cell-type palette, the reorderable interview in the center, and a resizable right column
 * holding the Athena seam + Settings (topic / voice / follow-up depth / time + insert helpers).
 * Authoring only: no grading, no question-deciding (Athena's seam), no execution.
 *
 * Type: Client Component
 */
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Mic, SlidersHorizontal, Hand,
  Sigma, FunctionSquare, FlaskConical, Code2, Image as ImageIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select'
import { CollapsibleCard } from '@/components/professor/assignments/studio/shared/CollapsibleCard'
import { SymbolMenu } from '@/components/professor/assignments/studio/shared/SymbolMenu'
import { CellImageUploadButton } from '@/components/professor/assignments/studio/shared/CellImageUploadButton'
import { StudioMarkdown } from '@/components/professor/assignments/studio/shared/StudioMarkdown'
import { StudioStepNav, type SaveState } from '@/components/professor/assignments/studio/shared/StudioChrome'
import { StudioHeader } from '@/components/professor/assignments/studio/shared/StudioHeader'
import { SaveAssignmentDialog } from '@/components/professor/assignments/studio/shared/SaveAssignmentDialog'
import { useExitGuard } from '@/components/professor/assignments/studio/shared/useExitGuard'
import { ResizableColumn } from '@/components/professor/assignments/studio/ResizableColumn'
import { PublishPanel } from '@/components/professor/assignments/studio/PublishPanel'
import { insertAt, wrapAt, linePrefixAt, type EditResult } from '@/lib/assignments/studio/insert-ops'
import { LIBRARY_VOICES } from '@/lib/ai/elevenlabs/voices'
import { newVerbalCell, type VerbalAssessmentConfig, type VerbalCell, type VerbalCellType } from '@/lib/assignments/verbal/config'
import { saveVerbalAssessment, generateVerbalQuestionAudio, renameAssignment, deleteAssignment } from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'
import { VerbalCellView, type VerbalCellOps } from './VerbalCellView'
import { VerbalPalette } from './VerbalPalette'
import {
  useAthenaSurface,
  useAthenaDock,
  type FillResult,
} from '@/components/professor/assignments/athena/AssignmentAthenaDock'
import { AthenaAskLine } from '@/components/professor/assignments/athena/AthenaAskLine'
import { serializeVerbalForAthena, applyVerbalOps } from '@/lib/assignments/verbal/athena-verbal-adapter'
import type { AssignmentScreen, AssignmentFillTool } from '@/lib/ai/assignment-assistant/schemas'
import type { VerbalOp } from '@/lib/ai/assignment-assistant/templates/registry'

interface Props {
  sectionId: string
  assignmentId: string
  title: string
  initialConfig: VerbalAssessmentConfig
  initialAudioUrls: Record<string, string | null>
  initialDueAt?: string | null
  initialStatus?: string
}

const CELL_LABEL: Record<VerbalCellType, string> = {
  greeting: 'Greeting',
  question: 'Question',
  mcq: 'MCQ',
  ai_followup: 'AI follow-up',
}

export function VerbalStudio({ sectionId, assignmentId, title: initialTitle, initialConfig, initialAudioUrls, initialDueAt, initialStatus }: Props) {
  const router = useRouter()
  const isPublished = initialStatus === 'published'
  const backUrl = `/professor/courses/${sectionId}/assignments`
  const [config, setConfig] = useState<VerbalAssessmentConfig>(initialConfig)
  const [audioUrls, setAudioUrls] = useState<Record<string, string | null>>(initialAudioUrls)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [generatingId, setGeneratingId] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [exitGuardOpen, setExitGuardOpen] = useState(false)
  // Athena is the shared dock (mounted at the assignments layout); the header trigger
  // opens it. `athenaDockOpen` drives the content push so the panel doesn't overlap.
  const { open: athenaDockOpen, setOpen: setAthenaDockOpen } = useAthenaDock()
  const [settingsOpen, setSettingsOpen] = useState(true)
  const [rightWidth, setRightWidth] = useState(300)
  const [title, setTitle] = useState(initialTitle)
  const firstRender = useRef(true)
  const activeCellRef = useRef<{ id: string; el: HTMLTextAreaElement } | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  // Debounced autosave (skips the initial mount).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    const t = setTimeout(async () => {
      setSaveState('saving')
      const res = await saveVerbalAssessment(sectionId, assignmentId, config)
      setSaveState('error' in res ? 'error' : 'saved')
    }, 800)
    return () => clearTimeout(t)
  }, [config, sectionId, assignmentId])

  const update = (patch: Partial<VerbalAssessmentConfig>) => setConfig((c) => ({ ...c, ...patch }))

  function addCell(type: VerbalCellType) {
    const cell = newVerbalCell(type)
    setConfig((c) => ({ ...c, cells: [...c.cells, cell] }))
    setSelectedId(cell.id)
  }

  const ops: VerbalCellOps = {
    update: (id, patch) => setConfig((c) => ({ ...c, cells: c.cells.map((x) => (x.id === id ? { ...x, ...patch } : x)) })),
    remove: (id) => setConfig((c) => ({ ...c, cells: c.cells.filter((x) => x.id !== id) })),
    move: (id, dir) =>
      setConfig((c) => {
        const i = c.cells.findIndex((x) => x.id === id)
        const j = i + dir
        if (i === -1 || j < 0 || j >= c.cells.length) return c
        const cells = [...c.cells]
        ;[cells[i], cells[j]] = [cells[j], cells[i]]
        return { ...c, cells }
      }),
    duplicate: (id) =>
      setConfig((c) => {
        const i = c.cells.findIndex((x) => x.id === id)
        if (i === -1) return c
        const copy: VerbalCell = { ...c.cells[i], id: Math.random().toString(36).slice(2, 12), audioPath: undefined }
        const cells = [...c.cells.slice(0, i + 1), copy, ...c.cells.slice(i + 1)]
        return { ...c, cells }
      }),
    generateAudio: async (id) => {
      setGeneratingId(id)
      await saveVerbalAssessment(sectionId, assignmentId, config)
      const res = await generateVerbalQuestionAudio(sectionId, assignmentId, id)
      setGeneratingId(null)
      if ('error' in res) {
        toast.error(res.error)
        return
      }
      setAudioUrls((prev) => ({ ...prev, [id]: res.audioUrl }))
      setConfig((c) => ({ ...c, cells: c.cells.map((x) => (x.id === id ? { ...x, audioPath: res.audioPath } : x)) }))
      toast.success('Question audio generated')
    },
    aiGenerate: () => setAthenaDockOpen(true),
  }

  // ── Athena seam ───────────────────────────────────────────────
  // Register this verbal editor as Athena's active authoring surface (kind='verbal').
  // getScreen snapshots the cells each turn; onFill applies apply_edits ops via the pure
  // adapter and drops the new config into state (autosave then persists). Refs keep the
  // callbacks stable so we never re-register on keystroke.
  const configRef = useRef(config)
  useEffect(() => {
    configRef.current = config
  })
  const getScreen = useCallback(
    (): AssignmentScreen => ({ authoring: serializeVerbalForAthena(configRef.current) }),
    [],
  )
  const onFill = useCallback((tool: AssignmentFillTool, payload: unknown): FillResult => {
    if (tool !== 'apply_edits') return { summary: 'Nothing to apply.', applied: false }
    const { ops: edits } = (payload ?? {}) as { ops?: VerbalOp[] }
    if (!edits?.length) return { summary: 'No changes.', applied: false }
    const before = configRef.current
    const { config: next, summary, changed } = applyVerbalOps(before, edits)
    if (changed === 0) return { summary, applied: false }
    setConfig(next)
    return { summary, undo: () => setConfig(before) }
  }, [])
  useAthenaSurface({ active: true, surface: 'authoring', kind: 'verbal', assignmentId, getScreen, onFill })

  // Insert engine: math/chemistry/code snippets go into the focused cell's prompt.
  function handleCellFocus(id: string, el: HTMLTextAreaElement) {
    activeCellRef.current = { id, el }
  }
  function applyEdit(fn: (value: string, start: number, end: number) => EditResult) {
    const a = activeCellRef.current
    if (!a) {
      toast('Click into a question to insert.')
      return
    }
    const el = a.el
    const r = fn(el.value, el.selectionStart, el.selectionEnd)
    ops.update(a.id, { prompt: r.value })
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(r.selStart, r.selEnd)
    })
  }
  const editor = {
    // Pad with a space when a math snippet would touch an adjacent `$` (keeps $a$ $b$ valid).
    insert: (text: string) => applyEdit((v, s, e) => {
      let t = text
      if (t.startsWith('$') && v[s - 1] === '$') t = ' ' + t
      if (t.endsWith('$') && v[e] === '$') t = t + ' '
      return insertAt(v, s, e, t)
    }),
    wrap: (pre: string, suf: string, ph?: string) => applyEdit((v, s, e) => {
      const p = pre.startsWith('$') && v[s - 1] === '$' ? ' ' + pre : pre
      const sfx = suf.endsWith('$') && v[e] === '$' ? suf + ' ' : suf
      return wrapAt(v, s, e, p, sfx, ph)
    }),
    linePrefix: (prefix: string) => applyEdit((v, s) => linePrefixAt(v, s, prefix)),
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    setConfig((c) => {
      const from = c.cells.findIndex((x) => x.id === active.id)
      const to = c.cells.findIndex((x) => x.id === over.id)
      if (from === -1 || to === -1) return c
      const cells = [...c.cells]
      const [moved] = cells.splice(from, 1)
      cells.splice(to, 0, moved)
      return { ...c, cells }
    })
  }

  // Exit guard: prompt before leaving a draft.
  useExitGuard({
    active: !isPublished,
    onRequestExit: () => setExitGuardOpen(true),
  })

  // Save from the exit-guard dialog: persist title (if changed) + config, then navigate.
  async function handleSave(savedTitle: string) {
    const next = savedTitle.trim()
    if (!next) return
    setExitGuardOpen(false)
    setSaveState('saving')
    if (next !== title) {
      setTitle(next)
      const renamed = await renameAssignment(sectionId, assignmentId, next)
      if ('error' in renamed) { setSaveState('error'); toast.error(renamed.error); return }
    }
    const res = await saveVerbalAssessment(sectionId, assignmentId, config)
    if ('error' in res) {
      setSaveState('error')
      toast.error("Couldn't save your changes. Check your connection and try again.")
      return
    }
    setSaveState('saved')
    toast.success('Assessment saved')
    router.push(backUrl)
  }

  // Discard: permanently delete the draft, then navigate away.
  async function handleDiscard() {
    setExitGuardOpen(false)
    // Check the result before navigating: a failed delete used to land the professor back on the
    // list with the draft still there and no explanation, reading as a silent success.
    const res = await deleteAssignment(sectionId, assignmentId)
    if ('error' in res) {
      toast.error(res.error)
      return
    }
    toast.success('Draft deleted.')
    router.push(backUrl)
  }

  function commitRename() {
    const next = title.trim()
    if (!next || next === initialTitle) return
    void renameAssignment(sectionId, assignmentId, next)
  }

  const showRight = mode === 'edit' && settingsOpen

  // Guided flow: Build (edit) → Preview → Publish. Steps advance only via Previous/Next.
  const stepIndex = publishing ? 2 : mode === 'edit' ? 0 : 1
  function nextStep() {
    if (publishing) return
    if (mode === 'edit') setMode('preview')
    else setPublishing(true)
  }
  function prevStep() {
    if (publishing) { setPublishing(false); return }
    if (mode === 'preview') setMode('edit')
  }

  return (
    // Fullscreen overlay: immersive editor over the app chrome; hover the top edge to leave.
    <div
      // pb-24 below md reserves the lane the floating AthenaAskLine sits in.
      className={`fixed inset-0 z-40 flex h-dvh flex-col bg-background pb-24 transition-[padding] duration-200 md:pb-0 ${
        athenaDockOpen ? 'md:pr-[var(--athena-dock-w)]' : ''
      }`}
    >
      <StudioHeader
        backUrl={backUrl}
        backLabel="Back to assignments"
        title={title}
        initialTitle={initialTitle}
        onTitleChange={setTitle}
        onCommitTitle={commitRename}
        saveState={saveState}
        untitledLabel="Untitled assessment"
        onRequestExit={!isPublished ? () => setExitGuardOpen(true) : undefined}
        center={
          <StudioStepNav
            steps={['Build', 'Preview', 'Publish']}
            active={stepIndex}
            onPrev={prevStep}
            onNext={nextStep}
            hideNext={publishing}
          />
        }
      >
        {/* Athena's ask line — the entry to the shared dock. */}
        {mode === 'edit' && <AthenaAskLine />}
        {!publishing && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSettingsOpen((o) => !o)}
            aria-pressed={settingsOpen}
            aria-label="Toggle settings panel"
            className="hidden lg:inline-flex"
          >
            <SlidersHorizontal className="h-4 w-4" />
          </Button>
        )}
      </StudioHeader>

      {/* ── Column shell ─────────────────────────────────────────────── */}
      {/* The fixed overlay above already reserves the dock lane; doing it here too
          subtracted the dock width twice and collapsed the columns. */}
      <div className="flex min-h-0 flex-1 gap-3 p-3">
        {publishing ? (
          <PublishPanel
            sectionId={sectionId}
            published={isPublished}
            assignmentId={assignmentId}
            defaultTitle={title}
            onNameSaved={setTitle}
            defaultDueAt={initialDueAt}
            defaultFileTypes={[]}
            hideFileTypes
            // Verbal assessments have no rubrics step to tag modules on, so keep the
            // legacy single-module roadmap picker here.
            placement="picker"
            contentEmpty={config.cells.length === 0}
          />
        ) : (
          <>
        {/* Left: cell palette */}
        {mode === 'edit' && <VerbalPalette onAdd={addCell} />}

        {/* Center: interview canvas */}
        <main className="min-w-0 flex-1 overflow-y-auto rounded-2xl border border-border bg-background p-4">
          {config.cells.length === 0 ? (
            <div className="mx-auto mt-12 flex max-w-md flex-col items-center gap-3 rounded-2xl border border-dashed border-border p-10 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground"><Mic className="h-6 w-6" /></span>
              <p className="font-medium text-foreground">Build the interview</p>
              <p className="text-sm text-muted-foreground">Add a greeting, then your questions. The flow runs top to bottom.</p>
              <Button onClick={() => addCell('greeting')}><Hand className="h-4 w-4" /> Add a greeting</Button>
            </div>
          ) : mode === 'preview' ? (
            <VerbalPreview config={config} />
          ) : (
            <DndContext id="verbal-cells" sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={config.cells.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                <div className="mx-auto max-w-3xl space-y-3">
                  {config.cells.map((c, i) => (
                    <SortableCell key={c.id} id={c.id}>
                      {(handle) => (
                        <VerbalCellView
                          cell={c}
                          index={i}
                          total={config.cells.length}
                          maxFollowUpDepth={config.maxFollowUpDepth}
                          selected={c.id === selectedId}
                          generating={generatingId === c.id}
                          audioUrl={audioUrls[c.id]}
                          ops={ops}
                          onSelect={() => setSelectedId(c.id)}
                          onCellFocus={handleCellFocus}
                          dragHandle={handle}
                        />
                      )}
                    </SortableCell>
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </main>

        {/* Right: Athena seam + Settings (resizable) */}
        {showRight && (
          <ResizableColumn width={rightWidth} onResize={setRightWidth} min={260} max={460} className="hidden lg:block">
            <div className="flex h-full flex-col gap-3 overflow-y-auto">
              {settingsOpen && (
                <CollapsibleCard title="Settings" icon={SlidersHorizontal} collapsible={false}>
                  <div className="space-y-1.5">
                    <Label htmlFor="va-topic" className="text-xs">Topic</Label>
                    <Input id="va-topic" value={config.topic} onChange={(e) => update({ topic: e.target.value })} placeholder="e.g. Binary search trees" className="h-8" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="va-voice" className="text-xs">AI voice</Label>
                    <Select value={config.voiceId} onValueChange={(v) => update({ voiceId: v })}>
                      <SelectTrigger id="va-voice" className="h-8 w-full text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {LIBRARY_VOICES.map((v) => (
                          <SelectItem key={v.id} value={v.id}>{v.name} · {v.description}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="va-depth" className="text-xs">Follow-up depth</Label>
                      <Input id="va-depth" type="number" min={0} max={5} value={config.maxFollowUpDepth} onChange={(e) => update({ maxFollowUpDepth: Number(e.target.value) })} className="h-8" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="va-time" className="text-xs">Time limit (min)</Label>
                      <Input id="va-time" type="number" min={1} max={120} value={config.timeLimitMinutes} onChange={(e) => update({ timeLimitMinutes: Number(e.target.value) })} className="h-8" />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">Depth and time limit are settings only; Athena decides follow-ups later.</p>

                  <div className="space-y-2 border-t border-border pt-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Insert into question</p>
                    <div className="flex flex-wrap gap-1.5">
                      <InsertBtn icon={Sigma} label="Math" onClick={() => editor.wrap('$', '$', 'x')} />
                      <InsertBtn icon={FunctionSquare} label="Math block" onClick={() => editor.insert('\n$$\n\n$$\n')} />
                      <SymbolMenu onPick={(latex) => editor.insert('$' + latex + '$')} />
                      <InsertBtn icon={FlaskConical} label="Chemistry" onClick={() => editor.wrap('$\\ce{', '}$', 'H2O')} />
                      <InsertBtn icon={Code2} label="Code" onClick={() => editor.insert('\n```\n\n```\n')} />
                      <InsertBtn icon={ImageIcon} label="Image" onClick={() => editor.insert('![Describe the image](image-url)')} />
                      <CellImageUploadButton
                        sectionId={sectionId}
                        assignmentId={assignmentId}
                        variant="chip"
                        onInserted={(markdown) => editor.insert(markdown)}
                      />
                    </div>
                    <p className="text-[11px] leading-snug text-muted-foreground">Click into a question, then insert math, chemistry, code, an image URL, or upload your own.</p>
                  </div>
                </CollapsibleCard>
              )}
            </div>
          </ResizableColumn>
        )}
          </>
        )}
      </div>

      <SaveAssignmentDialog
        open={exitGuardOpen}
        onOpenChange={setExitGuardOpen}
        defaultTitle={title}
        onSave={handleSave}
        onDiscard={!isPublished ? handleDiscard : undefined}
        saving={saveState === 'saving'}
      />
    </div>
  )
}

function SortableCell({ id, children }: { id: string; children: (handle: React.HTMLAttributes<HTMLButtonElement>) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = { transform: CSS.Transform.toString(transform), transition }
  const handle = { ...attributes, ...listeners } as React.HTMLAttributes<HTMLButtonElement>
  return (
    <div ref={setNodeRef} style={style} className={isDragging ? 'opacity-60' : undefined}>
      {children(handle)}
    </div>
  )
}

/** Read-only Preview: how the authored interview reads, top to bottom. */
function VerbalPreview({ config }: { config: VerbalAssessmentConfig }) {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {config.cells.map((c, i) => (
        <div key={c.id} className="rounded-2xl border border-border bg-card p-4">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {i + 1}. {CELL_LABEL[c.type]}
          </p>
          {c.type === 'ai_followup' ? (
            <p className="text-sm text-muted-foreground">
              Athena asks an adaptive follow-up here, up to {config.maxFollowUpDepth} deep.
            </p>
          ) : c.prompt.trim() ? (
            <StudioMarkdown content={c.prompt} />
          ) : (
            <p className="text-sm text-muted-foreground">Empty.</p>
          )}
          {c.type === 'mcq' && (c.options ?? []).length > 0 && (
            <ul className="mt-2 space-y-1">
              {(c.options ?? []).map((o) => (
                <li key={o.id} className="flex items-center gap-2 text-sm text-foreground">
                  <span className={c.correctOptionId === o.id ? 'font-medium text-primary' : 'text-muted-foreground'}>•</span>
                  {o.text || <span className="text-muted-foreground">Empty option</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

function InsertBtn({ icon: Icon, label, onClick }: { icon: React.ComponentType<{ className?: string }>; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
    >
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      {label}
    </button>
  )
}
