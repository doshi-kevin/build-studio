'use client'

import { useMemo } from 'react'
import { Package, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { EmptyState } from '@/components/ui/empty-state'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { ShelfCard } from './ShelfCard'
import { FavoritesSection } from './FavoritesSection'
import { RecentFilesSection } from './RecentFilesSection'
import { groupFilesByCourse } from '@/lib/warehouse/utils'
import type { WarehouseFile, WarehouseCourse, WarehouseTerm } from '@/lib/validations/warehouse'

// TODO: AI — AI organization suggestions (e.g. "You have 5 unsorted files — organize them?")

interface WarehouseShelfViewProps {
  files: WarehouseFile[]
  courses: WarehouseCourse[]
  terms: WarehouseTerm[]
  expandedShelfId: string | null
  expandedBoxId: string | null
  onExpandShelf: (shelfId: string | null) => void
  onExpandBox: (boxId: string | null) => void
  onSelectFile: (fileId: string) => void
  onToggleFavorite: (fileId: string) => void
  onRename: (file: WarehouseFile) => void
  onMove: (file: WarehouseFile) => void
  onDuplicate: (file: WarehouseFile) => void
  onDelete: (file: WarehouseFile) => void
  onEditNote: (fileId: string, note: string) => void
  onClearShelf: (courseId: string | null) => void
  onRemoveShelf: (courseId: string | null) => void
  onUpload: () => void
}

export function WarehouseShelfView({
  files,
  courses,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  terms,
  expandedShelfId,
  expandedBoxId,
  onExpandShelf,
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
  onUpload,
}: WarehouseShelfViewProps) {
  // Group files by course
  const courseGroups = useMemo(() => {
    const groups = groupFilesByCourse(files)
    // Build ordered list: all courses (even empty), then unsorted
    const result: { courseId: string | null; course: WarehouseCourse | null; files: WarehouseFile[] }[] = []

    for (const course of courses) {
      const courseFiles = groups.get(course.id) ?? []
      result.push({ courseId: course.id, course, files: courseFiles })
    }

    // Unsorted files
    const unsorted = groups.get('unsorted')
    if (unsorted && unsorted.length > 0) {
      result.push({ courseId: null, course: null, files: unsorted })
    }

    return result
  }, [files, courses])

  if (files.length === 0 && courses.length === 0) {
    return (
      <EmptyState
        variant="teaching"
        icon={Package}
        title="Your library is empty"
        description="Upload your lecture slides, readings, and notes to start building a reusable library you can pull from every term."
      >
        <Button onClick={onUpload}>
          <Upload className="h-4 w-4" />
          Upload your first file
        </Button>
      </EmptyState>
    )
  }

  return (
    <div className="space-y-6">
      {/* Top row: Favorites + Recent */}
      <div className="space-y-4">
        <FavoritesSection
          files={files}
          courses={courses}
          onSelectFile={onSelectFile}
          onToggleFavorite={onToggleFavorite}
        />
        <RecentFilesSection
          files={files}
          courses={courses}
          onSelectFile={onSelectFile}
          onToggleFavorite={onToggleFavorite}
        />
      </div>

      <Separator />

      {/* Course Shelves */}
      <div className="space-y-3">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Course Shelves
        </h2>
        <AnimatedList className="space-y-3">
          {courseGroups.map(({ courseId, course, files: courseFiles }) => {
            const shelfId = courseId ?? 'unsorted'
            return (
              <AnimatedItem key={shelfId}>
                <ShelfCard
                  course={course}
                  files={courseFiles}
                  allCourses={courses}
                  expanded={expandedShelfId === shelfId}
                  expandedBoxId={expandedBoxId}
                  onToggle={() => onExpandShelf(expandedShelfId === shelfId ? null : shelfId)}
                  onExpandBox={onExpandBox}
                  onSelectFile={onSelectFile}
                  onToggleFavorite={onToggleFavorite}
                  onRename={onRename}
                  onMove={onMove}
                  onDuplicate={onDuplicate}
                  onDelete={onDelete}
                  onEditNote={onEditNote}
                  onClearShelf={onClearShelf}
                  onRemoveShelf={onRemoveShelf}
                />
              </AnimatedItem>
            )
          })}
        </AnimatedList>
      </div>
    </div>
  )
}
