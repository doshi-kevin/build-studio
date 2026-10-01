/**
 * ChannelSidebar — Channel list section with create/rename/delete.
 *
 * Renders without its own outer column wrapper so it can be stacked
 * alongside ProjectResourcesSection inside the shared Discussions sidebar.
 * Displays channels with # prefix, highlights active channel, and provides
 * a create dialog and context menu for rename/delete.
 */
'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Hash, Plus, MoreHorizontal, Pencil, Trash2, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { MAX_CHANNELS_PER_TEAM } from '@/lib/validations/project-chat'
import {
  createChannel,
  renameChannel,
  deleteChannel,
} from '@/app/(dashboard)/student/courses/[sectionId]/projects/chat-actions'
import type { ChatChannel } from '@/lib/chat/hooks'

interface ChannelSidebarProps {
  channels: ChatChannel[]
  activeChannelId: string | null
  onSelectChannel: (id: string) => void
  teamId: string
  sectionId: string
  /** Extra content rendered below the channel list (e.g. PeoplePanel). */
  footerSlot?: React.ReactNode
}

export function ChannelSidebar({
  channels,
  activeChannelId,
  onSelectChannel,
  teamId,
  sectionId,
  footerSlot,
}: ChannelSidebarProps) {
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [creating, setCreating] = useState(false)

  const [renameTarget, setRenameTarget] = useState<ChatChannel | null>(null)
  const [renameName, setRenameName] = useState('')
  const [renaming, setRenaming] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<ChatChannel | null>(null)
  const [deleting, setDeleting] = useState(false)

  // The "+" trigger is always visible so team members know channel
  // creation exists; it switches to a disabled state with a hint when
  // the per-team cap is reached.
  const atCap = channels.length >= MAX_CHANNELS_PER_TEAM
  const canCreate = !atCap

  const handleCreate = async () => {
    if (!createName.trim()) return
    setCreating(true)
    try {
      const result = await createChannel(teamId, sectionId, { name: createName })
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success('Channel created')
        setShowCreate(false)
        setCreateName('')
        // Auto-select new channel
        const data = result.data as { id: string } | undefined
        if (data?.id) onSelectChannel(data.id)
      }
    } catch {
      toast.error('Something went wrong')
    } finally {
      setCreating(false)
    }
  }

  const handleRename = async () => {
    if (!renameTarget || !renameName.trim()) return
    setRenaming(true)
    try {
      const result = await renameChannel(renameTarget.id, sectionId, { name: renameName })
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success('Channel renamed')
        setRenameTarget(null)
      }
    } catch {
      toast.error('Something went wrong')
    } finally {
      setRenaming(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const result = await deleteChannel(deleteTarget.id, sectionId)
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success('Channel deleted')
        setDeleteTarget(null)
      }
    } catch {
      toast.error('Something went wrong')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <TooltipProvider>
    <div className="flex flex-col min-h-0">
      {/* Header */}
      <div className="p-3 border-b flex items-center justify-between shrink-0">
        <h3 className="text-sm font-semibold">Channels</h3>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* A disabled button takes no focus, so the wrapper has to be
                focusable for keyboard users to ever read the "limit reached"
                tooltip. Only when disabled — otherwise the span would add a
                second, pointless tab stop. */}
            <span tabIndex={canCreate ? -1 : 0}>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 disabled:opacity-50 disabled:hover:bg-transparent"
                onClick={() => setShowCreate(true)}
                disabled={!canCreate}
                aria-label={
                  canCreate
                    ? 'Create channel'
                    : `Channel limit reached (${MAX_CHANNELS_PER_TEAM})`
                }
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {canCreate
              ? 'New channel'
              : `Limit reached — delete a channel to add a new one (${channels.length}/${MAX_CHANNELS_PER_TEAM}).`}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Channels — capped when a footer (e.g. People) is present so that
          section keeps its own independent scroll region below. */}
      <div
        className={cn(
          'overflow-y-auto',
          footerSlot ? 'shrink-0 max-h-[50%]' : 'flex-1 min-h-0',
        )}
      >
        <div className="p-1.5 space-y-0.5">
        {channels.map((channel) => (
          <div
            key={channel.id}
            className={cn(
              'group flex items-center gap-1.5 px-2 py-1.5 rounded-xl cursor-pointer text-sm',
              channel.id === activeChannelId
                ? 'bg-foreground/10 text-foreground font-medium'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
            onClick={() => onSelectChannel(channel.id)}
          >
            <Hash className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate flex-1">{channel.name}</span>

            {!channel.is_default && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 opacity-0 group-hover:opacity-100 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-36">
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation()
                      setRenameTarget(channel)
                      setRenameName(channel.name)
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5 mr-2" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={(e) => {
                      e.stopPropagation()
                      setDeleteTarget(channel)
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ))}
        </div>
      </div>

      {/* People / footer — takes the rest with its own scroll region so
          it stays put when channels scroll, and vice versa. */}
      {footerSlot && (
        <div className="flex-1 min-h-0 flex flex-col border-t border-border/60">
          {footerSlot}
        </div>
      )}

      {/* Create Channel Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Create Channel</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Hash className="h-4 w-4 text-muted-foreground shrink-0" />
              <Input
                placeholder="channel-name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                autoFocus
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Name will be lowercase with hyphens. {channels.length}/{MAX_CHANNELS_PER_TEAM} channels used.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating || !createName.trim()}>
              {creating && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Channel Dialog */}
      <Dialog open={!!renameTarget} onOpenChange={() => setRenameTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename Channel</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Hash className="h-4 w-4 text-muted-foreground shrink-0" />
            <Input
              placeholder="new-name"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleRename()}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)} disabled={renaming}>
              Cancel
            </Button>
            <Button onClick={handleRename} disabled={renaming || !renameName.trim()}>
              {renaming && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Channel Confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete #{deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the channel and all its messages. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              variant="destructive"
            >
              {deleting && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </TooltipProvider>
  )
}
