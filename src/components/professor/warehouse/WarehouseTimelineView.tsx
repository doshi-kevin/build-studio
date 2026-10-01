'use client'

import { useMemo } from 'react'
import { Clock } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { TimelineTermSection } from './TimelineTermSection'
import { groupFilesByTerm, sortTerms } from '@/lib/warehouse/utils'
import type { WarehouseFile, WarehouseCourse, WarehouseTerm } from '@/lib/validations/warehouse'

// TODO: AI — AI lecture suggestions based on timeline patterns

interface WarehouseTimelineViewProps {
  files: WarehouseFile[]
  courses: WarehouseCourse[]
  terms: WarehouseTerm[]
  onSelectFile: (fileId: string) => void
  onToggleFavorite: (fileId: string) => void
  onRename: (file: WarehouseFile) => void
  onMove: (file: WarehouseFile) => void
  onDuplicate: (file: WarehouseFile) => void
  onDelete: (file: WarehouseFile) => void
  onEditNote: (fileId: string, note: string) => void
}

export function WarehouseTimelineView({
  files,
  courses,
  terms,
  onSelectFile,
  onToggleFavorite,
  onRename,
  onMove,
  onDuplicate,
  onDelete,
  onEditNote,
}: WarehouseTimelineViewProps) {
  const sortedTerms = useMemo(() => sortTerms(terms), [terms])
  const termGroups = useMemo(() => groupFilesByTerm(files), [files])

  // Build sections: sorted terms + unassigned
  const sections = useMemo(() => {
    const result: { termId: string | null; label: string; files: WarehouseFile[] }[] = []

    for (const term of sortedTerms) {
      const termFiles = termGroups.get(term.id) ?? []
      result.push({ termId: term.id, label: term.label, files: termFiles })
    }

    // Unassigned
    const unassigned = termGroups.get('unassigned') ?? []
    if (unassigned.length > 0) {
      result.push({ termId: null, label: 'No Term Assigned', files: unassigned })
    }

    return result
  }, [sortedTerms, termGroups])

  if (files.length === 0) {
    return (
      <EmptyState
        icon={Clock}
        title="No files to show"
        description="Upload files and assign them to terms to see your timeline."
      />
    )
  }

  return (
    <div className="w-full max-w-5xl mx-auto">
      <div className="mb-6">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Teaching Timeline
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          Files organized by academic term — great for reusing material across semesters.
        </p>
      </div>

      <div>
        {sections.map((section, index) => (
          <TimelineTermSection
            key={section.termId ?? 'unassigned'}
            label={section.label}
            files={section.files}
            courses={courses}
            defaultExpanded={index === 0} // First term expanded by default
            onSelectFile={onSelectFile}
            onToggleFavorite={onToggleFavorite}
            onRename={onRename}
            onMove={onMove}
            onDuplicate={onDuplicate}
            onDelete={onDelete}
            onEditNote={onEditNote}
          />
        ))}
      </div>
    </div>
  )
}
