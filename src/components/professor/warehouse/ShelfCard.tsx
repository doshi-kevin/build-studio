'use client'

import { useMemo } from 'react'
import { ChevronDown, ChevronRight, BookOpen, MoreVertical, Trash2, Eraser } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { WeekBox } from './WeekBox'
import { groupFilesByWeek } from '@/lib/warehouse/utils'
import { FILE_TYPE_COLORS, type WarehouseFile, type WarehouseCourse } from '@/lib/validations/warehouse'

interface ShelfCardProps {
  course: WarehouseCourse | null // null = "Unsorted Files" shelf
  files: WarehouseFile[]
  allCourses: WarehouseCourse[]
  expanded: boolean
  expandedBoxId: string | null
  onToggle: () => void
  onExpandBox: (boxId: string | null) => void
  onSelectFile: (fileId: string) => void
  onToggleFavorite: (fileId: string) => void
  onRename: (file: WarehouseFile) => void
  onMove: (file: WarehouseFile) => void
  onDuplicate: (file: WarehouseFile) => void
  onDelete: (file: WarehouseFile) => void
  onEditNote: (fileId: string, note: string) => void
  onClearShelf?: (courseId: string | null) => void
  onRemoveShelf?: (courseId: string | null) => void
}

export function ShelfCard({
  course,
  files,
  allCourses,
  expanded,
  expandedBoxId,
  onToggle,
  onExpandBox,
  onSelectFile,
  onToggleFavorite,
  onRename,
  onMove,
  onDuplicate,
  onDelete,
  onEditNote,
  onClearShelf,
  onRemoveShelf,
}: ShelfCardProps) {
  const isUnsorted = !course
  const shelfLabel = isUnsorted ? 'Unsorted Files' : `${course.code ? `${course.code} — ` : ''}${course.name}`

  // File type distribution dots
  const typeDots = [...new Set(files.map((f) => f.fileType))].slice(0, 6)

  // Group by week
  const weekGroups = useMemo(() => {
    const groups = groupFilesByWeek(files)
    // Sort weeks: 0 (unassigned) last, rest ascending
    const sorted = [...groups.entries()].sort((a, b) => {
      if (a[0] === 0) return 1
      if (b[0] === 0) return -1
      return a[0] - b[0]
    })
    return sorted
  }, [files])

  return (
    <div>
      {/* Shelf header */}
      <div
        className={`bg-card border rounded-xl p-4 cursor-pointer hover:border-ring/40 hover:shadow-sm transition duration-200 ease-out ${
          isUnsorted ? 'border-dashed border-muted-foreground/30' : 'border-border'
        }`}
        onClick={onToggle}
      >
        <div className="flex items-center gap-3">
          <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${isUnsorted ? 'bg-muted' : 'bg-primary/10'}`}>
            <BookOpen className={`h-5 w-5 ${isUnsorted ? 'text-muted-foreground' : 'text-primary'}`} />
          </div>
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold truncate">{shelfLabel}</h3>
            <div className="flex items-center gap-2 mt-0.5">
              <div className="flex gap-0.5">
                {typeDots.map((type) => (
                  <span
                    key={type}
                    className={`w-2 h-2 rounded-full ${FILE_TYPE_COLORS[type].dot}`}
                  />
                ))}
              </div>
              <span className="text-xs text-muted-foreground">
                {weekGroups.length} {weekGroups.length === 1 ? 'section' : 'sections'}
              </span>
            </div>
          </div>
          <Badge variant="secondary">{files.length} files</Badge>
          {/* Shelf actions menu */}
          {(onClearShelf || onRemoveShelf) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onClearShelf && files.length > 0 && (
                  <DropdownMenuItem
                    onClick={(e) => { e.stopPropagation(); onClearShelf(course?.id ?? null) }}
                    className="text-destructive focus:text-destructive"
                  >
                    <Eraser className="h-4 w-4 mr-2" />
                    Clear All Files
                  </DropdownMenuItem>
                )}
                {onRemoveShelf && !isUnsorted && (
                  <DropdownMenuItem
                    onClick={(e) => { e.stopPropagation(); onRemoveShelf(course?.id ?? null) }}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Remove Shelf
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Expanded: show week boxes or empty state */}
      {expanded && (
        <div className="space-y-2 mt-3 ml-4">
          {weekGroups.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No files yet. Upload files to this course shelf.
            </p>
          ) : (
            weekGroups.map(([weekNum, weekFiles]) => {
              const boxId = `${course?.id ?? 'unsorted'}-w${weekNum}`
              return (
                <WeekBox
                  key={boxId}
                  weekNumber={weekNum}
                  files={weekFiles}
                  courses={allCourses}
                  expanded={expandedBoxId === boxId}
                  onToggle={() => onExpandBox(expandedBoxId === boxId ? null : boxId)}
                  onSelectFile={onSelectFile}
                  onToggleFavorite={onToggleFavorite}
                  onRename={onRename}
                  onMove={onMove}
                  onDuplicate={onDuplicate}
                  onDelete={onDelete}
                  onEditNote={onEditNote}
                />
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
