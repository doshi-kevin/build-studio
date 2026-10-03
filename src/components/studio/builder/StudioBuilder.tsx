'use client'

import { useEffect, useId, useRef, useState, useTransition } from 'react'
import { flushSync } from 'react-dom'
import { Undo2, X } from 'lucide-react'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
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
import { DraftHistory } from './DraftHistory'
import { MemoryPanel } from './MemoryPanel'
import { SaveReleaseCard } from './SaveReleaseCard'
import { StudioChat } from './StudioChat'
import { StudioPreview } from './StudioPreview'
import { useBuildRun } from './use-build-run'
import { STATUS_BADGE, statusAnnouncement, type ConversationTurn, type Device, type OpenProject, type ViewMode } from './types'

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
  const [mode, setMode] = useState<ViewMode>('split')
  const [device, setDevice] = useState<Device>('desktop')
  const [pane, setPane] = useState<'chat' | 'preview'>('chat')
  // The workspace remounts this per project (key), so props only seed state.
  const [runId, setRunId] = useState<string | null>(initialRunId)
  const [turns, setTurns] = useState<ConversationTurn[]>([])
  const [conversation, setConversation] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [conversationReads, setConversationReads] = useState(0)
  const { progress, events, unreachable, sawActive, refresh } = useBuildRun(runId)
  const previewRef = useRef<HTMLElement>(null)
  const undoReasonId = useId()

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
  const runBadge = progress && (working || waiting) ? STATUS_BADGE[progress.status] : undefined
  // Save offers the draft the preview shows. After an undo that is the earlier draft, not
  // the one this run built, so it is saveable unless it already has a version.
  const builtShown = !!progress?.result?.previewHash && progress.result.previewHash === headHash
  const headEntry = fresh?.entries.find((e) => e.current)
  const canSave = ended && !!headHash && (fresh ? !headEntry?.savedVersion : builtShown)

  // On a phone the chat pane hides once the preview shows, so focus follows the switch.
  const showPreview = () => {
    flushSync(() => setPane('preview'))
    previewRef.current?.focus()
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

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="top-0 left-0 flex h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:max-w-none"
      >

        <DialogDescription className="sr-only">Chat with Athena on one side and preview the draft on the other.</DialogDescription>
        {/* Outside both panes: on a phone the hidden pane is display:none and would announce nothing. */}
        <p role="status" className="sr-only">
          {statusAnnouncement(progress?.status, sawActive)}
        </p>
        <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <Button variant="ghost" size="icon" className="h-11 w-11" onClick={onClose} aria-label="Close builder">
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
          <DialogTitle className="min-w-0 truncate text-base font-medium">{project.name}</DialogTitle>
          <Badge variant="secondary">{runBadge ?? (headHash ? 'Draft' : 'New')}</Badge>
          <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
            {undoWaits && !undoing && (
              <>
                <Button
                  variant="outline"
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
                  <Button variant="outline" className="min-h-11 gap-2" disabled={undoing}>
                    <Undo2 className="h-4 w-4" aria-hidden="true" />
                    {undoing ? 'Going back…' : 'Undo last change'}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
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
            <MemoryPanel sectionId={sectionId} pluginProjectId={project.pluginProjectId} reloadKey={memoryReads} />
            <DraftHistory entries={history?.entries ?? []} failed={historyFailed} onRetry={() => setHistoryReads((n) => n + 1)} />
          </div>
          <ToggleGroup
            type="single"
            variant="outline"
            value={pane}
            onValueChange={(v) => v && setPane(v as 'chat' | 'preview')}
            aria-label="Show chat or preview"
            className="ml-auto lg:hidden"
          >
            <ToggleGroupItem value="chat" className="min-h-11 min-w-11">
              {waiting ? 'Chat (needs you)' : 'Chat'}
            </ToggleGroupItem>
            <ToggleGroupItem value="preview" className="min-h-11 min-w-11">
              Preview
            </ToggleGroupItem>
          </ToggleGroup>
        </header>
        <div className="flex min-h-0 flex-1">
          <aside aria-label="Athena" className={cn('min-h-0 w-full shrink-0 border-r border-border lg:block lg:w-96', pane === 'chat' ? 'block' : 'hidden')}>
            <StudioChat
              turns={turns}
              conversation={conversation}
              onReloadConversation={() => {
                setConversation('loading')
                setConversationReads((n) => n + 1)
              }}
              current={runId ? { runId, progress, events, unreachable } : null}
              canSave={canSave}
              savesOtherDraft={!builtShown}
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
              onPreview={showPreview}
              onSave={async () => {
                if (!headHash) return { ok: false, message: 'There is no draft to save yet.' }
                const r = await saveDraftAsVersionAction({ sectionId, pluginProjectId: project.pluginProjectId, snapshotHash: headHash })
                if ('error' in r) return { ok: false, message: r.error }
                onChanged()
                setHistoryReads((n) => n + 1)
                return { ok: true, message: `Saved as version ${r.version}.`, saved: { versionId: r.versionId, version: r.version } }
              }}
              afterSave={(saved) => <SaveReleaseCard sectionId={sectionId} versionId={saved.versionId} version={saved.version} />}
            />
          </aside>
          <section
            ref={previewRef}
            tabIndex={-1}
            aria-label="Preview"
            className={cn('min-h-0 min-w-0 flex-1 focus:outline-none lg:block', pane === 'preview' ? 'block' : 'hidden')}
          >
            <StudioPreview
              sectionId={sectionId}
              pluginProjectId={project.pluginProjectId}
              snapshotHash={headHash}
              building={working || waiting}
              note={
                working && headHash
                  ? 'Athena is still working. This is your draft from before this request.'
                  : ended && progress?.result?.previewHash && !builtShown && headHash
                    ? 'This is your current draft. The one this build made is still in your history.'
                    : undefined
              }
              mode={mode}
              device={device}
              onModeChange={setMode}
              onDeviceChange={setDevice}
            />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
