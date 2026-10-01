'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, Calendar } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { FileCard } from './FileCard'
import type { WarehouseFile, WarehouseCourse } from '@/lib/validations/warehouse'

interface TimelineTermSectionProps {
  label: string
  files: WarehouseFile[]
  courses: WarehouseCourse[]
  defaultExpanded?: boolean
  onSelectFile: (fileId: string) => void
  onToggleFavorite: (fileId: string) => void
  onRename: (file: WarehouseFile) => void
  onMove: (file: WarehouseFile) => void
  onDuplicate: (file: WarehouseFile) => void
  onDelete: (file: WarehouseFile) => void
  onEditNote: (fileId: string, note: string) => void
}

export function TimelineTermSection({
  label,
  files,
  courses,
  defaultExpanded = false,
  onSelectFile,
  onToggleFavorite,
  onRename,
  onMove,
  onDuplicate,
  onDelete,
  onEditNote,
}: TimelineTermSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const courseMap = new Map(courses.map((c) => [c.id, c.name]))

  return (
    <div className="relative">
      {/* Timeline dot + line */}
      <div className="absolute left-0 top-0 bottom-0 w-6 flex flex-col items-center">
        <div className="w-3 h-3 rounded-full bg-primary border-2 border-background mt-3 z-10" />
        <div className="w-0.5 flex-1 bg-border" />
      </div>

      {/* Content */}
      <div className="ml-10">
        {/* Term header */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-3 mb-3 group"
        >
          <Calendar className="h-4 w-4 text-muted-foreground" />
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <h3 className="text-sm font-semibold group-hover:text-primary transition-colors">
            {label}
          </h3>
          <Badge variant="secondary" className="text-xs">
            {files.length} files
          </Badge>
        </button>

        {/* File cards */}
        {expanded && (
          <AnimatedList className="grid grid-cols-1 md:grid-cols-2 gap-3 pb-6">
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

        {!expanded && <div className="pb-4" />}
      </div>
    </div>
  )
}
