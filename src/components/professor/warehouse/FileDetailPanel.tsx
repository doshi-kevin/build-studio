'use client'

import { useState } from 'react'
import {
  FileText,
  Presentation,
  Video,
  Image as ImageIcon,
  FileSpreadsheet,
  File,
  Star,
  Pencil,
  ArrowRight,
  Copy,
  Trash2,
  Tag,
  BookOpen,
  Calendar,
  HardDrive,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import {
  FILE_TYPE_COLORS,
  FILE_TYPE_LABELS,
  type WarehouseFile,
  type WarehouseCourse,
  type FileType,
} from '@/lib/validations/warehouse'
import { formatFileSize, getRelativeTime } from '@/lib/warehouse/utils'
import type { LucideIcon } from 'lucide-react'

const FILE_TYPE_ICONS: Record<FileType, LucideIcon> = {
  pdf: FileText,
  ppt: Presentation,
  video: Video,
  image: ImageIcon,
  doc: FileSpreadsheet,
  other: File,
}

interface FileDetailPanelProps {
  file: WarehouseFile | null
  open: boolean
  onOpenChange: (open: boolean) => void
  courses: WarehouseCourse[]
  onUpdateNote: (fileId: string, note: string) => void
  onToggleFavorite: (fileId: string) => void
  onRename: (file: WarehouseFile) => void
  onMove: (file: WarehouseFile) => void
  onDuplicate: (file: WarehouseFile) => void
  onDelete: (file: WarehouseFile) => void
}

export function FileDetailPanel({
  file,
  open,
  onOpenChange,
  courses,
  onUpdateNote,
  onToggleFavorite,
  onRename,
  onMove,
  onDuplicate,
  onDelete,
}: FileDetailPanelProps) {
  const [editingNote, setEditingNote] = useState(false)
  const [noteText, setNoteText] = useState('')

  if (!file) return null

  const colors = FILE_TYPE_COLORS[file.fileType]
  const Icon = FILE_TYPE_ICONS[file.fileType]
  const usedInCourses = courses.filter((c) => file.usedInCourseIds.includes(c.id))
  const courseName = courses.find((c) => c.id === file.courseId)?.name

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] p-0 overflow-hidden">
        {/* Header with file icon + name */}
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle className="flex items-center gap-3">
            <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${colors.chip}`}>
              <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-base">{file.name}</p>
              <DialogDescription className="mt-0.5">
                {FILE_TYPE_LABELS[file.fileType]} — {formatFileSize(file.size)}
              </DialogDescription>
            </div>
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(85vh-7rem)]">
          <div className="px-6 pb-6 space-y-5">
            {/* Quick actions row */}
            <div className="flex gap-2 flex-wrap">
              <Button
                variant={file.favorite ? 'default' : 'outline'}
                size="sm"
                onClick={() => onToggleFavorite(file.id)}
                className={file.favorite ? 'bg-warning text-warning-foreground hover:bg-warning/90' : ''}
              >
                <Star className={`h-3.5 w-3.5 mr-1.5 ${file.favorite ? 'fill-warning-foreground' : ''}`} />
                {file.favorite ? 'Favorited' : 'Favorite'}
              </Button>
              <Button variant="outline" size="sm" onClick={() => onRename(file)}>
                <Pencil className="h-3.5 w-3.5 mr-1.5" />
                Rename
              </Button>
              <Button variant="outline" size="sm" onClick={() => onMove(file)}>
                <ArrowRight className="h-3.5 w-3.5 mr-1.5" />
                Move
              </Button>
              <Button variant="outline" size="sm" onClick={() => onDuplicate(file)}>
                <Copy className="h-3.5 w-3.5 mr-1.5" />
                Duplicate
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => onDelete(file)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                Delete
              </Button>
            </div>

            <Separator />

            {/* File info grid */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              {courseName && (
                <div className="flex items-center gap-2">
                  <BookOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-xs text-muted-foreground">Course</p>
                    <p className="font-medium">{courseName}</p>
                  </div>
                </div>
              )}
              {file.week && (
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-xs text-muted-foreground">Week</p>
                    <p className="font-medium">{file.week}</p>
                  </div>
                </div>
              )}
              {file.topic && (
                <div className="flex items-center gap-2">
                  <Tag className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-xs text-muted-foreground">Topic</p>
                    <p className="font-medium">{file.topic}</p>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Size</p>
                  <p className="font-medium">{formatFileSize(file.size)}</p>
                </div>
              </div>
            </div>

            {/* Tags */}
            {file.tags.length > 0 && (
              <>
                <Separator />
                <div>
                  <p className="text-xs text-muted-foreground mb-2">Tags</p>
                  <div className="flex gap-1.5 flex-wrap">
                    {file.tags.map((tag) => (
                      <Badge key={tag} variant="secondary" className="text-xs">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
              </>
            )}

            <Separator />

            {/* Quick Note */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium">Quick Note</p>
                {!editingNote && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setNoteText(file.note)
                      setEditingNote(true)
                    }}
                  >
                    <Pencil className="h-3 w-3 mr-1" />
                    {file.note ? 'Edit' : 'Add Note'}
                  </Button>
                )}
              </div>
              {editingNote ? (
                <div className="space-y-2">
                  <Textarea
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    placeholder="Your personal note about this file..."
                    rows={3}
                    className="resize-none"
                    maxLength={2000}
                  />
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-muted-foreground">{noteText.length}/2000</span>
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setEditingNote(false)}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          onUpdateNote(file.id, noteText)
                          setEditingNote(false)
                        }}
                      >
                        Save
                      </Button>
                    </div>
                  </div>
                </div>
              ) : file.note ? (
                <div className="bg-warning-muted p-3 rounded-xl border border-warning/30">
                  <p className="text-sm text-warning-muted-foreground">{file.note}</p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  No note yet — add a personal note to remember context about this file.
                </p>
              )}
            </div>

            {/* Used In */}
            {usedInCourses.length > 0 && (
              <>
                <Separator />
                <div>
                  <p className="text-sm font-medium mb-2">Used In</p>
                  <div className="space-y-1.5">
                    {usedInCourses.map((c) => (
                      <div key={c.id} className="flex items-center gap-2 text-sm p-2 rounded-xl bg-muted/50">
                        <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
                        <span>{c.code ? `${c.code} — ${c.name}` : c.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* Timestamps */}
            <Separator />
            <div className="flex gap-6 text-xs text-muted-foreground">
              <div>
                <p className="font-medium text-foreground/70">Created</p>
                <p>{new Date(file.createdAt).toLocaleDateString()}</p>
              </div>
              <div>
                <p className="font-medium text-foreground/70">Last Used</p>
                <p>{getRelativeTime(file.lastUsedAt)}</p>
              </div>
              <div>
                <p className="font-medium text-foreground/70">Updated</p>
                <p>{getRelativeTime(file.updatedAt)}</p>
              </div>
            </div>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
