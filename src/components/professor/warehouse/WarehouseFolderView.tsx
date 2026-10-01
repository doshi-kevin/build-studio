'use client'

import { useState, useMemo } from 'react'
import { FolderOpen } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { FolderTree } from './FolderTree'
import { FileCard } from './FileCard'
import type { WarehouseFile, WarehouseCourse } from '@/lib/validations/warehouse'

interface WarehouseFolderViewProps {
  files: WarehouseFile[]
  allFiles: WarehouseFile[] // unfiltered (for tree counts)
  courses: WarehouseCourse[]
  onSelectFile: (fileId: string) => void
  onToggleFavorite: (fileId: string) => void
  onRename: (file: WarehouseFile) => void
  onMove: (file: WarehouseFile) => void
  onDuplicate: (file: WarehouseFile) => void
  onDelete: (file: WarehouseFile) => void
  onEditNote: (fileId: string, note: string) => void
}

export function WarehouseFolderView({
  files,
  allFiles,
  courses,
  onSelectFile,
  onToggleFavorite,
  onRename,
  onMove,
  onDuplicate,
  onDelete,
  onEditNote,
}: WarehouseFolderViewProps) {
  const [activeNodeId, setActiveNodeId] = useState('all')
  const courseMap = useMemo(() => new Map(courses.map((c) => [c.id, c.name])), [courses])

  // Filter files based on active tree node
  const displayFiles = useMemo(() => {
    if (activeNodeId === 'all') return files
    if (activeNodeId === 'favorites') return files.filter((f) => f.favorite)
    if (activeNodeId === 'recent') {
      return [...files]
        .sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime())
        .slice(0, 20)
    }
    if (activeNodeId === 'unsorted') return files.filter((f) => !f.courseId)

    // Course node: course-{courseId}
    const courseMatch = activeNodeId.match(/^course-(.+?)(?:-w(\d+))?$/)
    if (courseMatch) {
      const courseId = courseMatch[1]
      const weekStr = courseMatch[2]
      if (weekStr !== undefined) {
        const weekNum = parseInt(weekStr)
        return files.filter(
          (f) => f.courseId === courseId && (weekNum === 0 ? !f.week : f.week === weekNum),
        )
      }
      return files.filter((f) => f.courseId === courseId)
    }

    return files
  }, [files, activeNodeId])

  // Breadcrumb label
  const breadcrumb = useMemo(() => {
    if (activeNodeId === 'all') return 'All Files'
    if (activeNodeId === 'favorites') return 'Favorites'
    if (activeNodeId === 'recent') return 'Recently Used'
    if (activeNodeId === 'unsorted') return 'Unsorted Files'

    const courseMatch = activeNodeId.match(/^course-(.+?)(?:-w(\d+))?$/)
    if (courseMatch) {
      const course = courses.find((c) => c.id === courseMatch[1])
      const courseName = course ? (course.code ? `${course.code} — ${course.name}` : course.name) : 'Unknown'
      const weekStr = courseMatch[2]
      if (weekStr !== undefined) {
        const weekNum = parseInt(weekStr)
        return `${courseName} › ${weekNum === 0 ? 'Unassigned' : `Week ${weekNum}`}`
      }
      return courseName
    }

    return 'Files'
  }, [activeNodeId, courses])

  return (
    <div className="flex flex-col lg:flex-row gap-6 min-h-100">
      {/* Left: Tree */}
      <div className="bg-card border border-border rounded-xl p-3 h-fit lg:sticky lg:top-4 lg:w-60 shrink-0">
        <FolderTree
          files={allFiles}
          courses={courses}
          activeNodeId={activeNodeId}
          onNodeSelect={setActiveNodeId}
        />
      </div>

      {/* Right: File grid */}
      <div className="min-w-0 flex-1">
        <div className="mb-4">
          <h2 className="text-sm font-semibold">{breadcrumb}</h2>
          <p className="text-xs text-muted-foreground tabular-nums">{displayFiles.length} files</p>
        </div>

        {displayFiles.length === 0 ? (
          <EmptyState
            icon={FolderOpen}
            title="No files here"
            description="This folder is empty."
          />
        ) : (
          <AnimatedList className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {displayFiles.map((file) => (
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
    </div>
  )
}
