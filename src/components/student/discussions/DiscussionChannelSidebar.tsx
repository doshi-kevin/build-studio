/**
 * DiscussionChannelSidebar — Channel list for discussions. Shows channels with
 * # prefix and optional create/rename/delete controls. The canManageChannels
 * prop controls whether management UI is shown.
 */
'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Hash, Plus, MoreHorizontal, Pencil, Trash2, Loader2, Archive } from 'lucide-react'
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
import type { DiscussionChannel } from '@/lib/discussion/hooks'

interface DiscussionChannelSidebarProps {
  channels: DiscussionChannel[]
  activeChannelId: string | null
  onSelectChannel: (channel: DiscussionChannel) => void
  canManageChannels: boolean
  maxChannels?: number
  onCreateChannel?: (name: string) => Promise<{ error?: string; data?: { id: string } }>
  onRenameChannel?: (channelId: string, name: string) => Promise<{ error?: string }>
  onDeleteChannel?: (channelId: string) => Promise<{ error?: string }>
  title?: string
  /** Extra content rendered below the channel list (e.g. PeoplePanel). */
  footerSlot?: React.ReactNode
}

export function DiscussionChannelSidebar({
  channels,
  activeChannelId,
  onSelectChannel,
  canManageChannels,
  maxChannels = 10,
  onCreateChannel,
  onRenameChannel,
  onDeleteChannel,
  title = 'Channels',
  footerSlot,
}: DiscussionChannelSidebarProps) {
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [creating, setCreating] = useState(false)

  const [renameTarget, setRenameTarget] = useState<DiscussionChannel | null>(null)
  const [renameName, setRenameName] = useState('')
  const [renaming, setRenaming] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<DiscussionChannel | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Show the "+" trigger to anyone who can manage channels — even when
  // capped — so the affordance is always discoverable. The button is
  // disabled with an explanatory tooltip when the cap is reached.
  const showCreateTrigger = canManageChannels && !!onCreateChannel
  const atCap = channels.length >= maxChannels
  const canCreate = showCreateTrigger && !atCap

  const handleCreate = async () => {
    if (!createName.trim() || !onCreateChannel) return
    setCreating(true)
    try {
      const result = await onCreateChannel(createName)
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success('Channel created')
        setShowCreate(false)
        setCreateName('')
        if (result.data?.id) {
          const newChannel = channels.find((c) => c.id === result.data?.id)
          if (newChannel) onSelectChannel(newChannel)
        }
      }
    } catch {
      toast.error('Something went wrong')
    } finally {
      setCreating(false)
    }
  }

  const handleRename = async () => {
    if (!renameTarget || !renameName.trim() || !onRenameChannel) return
    setRenaming(true)
    try {
      const result = await onRenameChannel(renameTarget.id, renameName)
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
    if (!deleteTarget || !onDeleteChannel) return
    setDeleting(true)
    try {
      const result = await onDeleteChannel(deleteTarget.id)
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
    <div className="w-64 border-r bg-muted/20 flex flex-col shrink-0">
      {/* Header */}
      <div className="px-4 py-3.5 border-b bg-background/60 flex items-center justify-between">
        <h3 className="text-sm font-bold tracking-tight">{title}</h3>
        {showCreateTrigger && (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* A disabled button takes no focus, so the wrapper has to be
                  focusable for keyboard users to ever read the "limit
                  reached" tooltip. Only when disabled — otherwise the span
                  would add a second, pointless tab stop. */}
              <span tabIndex={canCreate ? -1 : 0}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 rounded-xl hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent"
                  onClick={() => setShowCreate(true)}
                  disabled={!canCreate}
                  aria-label={
                    canCreate
                      ? 'Create channel'
                      : `Channel limit reached (${maxChannels})`
                  }
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {canCreate
                ? 'New channel'
                : `Limit reached — delete a channel to add a new one (${channels.length}/${maxChannels}).`}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Channels — capped when a footer (e.g. People) is present so that
          section keeps its own independent scroll region below. */}
      <div
        className={cn(
          'overflow-y-auto',
          footerSlot ? 'shrink-0 max-h-[50%]' : 'flex-1 min-h-0',
        )}
      >
        <div className="p-2 space-y-px">
        {channels.map((channel) => (
          <div
            key={channel.id}
            className={cn(
              'group flex items-center gap-2 px-2.5 py-1.5 rounded-xl cursor-pointer text-[13px] transition duration-150 ease-out',
              channel.id === activeChannelId
                ? 'bg-primary/10 text-primary font-semibold shadow-sm ring-1 ring-primary/10'
                : 'text-foreground/70 hover:bg-muted hover:text-foreground',
              channel.status === 'archived' && 'opacity-50',
            )}
            onClick={() => onSelectChannel(channel)}
          >
            {/* Active indicator bar */}
            <div
              className={cn(
                'w-0.5 h-4 rounded-full shrink-0 transition-colors',
                channel.id === activeChannelId ? 'bg-primary' : 'bg-transparent',
              )}
            />
            {channel.status === 'archived' ? (
              <Archive className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <Hash className={cn('h-3.5 w-3.5 shrink-0', channel.id === activeChannelId ? 'text-primary' : 'text-foreground/50')} />
            )}
            <span className="truncate flex-1">{channel.name}</span>

            {canManageChannels && !channel.is_default && channel.status === 'active' && (
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
                  {onRenameChannel && (
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
                  )}
                  {onDeleteChannel && (
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
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ))}
        </div>
      </div>

      {/* People / footer — takes the rest of the sidebar with its own scroll
          so it stays put when channels scroll and vice versa. */}
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
              Name will be lowercase with hyphens. {channels.length}/{maxChannels} channels used.
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
