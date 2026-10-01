'use client'

import { ChevronDown, ChevronRight, Package } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { FileCard } from './FileCard'
import { FILE_TYPE_COLORS, type WarehouseFile, type WarehouseCourse } from '@/lib/validations/warehouse'

interface WeekBoxProps {
  weekNumber: number // 0 = unassigned
  files: WarehouseFile[]
  courses: WarehouseCourse[]
  expanded: boolean
  onToggle: () => void
  onSelectFile: (fileId: string) => void
  onToggleFavorite: (fileId: string) => void
  onRename: (file: WarehouseFile) => void
  onMove: (file: WarehouseFile) => void
  onDuplicate: (file: WarehouseFile) => void
  onDelete: (file: WarehouseFile) => void
  onEditNote: (fileId: string, note: string) => void
}

export function WeekBox({
  weekNumber,
  files,
  courses,
  expanded,
  onToggle,
  onSelectFile,
  onToggleFavorite,
  onRename,
  onMove,
  onDuplicate,
  onDelete,
  onEditNote,
}: WeekBoxProps) {
  const label = weekNumber === 0 ? 'Unassigned' : `Week ${weekNumber}`
  const courseMap = new Map(courses.map((c) => [c.id, c.name]))

  // Common topic (if most files share the same topic)
  const topics = files.map((f) => f.topic).filter(Boolean)
  const topicCounts = new Map<string, number>()
  for (const t of topics) topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1)
  let commonTopic = ''
  let maxCount = 0
  for (const [t, c] of topicCounts) {
    if (c > maxCount) {
      maxCount = c
      commonTopic = t
    }
  }

  // File type dots for preview
  const typeDots = [...new Set(files.map((f) => f.fileType))].slice(0, 5)

  return (
    <div>
      <div
        className="bg-card border border-border rounded-xl p-3 cursor-pointer hover:border-ring/40 hover:shadow-sm transition duration-200 ease-out"
        onClick={onToggle}
      >
        <div className="flex items-center gap-3">
          <Package className="h-4 w-4 text-muted-foreground shrink-0" />
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{label}</span>
              {commonTopic && (
                <span className="text-xs text-muted-foreground truncate">— {commonTopic}</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Type preview dots */}
            <div className="flex gap-0.5">
              {typeDots.map((type) => (
                <span
                  key={type}
                  className={`w-2 h-2 rounded-full ${FILE_TYPE_COLORS[type].dot}`}
                />
              ))}
            </div>
            <Badge variant="secondary" className="text-xs">
              {files.length}
            </Badge>
          </div>
        </div>
      </div>

      {expanded && (
        <AnimatedList className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3 ml-6">
          {files.map((file) => (
            <AnimatedItem key={file.id}>
              <FileCard
                file={file}
                courseName={file.courseId ? courseMap.get(file.courseId) : undefined}
                onSelect={() => onSelectFile(file.id)}
                onToggleFavorite={() => onToggleFavorite(file.id)}
                onRename={() => onRename(file)}
                onMove={() => onMove(file)}
                onDuplicate={() => onDuplicate(file)}
                onDelete={() => onDelete(file)}
                onEditNote={() => {
                  const note = window.prompt('Quick note:', file.note)
                  if (note !== null) onEditNote(file.id, note)
                }}
              />
            </AnimatedItem>
          ))}
        </AnimatedList>
      )}
    </div>
  )
}
