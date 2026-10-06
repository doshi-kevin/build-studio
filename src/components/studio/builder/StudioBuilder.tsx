'use client'

import { useEffect, useId, useRef, useState, useTransition } from 'react'
import { Check, CheckCircle2, Save, Undo2, X } from 'lucide-react'
import { toast } from 'sonner'
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
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  answerQuestionAction,
  decideApprovalAction,
  decideMemoryAction,
  loadConversationAction,
  loadDraftHistoryAction,
  saveDraftAsVersionAction,
  startBuildAction,
  stopBuildAction,
  undoDraftAction,
} from '@/app/(dashboard)/professor/courses/[sectionId]/studio/actions'
import type { DraftHistory as DraftHistoryData } from '@/lib/studio/builder/service'
import { AthenaMascot } from './AthenaMascot'
import { DraftHistory } from './DraftHistory'
import { MemoryPanel } from './MemoryPanel'
import { Chip, StatusChip } from './RunCards'
import { SaveReleaseCard } from './SaveReleaseCard'
import { StudioChat } from './StudioChat'
import { StudioPreview } from './StudioPreview'
import { useBuildRun } from './use-build-run'
import { ENDED_UNBUILT, statusAnnouncement, type ConversationTurn, type OpenProject, type ViewMode } from './types'

const UNDO_WAITS = 'You can undo once this request finishes, or after you stop it.'

interface StudioBuilderProps {
  sectionId: string
  project: OpenProject | null
  /** The run to follow when the builder opens: the newest one. */
  runId: string | null
  onClose: () => void
  /** A build changed what the drafts list should show. */
  onChanged: () => void
}

export function StudioBuilder({ sectionId, project, runId: initialRunId, onClose, onChanged }: StudioBuilderProps) {
  const [mode, setMode] = useState<ViewMode>('professor')
  // The workspace remounts this per project (key), so props only seed state.
  const [runId, setRunId] = useState<string | null>(initialRunId)
  const [turns, setTurns] = useState<ConversationTurn[]>([])
  const [conversation, setConversation] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [conversationReads, setConversationReads] = useState(0)
  const { progress, events, unreachable, sawActive, refresh } = useBuildRun(runId)
  const undoReasonId = useId()
  const saveNoteId = useId()
  const releaseId = useId()
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const releaseRef = useRef<HTMLElement>(null)
  // The version the header's Save just made. Its next step shows at the end of the chat.
  const [saved, setSaved] = useState<{ versionId: string; version: string; hash: string } | null>(null)
  const [saving, startSaving] = useTransition()
  // Save unmounts once it succeeds, so focus moves to what it made. Not when the professor sent
  // a new request while the save ran: they are typing in the chat box.
  const focusSaved = useRef(true)
  useEffect(() => {
    if (saved && focusSaved.current) releaseRef.current?.focus()
  }, [saved])

  const pluginProjectId = project?.pluginProjectId ?? null
  useEffect(() => {
    if (!pluginProjectId) return
    let live = true
    loadConversationAction({ sectionId, pluginProjectId }).then(
      (r) => {
        if (!live) return
        if ('success' in r) setTurns(r.turns)
        setConversation('success' in r ? 'ready' : 'failed')
      },
      () => live && setConversation('failed'),
    )
    return () => {
      live = false
    }
  }, [sectionId, pluginProjectId, runId, conversationReads])

  // The draft pointer as the server has it, re-read whenever the run changes state and
  // after an undo. `key` says which run state it was read in.
  const statusKey = `${runId ?? ''}:${progress?.status ?? ''}`
  const [history, setHistory] = useState<(DraftHistoryData & { key: string }) | null>(null)
  const [historyFailed, setHistoryFailed] = useState(false)
  const [historyReads, setHistoryReads] = useState(0)
  // Bumped when a suggested decision is answered, so "Studio remembers (N)" re-reads.
  const [memoryReads, setMemoryReads] = useState(0)
  useEffect(() => {
    if (!pluginProjectId) return
    let live = true
    loadDraftHistoryAction({ sectionId, pluginProjectId }).then(
      (r) => {
        if (!live) return
        if ('success' in r) setHistory({ entries: r.entries, head: r.head, canUndo: r.canUndo, key: statusKey })
        setHistoryFailed(!('success' in r))
      },
      () => live && setHistoryFailed(true),
    )
    return () => {
      live = false
    }
  }, [sectionId, pluginProjectId, statusKey, historyReads])
  const fresh = history?.key === statusKey ? history : null
  const [undoing, startUndo] = useTransition()

  // A finished build moved the draft: preview and save follow it.
  const ended = progress?.status === 'preview_ready' || progress?.status === 'completed'
  const builtHash = progress?.status === 'preview_ready' ? (progress.result?.previewHash ?? null) : null
  const headHash = fresh ? fresh.head.hash : (builtHash ?? history?.head.hash ?? project?.headHash ?? null)
  useEffect(() => {
    if (builtHash) onChanged()
  }, [builtHash, onChanged])

  if (!project) return <Dialog open={false} />
  const working = progress?.status === 'queued' || progress?.status === 'running'
  const waiting = progress?.status === 'waiting_for_approval' || progress?.status === 'waiting_for_professor'
  const canUndo = !!fresh?.canUndo && !!fresh.head.hash && !working && !waiting && !undoing
  // While a build is active, Undo stays visible and says why it can't run yet.
  const undoWaits = (working || waiting) && !!(fresh ?? history)?.canUndo
  // Save offers the draft the preview shows. After an undo that is the earlier draft, not
  // the one this run built, so it is saveable unless it already has a version.
  const builtShown = !!progress?.result?.previewHash && progress.result.previewHash === headHash
  // Found by hash, so an older read still answers: a snapshot only ever goes from unsaved to saved.
  const headEntry = (fresh ?? history)?.entries.find((e) => e.hash === headHash)
  const headSaved = !!headEntry?.savedVersion || saved?.hash === headHash
  // In the header whatever the latest request did: a failed follow-up doesn't strand a good draft.
  const canSave = !!headHash && !working && !waiting && !undoing && !headSaved && (fresh ? true : ended && builtShown)
  const savesOtherDraft = !!progress?.result?.previewHash && !builtShown
  const savedVersion = headEntry?.savedVersion ?? (saved?.hash === headHash ? saved.version : null)
  const lastRunFailed = !!progress && ENDED_UNBUILT.includes(progress.status)

  const save = async () => {
    if (!headHash) return
    focusSaved.current = true
    const r = await saveDraftAsVersionAction({ sectionId, pluginProjectId: project.pluginProjectId, snapshotHash: headHash })
    if ('error' in r) {
      toast.error(r.error)
      return
    }
    setSaved({ versionId: r.versionId, version: r.version, hash: headHash })
    onChanged()
    setHistoryReads((n) => n + 1)
  }

  const undo = async () => {
    if (!fresh?.head.hash) return
    const r = await undoDraftAction({ sectionId, pluginProjectId: project.pluginProjectId, expectedHead: fresh.head.hash, expectedRev: fresh.head.rev })
    if ('error' in r) toast.error(r.error)
    else {
      // The preview follows at once; the list is re-read below.
      setHistory({ ...fresh, head: { hash: r.headHash, rev: r.rev }, canUndo: false })
      toast.success('Back to your previous draft.')
      onChanged()
    }
    setHistoryReads((n) => n + 1)
  }

  const athenaLine = working
    ? 'Working on it…'
    : progress?.status === 'waiting_for_approval'
      ? 'Waiting for your approval'
      : progress?.status === 'waiting_for_professor'
        ? 'Waiting for you'
        : 'Your build assistant'

  const release = saved && (
    <section ref={releaseRef} tabIndex={-1} aria-labelledby={releaseId} className="space-y-3 rounded-2xl border border-border bg-card p-4 shadow-card focus:outline-none">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-success-muted text-success-muted-foreground">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
        </span>
        <div>
          <h3 id={releaseId} className="text-sm font-semibold text-ink">
            Saved as version {saved.version}
          </h3>
          <p className="text-sm text-muted-foreground">Saving doesn’t change what students see.</p>
        </div>
      </div>
      <SaveReleaseCard sectionId={sectionId} versionId={saved.versionId} version={saved.version} />
    </section>
  )

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          // The preview comes first, so its frames would take the first Tab. Start in the chat box.
          e.preventDefault()
          composerRef.current?.focus()
        }}
        className="studio-brand top-0 left-0 flex h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:max-w-none"
      >
        <DialogDescription className="sr-only">Preview your draft on the left and chat with Athena on the right.</DialogDescription>
        {/* One announcer for the whole builder, outside both columns. */}
        <p role="status" className="sr-only">
          {statusAnnouncement(progress?.status, sawActive)}
        </p>
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
          <Button variant="ghost" size="icon" className="h-11 w-11" onClick={onClose} aria-label="Close builder">
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
          <span className="h-6 w-px bg-border" aria-hidden="true" />
          <DialogTitle className="min-w-0 truncate font-display text-base font-semibold text-ink">{project.name}</DialogTitle>
          {progress && (working || waiting) ? (
            <StatusChip status={progress.status} />
          ) : savedVersion ? (
            <Chip tone="success" icon={Check}>
              Saved as v{savedVersion}
            </Chip>
          ) : headHash ? (
            <Chip tone="neutral">Unsaved draft</Chip>
          ) : (
            <Chip tone="neutral">No draft yet</Chip>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <DraftHistory entries={history?.entries ?? []} failed={historyFailed} onRetry={() => setHistoryReads((n) => n + 1)} />
            {undoWaits && !undoing && (
              <>
                <Button
                  variant="ghost"
                  className="min-h-11 gap-2 aria-disabled:opacity-50"
                  aria-disabled="true"
                  aria-describedby={undoReasonId}
                  onClick={() => toast.info(UNDO_WAITS)}
                >
                  <Undo2 className="h-4 w-4" aria-hidden="true" />
                  Undo last change
                </Button>
                <span id={undoReasonId} className="sr-only">
                  {UNDO_WAITS}
                </span>
              </>
            )}
            {(canUndo || undoing) && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" className="min-h-11 gap-2" disabled={undoing}>
                    <Undo2 className="h-4 w-4" aria-hidden="true" />
                    {undoing ? 'Going back…' : 'Undo last change'}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent className="studio-brand">
                  <AlertDialogHeader>
                    <AlertDialogTitle>Go back to your previous draft?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Your draft goes back to how it was before Athena’s last change. You can go back one step only, and you can’t redo it,
                      though the newer draft stays listed in History. Your saved versions and what students see don’t change.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="min-h-11">Keep this draft</AlertDialogCancel>
                    <AlertDialogAction className="min-h-11" onClick={() => startUndo(undo)}>
                      Go back
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            {canSave && (
              <>
                <span className="mx-1 h-6 w-px bg-border" aria-hidden="true" />
                <Button className="min-h-11 gap-2 shadow-glow-brand" disabled={saving} aria-describedby={savesOtherDraft ? saveNoteId : undefined} onClick={() => startSaving(save)}>
                  <Save className="h-4 w-4" aria-hidden="true" />
                  {saving ? 'Checking and saving…' : savesOtherDraft ? 'Save current draft as version' : 'Save as version'}
                </Button>
                {savesOtherDraft && (
                  <span id={saveNoteId} className="sr-only">
                    Your current draft isn’t the one this build made. Saving keeps your current draft.
                  </span>
                )}
              </>
            )}
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <section aria-label="Preview" className="flex min-h-0 min-w-0 flex-1 flex-col">
            <StudioPreview
              sectionId={sectionId}
              pluginProjectId={project.pluginProjectId}
              snapshotHash={headHash}
              building={working}
              noteBusy={working || waiting}
              lastRunFailed={lastRunFailed}
              note={
                working && headHash
                  ? 'Athena is still working. This is your draft from before this request.'
                  : waiting
                    ? headHash
                      ? 'Athena is waiting for you in the chat. This is your draft from before this request.'
                      : 'Athena is waiting for you in the chat before building your first draft.'
                    : ended && progress?.result?.previewHash && !builtShown && headHash
                      ? 'This is your current draft. The one this build made is still in your history.'
                      : lastRunFailed && headHash
                        ? 'Your last request didn’t change this draft.'
                        : undefined
              }
              mode={mode}
              onModeChange={setMode}
            />
          </section>
          <aside aria-label="Athena" className="flex min-h-0 w-(--athena-dock-w) shrink-0 flex-col border-l border-border bg-card">
            <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
              <AthenaMascot size={32} />
              <div className="min-w-0 flex-1">
                <p className="font-display text-sm font-semibold text-ink">Athena</p>
                {/* The status region already announces state changes. */}
                <p aria-hidden="true" className="truncate text-xs text-muted-foreground">
                  {athenaLine}
                </p>
              </div>
              <MemoryPanel sectionId={sectionId} pluginProjectId={project.pluginProjectId} reloadKey={memoryReads} />
            </div>
            <div className="min-h-0 flex-1">
              <StudioChat
                turns={turns}
                conversation={conversation}
                onReloadConversation={() => {
                  setConversation('loading')
                  setConversationReads((n) => n + 1)
                }}
                current={runId ? { runId, progress, events, unreachable } : null}
                drafts={(fresh ?? history)?.entries ?? null}
                saveAvailable={canSave && !savesOtherDraft}
                composerRef={composerRef}
                release={release}
                onSend={async (text, replaceRunId) => {
                  const r = await startBuildAction({
                    sectionId,
                    pluginProjectId: project.pluginProjectId,
                    request: text,
                    clientRequestId: crypto.randomUUID(),
                    replaceRunId: replaceRunId ?? null,
                  })
                  if ('success' in r) {
                    // The request shows at once; the conversation re-read replaces this.
                    setTurns((prev) => [
                      ...prev.filter((t) => t.runId !== r.runId),
                      { runId: r.runId, request: text, status: 'queued', ending: null, summary: null, createdAt: new Date().toISOString() },
                    ])
                    setRunId(r.runId)
                    // The release card belongs to the version before this request.
                    setSaved(null)
                    focusSaved.current = false
                    onChanged()
                    return null
                  }
                  if (r.conflict?.kind === 'waiting') return { waitingRunId: r.conflict.runId }
                  return { error: r.error }
                }}
                onStop={async () => {
                  if (!runId) return
                  const r = await stopBuildAction({ sectionId, runId })
                  if ('error' in r) toast.error(r.error)
                  refresh()
                }}
                onDecide={async (approve) => {
                  if (!runId || !progress?.approval) return null
                  const r = await decideApprovalAction({ sectionId, runId, proposalId: progress.approval.proposalId, deltaHash: progress.approval.deltaHash, approve })
                  refresh()
                  return 'error' in r ? r.error : null
                }}
                onAnswer={async (answer) => {
                  if (!runId || !progress?.question) return null
                  const r = await answerQuestionAction({ sectionId, runId, questionId: progress.question.id, answer })
                  refresh()
                  return 'error' in r ? r.error : null
                }}
                onDecideMemory={async (memoryId, approve) => {
                  if (!runId) return null
                  const r = await decideMemoryAction({ sectionId, runId, memoryId, approve })
                  refresh()
                  setMemoryReads((n) => n + 1)
                  if ('error' in r) return r.error
                  if (approve) toast.success('Saved for this tool.')
                  return null
                }}
              />
            </div>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  )
}
