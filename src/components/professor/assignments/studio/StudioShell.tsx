/**
 * StudioShell: the notebook studio (Assignment Studio v2).
 *
 * Layout: a header bar (back, editable title, save status, Build/Add files/Publish steps,
 * View as student, AI Studio / Settings / overflow / Save) over a column shell — left cell palette,
 * center notebook canvas, an AI Assistant panel, and a right inspector.
 *
 * This shell owns the notebook state and is the ONLY place it mutates (via the pure
 * cell-ops). Edits autosave into assignments.settings.studio through the vetted server
 * action. We never execute anything; "Download .ipynb" serializes the model, "Open .ipynb"
 * parses a file back into it, the live proof of the lossless round-trip.
 *
 * Slice 1 builds the header + column shell. The left palette (slice 2), right inspector
 * (slice 3), and AI Assistant panel (slice 4) render as labeled placeholders for now;
 * the center canvas is fully working.
 */
'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  type StudioNotebook,
  type StudioCellType,

} from '@/lib/assignments/studio/notebook-model'
import {
  updateSource, insertRelative, insertCell, deleteCell, duplicateCell, moveCell,
  reorderCells, changeCellType, splitCell, mergeCellBelow, toggleCollapsed, toggleLocked,
  clearOutputs as clearCellOutputs, setCellAuthoring,
} from '@/lib/assignments/studio/cell-ops'
import { getAuthoring, type AuthoringMeta } from '@/lib/assignments/studio/authoring'
import { extractNotebookLinks } from '@/lib/assignments/studio/links'
import { saveStudioNotebook, renameAssignment, deleteAssignment } from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'
import { NotebookCanvas } from './NotebookCanvas'
import { isCopyOfPrevious } from './NotebookInspector'
import { NotebookPalette } from './NotebookPalette'
import { NotebookInspector, type ReferenceLink } from './NotebookInspector'
import { ResizableColumn } from './ResizableColumn'
import {
  useAthenaSurface,
  type FillResult,
} from '@/components/professor/assignments/athena/AssignmentAthenaDock'
import { AthenaAskLine } from '@/components/professor/assignments/athena/AthenaAskLine'
import { serializeNotebookForAthena, applyNotebookOps } from '@/lib/assignments/studio/athena-notebook-adapter'
import type { AssignmentScreen, AssignmentFillTool } from '@/lib/ai/assignment-assistant/schemas'
import type { NotebookOp } from '@/lib/ai/assignment-assistant/templates/registry'
import { StudioStepNav, type SaveState } from './shared/StudioChrome'
import { StudioHeader } from './shared/StudioHeader'
import { SupportingFilesStep } from './shared/SupportingFilesStep'
import { PublishPanel } from './PublishPanel'
import { SaveAssignmentDialog } from './shared/SaveAssignmentDialog'
import { ViewAsStudentToggle } from './shared/ViewAsStudentToggle'
import { useExitGuard } from './shared/useExitGuard'
import type { FileTypeKind, AssignmentRubric, AssignmentPdf, AssessmentConfig, AssignmentRubricSourceFile } from '@/lib/validations/assignment'
import type { StudioResources } from '@/lib/validations/studio'
import type { CellOps } from './studio-ops'

interface StudioDocProp {
  version: number
  templateId: string | null
  notebook: StudioNotebook
  // Loose: older stored docs predate generatedLinks; the shell defaults each field.
  resources?: Partial<StudioResources>
}

interface Props {
  sectionId: string
  assignmentId: string
  title: string
  initialDoc: StudioDocProp
  initialDueAt?: string | null
  initialFileTypes?: FileTypeKind[]
  initialPoints?: number
  initialRubric?: AssignmentRubric | null
  initialRubricDraft?: AssignmentRubric | null
  initialDescription?: string
  initialPdfs?: AssignmentPdf[]
  initialRubricSources?: AssignmentRubricSourceFile[]
  initialStatus?: string
  initialAssessment?: AssessmentConfig
  /** Step to open on: 'files' deep-links the "Add files & rubrics" step (e.g. returning from the Answer Key Studio). */
  initialStage?: 'build' | 'files'
}

/** The guided "Next Step" flow: build → supporting files → publish. Previewing as a student
 *  is a separate toggle (a "View as student" button), not a step in this flow. Editing an
 *  already-published assignment drops the Publish step (there's nothing left to publish). */
/** Mirrors NotebookInspector's outline preview so the toast names the block the same way. */
function snippet(source: string): string {
  const line = source.split('\n').find((l) => l.trim()) ?? ''
  return line.replace(/^#{1,6}\s*/, '').trim().slice(0, 60)
}
const TYPE_LABEL_FOR_TOAST: Record<string, string> = {
  code: 'Code block', markdown: 'Text block', raw: 'Raw block',
}

type Stage = 'build' | 'files' | 'publish'


export function StudioShell({
  sectionId, assignmentId, title: initialTitle, initialDoc, initialDueAt, initialFileTypes,
  initialPoints = 0, initialRubric = null, initialRubricDraft = null, initialDescription = '', initialPdfs = [],
  initialRubricSources = [], initialStatus, initialAssessment, initialStage,
}: Props) {
  const router = useRouter()
  const isPublished = initialStatus === 'published'
  const STAGES = ['Build', 'Add files & rubrics', isPublished ? 'Publish changes' : 'Publish'] as readonly string[]
  const STAGE_ORDER: Stage[] = ['build', 'files', 'publish']
  // Back, Save, Publish, and Discard all return to the assignments list. (Landing on a detail page
  // would 404 after a discard deletes the assignment.)
  const backUrl = `/professor/courses/${sectionId}/assignments`
  const backLabel = 'Back to assignments'
  const templateId = initialDoc.templateId
  const docVersion = initialDoc.version
  // The Solver tool appears in the side toolkit only for maths/physics templates.
  const solverEnabled = templateId === 'stem-maths' || templateId === 'stem-physics'

  const [notebook, setNotebook] = useState<StudioNotebook>(initialDoc.notebook)
  const [resources, setResources] = useState<StudioResources>({
    links: initialDoc.resources?.links ?? [],
    moduleTags: initialDoc.resources?.moduleTags ?? [],
    generatedLinks: initialDoc.resources?.generatedLinks ?? [],
  })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage>(initialStage ?? 'build')
  // "View as student" is a separate toggle, independent of the step flow: when on, the canvas
  // renders read-only exactly as a student sees it; when off, cells are editable.
  const [previewing, setPreviewing] = useState(false)
  const mode: 'edit' | 'preview' = previewing ? 'preview' : 'edit'
  const [inspectorWidth, setInspectorWidth] = useState(280)
  const [inspectorCollapsed, setInspectorCollapsed] = useState(true)
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [title, setTitle] = useState(initialTitle)
  /* The last title we know is PERSISTED — see DocumentStudio for the full reasoning:
     initialTitle is a mount-time prop, so reverting to it would restore the ORIGINAL name
     over a newer one that had already saved. */
  const persistedTitleRef = useRef(initialTitle)
  /* Renames are SERIALIZED through this chain. FOUR paths issue them — the header commit, the
     save dialog, Athena's apply_edits, and Athena's UNDO — and they were fire-and-forget against
     the same row. Athena renaming B→A and the user undoing before that request lands could
     resolve in either order, so the stale write could finish last: UI shows B, database holds A.
     Chaining makes the last-ISSUED rename the last-APPLIED one. */
  const renameChain = useRef<Promise<unknown>>(Promise.resolve())
  const queueRename = useCallback(
    (next: string) => {
      const run = renameChain.current.then(() => renameAssignment(sectionId, assignmentId, next))
      // Keep the chain alive even if one link rejects, or every later rename would be dropped.
      renameChain.current = run.catch(() => undefined)
      return run
    },
    [sectionId, assignmentId],
  )

  const [exitGuardOpen, setExitGuardOpen] = useState(false)
  // Live rubric state so the inspector's count/label stay current after an in-dialog save
  // (a client-side router.refresh() won't re-seed props on this always-mounted shell).
  const [rubric, setRubric] = useState<AssignmentRubric | null>(initialRubric)
  // Working rubric draft, lifted here so it survives the files step (and its editor) unmounting as
  // the professor moves between steps.
  const [rubricDraft, setRubricDraft] = useState<AssignmentRubric | null>(initialRubricDraft)
  const activeCellRef = useRef<{ id: string; el: HTMLTextAreaElement } | null>(null)
  const firstRender = useRef(true)
  // Autosave write ordering (see the effect below): every save is appended to this chain so two
  // can never be in flight against settings.studio at once, and saveSeqRef marks which one owns
  // the save indicator.
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const saveSeqRef = useRef(0)

  function buildDoc() {
    // Resources links are auto-derived from the notebook's cells; tags stay manual.
    return {
      version: docVersion,
      templateId,
      notebook,
      resources: { links: extractNotebookLinks(notebook), moduleTags: resources.moduleTags, generatedLinks: resources.generatedLinks },
    }
  }

  // Debounced autosave into settings.studio (skips the initial mount).
  //
  // Writes are serialized on saveChainRef and only the newest enqueued save owns the indicator —
  // the same fencing PublishPanel uses. Without it two overlapping saves both patch settings.studio
  // and the merge RPC can't order them, so a slow earlier save can land LAST and revert the
  // notebook to older content while the header reads "All changes saved". The catch matters too: a
  // network failure rejects the server action, and an unhandled rejection would both stick the
  // indicator on "Saving…" and poison the chain for every later save this session.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    setSaveState('saving')
    const t = setTimeout(() => {
      const mySeq = ++saveSeqRef.current
      saveChainRef.current = saveChainRef.current.then(async () => {
        try {
          const res = await saveStudioNotebook(sectionId, assignmentId, buildDoc())
          if (mySeq === saveSeqRef.current) setSaveState('error' in res ? 'error' : 'saved')
        } catch {
          if (mySeq === saveSeqRef.current) setSaveState('error')
        }
      })
    }, 800)
    return () => clearTimeout(t)
    // buildDoc closes over the latest notebook/resources; effect re-runs on change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebook, resources, sectionId, assignmentId, templateId, docVersion])

  const ops: CellOps = useMemo(
    () => ({
      setSource: (id, source) => setNotebook((nb) => updateSource(nb, id, source)),
      insert: (where, type, refId) => {
        const r = refId ? insertRelative(notebook, refId, where, type) : insertCell(notebook, notebook.cells.length, type)
        setNotebook(r.nb)
        setSelectedId(r.id)
      },
      remove: (id) => {
        // One-click delete (#542) needs a recovery path: toast-undo. Undo re-inserts ONLY the
        // deleted cell at its old index in the CURRENT notebook, so edits made while the toast
        // is up survive; the some() guard keeps a stale toast from inserting a duplicate.
        const idx = notebook.cells.findIndex((c) => c.id === id)
        const removed = notebook.cells[idx]
        setNotebook(deleteCell(notebook, id))
        setSelectedId((cur) => (cur === id ? null : cur))
        if (!removed) return
        /* Name WHAT was deleted, and flag it when it was a duplicate of the block above —
           after Duplicate the outline shows two identical rows, so "Cell deleted" left the
           professor unable to tell whether they had just destroyed the copy or the original.
           The 10s duration matters as much: this content is unrecoverable once the toast
           goes, and ~4s is not long enough to read, realise, and click Undo. */
        const label = snippet(removed.source) || TYPE_LABEL_FOR_TOAST[removed.cell_type]
        const wasCopy = isCopyOfPrevious(notebook.cells, idx)
        toast(`Deleted "${label}"${wasCopy ? ' (copy)' : ''}`, {
          duration: 10000,
          action: {
            label: 'Undo',
            onClick: () =>
              setNotebook((nb) => {
                if (nb.cells.some((c) => c.id === id)) return nb
                const at = Math.min(idx, nb.cells.length)
                return { ...nb, cells: [...nb.cells.slice(0, at), removed, ...nb.cells.slice(at)] }
              }),
          },
        })
      },
      duplicate: (id) => {
        const r = duplicateCell(notebook, id)
        setNotebook(r.nb)
        setSelectedId(r.id)
      },
      move: (id, dir) => setNotebook((nb) => moveCell(nb, id, dir)),
      reorder: (from, to) => setNotebook((nb) => reorderCells(nb, from, to)),
      changeType: (id, type) => setNotebook((nb) => changeCellType(nb, id, type)),
      split: (id, offset) => {
        const r = splitCell(notebook, id, offset)
        setNotebook(r.nb)
        setSelectedId(r.id)
      },
      mergeBelow: (id) => setNotebook((nb) => mergeCellBelow(nb, id)),
      toggleCollapse: (id) => setNotebook((nb) => toggleCollapsed(nb, id)),
      toggleLock: (id) => setNotebook((nb) => toggleLocked(nb, id)),
      clearOutputs: (id) => setNotebook((nb) => clearCellOutputs(nb, id)),
      setAuthoring: (id, meta) => setNotebook((nb) => setCellAuthoring(nb, id, meta)),
    }),
    [notebook],
  )

  function handleCellFocus(id: string, el: HTMLTextAreaElement) {
    activeCellRef.current = { id, el }
  }

  // Clearing the active cell on blur is what makes the "insert as a new cell" fallback fire once
  // you click away from every cell. The inspector's Insert buttons preventDefault on mousedown so
  // clicking them does NOT blur the textarea, keeping this ref intact for inline insertion.
  function handleCellBlur(id: string) {
    if (activeCellRef.current?.id === id) activeCellRef.current = null
  }

  const clearCollapseTimer = useCallback(() => {
    if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current)
  }, [])

  const startCollapseTimer = useCallback(() => {
    clearCollapseTimer()
    collapseTimerRef.current = setTimeout(() => setInspectorCollapsed(true), 10000)
  }, [clearCollapseTimer])

  const expandInspector = useCallback(() => {
    setInspectorCollapsed(false)
    clearCollapseTimer()
  }, [clearCollapseTimer])

  // Expand inspector whenever a cell is selected.
  useEffect(() => {
    if (selectedId) expandInspector()
  }, [selectedId, expandInspector])

  // Palette / quick-insert: create a real cell (below the selection, else appended), seed it
  // with the item's starter template, select it, and bring it into view.
  function insertFromPalette(item: { cellType: StudioCellType; template: string }) {
    const r = selectedId
      ? insertRelative(notebook, selectedId, 'below', item.cellType)
      : insertCell(notebook, notebook.cells.length, item.cellType)
    const nb = item.template ? updateSource(r.nb, r.id, item.template) : r.nb
    setNotebook(nb)
    setSelectedId(r.id)
    requestAnimationFrame(() => {
      document.getElementById(`studio-cell-${r.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }

  const selectedCell = selectedId ? notebook.cells.find((c) => c.id === selectedId) ?? null : null

  // Selecting a cell from the right-panel list scrolls the center canvas to it.
  function selectAndScroll(id: string) {
    setSelectedId(id)
    requestAnimationFrame(() => {
      document.getElementById(`studio-cell-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }

  // Selection clearing lives inside ops.remove so the toolbar delete path gets it too.
  function handleDeleteCell(id: string) {
    ops.remove(id)
  }

  function handleChangeAuthoring(meta: AuthoringMeta) {
    if (selectedId) ops.setAuthoring(selectedId, meta)
  }

  // Solver: append a generated solution to the selected cell's body (visible → student PDF)…
  function addSolutionToCell(markdown: string) {
    if (!selectedId) return
    setNotebook((nb) => {
      const cell = nb.cells.find((c) => c.id === selectedId)
      return cell ? updateSource(nb, selectedId, cell.source + markdown) : nb
    })
  }
  // …or keep it in that cell's answer key (professor-only, never shown to students).
  function addSolutionToAnswerKey(text: string) {
    if (!selectedId || !selectedCell) return
    const cur = getAuthoring(selectedCell.metadata)
    const answerKey = (cur.answerKey ? `${cur.answerKey}\n\n` : '') + text
    ops.setAuthoring(selectedId, { ...cur, answerKey })
  }

  // References reuse the studio resources' link list (persisted via autosave).
  function handleChangeReferences(refs: ReferenceLink[]) {
    setResources((r) => ({ ...r, generatedLinks: refs }))
  }

  // ── Athena seam ───────────────────────────────────────────────
  // Register this notebook editor as Athena's active authoring surface (kind='notebook').
  // getScreen snapshots the notebook each turn; onFill applies apply_edits ops via the
  // pure adapter and drops the result into state (autosave then persists, exactly as a
  // manual edit would). Refs keep the callbacks stable so we never re-register on keystroke.
  const notebookRef = useRef(notebook)
  const titleRef = useRef(title)
  useEffect(() => {
    notebookRef.current = notebook
    titleRef.current = title
  })

  const getScreen = useCallback(
    (): AssignmentScreen => ({ authoring: serializeNotebookForAthena(notebookRef.current, titleRef.current) }),
    [],
  )
  const onFill = useCallback(
    (tool: AssignmentFillTool, payload: unknown): FillResult => {
      if (tool !== 'apply_edits') return { summary: 'Nothing to apply.', applied: false }
      const { ops } = (payload ?? {}) as { ops?: NotebookOp[] }
      if (!ops?.length) return { summary: 'No changes.', applied: false }
      const before = notebookRef.current
      const beforeTitle = titleRef.current
      const { nb, title: newTitle, summary, changed } = applyNotebookOps(before, ops)
      if (changed === 0) return { summary, applied: false }
      setNotebook(nb)
      const renamed = newTitle !== null && newTitle !== beforeTitle
      if (renamed) {
        setTitle(newTitle as string)
        /* Athena's rename can be rejected (over 200 chars) just like a typed one. Discarding
           the result left the new title on screen unsaved — put the old one back and say so
           rather than letting the professor believe Athena's edit persisted. */
        void queueRename(newTitle as string).then((res) => {
          if ('error' in res) {
            toast.error(res.error)
            setTitle(beforeTitle)
            return
          }
          // Athena's rename persisted too — keep the confirmed-title marker in step, or a
          // later manual rename would revert to a stale name.
          persistedTitleRef.current = newTitle as string
        })
      }
      return {
        summary,
        undo: () => {
          setNotebook(before)
          if (renamed) {
            setTitle(beforeTitle)
            void queueRename(beforeTitle)
          }
        },
      }
    },
    [queueRename],
  )
  useAthenaSurface({
    active: true, surface: 'authoring', kind: 'notebook', assignmentId, getScreen, onFill,
    // Athena writes the rubric through a server action; keep our copy in step so the
    // rubric pane never shows stale/empty data the professor could overwrite.
    onRubricSaved: setRubric,
  })

  // Exit guard: prompt before leaving a draft (published assignments never nag).
  useExitGuard({
    active: !isPublished,
    onRequestExit: () => setExitGuardOpen(true),
  })

  // Save confirmed from the dialog: persist the title (if changed) then the notebook, then navigate.
  async function handleSave(savedTitle: string) {
    const next = savedTitle.trim()
    if (!next) return
    setExitGuardOpen(false)
    setSaveState('saving')
    if (next !== title) {
      setTitle(next)
      const renamed = await queueRename(next)
      if ('error' in renamed) {
        setSaveState('error')
        toast.error(renamed.error)
        return
      }
    }
    const res = await saveStudioNotebook(sectionId, assignmentId, buildDoc())
    if ('error' in res) {
      setSaveState('error')
      toast.error("Couldn't save your changes. Check your connection and try again.")
      return
    }
    setSaveState('saved')
    toast.success('Assignment saved')
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

  async function commitRename() {
    const next = title.trim()
    if (!next || next === persistedTitleRef.current) return
    const res = await queueRename(next)
    if ('error' in res) {
      toast.error(res.error)
      setTitle(persistedTitleRef.current) // show what is actually stored, not the mount-time name
      return
    }
    persistedTitleRef.current = next
  }

  const stageIndex = STAGE_ORDER.indexOf(stage)

  function goToStage(target: Stage) {
    setPreviewing(false) // leaving preview whenever the professor moves through the flow
    setStage(target)
  }

  // "Next Step" walks build → add files → publish (the last step, which renders the publish page).
  function nextStep() {
    if (stageIndex < STAGE_ORDER.length - 1) goToStage(STAGE_ORDER[stageIndex + 1])
  }

  // "Previous step" walks back through the flow.
  function prevStep() {
    if (stageIndex > 0) goToStage(STAGE_ORDER[stageIndex - 1])
  }

  return (
    // Fullscreen overlay: the studio covers the app chrome for an immersive editor.
    <div
      // pb-24 below md reserves the lane the floating AthenaAskLine sits in, so the
      // canvas never scrolls its controls underneath it. The Athena dock overlays the studio
      // (fixed, z-[55], its own shadow) instead of pushing it — squeezing the three-column
      // editor made it unreadable (#541).
      className="fixed inset-0 z-40 flex h-dvh flex-col bg-background pb-24 md:pb-0"
    >
      <StudioHeader
        backUrl={backUrl}
        backLabel={backLabel}
        title={title}
        initialTitle={initialTitle}
        onTitleChange={setTitle}
        onCommitTitle={commitRename}
        saveState={saveState}
        untitledLabel="Untitled assignment"
        onRequestExit={!isPublished ? () => setExitGuardOpen(true) : undefined}
        center={
          <StudioStepNav
            steps={STAGES}
            active={stageIndex}
            onPrev={prevStep}
            onNext={nextStep}
            hideNext={stage === 'publish'}
          />
        }
      >
        {stage !== 'publish' && (
          <ViewAsStudentToggle previewing={previewing} onToggle={() => setPreviewing((p) => !p)} />
        )}
        {(stage === 'build' || stage === 'files') && !previewing && (
          <AthenaAskLine />
        )}
      </StudioHeader>

      {/* ── Column shell ─────────────────────────────────────────────── */}
      {/* "View as student" preview takes precedence: it renders the read-only canvas even
          when the flow is on the Add-files step. */}
      <div className="flex min-h-0 flex-1 gap-3 p-3">
        {stage === 'publish' ? (
          <PublishPanel
            sectionId={sectionId}
            published={isPublished}
            assignmentId={assignmentId}
            defaultTitle={title}
            onNameSaved={setTitle}
            defaultDueAt={initialDueAt}
            defaultFileTypes={initialFileTypes}
            defaultAssessment={initialAssessment}
            contentEmpty={notebook.cells.length === 0}
          />
        ) : !previewing && stage === 'files' ? (
          <>
            <SupportingFilesStep
              sectionId={sectionId}
              assignmentId={assignmentId}
              contentKind="notebook"
              initialDescription={initialDescription}
              initialPdfs={initialPdfs}
              initialRubricSources={initialRubricSources}
              initialRubric={rubric}
              initialRubricDraft={rubricDraft}
              onRubricDraftChange={setRubricDraft}
              initialPoints={initialPoints}
              onRubricSaved={setRubric}
            />
          </>
        ) : (
          <>
        {/* Left: cell palette */}
        {mode === 'edit' && <NotebookPalette sectionId={sectionId} assignmentId={assignmentId} onInsert={insertFromPalette} />}

        {/* Center: notebook canvas */}
        {/* Faint warm cream on the canvas (#540) so the white cell cards read against it — a
            deliberate, Kevin/Aditya-approved use of warning-muted as surface chrome, at half
            alpha so it never reads as a caution state. */}
        <main className="min-w-0 flex-1 overflow-y-auto rounded-2xl border border-border bg-warning-muted/50 p-4">
          <NotebookCanvas
            notebook={notebook}
            selectedId={selectedId}
            mode={mode}
            ops={ops}
            onSelect={setSelectedId}
            onCellFocus={handleCellFocus}
            onCellBlur={handleCellBlur}
          />
        </main>

        {/* Right panel — cell list + inline settings, collapses to a slim rail after 10s idle */}
        {mode === 'edit' && (
          <div
            className="hidden shrink-0 motion-safe:transition-[width] motion-safe:duration-200 lg:block"
            style={{ width: inspectorCollapsed ? 48 : inspectorWidth }}
            onMouseEnter={expandInspector}
            onMouseLeave={startCollapseTimer}
            onFocus={expandInspector}
          >
            {!inspectorCollapsed && (
              // Drag handle — only visible when expanded
              <ResizableColumn width={inspectorWidth} onResize={setInspectorWidth} min={240} max={480}>
                <NotebookInspector
                  sectionId={sectionId}
                  notebook={notebook}
                  selectedId={selectedId}
                  solverEnabled={solverEnabled}
                  onSelect={selectAndScroll}
                  onChangeAuthoring={handleChangeAuthoring}
                  onDeleteCell={handleDeleteCell}
                  references={resources.generatedLinks}
                  onChangeReferences={handleChangeReferences}
                  onAddSolutionToCell={addSolutionToCell}
                  onAddSolutionToAnswerKey={addSolutionToAnswerKey}
                />
              </ResizableColumn>
            )}
            {inspectorCollapsed && (
              <NotebookInspector
                collapsed
                onExpand={expandInspector}
                sectionId={sectionId}
                notebook={notebook}
                selectedId={selectedId}
                solverEnabled={solverEnabled}
                onSelect={selectAndScroll}
                onChangeAuthoring={handleChangeAuthoring}
                onDeleteCell={handleDeleteCell}
                references={resources.generatedLinks}
                onChangeReferences={handleChangeReferences}
                onAddSolutionToCell={addSolutionToCell}
                onAddSolutionToAnswerKey={addSolutionToAnswerKey}
              />
            )}
          </div>
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
