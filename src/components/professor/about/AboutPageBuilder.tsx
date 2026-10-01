'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { type AboutContentV2 } from '@/lib/validations/course-about'
import { saveAboutContent } from '@/app/(dashboard)/professor/courses/[sectionId]/about/actions'
import { useAthenaSurface, type FillResult } from '@/components/professor/assignments/athena/AssignmentAthenaDock'
import { AthenaAskLine } from '@/components/professor/assignments/athena/AthenaAskLine'
import type { AssignmentFillTool, AssignmentScreen } from '@/lib/ai/assignment-assistant/schemas'
import type { AboutOp } from '@/lib/ai/assignment-assistant/templates/registry'
import { BlockEditorProvider, useBlockEditor, getStarterTemplate } from './block-editor'
import { serializeAboutForAthena, applyAboutOps, revertAboutOps } from './block-editor/athena-about-adapter'
import { BlockEditorHeader } from './BlockEditorHeader'
import { BlockCanvas } from './BlockCanvas'
import { BlockPreview } from './BlockPreview'

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export interface CourseInfo {
  code: string
  title: string
  department?: string
  credits?: number
  semester?: string
  instructor?: string
}

interface Props {
  sectionId: string
  initialContent: AboutContentV2
  courseInfo: CourseInfo
}

export function AboutPageBuilder({ sectionId, initialContent, courseInfo }: Props) {
  return (
    <BlockEditorProvider initialBlocks={initialContent.blocks} sectionId={sectionId}>
      <BuilderInner sectionId={sectionId} courseInfo={courseInfo} />
    </BlockEditorProvider>
  )
}

function BuilderInner({ sectionId, courseInfo }: { sectionId: string; courseInfo: CourseInfo }) {
  const {
    state, dispatch, isEditing, setIsEditing, expand,
    markChanged, dismissChanged, isUndoSafe, setActiveUndo, getActiveUndo,
  } = useBlockEditor()
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  /* Set when the professor clicks a section in preview: the canvas scrolls to it
     and puts the caret in its first field, so editing existing copy is one click. */
  const [focusBlockId, setFocusBlockId] = useState<string | null>(null)

  /* First-load auto-scaffold: if the prof has never edited the page, drop in
     a starter layout (Hero with course info + Description + Outcomes + Syllabus)
     so they land on something usable instead of an empty canvas. Triggers once
     per mount; later sessions read the persisted blocks and skip this. */
  const hasInitializedRef = useRef(false)
  useEffect(() => {
    if (hasInitializedRef.current) return
    hasInitializedRef.current = true
    if (state.blocks.length === 0) {
      dispatch({ type: 'APPLY_TEMPLATE', payload: { blocks: getStarterTemplate(courseInfo) } })
    }
  }, [state.blocks.length, dispatch, courseInfo])

  // Refs for latest state to avoid stale closures in async save
  const stateRef = useRef(state)
  stateRef.current = state

  // ── Athena registration ──────────────────────────────────────────────
  // The About page registers as the 'about' authoring kind: Athena's apply_edits
  // ops land here as reducer dispatches, so they ride the SAME autosave (and are
  // therefore live to students ~1.5s later, which the surface's prompt and copy
  // say honestly).
  //
  // EDIT MODE IS THE WRITE GATE: Athena is always reachable on this page — in
  // preview it discusses (review, drift, brainstorm) but fills are refused here
  // mechanically, and the screen/prompt tell the model to send the professor to
  // the "Edit page" button instead. Clicking Edit themselves is the professor's
  // deliberate arming step before an AI can touch a live page.
  const isEditingRef = useRef(isEditing)
  isEditingRef.current = isEditing
  const getScreen = useCallback(
    (): AssignmentScreen => ({
      authoring: serializeAboutForAthena(stateRef.current.blocks, isEditingRef.current),
    }),
    [],
  )
  const onFill = useCallback(
    (tool: AssignmentFillTool, payload: unknown): FillResult => {
      if (!isEditingRef.current) {
        return {
          summary: 'The page is in preview — click "Edit page" (top right) and ask again.',
          applied: false,
        }
      }
      if (tool !== 'apply_edits') {
        return { summary: 'That change isn’t supported on this page.', applied: false }
      }
      const ops = (payload as { ops?: AboutOp[] } | null)?.ops
      if (!Array.isArray(ops) || ops.length === 0) {
        return { summary: 'Nothing to change', applied: false }
      }
      const res = applyAboutOps(stateRef.current.blocks, ops)
      if (res.changed === 0) return { summary: res.summary, applied: false }
      dispatch({ type: 'APPLY_TEMPLATE', payload: { blocks: res.blocks } })
      markChanged(res.changedIds)

      /* Undo replays the fill's own footprint out of whatever is on the page NOW,
         rather than restoring the array as it stood before the fill — otherwise
         rewrite the description, fix a typo in week 3, hit Undo, and the typo fix
         goes too. A reorder undoes by re-sorting the CURRENT array to match the
         pre-fill order (see reorderToMatch) rather than replacing content, so it
         gets the same treatment — content and position revert independently,
         and neither replaces a block's content with a stale clone.

         isUndoSafe() is checked UNCONDITIONALLY, with no reorder exemption. It
         used to skip the check for a reordered fill on the theory that "a
         reorder doesn't touch content, nothing to protect" — true for THAT
         fill's own footprint, but the old whole-snapshot fallback replaced the
         ENTIRE page, which could silently discard a hand edit to any block on
         the page, not just ones this fill touched. Now that reorder-undo only
         moves positions, the exemption is not just unnecessary, it would be
         wrong to keep: a batch that reorders one block and edits another still
         needs the check for the edited one.

         The chat's Undo chip and the canvas's Undo button call this SAME
         closure, but they are two independent buttons that do not know about
         each other — clicking Keep on the canvas does not (and structurally
         cannot) reach into the chat panel's own local state to grey its button
         out. Without the getActiveUndo() check below, a professor who clicked
         Keep on the canvas and then, out of habit, clicked the now-stale Undo
         still showing in chat would silently revert content they had just
         chosen to keep — caught live while verifying this feature. Checking
         "am I still the live undo" here, not "is my button still visible" over
         there, closes it regardless of which button is stale.

         Both refusal paths `return false`, not just bail — the panel's
         handleUndo only marks a fill "Reverted" and tells Athena the change is
         gone when this returns something other than false. Discovered the hard
         way in the SAME live check as above: fixing the content-safety half
         above on its own left the chat chip lying — it said "Reverted", and
         posted "that change is no longer on the page" into Athena's own
         transcript, while the content sat right there unchanged. That is
         precisely the kind of stale-history drift this codebase's own QA notes
         call out elsewhere: a model told about a change that didn't happen is
         as dangerous as one never told about a change that did. */
      const undo = (): boolean => {
        if (getActiveUndo() !== undo) {
          toast.error('That change was already resolved.')
          return false
        }
        if (!isUndoSafe()) {
          toast.error("Can't undo — part of this was edited by hand since Athena made it.")
          return false
        }
        dispatch({
          type: 'APPLY_TEMPLATE',
          payload: { blocks: revertAboutOps(stateRef.current.blocks, res.undoPatch) },
        })
        dismissChanged()
        return true
      }
      setActiveUndo(undo)

      return {
        summary: res.summary,
        applied: true,
        undo,
        /* Keep: the chat's other action alongside Undo. Touches no content — the
           fill is already saved — it just clears the "review this" marker, same
           as clicking Keep on the canvas itself. Both call the identical
           dismissChanged(), which is what makes the stale-Undo check above see
           this turn as resolved from either direction. */
        keep: dismissChanged,
      }
    },
    [dispatch, markChanged, dismissChanged, isUndoSafe, setActiveUndo, getActiveUndo],
  )
  useAthenaSurface({ active: true, surface: 'authoring', kind: 'about', getScreen, onFill })

  const isSavingRef = useRef(false)
  const needsResaveRef = useRef(false)
  const isFirstRender = useRef(true)
  /* True from the first unsaved change until the save that covers it returns.
     Drives both the tab-close warning and the flush-on-unmount below. */
  const hasUnsavedRef = useRef(false)
  /* Bumped every time state.blocks changes (see the debounce effect below).
     performSave snapshots this at the moment IT started; if it's moved on by
     the time that save resolves, something newer arrived while this save was
     in flight, and clearing hasUnsavedRef would be a lie. Closes a real
     sequence: edit A → its 1.5s timer fires → save starts → edit B lands and
     schedules its OWN 1.5s timer → A's save resolves quickly and (without this
     check) clears hasUnsavedRef even though B hasn't saved yet → the
     professor navigates away before B's timer fires → B's timer is cancelled
     by the unmount, and the flush-on-unmount sees "nothing unsaved" and skips
     it. B is lost silently. needsResaveRef alone doesn't catch this: it only
     fires when the TIMER re-elapses while a save is still in flight, not when
     a newer edit is merely pending on its own not-yet-due timer. */
  const saveGenRef = useRef(0)

  const performSave = useCallback(async () => {
    if (isSavingRef.current) {
      needsResaveRef.current = true
      return
    }
    isSavingRef.current = true
    setSaveStatus('saving')
    const snap = stateRef.current
    const genAtStart = saveGenRef.current
    try {
      const content: AboutContentV2 = {
        version: 2,
        blocks: snap.blocks,
      }
      const result = await saveAboutContent(sectionId, content)
      if (result.error) {
        setSaveStatus('error')
        toast.error(result.error)
      } else {
        // Only clear the flag if nothing newer arrived while this save was in
        // flight — a failed save, a queued resave, or a later edit all leave
        // the page unsaved, and the exit warning must stay armed for those.
        if (!needsResaveRef.current && saveGenRef.current === genAtStart) {
          hasUnsavedRef.current = false
        }
        setSaveStatus('saved')
        setTimeout(() => setSaveStatus((s) => (s === 'saved' ? 'idle' : s)), 2000)
      }
    } catch {
      setSaveStatus('error')
      toast.error('Failed to save')
    } finally {
      isSavingRef.current = false
      if (needsResaveRef.current) {
        needsResaveRef.current = false
        performSave()
      }
    }
  }, [sectionId])

  // Debounced autosave: trigger 1.5s after any block change
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
    hasUnsavedRef.current = true
    saveGenRef.current += 1
    const timer = setTimeout(performSave, 1500)
    return () => clearTimeout(timer)
  }, [state.blocks, performSave])

  /* The 1.5s debounce is a window where the professor's last keystrokes exist
     only in this component. Two different exits, two different answers:
     - Leaving the page inside the app (a sidebar link) unmounts us and cancels
       the pending timer. Nothing to ask about on a page that has no publish
       step, so we just fire the save on the way out. The request is a plain
       fetch and completes after the component is gone.
     - Closing or reloading the tab kills the request too, so that one has to be
       a browser warning. */
  const performSaveRef = useRef(performSave)
  performSaveRef.current = performSave
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!hasUnsavedRef.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => {
      window.removeEventListener('beforeunload', warn)
      if (hasUnsavedRef.current) void performSaveRef.current()
    }
  }, [])

  /* Clicking a section in preview goes straight into editing that section. */
  const handleEditBlock = useCallback((blockId: string) => {
    expand(blockId)
    setIsEditing(true)
    setFocusBlockId(blockId)
  }, [expand, setIsEditing])

  return (
    // pb-16: the always-mounted AthenaAskLine is a fixed bottom-center pill, and this
    // page's last control (the centered "Add section") is centered too — the breather
    // keeps the button clear of the pill when it hover-expands upward. Local to this
    // host; the shared dock provider deliberately reserves no desktop lane.
    <div className="space-y-6 pb-16">
      <BlockEditorHeader courseInfo={courseInfo} saveStatus={saveStatus} />

      {isEditing ? (
        <BlockCanvas
          courseInfo={courseInfo}
          focusBlockId={focusBlockId}
          onFocusHandled={() => setFocusBlockId(null)}
        />
      ) : (
        <BlockPreview blocks={state.blocks} onEditBlock={handleEditBlock} />
      )}

      {/* Athena's trigger — ALWAYS present for the professor (this route is
          professor-only; students never see it). In preview Athena discusses but
          cannot edit: the fill gate above refuses, and Athena tells the professor
          to click "Edit page" themselves — the deliberate arming step. */}
      <AthenaAskLine />
    </div>
  )
}
