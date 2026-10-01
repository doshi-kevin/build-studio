'use client'

import {
  FileText,
  Presentation,
  Video,
  Image as ImageIcon,
  FileSpreadsheet,
  File,
  Star,
  StickyNote,
  MoreVertical,
  Pencil,
  ArrowRight,
  Copy,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { FILE_TYPE_COLORS, type FileType, type WarehouseFile } from '@/lib/validations/warehouse'
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

interface FileCardProps {
  file: WarehouseFile
  courseName?: string
  onSelect?: () => void
  onToggleFavorite?: () => void
  onRename?: () => void
  onMove?: () => void
  onDuplicate?: () => void
  onDelete?: () => void
  onEditNote?: () => void
  compact?: boolean
}

export function FileCard({
  file,
  courseName,
  onSelect,
  onToggleFavorite,
  onRename,
  onMove,
  onDuplicate,
  onDelete,
  onEditNote,
  compact = false,
}: FileCardProps) {
  const colors = FILE_TYPE_COLORS[file.fileType]
  const Icon = FILE_TYPE_ICONS[file.fileType]

  if (compact) {
    return (
      <div
        className="bg-card border border-border rounded-xl p-3 cursor-pointer hover:border-ring/40 hover:shadow-sm transition duration-200 ease-out"
        onClick={onSelect}
      >
        <div className="flex items-center gap-2">
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-xl ${colors.chip}`}>
            <Icon className="h-4 w-4" />
          </span>
          <span className="text-sm font-medium truncate flex-1">{file.name}</span>
          {file.favorite && <Star className="h-3 w-3 text-warning fill-warning shrink-0" />}
        </div>
      </div>
    )
  }

  return (
    <div
      className="group relative bg-card border border-border rounded-xl p-4 cursor-pointer hover:border-ring/40 hover:shadow-sm transition duration-200 ease-out"
      onClick={onSelect}
    >
      <div className="flex items-start gap-3">
        {/* File type icon chip */}
        <div className={`shrink-0 flex h-9 w-9 items-center justify-center rounded-xl ${colors.chip}`}>
          <Icon className="h-5 w-5" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold truncate group-hover:text-primary transition-colors">{file.name}</h3>
            {/* Favorite star */}
            <button
              onClick={(e) => {
                e.stopPropagation()
                onToggleFavorite?.()
              }}
              className="shrink-0"
            >
              <Star
                className={`h-3.5 w-3.5 transition-colors ${
                  file.favorite
                    ? 'text-warning fill-warning'
                    : 'text-muted-foreground/30 hover:text-warning'
                }`}
              />
            </button>
          </div>

          {/* Badges row */}
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {courseName && (
              <Badge variant="outline" className="text-xs">
                {courseName}
              </Badge>
            )}
            {file.week && (
              <Badge variant="secondary" className="text-xs">
                Week {file.week}
              </Badge>
            )}
            {file.topic && (
              <Badge variant="secondary" className="text-xs">
                {file.topic}
              </Badge>
            )}
          </div>

          {/* Note preview */}
          {file.note && (
            <div className="flex items-center gap-1 mt-1.5 text-xs text-muted-foreground">
              <StickyNote className="h-3 w-3 text-warning shrink-0" />
              <span className="truncate">{file.note}</span>
            </div>
          )}

          {/* Footer: size + last used */}
          <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
            <span>{formatFileSize(file.size)}</span>
            <span>{getRelativeTime(file.lastUsedAt)}</span>
          </div>
        </div>

        {/* Actions dropdown */}
        <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onEditNote && (
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEditNote() }}>
                  <StickyNote className="h-4 w-4 mr-2" />
                  {file.note ? 'Edit Note' : 'Add Note'}
                </DropdownMenuItem>
              )}
              {onRename && (
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onRename() }}>
                  <Pencil className="h-4 w-4 mr-2" />
                  Rename
                </DropdownMenuItem>
              )}
              {onMove && (
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onMove() }}>
                  <ArrowRight className="h-4 w-4 mr-2" />
                  Move
                </DropdownMenuItem>
              )}
              {onDuplicate && (
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDuplicate() }}>
                  <Copy className="h-4 w-4 mr-2" />
                  Duplicate
                </DropdownMenuItem>
              )}
              {onDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={(e) => { e.stopPropagation(); onDelete() }}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  )
}

export { FILE_TYPE_ICONS }
