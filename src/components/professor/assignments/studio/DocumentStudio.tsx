/**
 * DocumentStudio — the "Blank" (document) assignment editor.
 *
 * A Google-Docs / Notion-style page (a bordered sheet centered on a soft ground, `/` slash menu,
 * drag-handle reorder) wrapped in the SAME shell + guided flow as the notebook studio: the shared
 * StudioHeader with a Write · Add files & rubrics · Publish step flow, Save Assignment, and Next
 * Step. The editor stays mounted across steps (hidden on the files step) so edits are never lost.
 * The rubric lives in the shared "Add files & rubrics" step. Due/points/submission and the PDF
 * download live on the assignment detail page, not here.
 *
 * Content autosaves to `settings.document`. Deadline / file types persist via the Publish dialog.
 * Runs fullscreen.
 *
 * Type: Client Component
 */
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  EditorRoot,
  EditorContent,
  EditorCommand,
  EditorCommandItem,
  EditorCommandEmpty,
  EditorCommandList,
  EditorBubble,
  handleCommandNavigation,
  type JSONContent,
} from 'novel'
import type { Editor } from '@tiptap/core'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { TableGridPicker } from './shared/TableGridPicker'
import { documentExtensions } from './documentExtensions'
import { documentSlashCommand, groupedDocumentSlashItems, insertCategoryOf, CATEGORY_CHART, STUDIO_TOOL_EVENT, type StudioToolDetail } from './document-slash-command'
import { Command as CmdkCommand } from 'cmdk'
import { NodeSelector } from '@/components/professor/about/selectors/node-selector'
import { LinkSelector } from '@/components/professor/about/selectors/link-selector'
import { TextButtons } from '@/components/professor/about/selectors/text-buttons'
import { ColorSelector } from '@/components/professor/about/selectors/color-selector'
import { saveAssignmentDocument, renameAssignment, uploadCellImage, deleteAssignment } from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'
import { StudioStepNav, type SaveState } from './shared/StudioChrome'
import { StudioHeader } from './shared/StudioHeader'
import { SupportingFilesStep } from './shared/SupportingFilesStep'
import { SaveAssignmentDialog } from './shared/SaveAssignmentDialog'
import { ViewAsStudentToggle } from './shared/ViewAsStudentToggle'
import { useExitGuard } from './shared/useExitGuard'
import { StudioRightPalette } from './StudioRightPalette'
import {
  useAthenaSurface,
  useAthenaDock,
  type FillResult,
} from '@/components/professor/assignments/athena/AssignmentAthenaDock'
import { AthenaAskLine } from '@/components/professor/assignments/athena/AthenaAskLine'
import { serializeDocumentForAthena, applyDocumentOps } from './athena-document-adapter'
import type { AssignmentScreen, AssignmentFillTool } from '@/lib/ai/assignment-assistant/schemas'
import type { DocumentOp } from '@/lib/ai/assignment-assistant/templates/registry'
import { AnnotationLayer } from './AnnotationLayer'
import { DocumentReadOnly } from './DocumentReadOnly'
import { PublishPanel } from './PublishPanel'
import { CELL_IMAGE_MIME_TYPES, MAX_CELL_IMAGE_SIZE, type FileTypeKind, type AssignmentRubric, type AssignmentPdf, type AssessmentConfig, type AssignmentRubricSourceFile } from '@/lib/validations/assignment'

/* 400ms, down from 800. The unload flush cannot win the race against the next document request
   (browser-measured: 0 of 6 fast reloads showed the edit), so the exposure window IS the debounce.
   Halving it halves the window. Not lower: every keystroke burst would otherwise fire a Server
   Action, and the warning still covers the remainder. */
const AUTOSAVE_MS = 400
const editorExtensions = [...documentExtensions, documentSlashCommand]

// The document "page": a Google-Docs sheet — centered, comfortable margins, not too wide.
const PAGE = 'mx-auto w-full max-w-[960px] px-4 py-8'
const SHEET = 'rounded-2xl border border-border bg-card px-10 py-10 shadow-sm'
const EDITOR_CLASS =
  'studio-doc prose prose-neutral dark:prose-invert prose-headings:font-semibold font-default focus:outline-none max-w-full min-h-[55vh]'

// Slash-menu icon tiles are tinted by category (see CATEGORY_CHART) so the groups read at a glance.
const slashItemChart = (title: string): number => CATEGORY_CHART[insertCategoryOf(title)]

type Stage = 'build' | 'files' | 'publish'

interface Props {
  sectionId: string
  assignmentId: string
  title: string
  initialDoc: JSONContent
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

export function DocumentStudio({
  sectionId, assignmentId, title: initialTitle, initialDoc,
  initialDueAt, initialFileTypes, initialPoints = 0, initialRubric = null, initialRubricDraft = null,
  initialDescription = '', initialPdfs = [], initialRubricSources = [], initialStatus, initialAssessment, initialStage,
}: Props) {
  const router = useRouter()
  const isPublished = initialStatus === 'published'
  // Keep the Publish step even when already published — it's how the professor re-edits publish
  // settings (deadline, file types, assessment/proctoring config) after going live.
  const STAGES = ['Write', 'Add files & rubrics', isPublished ? 'Publish changes' : 'Publish'] as readonly string[]
  const STAGE_ORDER: Stage[] = ['build', 'files', 'publish']
  // Back, Save, Publish, and Discard all return to the assignments list (a detail URL would 404
  // after a discard deletes the assignment).
  const backUrl = `/professor/courses/${sectionId}/assignments`

  const [title, setTitle] = useState(initialTitle)
  /* The last title we know is PERSISTED. `initialTitle` is a mount-time prop and never moves,
     so using it to revert a failed rename would restore the ORIGINAL name over a newer one
     that had already saved — showing something the DB does not hold, which is the very
     mismatch the revert exists to prevent. It also made "rename back to the original" look
     like a no-op. Advanced on every confirmed rename instead. */
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

  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [editor, setEditor] = useState<Editor | null>(null)
  const editorRef = useRef<Editor | null>(null)
  const [openNode, setOpenNode] = useState(false)
  const [openColor, setOpenColor] = useState(false)
  const [openLink, setOpenLink] = useState(false)
  const [stage, setStage] = useState<Stage>(initialStage ?? 'build')
  const [exitGuardOpen, setExitGuardOpen] = useState(false)
  // Athena is the shared dock (mounted at the assignments layout). `athenaDockOpen`
  // drives the content push; `:` on an empty line and the header trigger open it.
  const { open: athenaDockOpen, setOpen: setAthenaDockOpen } = useAthenaDock()
  const [previewing, setPreviewing] = useState(false)
  // Slash-tool dialogs: the YouTube URL prompt and the table size picker (both need editor + state).
  const [videoOpen, setVideoOpen] = useState(false)
  const [videoUrl, setVideoUrl] = useState('')
  const [tableOpen, setTableOpen] = useState(false)
  // Current doc content (incl. unsaved edits) for save + the read-only student preview.
  const [docJson, setDocJson] = useState<JSONContent>(initialDoc)
  const [rubric, setRubric] = useState<AssignmentRubric | null>(initialRubric)
  // Working rubric draft, lifted here so it survives the files step unmounting between steps.
  const [rubricDraft, setRubricDraft] = useState<AssignmentRubric | null>(initialRubricDraft)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const docRef = useRef<JSONContent>(initialDoc)
  // Where the cursor was when the image picker opened — the native file dialog blurs the editor, so
  // we insert the uploaded image here instead of at the doc end (which drops it off-screen).
  const imageInsertPos = useRef<number | null>(null)

  const persist = useCallback(
    (doc: JSONContent) => {
      setSaveState('saving')
      // Deep-clone to plain JSON first: some TipTap node attrs (e.g. the YouTube node's object
      // attrs) are otherwise encoded by the Server Action as a temporary reference ("$T") that
      // doesn't round-trip, so those attrs arrive empty on the server and get dropped.
      const plain = JSON.parse(JSON.stringify(doc)) as JSONContent
      saveAssignmentDocument(sectionId, assignmentId, { version: 1, doc: plain })
        .then((res) => setSaveState('error' in res ? 'error' : 'saved'))
        .catch(() => setSaveState('error'))
    },
    [sectionId, assignmentId],
  )

  const onDocUpdate = useCallback(
    (doc: JSONContent) => {
      setDocJson(doc)
      docRef.current = doc
      if (saveTimer.current) clearTimeout(saveTimer.current)
      /* Nulled INSIDE the callback, not just where the timer is replaced. Without this the ref
         stays non-null forever after the first keystroke, so anything asking "is a save
         pending?" gets a permanent yes: browser QA measured a reload 1.7s after "All changes
         saved" still firing a duplicate save POST and a bogus unload warning. */
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null
        persist(doc)
      }, AUTOSAVE_MS)
    },
    [persist],
  )

  /* Unload handling for a save still inside the 800 ms debounce (#410 part 2).
     Browser QA measured this rather than letting me assume it, and corrected two things I had
     wrong, so the honest description is:

     THE FLUSH DOES NOT WIN THE RACE. A Server Action fired from `beforeunload` is not sequenced
     against the next document request, so the write commits AFTER the reload has already
     rendered: 0 of 6 fast-reload trials showed the edit, and each trial's document contained the
     PREVIOUS trial's text. It is not lost, it lands one reload late. That is still better than
     losing it, which is why the flush stays, but it is not a guarantee and must not be described
     as one.

     THE WARNING IS THE ACTUAL PROTECTION, and on drafts it was already there:
     `useExitGuard({ active: !isPublished })` calls preventDefault() unconditionally. So this
     handler only adds a warning on a PUBLISHED assignment, which is the case that previously had
     none at all. Worth keeping for exactly that reason, and worth not overstating.

     Registered once and reading refs inside the handler, rather than re-registering whenever
     dirtiness changes. `persist` is read through a ref for the same reason: the listener must
     always call the current one without the effect depending on it. */
  const persistRef = useRef(persist)
  const saveStateRef = useRef(saveState)
  useEffect(() => {
    persistRef.current = persist
    saveStateRef.current = saveState
  })
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      const pending = saveTimer.current !== null
      if (!pending && saveStateRef.current !== 'saving') return
      if (pending) {
        clearTimeout(saveTimer.current as ReturnType<typeof setTimeout>)
        saveTimer.current = null
        persistRef.current(docRef.current)
      }
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // ── Athena seam ───────────────────────────────────────────────
  // Register this document editor as Athena's active authoring surface (kind='document').
  // getScreen serializes the doc into heading-delimited sections; onFill applies apply_edits
  // ops to the live editor, then syncs React state + autosave via onDocUpdate (same path as a
  // manual edit). Undo restores the pre-edit doc snapshot.
  const titleRef = useRef(title)
  useEffect(() => {
    titleRef.current = title
  })
  const getScreen = useCallback(
    (): AssignmentScreen => ({ authoring: serializeDocumentForAthena(editorRef.current, titleRef.current) }),
    [],
  )
  const onFill = useCallback(
    (tool: AssignmentFillTool, payload: unknown): FillResult => {
      if (tool !== 'apply_edits') return { summary: 'Nothing to apply.', applied: false }
      const ed = editorRef.current
      if (!ed) return { summary: 'The editor is still loading — try again in a moment.', applied: false }
      const { ops } = (payload ?? {}) as { ops?: DocumentOp[] }
      if (!ops?.length) return { summary: 'No changes.', applied: false }
      const beforeDoc = ed.getJSON()
      const beforeTitle = titleRef.current
      const { summary, title: newTitle, changed, skipped } = applyDocumentOps(ed, ops)
      // A PARTIAL application is not a success. If any op named a content change but carried
      // none, report applied:false so the professor gets the amber "Not saved." chip and the
      // model is told to retry — instead of a confident "it's ready on your screen" over a
      // document that was never touched. (What Athena still DID apply stays applied; the
      // summary names both halves.)
      if (changed === 0 || skipped > 0) return { summary, applied: false }
      onDocUpdate(ed.getJSON())
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
          ed.commands.setContent(beforeDoc)
          onDocUpdate(ed.getJSON())
          if (renamed) {
            setTitle(beforeTitle)
            void queueRename(beforeTitle)
          }
        },
      }
    },
    [onDocUpdate, queueRename],
  )
  useAthenaSurface({
    active: true, surface: 'authoring', kind: 'document', assignmentId, getScreen, onFill,
    // Athena writes the rubric through a server action; keep our copy in step so the
    // rubric pane never shows stale/empty data the professor could overwrite.
    onRubricSaved: setRubric,
  })

  async function saveTitle() {
    const next = title.trim()
    if (!next || next === persistedTitleRef.current) return
    /* Was fire-and-forget: a rejected rename left the new title on screen as though it had
       saved, and only a reload revealed it had reverted. Surface it and put the STORED title
       back, so what is shown is what is stored. */
    const res = await queueRename(next)
    if ('error' in res) {
      toast.error(res.error)
      setTitle(persistedTitleRef.current)
      return
    }
    persistedTitleRef.current = next
  }

  function insertVideo() {
    const src = videoUrl.trim()
    if (!src || !editor) return
    /* The Tiptap YouTube extension REJECTS a non-YouTube URL and no-ops, returning false.
       The dialog used to close regardless, so pasting any other link produced no block, no
       placeholder and no message — the professor was left assuming the editor was broken
       (#410). The command's own return value is the signal; keep the dialog open with the
       URL still in it so they can correct it rather than retype it. */
    const inserted = editor.commands.setYoutubeVideo({ src, width: 640, height: 360 })
    if (!inserted) {
      toast.error('That doesn’t look like a YouTube link. Paste a youtube.com or youtu.be URL.')
      return
    }
    setVideoOpen(false)
    setVideoUrl('')
  }

  function insertTable(rows: number, cols: number) {
    editor?.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run()
    setTableOpen(false)
  }

  // Upload a picked file and drop it at the doc end (the editor may have blurred during the native
  // file dialog). Reads the editor via ref inside this async handler — never during render.
  const insertImageFromFile = useCallback(
    async (file: File) => {
      if (!CELL_IMAGE_MIME_TYPES.includes(file.type as (typeof CELL_IMAGE_MIME_TYPES)[number])) {
        toast.error('Upload a PNG, JPEG, GIF, or WebP image.')
        return
      }
      if (file.size > MAX_CELL_IMAGE_SIZE) {
        toast.error('That image is larger than 5 MB.')
        return
      }
      const fd = new FormData()
      fd.append('image', file)
      const tid = toast.loading('Uploading image…')
      const res = await uploadCellImage(sectionId, assignmentId, fd)
      if ('error' in res) {
        toast.error(res.error, { id: tid })
        return
      }
      const ed = editorRef.current
      if (!ed) { toast.dismiss(tid); return }
      // Insert at the saved cursor position (clamped), not the doc end, so the image appears where
      // the professor was working; scrollIntoView keeps it visible.
      const at = Math.min(imageInsertPos.current ?? ed.state.doc.content.size, ed.state.doc.content.size)
      ed.chain()
        .focus()
        .insertContentAt(at, [
          // Small and centered by default; the align/resize handles can adjust it.
          { type: 'image', attrs: { src: res.url, alt: file.name, width: 50, align: 'center' } },
          { type: 'paragraph' },
        ])
        .scrollIntoView()
        .run()
      imageInsertPos.current = null
      toast.success('Image added', { id: tid })
    },
    [sectionId, assignmentId],
  )

  // The slash tool items fire a window event (they can't hold component state); handle it here.
  useEffect(() => {
    const onTool = (e: Event) => {
      const { tool, pos } = (e as CustomEvent<StudioToolDetail>).detail
      if (tool === 'python') {
        router.push(`/professor/courses/${sectionId}/assignments/new/notebook`)
      } else if (tool === 'image') {
        // The command captured the insert position from its range (see imageInsertPos) — the native
        // dialog blurs the editor, so we can't re-read the selection reliably here.
        imageInsertPos.current = pos ?? null
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = CELL_IMAGE_MIME_TYPES.join(',')
        input.style.display = 'none'
        input.addEventListener('change', () => {
          const file = input.files?.[0]
          if (file) void insertImageFromFile(file)
          input.remove()
        })
        // Removed when the native dialog is dismissed without a pick (so it doesn't linger).
        input.addEventListener('cancel', () => input.remove())
        // Must be attached to the DOM: a detached file input can be garbage-collected while the
        // native dialog is open, so `change` never fires and the pick silently does nothing.
        document.body.appendChild(input)
        input.click()
      } else if (tool === 'video') {
        setVideoUrl('')
        setVideoOpen(true)
      } else if (tool === 'table') {
        setTableOpen(true)
      }
    }
    window.addEventListener(STUDIO_TOOL_EVENT, onTool)
    return () => window.removeEventListener(STUDIO_TOOL_EVENT, onTool)
  }, [router, sectionId, insertImageFromFile])

  // Escape exits the student preview (a learned modal-like expectation).
  useEffect(() => {
    if (!previewing) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreviewing(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewing])

  // ---- guided flow (mirrors the notebook studio) ----
  const stageIndex = STAGE_ORDER.indexOf(stage)
  function goToStage(target: Stage) {
    setPreviewing(false)
    setStage(target)
  }
  function nextStep() {
    if (stageIndex < STAGE_ORDER.length - 1) goToStage(STAGE_ORDER[stageIndex + 1])
  }
  function prevStep() {
    if (stageIndex > 0) goToStage(STAGE_ORDER[stageIndex - 1])
  }

  // Exit guard: prompt before leaving a draft (published assignments never nag).
  useExitGuard({
    active: !isPublished,
    onRequestExit: () => setExitGuardOpen(true),
  })

  async function handleSave(savedTitle: string) {
    const next = savedTitle.trim()
    if (!next) return
    setExitGuardOpen(false)
    setSaveState('saving')
    if (next !== title) {
      setTitle(next)
      const renamed = await queueRename(next)
      if ('error' in renamed) { setSaveState('error'); toast.error(renamed.error); return }
    }
    const plain = JSON.parse(JSON.stringify(docRef.current)) as JSONContent
    const res = await saveAssignmentDocument(sectionId, assignmentId, { version: 1, doc: plain })
    if ('error' in res) { setSaveState('error'); toast.error("Couldn't save your changes. Check your connection and try again."); return }
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

  const hasInitial = !!initialDoc.content?.length
  const onFilesStep = stage === 'files' && !previewing

  return (
    <div
      // pb-24 below md reserves the lane the floating AthenaAskLine sits in.
      className={`fixed inset-0 z-40 flex flex-col bg-background pb-24 transition-[padding] duration-200 md:pb-0 ${
        athenaDockOpen ? 'md:pr-[var(--athena-dock-w)]' : ''
      }`}
    >
      {/* Shared studio header — same shell + step flow as the notebook studio */}
      <StudioHeader
        backUrl={backUrl}
        backLabel="Back to assignments"
        title={title}
        initialTitle={initialTitle}
        onTitleChange={setTitle}
        onCommitTitle={saveTitle}
        saveState={saveState}
        untitledLabel="Untitled document"
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
        {/* Same gate as the notebook studio: the ask line belongs on BOTH authoring steps.
            It was build-only here, so Athena was unreachable on "Add files & rubrics" — the
            step Frontier navigates the professor to right after it saves a rubric. */}
        {(stage === 'build' || stage === 'files') && !previewing && (
          <AthenaAskLine />
        )}
      </StudioHeader>

      {/* No dock reservation here: the fixed overlay above already holds the lane open
          for the whole studio. Reserving in both nested the two paddings and squeezed the
          page to 112px at 1200px wide. */}
      <div className="relative flex min-h-0 flex-1">
        {/* Collapsible palette — docked on the LEFT (build step only) */}
        {stage === 'build' && !previewing && <StudioRightPalette editor={editor} doc={docJson} />}

        {/* Build step — the document page. Stays mounted (hidden on other steps) so edits persist. */}
        <div className={cn('min-w-0 flex-1 overflow-y-auto bg-muted/30', (onFilesStep || previewing || stage === 'publish') && 'hidden')}>
          <div className={PAGE}>
            <div
              className={cn(SHEET, 'cursor-text')}
              onClick={(e) => { if (e.target === e.currentTarget) editor?.commands.focus('end') }}
            >
              <EditorRoot>
                <EditorContent
                  {...(hasInitial ? { initialContent: initialDoc } : {})}
                  immediatelyRender={false}
                  extensions={editorExtensions}
                  onCreate={({ editor }) => {
                    setEditor(editor)
                    editorRef.current = editor
                    // Hand the section id to SolverNode so its blocks can run queries.
                    const st = editor.storage.wolfram as { sectionId: string } | undefined
                    if (st) st.sectionId = sectionId
                  }}
                  editorProps={{
                    handleDOMEvents: { keydown: (_view, event) => handleCommandNavigation(event) },
                    // ":" on an empty line launches Athena (mirrors "/" for the block menu); the ":"
                    // is swallowed so it doesn't land in the doc. Normal ":" mid-text is untouched.
                    handleTextInput: (view, _from, _to, text) => {
                      if (text !== ':') return false
                      const { $from, empty } = view.state.selection
                      if (empty && $from.parent.type.name === 'paragraph' && $from.parent.content.size === 0) {
                        setAthenaDockOpen(true)
                        return true
                      }
                      return false
                    },
                    attributes: { class: EDITOR_CLASS },
                  }}
                  onUpdate={({ editor }) => onDocUpdate(editor.getJSON())}
                >
                  <EditorCommand className="z-50 h-auto max-h-[330px] overflow-y-auto rounded-xl border border-border bg-background px-1 py-2 shadow-md">
                    <EditorCommandEmpty className="px-2 text-muted-foreground">No results</EditorCommandEmpty>
                    <EditorCommandList>
                      {groupedDocumentSlashItems().map((group) => (
                        <CmdkCommand.Group
                          key={group.category}
                          heading={group.category}
                          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground"
                        >
                          {group.items.map((item) => {
                            const chart = slashItemChart(item.title)
                            return (
                              <EditorCommandItem
                                value={item.title}
                                onCommand={(val) => item.command?.(val)}
                                className="flex w-full items-center space-x-2 rounded-xl px-2 py-1 text-left text-sm hover:bg-accent aria-selected:bg-accent"
                                key={item.title}
                              >
                                <div
                                  className="flex h-10 w-10 items-center justify-center rounded-lg"
                                  style={{ background: `color-mix(in oklch, var(--chart-${chart}) 12%, transparent)`, color: `var(--chart-${chart})` }}
                                >
                                  {item.icon}
                                </div>
                                <div>
                                  <p className="font-medium">{item.title}</p>
                                  <p className="text-xs text-muted-foreground">{item.description}</p>
                                </div>
                              </EditorCommandItem>
                            )
                          })}
                        </CmdkCommand.Group>
                      ))}
                    </EditorCommandList>
                  </EditorCommand>

                  <EditorBubble
                    tippyOptions={{ placement: 'top' }}
                    className="flex w-fit max-w-[90vw] overflow-hidden rounded-xl border border-border bg-background shadow-xl"
                  >
                    <Separator orientation="vertical" />
                    <NodeSelector open={openNode} onOpenChange={setOpenNode} />
                    <Separator orientation="vertical" />
                    <LinkSelector open={openLink} onOpenChange={setOpenLink} />
                    <Separator orientation="vertical" />
                    <TextButtons />
                    <Separator orientation="vertical" />
                    <ColorSelector open={openColor} onOpenChange={setOpenColor} />
                  </EditorBubble>
                </EditorContent>
              </EditorRoot>
            </div>
          </div>
        </div>

        {/* Add files & rubrics step (shared with the notebook studio) */}
        {onFilesStep && (
          <div className="min-w-0 flex-1 overflow-y-auto p-3">
            <SupportingFilesStep
              sectionId={sectionId}
              assignmentId={assignmentId}
              contentKind="document"
              initialDescription={initialDescription}
              initialPdfs={initialPdfs}
              initialRubricSources={initialRubricSources}
              initialRubric={rubric}
              initialRubricDraft={rubricDraft}
              onRubricDraftChange={setRubricDraft}
              initialPoints={initialPoints}
              onRubricSaved={setRubric}
            />
          </div>
        )}

        {/* Publish step — the publish page (name, deadline, module, submissions, assessment). */}
        {stage === 'publish' && (
          <div className="min-w-0 flex-1 overflow-y-auto p-3">
            <PublishPanel
              sectionId={sectionId}
              published={isPublished}
              assignmentId={assignmentId}
              defaultTitle={title}
              onNameSaved={setTitle}
              defaultDueAt={initialDueAt}
              defaultFileTypes={initialFileTypes}
              defaultAssessment={initialAssessment}
              contentEmpty={!docJson.content?.length}
            />
          </div>
        )}

        {/* Student preview overlay — read-only doc + a professor markup layer. */}
        {previewing && (
          <div className="absolute inset-0 z-20 overflow-y-auto bg-muted/30">
            <div className="relative min-h-full">
              <div className={PAGE}>
                <div className={SHEET}>
                  <h1 className="mb-4 text-3xl font-bold tracking-tight text-foreground">{title || 'Untitled'}</h1>
                  {docJson.content?.length ? (
                    <DocumentReadOnly content={docJson} />
                  ) : (
                    <p className="text-sm text-muted-foreground">Nothing to preview yet. Add content to the document.</p>
                  )}
                </div>
              </div>
              <AnnotationLayer />
            </div>
          </div>
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

      <Dialog open={videoOpen} onOpenChange={setVideoOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Embed a video</DialogTitle>
            <DialogDescription>Paste a YouTube link to embed it in the page.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="video-url">YouTube URL</Label>
            <Input
              id="video-url"
              value={videoUrl}
              autoFocus
              onChange={(e) => setVideoUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && videoUrl.trim()) insertVideo() }}
              placeholder="https://www.youtube.com/watch?v=..."
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVideoOpen(false)}>Cancel</Button>
            <Button onClick={insertVideo} disabled={!videoUrl.trim()}>Embed</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={tableOpen} onOpenChange={setTableOpen}>
        <DialogContent className="w-auto max-w-fit">
          <DialogHeader>
            <DialogTitle>Insert a table</DialogTitle>
            <DialogDescription>Hover to choose the number of rows and columns.</DialogDescription>
          </DialogHeader>
          <TableGridPicker onPick={insertTable} />
        </DialogContent>
      </Dialog>

    </div>
  )
}
